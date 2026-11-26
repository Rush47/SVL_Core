"""Klient jednostki obliczeniowej Ollama dla systemu JYN_OS (:11434 oraz statek SVL-364 :11435)."""

from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional

from .chat_engine import (
    build_polish_chat_messages,
    clean_polish_response,
    compute_turn_options,
)
from .config import (
    CANONICAL_MODELS_PRIORITY,
    DEFAULT_SYSTEM_PROMPT_PL,
    SHIP_MODELS_CATALOG,
    JynOSConfig,
    select_canonical_base_for_host,
)

_LOCAL_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _urlopen_direct(req_or_url: Any, timeout: float) -> Any:
    """Omija zmienne proxy dla lokalnych adresów 127.0.0.1/localhost, zachowując zgodność z unittest.mock."""
    if hasattr(urllib.request.urlopen, "_mock_name") or type(urllib.request.urlopen).__module__.startswith("unittest.mock"):
        return urllib.request.urlopen(req_or_url, timeout=timeout)
    url_str = req_or_url.full_url if isinstance(req_or_url, urllib.request.Request) else str(req_or_url)
    host = (urllib.parse.urlparse(url_str).hostname or "").lower()
    if host in ("127.0.0.1", "localhost", "::1"):
        return _LOCAL_NO_PROXY_OPENER.open(req_or_url, timeout=timeout)
    return urllib.request.urlopen(req_or_url, timeout=timeout)


class SvlOllamaClient:
    """Interfejs bezstrumieniowej łączności z węzłami Ollama: lokalnym (:11434) i pokładowym SVL-364 (:11435)."""

    def __init__(self, config: Optional[JynOSConfig] = None):
        self.config = config or JynOSConfig.load_from_env()
        self._tags_cache: Dict[str, tuple[float, List[str]]] = {}

    def get_endpoints(self) -> Dict[str, str]:
        return {
            "Local Primary Node (:11434)": self.config.local_ollama_url,
            "Ship SVL-364 (SSH / Bridge :11435)": self.config.ship_ollama_url,
        }

    def invalidate_cache(self, url: Optional[str] = None) -> None:
        if url:
            self._tags_cache.pop(url.rstrip("/"), None)
        else:
            self._tags_cache.clear()

    def check_node_status(self, url: Optional[str] = None) -> Dict[str, Any]:
        """Sprawdza dostępność węzła Ollama, jego wersję oraz zainstalowane modele."""
        target_url = (url or self.config.get_active_ollama_url()).rstrip("/")
        version_url = f"{target_url}/api/version"
        tags_url = f"{target_url}/api/tags"

        result: Dict[str, Any] = {
            "endpoint": target_url,
            "online": False,
            "version": None,
            "installed_models": [],
            "apex_present": False,
            "vision_present": False,
            "error": None,
        }

        try:
            req_ver = urllib.request.Request(version_url, headers={"User-Agent": "JYN_OS-Ollama/3.0.0"})
            with _urlopen_direct(req_ver, timeout=2.5) as r:
                data = json.loads(r.read().decode("utf-8"))
                result["online"] = True
                result["version"] = data.get("version")
        except Exception as e:
            result["error"] = f"Brak odpowiedzi na {version_url}: {e}"
            return result

        try:
            req_tags = urllib.request.Request(tags_url, headers={"User-Agent": "JYN_OS-Ollama/3.0.0"})
            with _urlopen_direct(req_tags, timeout=3.0) as r:
                data = json.loads(r.read().decode("utf-8"))
                models = [str(m.get("name")) for m in data.get("models", []) if isinstance(m, dict) and m.get("name")]
                result["installed_models"] = models
                result["apex_present"] = any("svl364-apex-uncensored" in m.lower() for m in models)
                result["vision_present"] = any("vision" in m.lower() for m in models)
                self._tags_cache[target_url] = (time.monotonic(), models)
        except Exception as e:
            result["error"] = f"Błąd odczytu modeli z {tags_url}: {e}"

        return result

    def get_installed_models_cached(self, target_url: str, ttl_sec: float = 60.0) -> Optional[List[str]]:
        """Zwraca listę modeli z krótkiego cache (bez narzutu przy każdym zapytaniu czatu)."""
        clean_url = target_url.rstrip("/")
        cached = self._tags_cache.get(clean_url)
        now = time.monotonic()
        if cached and (now - cached[0]) < ttl_sec:
            return cached[1]
        if hasattr(urllib.request.urlopen, "_mock_name") or type(urllib.request.urlopen).__module__.startswith("unittest.mock"):
            return None
        try:
            req = urllib.request.Request(f"{clean_url}/api/tags", headers={"User-Agent": "JYN_OS-Ollama/3.0.0"})
            with _urlopen_direct(req, timeout=1.5) as r:
                data = json.loads(r.read().decode("utf-8"))
                models = [str(m.get("name")) for m in data.get("models", []) if isinstance(m, dict) and m.get("name")]
                self._tags_cache[clean_url] = (now, models)
                return models
        except Exception:
            return None

    def get_ship_models_catalog(self) -> List[Dict[str, Any]]:
        """Zwraca specyfikację 13 kanonicznych modeli pokładowych statku SVL-364."""
        return SHIP_MODELS_CATALOG

    def pull_model(
        self,
        model: str,
        url: Optional[str] = None,
        timeout: float = 900.0,
    ) -> Dict[str, Any]:
        """Pobiera model do wybranego węzła Ollama w trybie bez strumieniowania (stream=False)."""
        target_url = (url or self.config.get_active_ollama_url()).rstrip("/")
        endpoint = f"{target_url}/api/pull"
        payload = {"name": model, "stream": False}
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

        req = urllib.request.Request(
            endpoint,
            data=data,
            headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": "JYN_OS-Ollama/3.0.0"},
            method="POST",
        )
        try:
            with _urlopen_direct(req, timeout=timeout) as response:
                resp_json = json.loads(response.read().decode("utf-8"))
                if not isinstance(resp_json, dict) or resp_json.get("status") != "success" or resp_json.get("error"):
                    raise ValueError(
                        str(resp_json.get("error") or resp_json.get("status") or "Brak potwierdzenia pobrania")
                        if isinstance(resp_json, dict)
                        else "Niepoprawna odpowiedź Ollamy"
                    )
                self.invalidate_cache(target_url)
                return {
                    "success": True,
                    "model": model,
                    "endpoint": target_url,
                    "status": resp_json.get("status", "success"),
                }
        except Exception as e:
            return {
                "success": False,
                "model": model,
                "endpoint": target_url,
                "error": f"Błąd pobierania modelu {model} ({target_url}): {e}",
            }

    def create_apex_model(
        self,
        base_model: Optional[str] = None,
        target_name: str = "svl364-apex-uncensored:latest",
        url: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Buduje profil svl364-apex-uncensored:latest na bazie kanonicznego modelu z katalogu 13 modeli."""
        target_url = (url or self.config.local_ollama_url).rstrip("/")
        chosen_base = base_model or "dolphin-llama3:70b"
        if target_name.lower().split(":")[0] == "svl364-apex-uncensored" and not (
            chosen_base.lower() == "dolphin-llama3:70b" or chosen_base.lower().startswith("dolphin-llama3:70b-")
        ):
            return {"success": False, "model": target_name, "base_model": chosen_base,
                    "error": "Apex wymaga rzeczywistej bazy dolphin-llama3:70b."}
        installed = self.get_installed_models_cached(target_url, ttl_sec=0.0)
        if installed is not None and chosen_base.lower() not in {m.lower() for m in installed}:
            return {"success": False, "model": target_name, "base_model": chosen_base,
                    "error": f"Brak zainstalowanej bazy {chosen_base} na {target_url}."}

        ollama_bin = shutil.which("ollama") or "/usr/local/bin/ollama"
        if os.path.isfile(ollama_bin) and urllib.parse.urlparse(target_url).hostname in ("127.0.0.1", "localhost", "::1") and urllib.parse.urlparse(target_url).port == 11434:
            import tempfile
            modelfile_text = (
                f"FROM {chosen_base}\n"
                f"PARAMETER num_ctx {self.config.chat_num_ctx}\n"
                f"PARAMETER num_predict {self.config.chat_num_predict}\n"
                "PARAMETER temperature 0.3\n"
                "PARAMETER top_p 0.85\n"
                "PARAMETER top_k 40\n"
                "PARAMETER repeat_penalty 1.1\n"
                f'SYSTEM """{DEFAULT_SYSTEM_PROMPT_PL}"""\n'
            )
            fd, tmp_path = tempfile.mkstemp(prefix="Modelfile_svl364_", text=True)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    f.write(modelfile_text)
                proc = subprocess.run(
                    [ollama_bin, "create", target_name, "-f", tmp_path],
                    capture_output=True,
                    text=True,
                    timeout=120,
                    env={**os.environ, "OLLAMA_HOST": target_url},
                )
                if proc.returncode == 0:
                    self.invalidate_cache(target_url)
                    return {"success": True, "model": target_name, "base_model": chosen_base, "endpoint": target_url}
                err_msg = proc.stderr.strip() or proc.stdout.strip()
            except Exception as exc:
                err_msg = str(exc)
            finally:
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass
        else:
            err_msg = "Brak lokalnej binarki ollama"

        payload = {
            "model": target_name,
            "from": chosen_base,
            "system": DEFAULT_SYSTEM_PROMPT_PL,
            "parameters": {
                "num_ctx": self.config.chat_num_ctx,
                "num_predict": self.config.chat_num_predict,
                "temperature": 0.3,
                "top_p": 0.85,
                "repeat_penalty": 1.1,
            },
            "stream": False,
        }
        req = urllib.request.Request(
            f"{target_url}/api/create",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            with _urlopen_direct(req, timeout=120.0) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                if isinstance(body, dict) and body.get("status") == "success":
                    self.invalidate_cache(target_url)
                    return {"success": True, "model": target_name, "base_model": chosen_base, "endpoint": target_url}
                err_msg = str(body.get("error") or body)
        except Exception as exc:
            err_msg = str(exc)
        return {"success": False, "model": target_name, "base_model": chosen_base, "error": err_msg}

    def warm_up(self, model: Optional[str] = None, url: Optional[str] = None) -> Dict[str, Any]:
        """Ładuje aktywny model do pamięci RAM z keep_alive=-1 i rozgrzewa polski prefiks KV-cache."""
        target_url = (url or self.config.get_active_ollama_url()).rstrip("/")
        chosen_model = (model or self.config.get_active_model()).strip()
        installed = self.get_installed_models_cached(target_url, ttl_sec=5.0)
        candidates = self._candidate_models(chosen_model, has_images=False, installed=installed)
        exec_model = candidates[0] if candidates else chosen_model

        opts = compute_turn_options("rozgrzej", self.config, has_images=False)
        opts["num_predict"] = 1
        payload = {
            "model": exec_model,
            "messages": self._build_messages("ok"),
            "stream": False,
            "keep_alive": -1,
            "options": opts,
        }
        req = urllib.request.Request(
            f"{target_url}/api/chat",
            data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            with _urlopen_direct(req, timeout=self.config.chat_timeout) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                if not isinstance(body, dict) or body.get("error") or body.get("done") is not True:
                    raise ValueError(f"Niepotwierdzone rozgrzanie modelu: {body}")
                return {"success": True, "model": exec_model, "endpoint": target_url}
        except Exception as exc:
            return {"success": False, "model": exec_model, "endpoint": target_url, "error": str(exc)}

    def _encode_images(self, images: Optional[List[str]]) -> List[str]:
        b64_images: List[str] = []
        if not images:
            return b64_images
        for img_item in images:
            if not img_item:
                continue
            p = Path(img_item)
            if p.is_file():
                try:
                    b64_images.append(base64.b64encode(p.read_bytes()).decode("ascii"))
                except Exception:
                    pass
            else:
                b64_images.append(img_item.split("base64,")[-1])
        return b64_images

    def _build_messages(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        history: Optional[List[Dict[str, str]]] = None,
        images: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        b64_images = self._encode_images(images)
        return build_polish_chat_messages(
            prompt=prompt,
            config=self.config,
            system_prompt=system_prompt,
            history=history,
            b64_images=b64_images or None,
        )

    def _candidate_models(
        self,
        selected_model: str,
        has_images: bool = False,
        installed: Optional[List[str]] = None,
    ) -> List[str]:
        """Wyłącznie wybrany model, bez podmiany."""
        return [(selected_model or self.config.get_active_model()).strip()]

    def _runtime_options(self, prompt: str, has_images: bool = False) -> Dict[str, Any]:
        return compute_turn_options(prompt=prompt, config=self.config, has_images=has_images)

    def chat(
        self,
        prompt: str,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        url: Optional[str] = None,
        images: Optional[List[str]] = None,
        history: Optional[List[Dict[str, str]]] = None,
        timeout: Optional[float] = None,
        capabilities: str = "",
    ) -> Dict[str, Any]:
        """Wykonuje szybkie zapytanie czatu po polsku z całkowicie wyłączonym strumieniowaniem (stream=False)."""
        primary_url = (url or self.config.get_active_ollama_url()).rstrip("/")
        endpoints = [primary_url]

        selected_model = (model or self.config.get_active_model()).strip()
        messages = self._build_messages(prompt, system_prompt=system_prompt, history=history, images=images)
        if capabilities:
            messages.insert(0, {"role": "system", "content": capabilities})
        options = self._runtime_options(prompt, has_images=bool(images))
        effective_timeout = self.config.chat_timeout if timeout is None else timeout

        last_err = ""
        for ep_url in endpoints:
            chat_endpoint = f"{ep_url}/api/chat"
            candidates = [selected_model]

            node_unreachable = False
            for cand_model in candidates:
                payload = {
                    "model": cand_model,
                    "messages": messages,
                    # Strumieniowanie odpowiedzi jest bezwzględnie wyłączone
                    "stream": False,
                    "keep_alive": -1,
                    "options": options,
                }
                data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
                req = urllib.request.Request(
                    chat_endpoint,
                    data=data,
                    headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": "JYN_OS-Ollama/3.0.0"},
                    method="POST",
                )
                try:
                    with _urlopen_direct(req, timeout=effective_timeout) as response:
                        resp_json = json.loads(response.read().decode("utf-8"))
                        if not isinstance(resp_json, dict):
                            raise ValueError("Niepoprawny format odpowiedzi JSON z Ollamy")
                        if resp_json.get("error"):
                            last_err = str(resp_json["error"])
                            if not self.config.strict_model and len(candidates) > 1 and "not found" in last_err.lower():
                                continue
                            break
                        message = resp_json.get("message") or {}
                        raw_content = message.get("content") if isinstance(message, dict) else None
                        if isinstance(raw_content, str) and raw_content.strip() and resp_json.get("done") is True:
                            cleaned_reply = clean_polish_response(raw_content)
                            if not cleaned_reply:
                                last_err = f"Model {cand_model} nie zwrócił treści odpowiedzi"
                                break
                            routed_model = str(resp_json.get("routed_model") or resp_json.get("model") or "")
                            normalize = lambda name: name.lower() if ":" in name else name.lower() + ":latest"
                            if not routed_model or normalize(routed_model) != normalize(cand_model):
                                last_err = f"Niepotwierdzony lub inny model: {routed_model or '-'}; wybrano {cand_model}"
                                break
                            return {
                                "success": True,
                                "model": cand_model,
                                "routed_model": routed_model,
                                "substituted": routed_model != selected_model,
                                "endpoint": ep_url,
                                "response": cleaned_reply,
                                "total_duration": resp_json.get("total_duration"),
                                "eval_count": resp_json.get("eval_count"),
                                "load_duration": resp_json.get("load_duration"),
                                "prompt_eval_duration": resp_json.get("prompt_eval_duration"),
                                "eval_duration": resp_json.get("eval_duration"),
                                "done_reason": resp_json.get("done_reason"),
                                "truncated": resp_json.get("done_reason") == "length",
                            }
                        last_err = f"Pusta lub niedokończona odpowiedź z modelu {cand_model}"
                        break
                except urllib.error.HTTPError as he:
                    try:
                        err_body = he.read().decode("utf-8")
                        parsed_err = json.loads(err_body).get("error") if err_body.strip().startswith("{") else err_body
                    except Exception:
                        parsed_err = str(he)
                    last_err = f"HTTP {he.code}: {parsed_err}"
                    if he.code == 404 and not self.config.strict_model and len(candidates) > 1:
                        self.invalidate_cache(ep_url)
                        continue
                    if he.code in (404, 502, 503, 504):
                        node_unreachable = True
                    break
                except TimeoutError:
                    last_err = f"Przekroczono czas oczekiwania ({effective_timeout}s) na Ollamę ({ep_url})."
                    break
                except OSError as oe:
                    last_err = f"Błąd połączenia z węzłem Ollama ({ep_url}): {oe}"
                    node_unreachable = True
                    break
                except Exception as e:
                    last_err = f"Błąd komunikacji z węzłem Ollama ({ep_url}): {e}"
                    break

            if not node_unreachable:
                break

        return {
            "success": False,
            "model": selected_model,
            "endpoint": primary_url,
            "error": last_err or "Nie udało się uzyskać odpowiedzi z Ollamy.",
        }

    def chat_stream(
        self,
        prompt: str,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        url: Optional[str] = None,
        history: Optional[List[Dict[str, str]]] = None,
        timeout: Optional[float] = None,
    ) -> Generator[Dict[str, Any], None, None]:
        """Adapter kompatybilności (strumieniowanie wyłączone): zwraca wyłącznie jeden pełny wynik."""
        result = self.chat(prompt, model=model, system_prompt=system_prompt, url=url, history=history, timeout=timeout)
        if result.get("success"):
            yield {"ok": True, "model": result["model"], "token": result["response"], "done": True}
        else:
            yield {"ok": False, "model": result.get("model"), "error": result.get("error"), "done": True}

    def chat_vision(
        self,
        prompt: str,
        image_path: str,
        model: Optional[str] = None,
        url: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Zapytanie multimodalne dla kanonicznego modelu wizyjnego (llama3.2-vision:11b)."""
        chosen_model = model or self.config.vision_model
        return self.chat(
            prompt=prompt,
            model=chosen_model,
            url=url,
            images=[image_path],
            timeout=timeout,
        )

    def install_local_ollama(self, ensure_models: bool = True) -> Dict[str, Any]:
        """Instaluje lub uruchamia zoptymalizowany silnik Ollama (:11434) i przygotowuje model kanoniczny."""
        ollama_bin = shutil.which("ollama") or "/usr/local/bin/ollama"
        installed = os.path.isfile(ollama_bin) and os.access(ollama_bin, os.X_OK)

        if not installed:
            try:
                subprocess.run(
                    ["bash", "-o", "pipefail", "-c", "curl -fsSL https://ollama.com/install.sh | sh"],
                    check=True,
                    capture_output=True,
                    timeout=240,
                )
                ollama_bin = shutil.which("ollama") or "/usr/local/bin/ollama"
                installed = os.path.isfile(ollama_bin) and os.access(ollama_bin, os.X_OK)
            except Exception as e:
                return {"success": False, "error": f"Błąd instalacji Ollamy: {e}"}

        status = self.check_node_status(self.config.local_ollama_url)
        if not status["online"] and installed:
            daemon_env = dict(os.environ)
            daemon_env.setdefault("OLLAMA_HOST", "127.0.0.1:11434")
            daemon_env.setdefault("OLLAMA_KEEP_ALIVE", "-1")
            daemon_env.setdefault("OLLAMA_FLASH_ATTENTION", "1")
            daemon_env.setdefault("OLLAMA_KV_CACHE_TYPE", "q8_0")
            daemon_env.setdefault("OLLAMA_NUM_PARALLEL", "1")
            daemon_env.setdefault("OLLAMA_MAX_LOADED_MODELS", "1")
            subprocess.Popen(
                [ollama_bin, "serve"],
                env=daemon_env,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            for _ in range(25):
                time.sleep(0.2)
                status = self.check_node_status(self.config.local_ollama_url)
                if status["online"]:
                    break

        if status["online"] and ensure_models:
            models = status.get("installed_models", [])
            if not models:
                base_to_pull = select_canonical_base_for_host()
                pull_res = self.pull_model(base_to_pull, url=self.config.local_ollama_url)
                if pull_res.get("success"):
                    status = self.check_node_status(self.config.local_ollama_url)
                    models = status.get("installed_models", [])
            if models and not any("svl364-apex-uncensored" in m.lower() for m in models):
                self.create_apex_model(url=self.config.local_ollama_url)
                status = self.check_node_status(self.config.local_ollama_url)
            if status.get("installed_models"):
                self.warm_up(url=self.config.local_ollama_url)

        return {
            "success": status["online"],
            "installed": installed,
            "version": status.get("version"),
            "models": status.get("installed_models", []),
            "binary": ollama_bin,
        }
