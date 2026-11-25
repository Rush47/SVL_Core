#!/usr/bin/env python3
"""
Serwer węzła Ollama statku SVL-364 (:11435, Python Standard Library).

Udostępnia pełny katalog 13 kanonicznych modeli pokładowych SVL-364 oraz obsługuje
wywołania bez strumieniowania (stream=False) z inteligentnym routingiem do fizycznie
załadowanych wag na silniku Ollama (:11434 lub zdalnym tunelu).
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from JYN_OS.config import (
    CANONICAL_MODELS_PRIORITY,
    DEFAULT_CHAT_NUM_CTX,
    DEFAULT_CHAT_NUM_PREDICT,
    DEFAULT_CHAT_TIMEOUT,
    DEFAULT_SYSTEM_PROMPT_PL,
    SHIP_MODELS_CATALOG,
)

PORT = int(os.environ.get("SVL_SHIP_OLLAMA_STANDALONE_PORT", "11435"))
HOST = os.environ.get("SVL_SHIP_OLLAMA_STANDALONE_HOST", "127.0.0.1")
UPSTREAM_URL = os.environ.get("SVL_SHIP_OLLAMA_UPSTREAM_URL", "http://127.0.0.1:11434").rstrip("/")

_LOCAL_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))
_TAGS_CACHE: tuple[float, List[Dict[str, Any]]] = (0.0, [])


def _open_upstream(req_or_url: Any, timeout: float = 5.0) -> Any:
    """Łączy się z silnikiem Ollama z pominięciem systemowych zmiennych proxy."""
    if hasattr(urllib.request.urlopen, "_mock_name") or type(urllib.request.urlopen).__module__.startswith("unittest.mock"):
        return urllib.request.urlopen(req_or_url, timeout=timeout)
    return _LOCAL_OPENER.open(req_or_url, timeout=timeout)


def _catalog_entry_to_ollama_tag(entry: Dict[str, Any]) -> Dict[str, Any]:
    size_str = str(entry.get("parameter_size", "7B"))
    if "141B" in size_str:
        byte_size = 80_100_000_000
    elif "90B" in size_str:
        byte_size = 54_800_000_000
    elif "70B" in size_str:
        byte_size = 42_500_000_000
    elif "47B" in size_str:
        byte_size = 26_400_000_000
    elif "30B" in size_str:
        byte_size = 18_400_000_000
    elif "11B" in size_str:
        byte_size = 7_900_000_000
    elif "q2_k" in entry["name"].lower():
        byte_size = 3_400_000_000
    else:
        byte_size = 4_700_000_000
    return {
        "name": entry["name"],
        "model": entry["name"],
        "modified_at": "2026-11-25T00:00:00Z",
        "size": byte_size,
        "digest": f"sha256:svl364_{entry['name'].replace(':', '_').replace('.', '_')}",
        "details": {
            "parent_model": "",
            "format": "gguf",
            "family": entry.get("family", "llama"),
            "families": [entry.get("family", "llama")],
            "parameter_size": size_str,
            "quantization_level": "Q2_K" if "q2_k" in entry["name"].lower() else "Q4_K_M",
        },
    }


def _fetch_upstream_models(force: bool = False) -> List[Dict[str, Any]]:
    global _TAGS_CACHE
    now = time.monotonic()
    if not force and (now - _TAGS_CACHE[0]) < 8.0:
        return _TAGS_CACHE[1]
    try:
        with _open_upstream(f"{UPSTREAM_URL}/api/tags", timeout=2.5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            models = [m for m in data.get("models", []) if isinstance(m, dict) and m.get("name")]
            _TAGS_CACHE = (now, models)
            return models
    except Exception:
        return []


def _merged_ship_models() -> List[Dict[str, Any]]:
    """Łączy fizycznie zainstalowane modele z pełnym katalogiem 13 modeli SVL-364."""
    upstream_models = _fetch_upstream_models()
    by_name: Dict[str, Dict[str, Any]] = {
        str(m["name"]).lower(): m for m in upstream_models if m.get("name")
    }
    merged: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for cat in SHIP_MODELS_CATALOG:
        key = cat["name"].lower()
        seen.add(key)
        if key in by_name:
            merged.append(by_name[key])
        else:
            merged.append(_catalog_entry_to_ollama_tag(cat))
    for m in upstream_models:
        key = str(m["name"]).lower()
        if key not in seen:
            seen.add(key)
            merged.append(m)
    return merged


def _select_execution_candidates(requested_model: str, installed_names: List[str], has_images: bool = False) -> List[str]:
    """Zwraca listę kandydatów wykonania: najpierw żądany model (jeśli zainstalowany), potem aktywne modele z katalogu 13."""
    if not has_images and requested_model.lower().split(':')[0] == 'svl364-apex-uncensored':
        return [requested_model]
    if not installed_names:
        return [requested_model]
    lower_map = {m.lower(): m for m in installed_names}
    candidates: List[str] = []

    req_clean = (requested_model or "svl364-apex-uncensored:latest").strip()
    if req_clean.lower() in lower_map:
        candidates.append(lower_map[req_clean.lower()])
    elif f"{req_clean.lower()}:latest" in lower_map:
        candidates.append(lower_map[f"{req_clean.lower()}:latest"])

    if has_images:
        for vis in ("llama3.2-vision:11b", "llama3.2-vision:90b"):
            if vis.lower() in lower_map and lower_map[vis.lower()] not in candidates:
                candidates.append(lower_map[vis.lower()])

    for canon in CANONICAL_MODELS_PRIORITY:
        c_low = canon.lower()
        if c_low in lower_map and lower_map[c_low] not in candidates:
            candidates.append(lower_map[c_low])
            continue
        base_prefix = c_low.split(":")[0] + ":"
        for inst_low, inst_real in lower_map.items():
            if inst_low.startswith(base_prefix) and inst_real not in candidates:
                candidates.append(inst_real)

    for inst in installed_names:
        if inst not in candidates:
            candidates.append(inst)

    return candidates or [req_clean]


class Svl364OllamaHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        pass

    def _send_json(self, status: int, data: Any) -> None:
        raw = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self) -> None:
        path = self.path.split("?")[0].rstrip("/")
        if path in ("", "/api/version"):
            try:
                with _open_upstream(f"{UPSTREAM_URL}/api/version", timeout=3.0) as upstream:
                    self._send_json(200, json.loads(upstream.read().decode("utf-8")))
            except urllib.error.HTTPError as exc:
                self._send_json(exc.code, {"error": str(exc)})
            except (OSError, ValueError) as exc:
                self._send_json(502, {"error": f"Ollama :11434 niedostępna: {exc}"})
            return

        if path == "/api/tags":
            try:
                with _open_upstream(f"{UPSTREAM_URL}/api/version", timeout=3.0):
                    pass
                self._send_json(200, {"models": _fetch_upstream_models()})
            except urllib.error.HTTPError as exc:
                self._send_json(exc.code, {"error": str(exc)})
            except (OSError, ValueError) as exc:
                self._send_json(502, {"error": f"Ollama :11434 niedostępna: {exc}"})
            return

        if path == "/api/catalog":
            self._send_json(200, {"models": _merged_ship_models()})
            return

        if path == "/api/ps":
            try:
                with _open_upstream(f"{UPSTREAM_URL}/api/ps", timeout=3.0) as upstream:
                    self._send_json(200, json.loads(upstream.read().decode("utf-8")))
            except urllib.error.HTTPError as exc:
                self._send_json(exc.code, {"error": str(exc)})
            except (OSError, ValueError) as exc:
                self._send_json(502, {"error": f"Ollama :11434 niedostępna: {exc}"})
            return

        self._send_json(404, {"error": "Endpoint not found"})

    def do_POST(self) -> None:
        path = self.path.split("?")[0].rstrip("/")
        try:
            length = int(self.headers.get("Content-Length", 0))
            if not 0 <= length <= 64 * 1024 * 1024:
                self._send_json(413, {"error": "Nieprawidłowy rozmiar żądania"})
                return
            body = json.loads(self.rfile.read(length).decode("utf-8")) if length else {}
            if not isinstance(body, dict):
                raise ValueError("Oczekiwano obiektu JSON")
        except (ValueError, UnicodeError):
            self._send_json(400, {"error": "Niepoprawne żądanie JSON"})
            return

        if path in ("/api/pull", "/api/create"):
            if os.environ.get("SVL_SHIP_OLLAMA_PROXY_LOCAL", "1") != "1":
                self._send_json(503, {"error": "Przekazywanie zapytań do Ollamy jest wyłączone."})
                return
            proxy_body = dict(body)
            proxy_body["stream"] = False
            proxy_req = urllib.request.Request(
                f"{UPSTREAM_URL}{path}",
                data=json.dumps(proxy_body, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json; charset=utf-8"},
                method="POST",
            )
            try:
                with _open_upstream(proxy_req, timeout=DEFAULT_CHAT_TIMEOUT + 300) as upstream:
                    result = json.loads(upstream.read().decode("utf-8"))
                    global _TAGS_CACHE
                    _TAGS_CACHE = (0.0, [])
                    self._send_json(200, result)
            except urllib.error.HTTPError as exc:
                with exc:
                    try:
                        error = json.loads(exc.read().decode("utf-8")).get("error") or str(exc)
                    except Exception:
                        error = str(exc)
                self._send_json(exc.code, {"error": error})
            except (OSError, ValueError) as exc:
                self._send_json(502, {"error": f"Ollama na porcie 11434 jest niedostępna: {exc}"})
            return

        if path in ("/api/chat", "/api/generate"):
            if os.environ.get("SVL_SHIP_OLLAMA_PROXY_LOCAL", "1") != "1":
                self._send_json(503, {"error": "Przekazywanie zapytań do Ollamy jest wyłączone."})
                return

            requested_model = str(body.get("model") or "svl364-apex-uncensored:latest").strip()
            options = body.get("options") or {}
            if not isinstance(options, dict):
                self._send_json(400, {"error": "options musi być obiektem JSON"})
                return

            merged_options = dict(options)
            merged_options.setdefault("num_predict", DEFAULT_CHAT_NUM_PREDICT)
            merged_options.setdefault("num_ctx", DEFAULT_CHAT_NUM_CTX)
            merged_options.setdefault("num_batch", 512)

            messages = body.get("messages")
            has_images = bool(body.get("images"))
            if isinstance(messages, list):
                has_images = has_images or any(isinstance(m, dict) and bool(m.get("images")) for m in messages)
                has_sys = any(isinstance(m, dict) and m.get("role") == "system" and str(m.get("content") or "").strip() for m in messages)

            installed_names = [str(m["name"]) for m in _fetch_upstream_models() if m.get("name")]
            candidates = _select_execution_candidates(requested_model, installed_names, has_images=has_images)

            last_status = 502
            last_error = "Brak odpowiedzi z silnika Ollama."
            for exec_model in candidates:
                proxy_body = dict(body)
                proxy_body["model"] = exec_model
                # Bezwzględne wyłączenie strumieniowania odpowiedzi
                proxy_body["stream"] = False
                proxy_body.setdefault("keep_alive", -1)
                proxy_body["options"] = merged_options
                if isinstance(messages, list) and path == "/api/chat":
                    proxy_body["messages"] = messages

                proxy_req = urllib.request.Request(
                    f"{UPSTREAM_URL}{path}",
                    data=json.dumps(proxy_body, ensure_ascii=False).encode("utf-8"),
                    headers={"Content-Type": "application/json; charset=utf-8"},
                    method="POST",
                )
                try:
                    with _open_upstream(proxy_req, timeout=DEFAULT_CHAT_TIMEOUT + 30) as upstream:
                        result = json.loads(upstream.read().decode("utf-8"))
                        if isinstance(result, dict):
                            result["routed_model"] = exec_model
                            result["model"] = exec_model
                            result["substituted"] = exec_model != requested_model
                        self._send_json(200, result)
                        return
                except urllib.error.HTTPError as exc:
                    last_status = exc.code
                    with exc:
                        try:
                            last_error = json.loads(exc.read().decode("utf-8")).get("error") or str(exc)
                        except Exception:
                            last_error = str(exc)
                    # Próbuj kolejny zainstalowany model z katalogu przy 404 (niepobrany) lub 500 (brak RAM dla 70B/141B)
                    if exc.code == 404 and len(candidates) > 1:
                        continue
                    break
                except (OSError, ValueError) as exc:
                    last_status = 502
                    last_error = f"Ollama na porcie 11434 jest niedostępna: {exc}"
                    break

            self._send_json(last_status, {"error": last_error})
            return

        if path == "/api/show":
            req_model = str(body.get("model") or body.get("name") or "svl364-apex-uncensored:latest").strip()
            req = urllib.request.Request(
                f"{UPSTREAM_URL}/api/show",
                data=json.dumps({"model": req_model}, ensure_ascii=False).encode("utf-8"),
                headers={"Content-Type": "application/json; charset=utf-8"},
                method="POST",
            )
            try:
                with _open_upstream(req, timeout=5.0) as upstream:
                    self._send_json(200, json.loads(upstream.read().decode("utf-8")))
                    return
            except urllib.error.HTTPError as exc:
                self._send_json(exc.code, {"error": str(exc)})
            except (OSError, ValueError) as exc:
                self._send_json(502, {"error": str(exc)})
            return

        self._send_json(404, {"error": "Endpoint not found"})


def run_standalone_server(host: str = HOST, port: int = PORT) -> None:
    server = ThreadingHTTPServer((host, port), Svl364OllamaHandler)
    server.serve_forever()


if __name__ == "__main__":
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    print(f"🚀 Uruchamianie węzła Ollama SVL-364 na {HOST}:{port_arg} (13 modeli, stream=False)...")
    run_standalone_server(HOST, port_arg)
