"""Klient jednostki obliczeniowej Ollama statku SVL-364 oraz lokalnego silnika (:11434) z obsługą modeli wizyjnych."""

from __future__ import annotations

import base64
import json
import re
import time
import os
import shutil
import subprocess
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, Generator, List, Optional

from .config import SHIP_MODELS_CATALOG, JynOSConfig


class SvlOllamaClient:
    """Interfejs łączności z węzłami Ollama: lokalnym (:11434) oraz pokładowym statku SVL-364 (:11435)."""

    def __init__(self, config: Optional[JynOSConfig] = None):
        self.config = config or JynOSConfig.load_from_env()
        self._apex_verified: Dict[str, float] = {}

    def get_endpoints(self) -> Dict[str, str]:
        return {
            "Local Primary Node (:11434)": self.config.local_ollama_url,
            "Ship SVL-364 (Backup SSH Tunnel :11435)": self.config.ship_ollama_url,
        }

    def check_node_status(self, url: Optional[str] = None) -> Dict[str, Any]:
        """Sprawdza dostępność wybranego węzła Ollama, wersję i listę modeli."""
        target_url = (url or self.config.get_active_ollama_url()).rstrip("/")
        version_url = f"{target_url}/api/version"
        tags_url = f"{target_url}/api/tags"

        result = {
            "endpoint": target_url,
            "online": False,
            "version": None,
            "installed_models": [],
            "apex_present": False,
            "vision_present": False,
            "error": None,
        }

        try:
            req_ver = urllib.request.Request(version_url, headers={"User-Agent": "JYN_OS-Ollama/2.4.0"})
            with urllib.request.urlopen(req_ver, timeout=2.5) as r:
                data = json.loads(r.read().decode("utf-8"))
                result["online"] = True
                result["version"] = data.get("version")
        except Exception as e:
            result["error"] = f"Brak odpowiedzi na {version_url}: {e}"
            return result

        try:
            req_tags = urllib.request.Request(tags_url, headers={"User-Agent": "JYN_OS-Ollama/2.4.0"})
            with urllib.request.urlopen(req_tags, timeout=3.0) as r:
                data = json.loads(r.read().decode("utf-8"))
                models = [m.get("name") for m in data.get("models", []) if m.get("name")]
                result["installed_models"] = models
                result["apex_present"] = any("svl364-apex-uncensored" in m for m in models)
                result["vision_present"] = any("vision" in m.lower() for m in models)
        except Exception as e:
            result["error"] = f"Błąd odczytu modeli z {tags_url}: {e}"

        return result

    def get_ship_models_catalog(self) -> List[Dict[str, Any]]:
        """Zwraca specyfikację 13 modeli pokładowych statku SVL-364."""
        return SHIP_MODELS_CATALOG

    def pull_model(
        self,
        model: str,
        url: Optional[str] = None,
        timeout: float = 900.0,
    ) -> Dict[str, Any]:
        """Pobiera model do wybranego węzła Ollama (domyślnie lokalnego :11434)."""
        target_url = (url or self.config.get_active_ollama_url()).rstrip("/")
        endpoint = f"{target_url}/api/pull"
        payload = {"name": model, "stream": False}
        data = json.dumps(payload).encode("utf-8")

        req = urllib.request.Request(
            endpoint,
            data=data,
            headers={"Content-Type": "application/json", "User-Agent": "JYN_OS-Ollama/2.4.0"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                resp_json = json.loads(response.read().decode("utf-8"))
                if not isinstance(resp_json, dict) or resp_json.get("status") != "success" or resp_json.get("error"):
                    raise ValueError(str(resp_json.get("error") or resp_json.get("status") or "Brak potwierdzenia pobrania") if isinstance(resp_json, dict) else "Niepoprawna odpowiedź Ollamy")
                self._apex_verified.clear()
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

    @staticmethod
    def _normalize_feed_title(raw_title: str) -> str:
        """Normalizuje tytuł wpisu feedu (usuwa wiodące emoji, gwiazdki Markdown i nadmiarowe spacje)."""
        import re
        cleaned = re.sub(r"^[\sℹ️⚠️🚨✅❌🛰️•*]+", "", str(raw_title or "")).strip()
        cleaned = cleaned.replace("**", "").strip()
        cleaned = re.sub(r"\s+", " ", cleaned)
        return cleaned

    @classmethod
    def _clean_feed_message(cls, raw_title: str, raw_msg: str, max_len: int = 115) -> str:
        """Usuwa powtórzony tytuł z początku treści komunikatu i spłaszcza białe znaki."""
        import re
        norm_title = cls._normalize_feed_title(raw_title).lower()
        lines = [ln.strip() for ln in str(raw_msg or "").splitlines() if ln.strip()]
        if lines and cls._normalize_feed_title(lines[0]).lower() == norm_title:
            lines = lines[1:]
        flat = re.sub(r"\s+", " ", " · ".join(lines)).replace("**", "").strip()
        return flat[:max_len]

    def _fetch_live_svl_context(self) -> str:
        """Pobiera zwięzły, zdeduplikowany kontekst na żywo z jądra SVL / statku SVL-364 (cache 25 s)."""
        import time
        now = time.monotonic()
        cached = getattr(self, "_cached_svl_ctx", None)
        if cached and (now - cached[0]) < 25.0:
            return cached[1]

        ctx = ""
        try:
            ov_url = f"{self.config.backend_url.rstrip('/')}/api/py/svl364/overview"
            req = urllib.request.Request(ov_url, headers={"User-Agent": "JYN_OS-Ollama/2.6.0"})
            with urllib.request.urlopen(req, timeout=0.75) as r:
                data = json.loads(r.read().decode("utf-8"))
                if data.get("ok"):
                    summary = data.get("summary") or {}
                    raw_feed = data.get("feed") or []
                    buckets: Dict[str, List[str]] = {
                        "mission": [],
                        "research": [],
                        "status": [],
                    }
                    limits = {"mission": 6, "research": 5, "status": 2}
                    seen_titles: set[str] = set()
                    for it in raw_feed:
                        raw_title = str(it.get("title") or "").strip()
                        if not raw_title or raw_title.startswith("MCP/SSH · printf"):
                            continue
                        clean_title = self._normalize_feed_title(raw_title)
                        dedup_key = clean_title.lower()
                        if not clean_title or dedup_key in seen_titles:
                            continue
                        cat = str(it.get("category") or "info").lower()
                        bucket_key = cat if cat in ("mission", "research") else "status"
                        if len(buckets[bucket_key]) >= limits[bucket_key]:
                            continue
                        seen_titles.add(dedup_key)
                        clean_msg = self._clean_feed_message(raw_title, str(it.get("message") or ""), 115)
                        line = f"- [{cat.upper()}] {clean_title}" + (f": {clean_msg}" if clean_msg else "")
                        buckets[bucket_key].append(line)

                    ordered_lines = buckets["mission"] + buckets["research"] + buckets["status"]
                    ctx = (
                        f"\n[STAN SVL-364 NA ŻYWO: usługi={summary.get('servicesOnline', 0)}/{summary.get('servicesTotal', 12)}, "
                        f"aktywne_misje={summary.get('activeMissions', 0)}, aktywne_badania={summary.get('activeResearch', 0)}, "
                        f"transmisje={summary.get('transmissions', 0)}, otwarte_incydenty={summary.get('openIncidents', 0)}]\n"
                        + ("\n".join(ordered_lines) if ordered_lines else "")
                    )
        except Exception:
            ctx = ""

        self._cached_svl_ctx = (now, ctx)
        return ctx

    def _build_messages(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        history: Optional[List[Dict[str, str]]] = None,
        images: Optional[List[str]] = None,
    ) -> List[Dict[str, Any]]:
        # Pusty wpis systemowy blokuje automatyczne dołączanie promptu modelu
        # przez Ollama. Nie narzucamy osobowości, stylu ani instrukcji.
        # system_prompt pozostaje tylko dla kompatybilności starszych wywołań.
        messages: List[Dict[str, Any]] = [{"role": "system", "content": ""}]
        if history:
            # Zachowujemy całe ostatnie wiadomości w przybliżonym budżecie kontekstu.
            input_tokens = max(256, self.config.chat_num_ctx - min(
                self.config.chat_num_predict, self.config.chat_num_ctx // 2
            ) - 256)
            remaining = max(0, input_tokens * 3 - len(prompt))
            recent = []
            for turn in reversed(history[-20:]):
                role = turn.get("role", "user")
                content = str(turn.get("content", "")).strip()
                if role not in ("user", "assistant") or not content:
                    continue
                cost = len(content) + 32
                if cost > remaining:
                    break
                recent.append({"role": role, "content": content})
                remaining -= cost
            messages.extend(reversed(recent))

        user_msg: Dict[str, Any] = {"role": "user", "content": prompt}
        if images:
            b64_images: List[str] = []
            for img_item in images:
                if not img_item:
                    continue
                p = Path(img_item)
                if p.is_file():
                    try:
                        raw = p.read_bytes()
                        b64_images.append(base64.b64encode(raw).decode("ascii"))
                    except Exception:
                        pass
                else:
                    clean_b64 = img_item.split("base64,")[-1]
                    b64_images.append(clean_b64)
            if b64_images:
                user_msg["images"] = b64_images

        messages.append(user_msg)
        return messages

    def _candidate_models(self, selected_model: str, has_images: bool = False) -> List[str]:
        # Tekst nie może zostać po cichu przekazany do innego modelu.
        candidates = [selected_model]
        if has_images:
            candidates.extend([self.config.vision_model, "moondream:1.8b"])
        return list(dict.fromkeys(m for m in candidates if m))

    def _verify_apex(self, target_url: str, model: str) -> None:
        """Sprawdza rzeczywisty rozmiar modelu, a nie sam alias Apex."""
        if model.split(":")[0].lower() != "svl364-apex-uncensored":
            return
        key = f"{target_url}/{model}"
        now = time.monotonic()
        if now - self._apex_verified.get(key, -3600.0) < 60:
            return
        req = urllib.request.Request(
            f"{target_url}/api/show",
            data=json.dumps({"model": model}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=5.0) as response:
            info = json.load(response)
        if not isinstance(info, dict) or not isinstance(info.get("details"), dict):
            raise ValueError("Ollama nie zwróciła metadanych modelu.")
        size = str(info["details"].get("parameter_size", ""))
        match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)\s*B\s*", size, re.I)
        if not match or not 65 <= float(match.group(1)) <= 75:
            raise ValueError(f"Alias {model} nie wskazuje na zweryfikowany model 70B (parameter_size={size or 'brak'}). Odtwórz Apex z Modelfile 70B.")
        self._apex_verified[key] = now

    def _runtime_options(self, prompt: str) -> Dict[str, Any]:
        return {
            "temperature": 0.25,
            "top_p": 0.85,
            "repeat_penalty": 1.12,
            "num_ctx": self.config.chat_num_ctx,
            "num_predict": min(self.config.chat_num_predict, self.config.chat_num_ctx),
            "num_batch": 512,
        }

    def chat(
        self,
        prompt: str,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        url: Optional[str] = None,
        images: Optional[List[str]] = None,
        history: Optional[List[Dict[str, str]]] = None,
        timeout: Optional[float] = None,
    ) -> Dict[str, Any]:
        """Wykonuje zapytanie czatu do modelu z historią rozmowy, bez narzuconego promptu systemowego."""
        target_url = (url or self.config.get_active_ollama_url()).rstrip("/")
        endpoint = f"{target_url}/api/chat"
        selected_model = model or self.config.get_active_model()
        try:
            self._verify_apex(target_url, selected_model)
        except (OSError, ValueError) as exc:
            return {"success": False, "model": selected_model, "endpoint": target_url, "error": f"Weryfikacja Apex: {exc}"}
        messages = self._build_messages(prompt, system_prompt=system_prompt, history=history, images=images)
        options = self._runtime_options(prompt)

        last_err = ""
        for cand_model in self._candidate_models(selected_model, has_images=bool(images)):
            payload = {
                "model": cand_model,
                "messages": messages,
                "stream": False,
                "keep_alive": -1,
                "options": options,
            }
            data = json.dumps(payload).encode("utf-8")
            req = urllib.request.Request(
                endpoint,
                data=data,
                headers={"Content-Type": "application/json", "User-Agent": "JYN_OS-Ollama/2.6.0"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=self.config.chat_timeout if timeout is None else timeout) as response:
                    resp_json = json.loads(response.read().decode("utf-8"))
                    if not isinstance(resp_json, dict):
                        raise ValueError("Niepoprawny format odpowiedzi Ollamy")
                    if resp_json.get("error"):
                        last_err = str(resp_json["error"])
                        break
                    message = resp_json.get("message") or {}
                    content = message.get("content") if isinstance(message, dict) else None
                    if isinstance(content, str) and content.strip() and resp_json.get("done") is True:
                        content = content.strip()
                        return {
                            "success": True,
                            "model": cand_model,
                            "substituted": cand_model != selected_model,
                            "endpoint": target_url,
                            "response": content,
                            "total_duration": resp_json.get("total_duration"),
                            "eval_count": resp_json.get("eval_count"),
                            "load_duration": resp_json.get("load_duration"),
                            "prompt_eval_duration": resp_json.get("prompt_eval_duration"),
                            "eval_duration": resp_json.get("eval_duration"),
                            "done_reason": resp_json.get("done_reason"),
                            "truncated": resp_json.get("done_reason") == "length",
                        }
                    last_err = f"Pusta lub niedokończona odpowiedź z modelu {cand_model}"
            except urllib.error.HTTPError as he:
                try:
                    err_text = he.read().decode("utf-8")
                except Exception:
                    err_text = str(he)
                last_err = f"HTTP {he.code}: {err_text}"
                if he.code == 404 and images:
                    continue
                break
            except TimeoutError:
                last_err = f"Przekroczono czas oczekiwania na Ollamę ({target_url}). Sprawdź zasoby hosta i SVL_CHAT_TIMEOUT."
                break
            except Exception as e:
                last_err = f"Błąd połączenia z węzłem Ollama ({target_url}): {e}"
                break

        return {
            "success": False,
            "model": selected_model,
            "endpoint": target_url,
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
        """Zgodność ze starszymi wywołaniami: zwraca jeden kompletny wynik."""
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
        """Wygodne zapytanie multimodalne dla modelu wizyjnego (llama3.2-vision:11b)."""
        chosen_model = model or self.config.vision_model
        return self.chat(
            prompt=prompt,
            model=chosen_model,
            url=url,
            images=[image_path],
            timeout=timeout,
        )

    def install_local_ollama(self) -> Dict[str, Any]:
        """Weryfikuje lub instaluje lokalny silnik Ollama i upewnia się, że działa."""
        ollama_bin = shutil.which("ollama") or "/usr/local/bin/ollama"
        installed = os.path.isfile(ollama_bin) and os.access(ollama_bin, os.X_OK)

        if not installed:
            try:
                subprocess.run(
                    ["bash", "-o", "pipefail", "-c", "curl -fsSL https://ollama.com/install.sh | sh"],
                    check=True,
                    capture_output=True,
                    timeout=120,
                )
                ollama_bin = shutil.which("ollama") or "/usr/local/bin/ollama"
                installed = os.path.isfile(ollama_bin) and os.access(ollama_bin, os.X_OK)
            except Exception as e:
                return {"success": False, "error": f"Błąd instalacji Ollamy: {e}"}

        # Upewnij się, że lokalny węzeł na 11434 odpowiada
        status = self.check_node_status(self.config.local_ollama_url)
        if not status["online"] and installed:
            # Uruchomienie deamona w tle
            subprocess.Popen(
                [ollama_bin, "serve"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            import time
            time.sleep(1.5)
            status = self.check_node_status(self.config.local_ollama_url)

        return {
            "success": status["online"],
            "installed": installed,
            "version": status.get("version"),
            "models": status.get("installed_models", []),
            "binary": ollama_bin,
        }
