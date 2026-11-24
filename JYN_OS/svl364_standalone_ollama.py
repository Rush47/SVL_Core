#!/usr/bin/env python3
"""
Niezależny serwer zapasowej Ollamy dla statku SVL-364 (Python Standard Library).
Przekazuje żądania do rzeczywistej Ollamy na porcie 11434; nie symuluje modeli.
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from JYN_OS.config import DEFAULT_CHAT_NUM_CTX, DEFAULT_CHAT_NUM_PREDICT, DEFAULT_CHAT_TIMEOUT

PORT = int(os.environ.get("SVL_SHIP_OLLAMA_STANDALONE_PORT", "11435"))
HOST = os.environ.get("SVL_SHIP_OLLAMA_STANDALONE_HOST", "127.0.0.1")

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
        if path in ("", "/api/version", "/api/tags", "/api/ps"):
            endpoint = "/api/version" if not path else path
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:11434{endpoint}", timeout=5.0) as upstream:
                    self._send_json(200, json.load(upstream))
            except urllib.error.HTTPError as exc:
                self._send_json(exc.code, {"error": str(exc)})
            except (OSError, ValueError) as exc:
                self._send_json(502, {"error": f"Ollama :11434 niedostępna: {exc}"})
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
            options.setdefault("num_predict", DEFAULT_CHAT_NUM_PREDICT)
            options.setdefault("num_ctx", DEFAULT_CHAT_NUM_CTX)
            proxy_body["options"] = options
            # Klient JYN_OS obsługuje wybór modeli zapasowych po HTTP 404.
            proxy_req = urllib.request.Request(
                f"http://127.0.0.1:11434{path}",
                data=json.dumps(proxy_body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                upstream = urllib.request.urlopen(proxy_req, timeout=DEFAULT_CHAT_TIMEOUT + 30)
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
            req = urllib.request.Request(
                "http://127.0.0.1:11434/api/show",
                data=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=5.0) as upstream:
                    self._send_json(200, json.load(upstream))
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
    print(f"🚀 Uruchamianie zapasowej Ollamy SVL-364 na {HOST}:{port_arg}...")
    run_standalone_server(HOST, port_arg)
