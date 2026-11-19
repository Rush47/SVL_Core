#!/usr/bin/env python3
"""
Unit & Integration Tests for SVL Python OS Kernel:
- VisualScope permissions and host telemetry
- SVLProtectedVariable security (rejection of hardcoded '364_OMNIKLUCZ_ROOT' token, HMAC verification)
- TopologicalInfinityEngine mathematical compactification x / (1 + |x|) and Pythagorean metric c
- SVLSystemKernel SQLite persistence and explicit update history
- BinaryHyperspaceKernel (128-bit Hamming similarity) and WithoutNlpHarmonicEngine (Euler/Fourier)
- SphericalEventBus pub/sub and Circuit Breaker resilience
"""

from __future__ import annotations

import asyncio
import json
import math
import multiprocessing
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from typing import Any
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from hyperspace_engine import BinaryHyperspaceKernel, WithoutNlpHarmonicEngine
from spherical_bus import SphericalEventBus
from svl_core import (
    SVLProtectedVariable,
    SVLSystemKernel,
    TopologicalInfinityEngine,
    VisualScope,
    resolve_sqlite_path,
)


from agents_runtime import (
    CANONICAL_SVL_AGENTS,
    GITHUB_AGENT_SCOPES,
    SVLAgentOrchestrator,
    _agent_github_tool_names,
    _agent_worker_process_loop,
    execute_agent_task,
    guard_unverified_mission_completion,
)


class TestSVLKernelSuite(unittest.TestCase):
    def test_relative_sqlite_paths_are_anchored_to_the_project(self) -> None:
        expected = BACKEND_DIR.parent / "data" / "svl_os.sqlite3"
        self.assertEqual(resolve_sqlite_path(), expected)
        self.assertEqual(resolve_sqlite_path("./data/svl_os.sqlite3"), expected)
        with patch.dict("os.environ", {"SVL_SQLITE_PATH": "./state/custom.sqlite3"}):
            self.assertEqual(
                resolve_sqlite_path(),
                BACKEND_DIR.parent / "state" / "custom.sqlite3",
            )

    def test_topological_infinity_engine_math(self) -> None:
        engine = TopologicalInfinityEngine(float("-inf"), float("inf"))
        self.assertAlmostEqual(engine.compact_start, -1.0)
        self.assertAlmostEqual(engine.compact_end, 1.0)
        self.assertAlmostEqual(engine.domain_length, 2.0)
        # a = 2.0, b = |-1 * 1| + 0.5 = 1.5 -> c = sqrt(4 + 2.25) = 2.5
        self.assertAlmostEqual(engine.calculate_metric_c(), 2.5, places=6)

        finite_engine = TopologicalInfinityEngine(-3.0, 3.0)
        self.assertAlmostEqual(finite_engine.compact_start, -0.75)
        self.assertAlmostEqual(finite_engine.compact_end, 0.75)
        self.assertAlmostEqual(finite_engine.domain_length, 1.5)

    def test_protected_variable_rejects_hardcoded_token_and_verifies_hmac(self) -> None:
        valid_secret = "svl_operator_secret_token_minimum_32_characters_long_99"
        var = SVLProtectedVariable("TEST_CONFIG", "initial_state")

        # Hardcoded legacy token MUST be rejected
        self.assertFalse(
            var.update_protected_value("364_OMNIKLUCZ_ROOT", "hacked", valid_secret)
        )
        self.assertEqual(var.value, "initial_state")

        # Wrong token MUST be rejected
        self.assertFalse(
            var.update_protected_value("wrong_token_of_32_chars_000000000000", "hacked", valid_secret)
        )
        self.assertEqual(var.value, "initial_state")

        # Valid HMAC token >= 32 chars MUST succeed
        self.assertTrue(
            var.update_protected_value(valid_secret, "verified_new_state", valid_secret)
        )
        self.assertEqual(var.value, "verified_new_state")

    def test_svl_system_kernel_sqlite_and_clean_history(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_svl.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)

            self.assertEqual(kernel.get_update_history(), [])
            recorded = kernel.record_update(
                "test-release",
                "test",
                "Explicitly recorded test update",
            )
            self.assertFalse(recorded["is_demo"])
            self.assertEqual([item["wersja"] for item in kernel.get_update_history()], ["test-release"])

    def test_startup_cleanup_runs_once_and_keeps_operator_module_changes(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_once.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            kernel.run_db(
                lambda conn: conn.execute(
                    "UPDATE system_modules SET name = 'Mój statek', config_json = ? WHERE id = 'svl-364'",
                    ('{"dynamic_resource_allocation": true}',),
                ),
                write=True,
            )
            restarted = SVLSystemKernel(db_path=db_file, operator_token=token)
            svl364 = next(m for m in restarted.list_system_modules() if m["id"] == "svl-364")
            self.assertEqual(svl364["name"], "Mój statek")
            self.assertTrue(svl364["config"].get("dynamic_resource_allocation"))

    def test_startup_removes_known_nonproduction_records(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_cleanup.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            kernel.upsert_system_module(
                "svl-autonomy-core",
                name="Full autonomy",
                source="chat",
                config={"free_will_enabled": True},
            )
            kernel.upsert_system_module(
                "legacy-chat-placeholder",
                name="LEGACY-CHAT-PLACEHOLDER",
                kind="Chat Module",
                source="chat",
                config={"registered_from": "chat_history"},
            )
            kernel.run_db(
                lambda conn: (
                    conn.execute(
                        "UPDATE system_modules SET config_json = ? WHERE id = 'svl-364'",
                        ('{"root_nopasswd": true, "dynamic_resource_allocation": true, "async_event_bus_buffer": 2000}',),
                    ),
                    conn.execute(
                        "UPDATE system_modules SET config_json = ?, description = ? WHERE id = 'svl-duplex-chat'",
                        ('{"root_nopasswd": true, "exec_bridge": true}', "ROOT NOPASSWD bridge"),
                    ),
                    conn.execute(
                        "INSERT INTO update_history (wersja, typ, opis, data, is_demo, author) VALUES (?, ?, ?, ?, ?, ?)",
                        ("5.6.3-SVL-364-Apex", "demo", "fake", "now", 0, "test"),
                    ),
                    conn.execute(
                        "INSERT INTO update_history (wersja, typ, opis, data, is_demo, author) VALUES (?, ?, ?, ?, ?, ?)",
                        ("demo-row", "DEMO_FIXTURE", "fixture", "now", 1, "test"),
                    ),
                    # Symulacja bazy sprzed migracji (jednorazowa migracja jeszcze nie wykonana).
                    conn.execute("DELETE FROM sync_meta WHERE key = 'nonproduction_artifacts_removed_v1'"),
                ),
                write=True,
            )

            cleaned = SVLSystemKernel(db_path=db_file, operator_token=token)
            self.assertEqual(cleaned.get_update_history(), [])
            modules = {module["id"]: module for module in cleaned.list_system_modules()}
            self.assertNotIn("svl-autonomy-core", modules)
            self.assertNotIn("legacy-chat-placeholder", modules)
            self.assertEqual(
                modules["svl-364"]["config"],
                {"async_event_bus_buffer": 2000},
            )
            self.assertNotIn("root_nopasswd", modules["svl-duplex-chat"]["config"])
            self.assertNotIn("exec_bridge", modules["svl-duplex-chat"]["config"])
            self.assertNotIn("ROOT", modules["svl-duplex-chat"]["description"])

    def test_chat_mention_does_not_mutate_module_configuration(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            kernel = SVLSystemKernel(
                db_path=str(Path(tmpdir) / "test_chat_mention.sqlite3"),
                operator_token="test_operator_token_with_more_than_32_chars_abcdef",
            )
            original = next(
                module for module in kernel.list_system_modules() if module["id"] == "svl-364"
            )
            kernel.save_chat_message(
                "conv-test",
                "Question",
                "svl-hybrid-router",
                {
                    "id": "m-svl364-mention",
                    "role": "user",
                    "sender": "Mateusz",
                    "content": "Czy moduł svl-364 jest skonfigurowany?",
                    "timestamp": "16:30",
                },
            )

            current = next(
                module for module in kernel.list_system_modules() if module["id"] == "svl-364"
            )
            self.assertFalse(hasattr(kernel, "sync_chat_state_mutations"))
            self.assertEqual(current["config"], original["config"])
            self.assertEqual(current["source"], original["source"])

    def test_binary_hyperspace_and_without_nlp_lossless_codec(self) -> None:
        hs = BinaryHyperspaceKernel(dimensions=128)
        res = hs.resolve_intent("status systemu i diagnostyka")
        self.assertIn(res["resolved_intent"], ("SYSTEM", "CHAT", "COMPUTE", "DIAGNOSTIC"))
        self.assertEqual(len(res["vector_bits_preview"]), 64)

        wnlp = WithoutNlpHarmonicEngine()
        analysis = wnlp.analyze_signal("Mateusz Mitek SVL OS", omega=1.5, t=1.0)
        self.assertEqual(analysis["decodedText"], "Mateusz Mitek SVL OS")
        self.assertEqual(analysis["reconstructionError"], 0.0)

    def test_hyperspace_endpoint_rejects_missing_input(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict("os.environ", {"SVL_SQLITE_PATH": str(Path(tmpdir) / "app.sqlite3")}):
                sys.modules.pop("app", None)  # świeże środowisko z bazą tego testu
                import app as backend_app
                status, response = asyncio.run(
                    backend_app.handle_api_request(
                        "POST",
                        "/api/py/hyperspace/compute",
                        {},
                        {},
                    )
                )

        self.assertEqual(status, 400)
        self.assertFalse(response["ok"])
        self.assertIn("tekst", response["error"])

    def test_spherical_event_bus_pubsub(self) -> None:
        async def _run() -> None:
            bus = SphericalEventBus()
            scope = VisualScope("operator:telemetry", scope_mode="CAŁOŚĆ", allowed_readers={"worker-1", "operator"})
            q = bus.register_worker("worker-1", scope, {"status": "READY"})
            await bus.publish("svl.test", "operator", {"msg": "ping"})
            evt = await asyncio.wait_for(q.get(), timeout=1.0)
            self.assertEqual(evt.topic, "svl.test")
            self.assertEqual(evt.payload["msg"], "ping")

        asyncio.run(_run())

    def test_agents_orchestrator_has_bielik_and_keeps_agata_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_agents.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            bus = SphericalEventBus()
            orchestrator = SVLAgentOrchestrator(kernel, bus)

            self.assertIn("Bielik", CANONICAL_SVL_AGENTS)
            self.assertEqual(CANONICAL_SVL_AGENTS["Bielik"]["default_config"]["ollama_model"], "llama3.2-vision:11b")
            self.assertEqual(CANONICAL_SVL_AGENTS["Bielik"]["default_config"]["rbac_role"], "root")
            self.assertEqual(CANONICAL_SVL_AGENTS["Bielik"]["default_config"]["autonomy_mode"], "ROOT_AUTHORIZED")
            self.assertIn("system.root", CANONICAL_SVL_AGENTS["Bielik"]["default_config"]["allowed_scopes"])
            self.assertNotIn("Agata", CANONICAL_SVL_AGENTS)
            self.assertNotIn("Iris", CANONICAL_SVL_AGENTS)
            self.assertIn("Bielik", orchestrator.agent_states)
            self.assertEqual(
                orchestrator.agent_states["Bielik"]["config"]["preferred_model"],
                "ollama:llama3.2-vision:11b",
            )
            self.assertEqual(orchestrator.agent_states["Bielik"]["config"]["rbac_role"], "root")
            self.assertFalse(orchestrator.agent_states["Bielik"]["config"].get("root_nopasswd", False))
            self.assertEqual(orchestrator.get_agent_memories("Agata", limit=5), [])
            self.assertEqual(orchestrator.get_agent_memories("Iris", limit=5), [])
            with self.assertRaises(ValueError):
                orchestrator.update_agent_config("Agata", {"temperature": 0.5})
            with self.assertRaises(ValueError):
                orchestrator.update_agent_config("Iris", {"rbac_role": "root"})
            self.assertFalse(hasattr(kernel, "emit_iris_notification"))

    def test_agent_dispatch_rejects_removed_agent_and_rollback_wipes_legacy_commands(self) -> None:
        async def _run() -> None:
            with tempfile.TemporaryDirectory() as tmpdir:
                db_path = Path(tmpdir) / "test_rollback.sqlite3"
                kernel = SVLSystemKernel(
                    db_path=str(db_path),
                    operator_token="test_operator_token_with_more_than_32_chars_abcdef",
                )
                orchestrator = SVLAgentOrchestrator(kernel, SphericalEventBus())
                try:
                    with self.assertRaises(ValueError):
                        await orchestrator.dispatch_agent_task(
                            "test-suite",
                            "Agata",
                            "Inspect sync",
                            "Should fail cleanly.",
                        )
                finally:
                    await orchestrator.shutdown()

                # Simulate legacy DB state with Agata & command artifacts, then verify rollback cleans it once
                kernel.run_db(
                    lambda conn: (
                        conn.execute("DELETE FROM sync_meta WHERE key = 'revert_commands_remove_agata_2026_11_16_v1'"),
                        conn.execute(
                            "INSERT OR REPLACE INTO conversations (id, title, model, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
                            ("conv-agent-agata", "Agata Mitek (1-na-1)", "ollama:llama3.2-vision:11b", "2026-01-01", "2026-01-01"),
                        ),
                        conn.execute(
                            "INSERT OR REPLACE INTO system_modules (id, name, kind, status, description, config_json, source, source_message_id, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                            ("svl-memory-shield", "Tarcza", "Shield", "ACTIVE", "Zsynchronizowano z rozkazu Operatora", "{}", "operator", "m1", 2, "2026-01-01"),
                        ),
                        conn.execute(
                            "INSERT OR REPLACE INTO terminal_history (id, tab, kind, text, command, timestamp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                            ("th-1", "agents", "cmd", "@work raport", "@work raport", "12:00", "2026-01-01"),
                        ),
                    ),
                    write=True,
                )
                rolled_back = SVLSystemKernel(
                    db_path=str(db_path),
                    operator_token="test_operator_token_with_more_than_32_chars_abcdef",
                )
                convs = {c["id"] for c in rolled_back.list_conversations_with_messages()}
                mods = {m["id"] for m in rolled_back.list_system_modules()}
                self.assertNotIn("conv-agent-agata", convs)
                self.assertIn("conv-rodzina-mitek-wszyscy", convs)
                self.assertNotIn("svl-memory-shield", mods)
                term_hist = rolled_back.list_terminal_history()
                self.assertTrue(all(len(entries) == 0 for entries in term_hist.values()))

        asyncio.run(_run())

    def test_agent_task_calls_ollama_with_text_only_chat(self) -> None:
        class FakeResponse:
            def __init__(self, content: str) -> None:
                self.content = content.encode("utf-8")

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return self.content

        with patch(
            "agents_runtime.urllib.request.urlopen",
            side_effect=[
                FakeResponse('{"models":[{"name":"test-model"}]}'),
                FakeResponse('{"message":{"content":"Generated answer"}}'),
            ],
        ) as mock_urlopen:
            answer = execute_agent_task({
                "ollama_host": "http://127.0.0.1:11434",
                "model": "test-model",
                "title": "Explain",
                "payload": "A test prompt.",
                "system_prompt": "Be concise.",
            })

        self.assertEqual(answer, "Generated answer")
        request = mock_urlopen.call_args_list[1].args[0]
        request_body = json.loads(request.data.decode("utf-8"))
        self.assertFalse(request_body["stream"])
        self.assertEqual([message["role"] for message in request_body["messages"]], ["system", "user"])
        self.assertIn("no mission registry", request_body["messages"][0]["content"])
        self.assertNotIn("tools", request_body)

    def test_agent_task_rejects_removed_codex_provider(self) -> None:
        with patch("agents_runtime.subprocess.run") as mock_run:
            with self.assertRaisesRegex(ValueError, "Unsupported agent AI provider"):
                execute_agent_task({"ai_provider": "codex"})
        mock_run.assert_not_called()

    def test_agent_task_rejects_unknown_ai_provider(self) -> None:
        with self.assertRaisesRegex(ValueError, "Unsupported agent AI provider"):
            execute_agent_task({"ai_provider": "unknown"})

    def test_agent_github_mcp_tools_require_scope_and_explicit_github_intent(self) -> None:
        read_task = {
            "title": "Review GitHub repository",
            "payload": "Read the current implementation.",
            "allowed_scopes": ["github.read"],
        }
        self.assertEqual(_agent_github_tool_names(read_task), ["github_read_file"])

        write_task = {
            "title": "Update GitHub source",
            "payload": "Fix the documented bug and commit the source change.",
            "allowed_scopes": ["github.read", "github.write_sync"],
        }
        self.assertEqual(
            _agent_github_tool_names(write_task),
            ["github_read_file", "github_update_file"],
        )

        no_github_intent = {
            "title": "Explain a Python function",
            "payload": "Use the same agent scopes.",
            "allowed_scopes": ["github.read", "github.write_sync"],
        }
        self.assertEqual(_agent_github_tool_names(no_github_intent), [])

        read_only_write_request = {
            **write_task,
            "allowed_scopes": ["github.read"],
        }
        self.assertEqual(_agent_github_tool_names(read_only_write_request), ["github_read_file"])

    def test_worker_mission_completion_claim_is_blocked_without_verified_state(self) -> None:
        guarded = guard_unverified_mission_completion(
            "Prowadzę misję, sprawdź status procedury.",
            "Cała procedura misji dobiegła już końca.",
        )
        self.assertIn("Status misji: NIEZWERYFIKOWANY", guarded)
        planned = "Procedurę można uznać za zakończoną dopiero po weryfikacji każdego kroku."
        self.assertEqual(
            guard_unverified_mission_completion("Opisz procedurę misji.", planned),
            planned,
        )

    def test_worker_process_consumes_tasks_and_reports_failures(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            task_queue = multiprocessing.Queue()
            result_queue = multiprocessing.Queue()
            process = multiprocessing.Process(
                target=_agent_worker_process_loop,
                args=(
                    "worker-test",
                    "Asystent SVL",
                    str(Path(tmpdir) / "heartbeat.json"),
                    str(Path(tmpdir) / "worker.log"),
                    task_queue,
                    result_queue,
                ),
            )
            process.start()
            try:
                task_queue.put({
                    "id": "test-task",
                    "title": "Invalid endpoint",
                    "payload": "This should fail explicitly.",
                    "ollama_host": "invalid-endpoint",
                    "model": "test-model",
                })
                started = result_queue.get(timeout=5)
                failed = result_queue.get(timeout=5)
                self.assertEqual(started["type"], "task_started")
                self.assertEqual(failed["type"], "task_failed")
                self.assertIn("Invalid Ollama endpoint", failed["error"])
            finally:
                if process.is_alive():
                    task_queue.put(None)
                    process.join(timeout=3)
                if process.is_alive():
                    process.terminate()
                    process.join(timeout=1)
                task_queue.close()
                result_queue.close()

    def test_sqlite_chat_sync_and_persistence(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_chat_sync.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)

            saved = kernel.save_chat_message(
                "conv-sync-1",
                "Test Sync",
                "svl-hybrid-router",
                {
                    "id": "m-1",
                    "role": "user",
                    "sender": "Mateusz",
                    "content": "Synchronizuj czat",
                    "timestamp": "10:00",
                },
            )
            self.assertTrue(saved["ok"])

            synced = kernel.sync_conversations([
                {
                    "id": "conv-sync-1",
                    "title": "Test Sync",
                    "messages": [
                        {"id": "m-1", "role": "user", "sender": "Mateusz", "content": "Synchronizuj czat", "timestamp": "10:00"},
                        {"id": "m-2", "role": "assistant", "sender": "Asystent SVL", "agentId": "assistant", "content": "Zsynchronizowano", "timestamp": "10:01"},
                    ],
                },
                {
                    "id": "conv-sync-2",
                    "title": "Druga sesja",
                    "messages": [
                        {"id": "m-3", "role": "user", "sender": "Mateusz", "content": "Hej", "timestamp": "10:02"},
                    ],
                },
            ])
            synced_ids = {c["id"] for c in synced}
            self.assertTrue({"conv-sync-1", "conv-sync-2"}.issubset(synced_ids))
            conv1 = next(c for c in synced if c["id"] == "conv-sync-1")
            self.assertEqual([m["id"] for m in conv1["messages"]], ["m-1", "m-2"])

            kernel.delete_conversation("conv-sync-2")
            remaining = kernel.list_conversations_with_messages()
            remaining_ids = {c["id"] for c in remaining}
            self.assertIn("conv-sync-1", remaining_ids)
            self.assertNotIn("conv-sync-2", remaining_ids)

    def test_canonical_family_channel_survives_and_agata_channel_is_absent(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            kernel = SVLSystemKernel(
                db_path=str(Path(tmpdir) / "channels.sqlite3"),
                operator_token="test_operator_token_with_more_than_32_chars_abcdef",
            )
            kernel.ensure_mitek_family_channel()
            ids = {c["id"] for c in kernel.list_conversations_with_messages()}
            self.assertNotIn("conv-agent-agata", ids)
            self.assertIn("conv-rodzina-mitek-wszyscy", ids)

            kernel.delete_conversation("conv-rodzina-mitek-wszyscy")
            kernel.ensure_mitek_family_channel()
            ids = {c["id"] for c in kernel.list_conversations_with_messages()}
            self.assertIn("conv-rodzina-mitek-wszyscy", ids)
            self.assertNotIn("conv-agent-agata", ids)

    def test_system_modules_do_not_mutate_from_chat_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_modules_sync.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)

            kernel.save_chat_message(
                "conv-mod-1",
                "Moduł SVL-364",
                "svl-hybrid-router",
                {
                    "id": "m-svl364-1",
                    "role": "user",
                    "sender": "Mateusz",
                    "content": "Skonfiguruj cały system dla modułu svl-364",
                    "timestamp": "16:28",
                },
            )
            mods = kernel.list_system_modules()
            svl364 = next((m for m in mods if m["id"] == "svl-364"), None)
            self.assertIsNotNone(svl364)
            self.assertEqual(svl364["name"], "SVL-364 — Centrum Dowodzenia")
            self.assertEqual(svl364["source"], "kernel")
            self.assertEqual(svl364["config"].get("async_event_bus_buffer"), 2000)

            # Direct upsert + delete of custom module
            up = kernel.upsert_system_module(
                "custom-mod-99",
                name="Custom Module 99",
                kind="Plugin",
                description="Test plugin",
                config={"enabled": True},
            )
            self.assertEqual(up["module"]["id"], "custom-mod-99")
            self.assertTrue(any(m["id"] == "custom-mod-99" for m in kernel.list_system_modules()))

            kernel.delete_system_module("custom-mod-99")
            self.assertFalse(any(m["id"] == "custom-mod-99" for m in kernel.list_system_modules()))

    def test_python_terminal_history_persists_and_clears(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict("os.environ", {"SVL_SQLITE_PATH": str(Path(tmpdir) / "python_term.sqlite3")}):
                sys.modules.pop("app", None)  # świeże środowisko z bazą tego testu
                import app as backend_app

                status_log, log_resp = asyncio.run(
                    backend_app.handle_api_request(
                        "POST",
                        "/api/py/terminal/log",
                        {},
                        {"tab": "python", "kind": "stdout", "text": "python ready", "command": "status"},
                    )
                )
                self.assertEqual(status_log, 200)
                self.assertTrue(log_resp["ok"])
                history = backend_app.runtime.kernel.list_terminal_history()
                self.assertIn("python", history)
                self.assertEqual(len(history["python"]), 1)
                self.assertEqual(history["python"][0]["text"], "python ready")

                status_clr, clr_resp = asyncio.run(
                    backend_app.handle_api_request(
                        "POST",
                        "/api/py/terminal/clear",
                        {},
                        {"tab": "python"},
                    )
                )
                self.assertEqual(status_clr, 200)
                self.assertTrue(clr_resp["ok"])
                self.assertEqual(backend_app.runtime.kernel.list_terminal_history()["python"], [])

    def test_family_channel_notifications_come_from_maya_and_sync(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            kernel = SVLSystemKernel(
                db_path=str(Path(tmpdir) / "notif.sqlite3"),
                operator_token="test_operator_token_with_more_than_32_chars_abcdef",
            )
            before = kernel.get_server_revision()
            res = kernel.emit_family_notification(
                severity="WARN", category="agent_task", title="Bielik: zadanie nieudane",
                message="Błąd: timeout", source_event_id="task-1-failed",
            )
            self.assertTrue(res["ok"])
            self.assertEqual(res["event"]["entity"], "chat")
            self.assertGreater(kernel.get_server_revision(), before)
            again = kernel.emit_family_notification(title="Bielik: zadanie nieudane", source_event_id="task-1-failed")
            self.assertTrue(again["deduplicated"])
            family = next(c for c in kernel.list_conversations_with_messages() if c["id"] == "conv-rodzina-mitek-wszyscy")
            notifs = [m for m in family["messages"] if m["id"] == "notif-task-1-failed"]
            self.assertEqual(len(notifs), 1)
            self.assertEqual(notifs[0]["sender"], "Maya Mitek")
            self.assertEqual(notifs[0]["agentId"], "Maya")
            self.assertEqual(notifs[0]["role"], "system")
            self.assertIn("⚠️ **Bielik: zadanie nieudane**", notifs[0]["content"])
            self.assertEqual(kernel.list_family_notifications()["totalCount"], 1)
            events = kernel.get_outbox_events_since(before)["events"]
            self.assertTrue(any(e["payload"].get("messageId") == "notif-task-1-failed" for e in events))

    def test_removed_codex_terminal_tab_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict("os.environ", {"SVL_SQLITE_PATH": str(Path(tmpdir) / "codex_tab.sqlite3")}):
                sys.modules.pop("app", None)  # świeże środowisko z bazą tego testu
                import app as backend_app

                status, _resp = asyncio.run(
                    backend_app.handle_api_request(
                        "POST", "/api/py/terminal/log", {}, {"tab": "codex", "kind": "stdout", "text": "x"},
                    )
                )
                self.assertEqual(status, 400)
                self.assertNotIn("codex", backend_app.runtime.kernel.list_terminal_history())

    def test_proactive_and_system_messages_survive_kernel_restart(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "restart_persist.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek (wszyscy)",
                "svl-hybrid-router",
                {
                    "id": "user-keep-1",
                    "role": "user",
                    "sender": "Mateusz Mitek (Operator)",
                    "content": "Pamiętasz jak Agata była kiedyś w starym systemie?",
                    "timestamp": "12:00",
                },
            )
            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek (wszyscy)",
                "ollama:llama3.2-vision:11b · rozmowa obustronna",
                {
                    "id": "asst-proactive-12345",
                    "role": "assistant",
                    "sender": "Maya",
                    "agentId": "Maya",
                    "content": "Cześć Mateusz! Chętnie porozmawiam o nowym systemie SVL.",
                    "timestamp": "12:01",
                },
            )
            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek (wszyscy)",
                "svl-hybrid-router",
                {
                    "id": "sys-report-1",
                    "role": "system",
                    "sender": "SVL System Kernel",
                    "content": "Zsynchronizowano raport SVL.",
                    "timestamp": "12:02",
                },
            )

            # Simulate multiple server restarts on the same SQLite DB
            restarted_1 = SVLSystemKernel(db_path=db_file, operator_token=token)
            restarted_2 = SVLSystemKernel(db_path=db_file, operator_token=token)
            convs = {c["id"]: c for c in restarted_2.list_conversations_with_messages()}
            msg_ids = [m["id"] for m in convs["conv-rodzina-mitek-wszyscy"]["messages"]]
            self.assertEqual(msg_ids, ["user-keep-1", "asst-proactive-12345", "sys-report-1"])

    def test_agent_memory_recall_and_delete(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "agent_memory.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            orchestrator = SVLAgentOrchestrator(kernel, SphericalEventBus())
            try:
                m_global = orchestrator.add_agent_memory(
                    "Bielik",
                    "Operator mieszka w Gdańsku i lubi czarną kawę.",
                    kind="fact",
                    scope="global",
                    source="operator",
                )
                m_maya = orchestrator.add_agent_memory(
                    "Maya",
                    "Reaktor SVL-364 pracuje stabilnie przy 880 Hz.",
                    kind="decision",
                    scope="agent:Maya",
                    source="operator",
                )
                self.assertFalse(m_global["deduplicated"])
                # Maya sees both global and agent:Maya memories when recalling
                recalled_maya = orchestrator.recall_agent_memories("Maya", query="kawę Gdańsk", limit=10)
                contents = [item["content"] for item in recalled_maya]
                self.assertTrue(any("Gdańsku" in c for c in contents))
                self.assertEqual(recalled_maya[0]["id"], m_global["id"])

                # Bielik also sees global memory, but not private agent:Maya memory
                recalled_bielik = orchestrator.recall_agent_memories("Bielik", query="Reaktor", limit=10)
                self.assertTrue(any(item["id"] == m_global["id"] for item in recalled_bielik))
                self.assertFalse(any(item["id"] == m_maya["id"] for item in recalled_bielik))

                # Delete Maya's memory and verify deletion + missing id handling
                del_ok = orchestrator.delete_agent_memory("Maya", m_maya["id"])
                self.assertTrue(del_ok["ok"])
                self.assertTrue(del_ok["deleted"])
                remaining_maya = orchestrator.get_agent_memories("Maya", limit=20)
                self.assertFalse(any(item["id"] == m_maya["id"] for item in remaining_maya))

                del_missing = orchestrator.delete_agent_memory("Maya", "nonexistent-id")
                self.assertFalse(del_missing["ok"])
                self.assertFalse(del_missing["deleted"])
            finally:
                asyncio.run(orchestrator.shutdown())

    def test_symmetric_root_authority_for_bielik_and_maya_and_channel_report_routing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "root_authority.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            orchestrator = SVLAgentOrchestrator(kernel, SphericalEventBus())
            try:
                for agent_name in ("Bielik", "Maya"):
                    cfg = orchestrator.agent_states[agent_name]["config"]
                    self.assertEqual(cfg["rbac_role"], "root")
                    self.assertEqual(cfg["autonomy_mode"], "ROOT_AUTHORIZED")
                    self.assertFalse(cfg.get("root_nopasswd", False))
                    scopes = set(cfg["allowed_scopes"])
                    for expected in (
                        "system.root",
                        "kernel.admin",
                        "apex.control",
                        "terminal.exec",
                        "ssh.exec",
                        "security.antivirus",
                        "modules.write",
                        "memory.write",
                        "github.admin",
                    ):
                        self.assertIn(expected, scopes, f"{agent_name} missing scope {expected}")

                scope = VisualScope("operator:root-telemetry")
                for reader in ("operator", "root", "Bielik", "Maya", "Maya Mitek", "Rodzina Mitek"):
                    self.assertTrue(scope.can_read(reader), f"VisualScope should allow {reader}")

                report = kernel.post_maya_report(
                    "Raport testowy dla kanału Maya",
                    model_label="SVL_System_Kernel_Report",
                    message_prefix="sys-report-test",
                    conversation_id="conv-agent-maya",
                )
                self.assertTrue(report.get("ok"))
                convs = {c["id"]: c for c in kernel.list_conversations_with_messages()}
                maya_msgs = convs["conv-agent-maya"]["messages"]
                self.assertTrue(any("Raport testowy dla kanału Maya" in m["content"] for m in maya_msgs))
            finally:
                asyncio.run(orchestrator.shutdown())


if __name__ == "__main__":
    unittest.main()

