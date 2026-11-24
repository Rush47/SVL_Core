#!/usr/bin/env python3
"""Testy jednostkowe systemu klienta JYN_OS."""

import unittest
import io
import json
from unittest.mock import patch
from pathlib import Path
import sys

# Dodaj główny katalog do ścieżki importu
current_dir = Path(__file__).resolve().parent
parent_dir = current_dir.parent
if str(parent_dir) not in sys.path:
    sys.path.insert(0, str(parent_dir))

from JYN_OS.config import JynOSConfig, SHIP_MODELS_CATALOG, resolve_auth_token
from JYN_OS.ssh_client import Svl364SshClient
from JYN_OS.ollama_client import SvlOllamaClient
from JYN_OS.mcp_client import SvlMcpClient
from JYN_OS.telemetry import SvlShipTelemetry


class TestJynOSClientSuite(unittest.TestCase):
    def setUp(self):
        self.cfg = JynOSConfig.load_from_env()

    def test_catalog_has_all_13_ship_models(self):
        self.assertEqual(len(SHIP_MODELS_CATALOG), 13)
        names = [m["name"] for m in SHIP_MODELS_CATALOG]
        self.assertIn("svl364-apex-uncensored:latest", names)
        self.assertIn("dolphin-mixtral:8x22b", names)
        self.assertIn("llama3.2-vision:90b", names)
        self.assertIn("llama3.2-vision:11b", names)
        self.assertIn("deepseek-r1:7b", names)
        self.assertIn("qwen2.5-coder:7b", names)

    def test_auth_token_resolver_finds_token(self):
        token = resolve_auth_token("http://127.0.0.1:3000/api/mcp/svl364")
        self.assertTrue(len(token) > 0, "Powinien odnaleźć poprawny token autoryzacji")

    def test_ssh_client_detects_ship_key_and_target(self):
        ssh = Svl364SshClient(self.cfg)
        status = ssh.get_key_status()
        self.assertTrue(status["private_key_exists"])
        self.assertEqual(ssh.config.ssh_profile, "Ship")

    def test_mcp_client_endpoints_defined(self):
        mcp = SvlMcpClient(self.cfg)
        endpoints = mcp.federated_endpoints
        self.assertIn("Universal MCP Hub (Ship 3334)", endpoints)
        self.assertIn("System MCP Gateway (3000/mcp/svl)", endpoints)
        self.assertIn("Ship MCP Gateway (3000/api/mcp/svl364)", endpoints)
        self.assertIn("Backend Python MCP (8085/mcp)", endpoints)

    def test_ollama_client_points_to_backup_ship_port(self):
        ollama = SvlOllamaClient(self.cfg)
        self.assertIn("11435", ollama.config.ship_ollama_url)
        self.assertEqual(ollama.config.ship_model, "svl364-apex-uncensored:latest")

    def test_local_ollama_and_vision_config(self):
        ollama = SvlOllamaClient(self.cfg)
        self.assertIn("11434", ollama.config.local_ollama_url)
        self.assertEqual(ollama.config.active_ollama_target, "local")
        self.assertEqual(ollama.config.get_active_ollama_url(), ollama.config.local_ollama_url)
        self.assertEqual(ollama.config.get_active_model(), "svl364-apex-uncensored:latest")

        ollama.config.set_active_target("ship")
        self.assertEqual(ollama.config.active_ollama_target, "ship")
        self.assertEqual(ollama.config.get_active_ollama_url(), ollama.config.ship_ollama_url)
        self.assertEqual(ollama.config.get_active_model(), "svl364-apex-uncensored:latest")


class TestApexCompleteChat(unittest.TestCase):
    def test_single_nonstreaming_request_and_no_fallback(self):
        cfg = JynOSConfig(local_model="svl364-apex-uncensored:latest", active_ollama_target="local")
        client = SvlOllamaClient(cfg)
        show = {"details": {"parameter_size": "70.6B"}}
        reply = {"message": {"content": "Gotowa odpowiedź"}, "done": True, "eval_count": 12}
        with patch.object(client, "_fetch_live_svl_context", return_value=""), patch(
            "JYN_OS.ollama_client.urllib.request.urlopen",
            side_effect=[io.BytesIO(json.dumps(show).encode()), io.BytesIO(json.dumps(reply).encode())],
        ) as mock:
            result = client.chat("test")
        self.assertTrue(result["success"])
        self.assertEqual(mock.call_count, 2)
        payload = json.loads(mock.call_args.args[0].data)
        self.assertIs(payload["stream"], False)
        self.assertEqual(payload["model"], cfg.local_model)
        self.assertEqual(payload["keep_alive"], -1)
        self.assertEqual(payload["options"]["num_predict"], min(cfg.chat_num_predict, cfg.chat_num_ctx))
        self.assertEqual(payload["options"]["num_ctx"], cfg.chat_num_ctx)
        self.assertEqual(client._candidate_models(cfg.local_model), [cfg.local_model])

    def test_long_reply_and_truncation_metadata(self):
        cfg = JynOSConfig(chat_num_ctx=8192, chat_num_predict=4096, chat_timeout=900)
        client = SvlOllamaClient(cfg)
        long_text = "pełna wypowiedź " * 500
        show = {"details": {"parameter_size": "70B"}}
        reply = {"message": {"content": long_text}, "done": True, "done_reason": "length"}
        with patch("JYN_OS.ollama_client.urllib.request.urlopen",
            side_effect=[io.BytesIO(json.dumps(show).encode()), io.BytesIO(json.dumps(reply).encode())],
        ) as mock:
            result = client.chat("Opowiedz", model="svl364-apex-uncensored:latest")
        self.assertEqual(result["response"], long_text.strip())
        self.assertTrue(result["truncated"])
        self.assertEqual(mock.call_args.kwargs["timeout"], 900)
        payload = json.loads(mock.call_args.args[0].data)
        self.assertEqual(payload["options"]["num_predict"], 4096)
        self.assertFalse(payload["stream"])

    def test_no_system_instructions_and_no_live_context_injection(self):
        client = SvlOllamaClient(JynOSConfig(chat_num_ctx=8192, chat_num_predict=4096))
        previous = "a" * 2000
        with patch.object(client, "_fetch_live_svl_context") as fetch:
            messages = client._build_messages("Dalej", system_prompt="Nie dołączaj tego",
                history=[{"role": "system", "content": "Stara instrukcja"},
                         {"role": "assistant", "content": previous}])
        fetch.assert_not_called()
        self.assertEqual(messages, [{"role": "system", "content": ""},
                                    {"role": "assistant", "content": previous},
                                    {"role": "user", "content": "Dalej"}])

    def test_reject_small_model_disguised_as_apex(self):
        client = SvlOllamaClient(JynOSConfig(local_model="svl364-apex-uncensored:latest", active_ollama_target="local"))
        with patch("JYN_OS.ollama_client.urllib.request.urlopen", return_value=io.BytesIO(
            b'{"details":{"parameter_size":"1.5B"}}'
        )) as mock:
            result = client.chat("test")
        self.assertFalse(result["success"])
        self.assertIn("70B", result["error"])
        self.assertEqual(mock.call_count, 1)


if __name__ == "__main__":
    unittest.main()
