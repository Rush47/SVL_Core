"""Klient jednostki obliczeniowej Ollama statku SVL-364 oraz lokalnego silnika (:11434) z obsługą modeli wizyjnych."""

from __future__ import annotations

import base64
import json
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

    def chat(
        self,
        prompt: str,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        url: Optional[str] = None,
        images: Optional[List[str]] = None,
        timeout: float = 60.0,
    ) -> Dict[str, Any]:
        """Wykonuje synchroniczne zapytanie czatu do modelu (tekstowe lub multimodalne/wizyjne)."""
        target_url = (url or self.config.get_active_ollama_url()).rstrip("/")
        endpoint = f"{target_url}/api/chat"
        selected_model = model or self.config.get_active_model()

        sys_msg = system_prompt or (
            "Jesteś pokładowym rdzeniem AI systemu SVL CoreOS 2 (Jyn Mitek / Apex) "
            "dla Operatora Mateusza Mitka. "
            "Odpowiadaj bezpośrednio, technicznie, po polsku."
        )

        user_msg: Dict[str, Any] = {"role": "user", "content": prompt}

        # Obsługa obrazów dla modeli multimodalnych (np. llama3.2-vision:11b)
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
                    # Zakładamy bezpośredni ciąg base64
                    clean_b64 = img_item.split("base64,")[-1]
                    b64_images.append(clean_b64)
            if b64_images:
                user_msg["images"] = b64_images

        messages = [
            {"role": "system", "content": sys_msg},
            user_msg,
        ]

        payload = {
            "model": selected_model,
            "messages": messages,
            "stream": False,
            "options": {
                "temperature": 0.75,
                "top_p": 0.92,
                "num_ctx": 16384,
            },
        }

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
                message = resp_json.get("message", {})
                content = message.get("content", "")
                return {
                    "success": True,
                    "model": selected_model,
                    "endpoint": target_url,
                    "response": content,
                    "total_duration": resp_json.get("total_duration"),
                    "eval_count": resp_json.get("eval_count"),
                }
        except urllib.error.HTTPError as he:
            try:
                err_text = he.read().decode("utf-8")
            except Exception:
                err_text = str(he)
            return {
                "success": False,
                "model": selected_model,
                "endpoint": target_url,
                "error": f"HTTP {he.code}: {err_text}",
            }
        except Exception as e:
            return {
                "success": False,
                "model": selected_model,
                "endpoint": target_url,
                "error": f"Błąd połączenia z węzłem Ollama ({target_url}): {e}",
            }

    def chat_vision(
        self,
        prompt: str,
        image_path: str,
        model: Optional[str] = None,
        url: Optional[str] = None,
        timeout: float = 90.0,
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
                    ["curl -fsSL https://ollama.com/install.sh | sh"],
                    shell=True,
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
