"""Klient jednostki obliczeniowej Ollama statku SVL-364 (:11435) oraz modelu svl364-apex-uncensored."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from typing import Any, Dict, Generator, List, Optional

from .config import SHIP_MODELS_CATALOG, JynOSConfig


class SvlOllamaClient:
    """Interfejs łączności z węzłem Ollama statku SVL-364 (domyślnie tunel SSH :11435)."""

    def __init__(self, config: Optional[JynOSConfig] = None):
        self.config = config or JynOSConfig.load_from_env()

    def get_endpoints(self) -> Dict[str, str]:
        return {
            "Ship SVL-364 (Backup SSH Tunnel :11435)": self.config.ship_ollama_url,
            "Local Primary Node (:11434)": self.config.local_ollama_url,
        }

    def check_node_status(self, url: Optional[str] = None) -> Dict[str, Any]:
        """Sprawdza dostępność węzła Ollama, wersję i listę modeli."""
        target_url = (url or self.config.ship_ollama_url).rstrip("/")
        version_url = f"{target_url}/api/version"
        tags_url = f"{target_url}/api/tags"

        result = {
            "endpoint": target_url,
            "online": False,
            "version": None,
            "installed_models": [],
            "apex_present": False,
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
        except Exception as e:
            result["error"] = f"Błąd odczytu modeli z {tags_url}: {e}"

        return result

    def get_ship_models_catalog(self) -> List[Dict[str, Any]]:
        """Zwraca specyfikację 13 modeli pokładowych statku SVL-364."""
        return SHIP_MODELS_CATALOG

    def chat(
        self,
        prompt: str,
        model: Optional[str] = None,
        system_prompt: Optional[str] = None,
        url: Optional[str] = None,
        timeout: float = 60.0,
    ) -> Dict[str, Any]:
        """Wykonuje synchroniczne zapytanie czatu do modelu statku."""
        target_url = (url or self.config.ship_ollama_url).rstrip("/")
        endpoint = f"{target_url}/api/chat"
        selected_model = model or self.config.ship_model

        sys_msg = system_prompt or (
            "Jesteś pokładowym rdzeniem AI systemu SVL CoreOS 2 (Jyn Mitek / Apex) "
            "na statku SVL-364 Ebon Apex dla Operatora Mateusza Mitka. "
            "Odpowiadaj bezpośrednio, technicznie, po polsku."
        )

        messages = [
            {"role": "system", "content": sys_msg},
            {"role": "user", "content": prompt},
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
