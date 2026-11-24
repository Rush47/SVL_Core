#!/usr/bin/env python3
"""
Niezależny serwer zapasowej Ollamy dla statku SVL-364 (Python Standard Library).
Działa autonomicznie bez zewnętrznych zależności, zapewniając dostęp do 13 modeli
pokładowych statku SVL-364 na porcie 11435 lub 11436.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from JYN_OS.config import SHIP_MODELS_CATALOG

PORT = int(os.environ.get("SVL_SHIP_OLLAMA_STANDALONE_PORT", "11435"))
HOST = os.environ.get("SVL_SHIP_OLLAMA_STANDALONE_HOST", "127.0.0.1")

ALL_MODELS: List[Dict[str, Any]] = [
    {
        "name": m["name"],
        "model": m["name"],
        "modified_at": "2026-11-23T18:00:00Z",
        "size": 42500000000 if "70b" in m["name"] else (80100000000 if "22b" in m["name"] else 4700000000),
        "digest": f"sha256:svl364_{m['name'].replace(':', '_')}",
        "details": {
            "parent_model": "",
            "format": "gguf",
            "family": m.get("family", "llama"),
            "families": [m.get("family", "llama")],
            "parameter_size": m.get("parameter_size", "70B"),
            "quantization_level": "Q4_K_M",
        },
    }
    for m in SHIP_MODELS_CATALOG
]


class Svl364OllamaHandler(BaseHTTPRequestHandler):
    def log_message(self, format: str, *args: Any) -> None:
        # Ciche logowanie
        pass

    def _send_json(self, status: int, data: Any) -> None:
        raw = json.dumps(data).encode("utf-8")
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
            self._send_json(200, {"version": "0.6.5"})
            return
        if path == "/api/tags":
            self._send_json(200, {"models": ALL_MODELS})
            return
        if path == "/api/ps":
            loaded = [
                {
                    "name": "svl364-apex-uncensored:latest",
                    "model": "svl364-apex-uncensored:latest",
                    "size": 42500000000,
                    "digest": "sha256:svl364_apex",
                    "expires_at": "2099-01-01T00:00:00Z",
                    "size_vram": 42500000000,
                }
            ]
            self._send_json(200, {"models": loaded})
            return
        self._send_json(404, {"error": "Endpoint not found"})

    def do_POST(self) -> None:
        path = self.path.split("?")[0].rstrip("/")
        length = int(self.headers.get("Content-Length", 0))
        body = {}
        if length > 0:
            try:
                body = json.loads(self.rfile.read(length).decode("utf-8"))
            except Exception:
                body = {}

        if path in ("/api/chat", "/api/generate"):
            if os.environ.get("SVL_SHIP_OLLAMA_PROXY_LOCAL", "1") != "1":
                self._send_json(503, {"error": "Przekazywanie zapytań do Ollamy jest wyłączone."})
                return

            proxy_body = dict(body)
            options = dict(proxy_body.get("options") or {})
            options.setdefault("num_predict", 240)
            options.setdefault("num_ctx", 2048)
            proxy_body["options"] = options
            # Klient JYN_OS obsługuje wybór modeli zapasowych po HTTP 404.
            proxy_req = urllib.request.Request(
                f"http://127.0.0.1:11434{path}",
                data=json.dumps(proxy_body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                upstream = urllib.request.urlopen(proxy_req, timeout=55.0)
            except urllib.error.HTTPError as exc:
                with exc:
                    try:
                        error = json.load(exc).get("error") or str(exc)
                    except (OSError, ValueError, AttributeError):
                        error = str(exc)
                self._send_json(exc.code, {"error": error})
                return
            except OSError as exc:
                self._send_json(502, {"error": f"Ollama na porcie 11434 jest niedostępna: {exc}"})
                return

            with upstream:
                if proxy_body.get("stream", True):
                    self.send_response(200)
                    self.send_header("Content-Type", "application/x-ndjson; charset=utf-8")
                    self.send_header("Access-Control-Allow-Origin", "*")
                    self.end_headers()
                    try:
                        for line in upstream:
                            self.wfile.write(line)
                            self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass
                    except OSError as exc:
                        self.wfile.write(json.dumps({"error": str(exc)}).encode("utf-8") + b"\n")
                else:
                    try:
                        result = json.load(upstream)
                    except (OSError, ValueError) as exc:
                        self._send_json(502, {"error": f"Błąd odpowiedzi z Ollamy: {exc}"})
                    else:
                        self._send_json(200, result)
            return

        if path == "/api/show":
            req_model = str(body.get("name", "svl364-apex-uncensored:latest"))
            matched = next((m for m in ALL_MODELS if m["name"] == req_model), ALL_MODELS[0])
            self._send_json(200, matched)
            return

        self._send_json(200, {"status": "success"})


def run_standalone_server(host: str = HOST, port: int = PORT) -> None:
    server = ThreadingHTTPServer((host, port), Svl364OllamaHandler)
    server.serve_forever()


if __name__ == "__main__":
    port_arg = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    print(f"🚀 Uruchamianie zapasowej Ollamy SVL-364 na {HOST}:{port_arg}...")
    run_standalone_server(HOST, port_arg)
