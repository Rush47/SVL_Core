#!/usr/bin/env python3
"""Testy jednostkowe i regresyjne systemu klienta oraz nowego modułu czatu JYN_OS v3.0."""

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

current_dir = Path(__file__).resolve().parent
parent_dir = current_dir.parent
if str(parent_dir) not in sys.path:
    sys.path.insert(0, str(parent_dir))

from JYN_OS.chat_engine import (
    JynChatEngine,
    build_polish_chat_messages,
    clean_polish_response,
    compute_turn_options,
)
from JYN_OS.config import (
    CANONICAL_MODELS_PRIORITY,
    DEFAULT_SYSTEM_PROMPT_PL,
    SHIP_MODELS_CATALOG,
    JynOSConfig,
    resolve_auth_token,
    select_canonical_base_for_host,
)
from JYN_OS.mcp_client import SvlMcpClient
from JYN_OS.ollama_client import SvlOllamaClient
from JYN_OS.shell import JynOSShell
from JYN_OS.ssh_client import Svl364SshClient
from JYN_OS.svl364_standalone_ollama import _merged_ship_models, _select_execution_candidates


class TestJynOSCanonicalModelsSuite(unittest.TestCase):
    def setUp(self):
        self.cfg = JynOSConfig.load_from_env()

    def test_catalog_has_exact_13_canonical_ship_models_and_no_qwen_1_5b(self):
        self.assertEqual(len(SHIP_MODELS_CATALOG), 13)
        names = [m["name"] for m in SHIP_MODELS_CATALOG]
        self.assertIn("svl364-apex-uncensored:latest", names)
        self.assertIn("dolphin-mixtral:8x22b", names)
        self.assertIn("dolphin-llama3:70b", names)
        self.assertIn("wizard-vicuna-uncensored:30b", names)
        self.assertIn("dolphin-mixtral:8x7b", names)
        self.assertIn("dolphin-llama3:8b-v2.9-q2_K", names)
        self.assertIn("llama3.2-vision:90b", names)
        self.assertIn("llama3.2-vision:11b", names)
        self.assertIn("deepseek-r1:7b", names)
        self.assertIn("qwen2.5:7b", names)
        self.assertIn("qwen2.5-coder:7b", names)
        self.assertIn("llama3:8b", names)
        self.assertIn("mistral:7b", names)
        self.assertNotIn("qwen2.5:1.5b", names)
        self.assertNotIn("qwen2.5:1.5b", CANONICAL_MODELS_PRIORITY)
        self.assertEqual(self.cfg.vision_model, "llama3.2-vision:11b")

    def test_hardware_base_selection_uses_only_canonical_models(self):
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SVL_APEX_BASE_MODEL", None)
            self.assertEqual(select_canonical_base_for_host(8.0), "qwen2.5:7b")
            self.assertEqual(select_canonical_base_for_host(16.0), "llama3.2-vision:11b")
            self.assertEqual(select_canonical_base_for_host(28.0), "wizard-vicuna-uncensored:30b")
            self.assertEqual(select_canonical_base_for_host(36.0), "dolphin-mixtral:8x7b")
            self.assertEqual(select_canonical_base_for_host(64.0), "dolphin-llama3:70b")

    def test_auth_token_resolver_finds_token(self):
        with patch.dict(os.environ, {"SVL_OPERATOR_TOKEN": "test-token"}):
            self.assertEqual(resolve_auth_token("http://127.0.0.1:3000/api/mcp/svl364"), "test-token")

    def test_ssh_client_detects_ship_key_and_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            key = Path(tmp) / "test_key"
            key.touch()
            ssh = Svl364SshClient(JynOSConfig(ssh_key_path=key, ssh_profile="Ship"))
            self.assertTrue(ssh.get_key_status()["private_key_exists"])
            self.assertEqual(ssh.config.ssh_profile, "Ship")

    def test_mcp_client_endpoints_defined(self):
        mcp = SvlMcpClient(self.cfg)
        endpoints = mcp.federated_endpoints
        self.assertIn("Universal MCP Hub (Ship 3334)", endpoints)
        self.assertIn("System MCP Gateway (3000/mcp/svl)", endpoints)
        self.assertIn("Ship MCP Gateway (3000/api/mcp/svl364)", endpoints)
        self.assertIn("Backend Python MCP (8085/mcp)", endpoints)

    def test_ollama_endpoints_and_target_switching(self):
        ollama = SvlOllamaClient(self.cfg)
        self.assertIn("11435", ollama.config.ship_ollama_url)
        self.assertIn("11434", ollama.config.local_ollama_url)
        self.assertFalse(ollama.config.chat_stream_enabled)
        self.assertEqual(ollama.config.get_active_model(), "svl364-apex-uncensored:latest")

        ollama.config.set_active_target("ship")
        self.assertEqual(ollama.config.active_ollama_target, "ship")
        self.assertEqual(ollama.config.get_active_ollama_url(), ollama.config.ship_ollama_url)


class TestRebuiltNonStreamingPolishChatModule(unittest.TestCase):
    def test_strict_nonstreaming_request_and_polish_system_prompt(self):
        cfg = JynOSConfig(local_model="svl364-apex-uncensored:latest", active_ollama_target="local")
        client = SvlOllamaClient(cfg)
        reply = {
            "message": {"content": "Melduję pełną gotowość systemów pokładowych, Mateuszu."},
            "done": True,
            "eval_count": 14,
            "eval_duration": 700_000_000,
        }
        with patch(
            "JYN_OS.ollama_client.urllib.request.urlopen",
            return_value=io.BytesIO(json.dumps(reply, ensure_ascii=False).encode("utf-8")),
        ) as mock:
            result = client.chat("Zamelduj status")

        self.assertTrue(result["success"])
        self.assertEqual(mock.call_count, 1)
        payload = json.loads(mock.call_args.args[0].data.decode("utf-8"))
        self.assertIs(payload["stream"], False)
        self.assertEqual(payload["model"], "svl364-apex-uncensored:latest")
        self.assertEqual(payload["keep_alive"], -1)
        self.assertEqual(payload["messages"][0]["role"], "system")
        self.assertIn("polszczyzną", payload["messages"][0]["content"])
        self.assertIn("Jyn Mitek", payload["messages"][0]["content"])

    def test_adaptive_fast_turn_options(self):
        cfg = JynOSConfig(chat_num_ctx=2048, chat_num_predict=384)
        with patch.dict(os.environ, {}, clear=False):
            os.environ.pop("SVL_CHAT_NUM_PREDICT", None)
            short_opts = compute_turn_options("Cześć Jyn!", cfg)
            self.assertLessEqual(short_opts["num_predict"], 192)
            self.assertEqual(short_opts["num_ctx"], 2048)

            detailed_opts = compute_turn_options("Napisz skrypt w Pythonie i podaj szczegółowy raport architektury", cfg)
            self.assertGreaterEqual(detailed_opts["num_predict"], 768)
            self.assertEqual(detailed_opts["num_ctx"], 2048)

    def test_clean_polish_response_strips_think_and_role_prefixes(self):
        raw = "<think>Analyzing in English...</think>\n[Jyn Mitek]: Sprawdziłam telemetrię statku, Mateuszu.\nUser: kolejne pytanie"
        self.assertEqual(clean_polish_response(raw), "Sprawdziłam telemetrię statku, Mateuszu.")

    def test_chat_engine_slash_commands_and_session_memory(self):
        cfg = JynOSConfig()
        client = SvlOllamaClient(cfg)
        engine = JynChatEngine(config=cfg, ollama=client)

        cat_res = engine.send("/modele")
        self.assertTrue(cat_res.ok)
        self.assertTrue(cat_res.local_command)
        self.assertIn("dolphin-mixtral:8x22b", cat_res.reply)
        self.assertIn("qwen2.5:7b", cat_res.reply)

        reply = {
            "message": {"content": "Wszystkie 13 modeli pokładowych jest aktywnych, Mateuszu."},
            "done": True,
            "eval_count": 12,
            "eval_duration": 500_000_000,
        }
        with patch(
            "JYN_OS.ollama_client.urllib.request.urlopen",
            return_value=io.BytesIO(json.dumps(reply, ensure_ascii=False).encode("utf-8")),
        ):
            turn = engine.send("Jakie modele działają?")
        self.assertTrue(turn.ok)
        self.assertEqual(len(engine.history), 2)

        clr = engine.send("/wyczysc")
        self.assertTrue(clr.ok)
        self.assertEqual(engine.history, [])

    def test_svl364_ship_node_exposes_all_13_models_and_routes_to_installed(self):
        with patch(
            "JYN_OS.svl364_standalone_ollama._fetch_upstream_models",
            return_value=[{"name": "svl364-apex-uncensored:latest"}, {"name": "qwen2.5:7b"}],
        ):
            merged = _merged_ship_models()
        self.assertEqual(len(merged), 13)
        cands = _select_execution_candidates(
            "dolphin-mixtral:8x22b",
            ["svl364-apex-uncensored:latest", "qwen2.5:7b"],
        )
        self.assertEqual(cands[0], "svl364-apex-uncensored:latest")
        self.assertIn("qwen2.5:7b", cands)


class TestRuntimeRegression(unittest.TestCase):
    def test_single_word_chat_and_eof(self):
        shell = JynOSShell(JynOSConfig())
        with patch.object(shell, "_run_complete_chat", return_value=True) as run:
            self.assertIsNone(shell.default("Cześć"))
            run.assert_called_once_with("Cześć")
        self.assertTrue(shell.do_EOF(""))

    def test_chat_interrupt_does_not_exit_shell_or_write_history(self):
        shell = JynOSShell(JynOSConfig())
        with patch.object(shell.chat_engine, "send", side_effect=KeyboardInterrupt):
            self.assertFalse(shell._run_complete_chat("Cześć"))
        self.assertEqual(shell.chat_history, [])

    def test_model_pull_error_not_success(self):
        client = SvlOllamaClient(JynOSConfig())
        with patch("JYN_OS.ollama_client.urllib.request.urlopen", return_value=io.BytesIO(b'{"error":"disk full"}')):
            result = client.pull_model("qwen2.5:7b")
        self.assertFalse(result["success"])
        self.assertIn("disk full", result["error"])

    def test_chat_rejects_partial_and_null(self):
        client = SvlOllamaClient(JynOSConfig())
        for reply in ({"message": {"content": None}, "done": True},
                      {"message": {"content": "partial"}, "done": False}):
            with patch(
                "JYN_OS.ollama_client.urllib.request.urlopen",
                return_value=io.BytesIO(json.dumps(reply).encode()),
            ):
                self.assertFalse(client.chat("test", model="qwen2.5:7b", url="http://127.0.0.1:11434")["success"])

    def test_target_alias_normalized(self):
        cfg = JynOSConfig(active_ollama_target=" SVL364 ")
        self.assertEqual(cfg.active_ollama_target, "ship")
        self.assertEqual(cfg.get_active_ollama_url(), cfg.ship_ollama_url)

    def test_build_polish_messages_preserves_custom_system_prompt(self):
        cfg = JynOSConfig()
        msgs = build_polish_chat_messages("Raport", cfg, system_prompt="Niestandardowa instrukcja PL")
        self.assertEqual(msgs[0], {"role": "system", "content": "Niestandardowa instrukcja PL"})
        self.assertEqual(DEFAULT_SYSTEM_PROMPT_PL[:6], "Jesteś")


if __name__ == "__main__":
    unittest.main()
