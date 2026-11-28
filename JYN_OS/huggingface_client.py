"""Klient Hugging Face Inference REST API z obsługą HF_TOKEN / HUGGINGFACE_API_KEY oraz fallbackiem na Ollamę."""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

from .config import JynOSConfig
from .ollama_client import SvlOllamaClient

DEFAULT_HF_API_BASE = "https://api-inference.huggingface.co/models"
DEFAULT_HF_MODEL = "Qwen/Qwen2.5-14B-Instruct"


def resolve_hf_token() -> str:
    """Pobiera token autoryzacyjny Hugging Face ze zmiennych środowiskowych HF_TOKEN lub HUGGINGFACE_API_KEY."""
    for env_key in ("HF_TOKEN", "HUGGINGFACE_API_KEY", "HUGGING_FACE_HUB_TOKEN"):
        val = os.environ.get(env_key, "").strip()
        if val:
            return val
    return ""


class HuggingFaceInferenceClient:
    """Klient wywołań modeli przez Hugging Face Inference REST API z lokalnym fallbackiem na serwer Ollama."""

    def __init__(
        self,
        config: Optional[JynOSConfig] = None,
        ollama_client: Optional[SvlOllamaClient] = None,
        api_token: Optional[str] = None,
        default_model: str = DEFAULT_HF_MODEL,
        api_base: str = DEFAULT_HF_API_BASE,
    ) -> None:
        self.config = config or JynOSConfig.load_from_env()
        self.ollama = ollama_client or SvlOllamaClient(self.config)
        self._explicit_token = api_token
        self.default_model = os.environ.get("SVL_HF_MODEL", default_model).strip() or DEFAULT_HF_MODEL
        self.api_base = api_base.rstrip("/")

    def get_token(self) -> str:
        if self._explicit_token is not None:
            return self._explicit_token.strip()
        return resolve_hf_token()

    def build_endpoint_url(self, model_id: Optional[str] = None) -> str:
        chosen = (model_id or self.default_model).strip().lstrip("/")
        return f"{self.api_base}/{chosen}"

    def generate(
        self,
        prompt: str,
        model_id: Optional[str] = None,
        max_new_tokens: int = 512,
        temperature: float = 0.3,
        timeout: float = 30.0,
        fallback_to_ollama: bool = True,
        ollama_fallback_model: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Wywołuje model przez Hugging Face Inference REST API, a w razie braku tokenu lub błędu przełącza na Ollamę."""
        chosen_model = (model_id or self.default_model).strip()
        token = self.get_token()
        endpoint = self.build_endpoint_url(chosen_model)

        headers: Dict[str, str] = {
            "Content-Type": "application/json; charset=utf-8",
            "User-Agent": "JYN_OS-HuggingFaceClient/1.0",
        }
        if token:
            headers["Authorization"] = f"Bearer {token}"

        payload = {
            "inputs": prompt,
            "parameters": {
                "max_new_tokens": max_new_tokens,
                "temperature": temperature,
                "return_full_text": False,
            },
        }

        hf_error: Optional[str] = None
        if token:
            req = urllib.request.Request(
                endpoint,
                data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                headers=headers,
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    raw = resp.read().decode("utf-8")
                    parsed = json.loads(raw)
                    generated_text = self._extract_generated_text(parsed)
                    if generated_text:
                        return {
                            "success": True,
                            "provider": "huggingface",
                            "model": chosen_model,
                            "endpoint": endpoint,
                            "response": generated_text,
                            "fallback_used": False,
                        }
                    hf_error = f"Pusta odpowiedź z Hugging Face API: {raw[:200]}"
            except urllib.error.HTTPError as he:
                try:
                    err_body = he.read().decode("utf-8")
                except Exception:
                    err_body = str(he)
                hf_error = f"HTTP {he.code}: {err_body}"
            except Exception as exc:
                hf_error = f"Błąd połączenia z Hugging Face API: {exc}"
        else:
            hf_error = "Brak skonfigurowanego tokenu HF_TOKEN / HUGGINGFACE_API_KEY"

        if not fallback_to_ollama:
            return {
                "success": False,
                "provider": "huggingface",
                "model": chosen_model,
                "endpoint": endpoint,
                "error": hf_error,
                "fallback_used": False,
            }

        fallback_model = ollama_fallback_model or self.config.get_active_model()
        ollama_res = self.ollama.chat(prompt=prompt, model=fallback_model, timeout=timeout)
        if ollama_res.get("success"):
            return {
                "success": True,
                "provider": "ollama_fallback",
                "model": ollama_res.get("model", fallback_model),
                "requested_hf_model": chosen_model,
                "endpoint": ollama_res.get("endpoint"),
                "response": ollama_res.get("response", ""),
                "fallback_used": True,
                "hf_error": hf_error,
            }

        return {
            "success": False,
            "provider": "ollama_fallback",
            "model": fallback_model,
            "requested_hf_model": chosen_model,
            "error": f"HF: {hf_error} | Ollama: {ollama_res.get('error')}",
            "fallback_used": True,
        }

    @staticmethod
    def _extract_generated_text(parsed: Any) -> str:
        if isinstance(parsed, list) and parsed:
            first = parsed[0]
            if isinstance(first, dict):
                return str(first.get("generated_text") or first.get("summary_text") or "").strip()
        if isinstance(parsed, dict):
            if "generated_text" in parsed:
                return str(parsed["generated_text"]).strip()
            choices = parsed.get("choices")
            if isinstance(choices, list) and choices:
                c0 = choices[0]
                if isinstance(c0, dict):
                    msg = c0.get("message")
                    if isinstance(msg, dict) and msg.get("content"):
                        return str(msg["content"]).strip()
                    if c0.get("text"):
                        return str(c0["text"]).strip()
        return ""
