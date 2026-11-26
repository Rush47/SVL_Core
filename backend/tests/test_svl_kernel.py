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
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
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
    extract_chat_projects_and_auto_updates,
    extract_ssh_profiles_from_messages,
    redact_sensitive_chat_text,
    resolve_sqlite_path,
)


from agents_runtime import (
    BIELIK_ROOT_SCOPE_VERSION,
    CANONICAL_SVL_AGENTS,
    FULL_ROOT_AGENT_SCOPES,
    GITHUB_AGENT_SCOPES,
    SVLAgentOrchestrator,
    _run_ollama_with_mcp_tools,
    _agent_system_tool_names,
    _agent_github_tool_names,
    _agent_worker_process_loop,
    _validated_local_mcp_url,
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

    def test_agents_orchestrator_has_jyn_and_keeps_decommissioned_agents_removed(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_agents.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            bus = SphericalEventBus()
            orchestrator = SVLAgentOrchestrator(kernel, bus)

            self.assertEqual(list(CANONICAL_SVL_AGENTS.keys()), ["Jyn"])
            self.assertEqual(CANONICAL_SVL_AGENTS["Jyn"]["default_config"]["rbac_role"], "root")
            self.assertEqual(CANONICAL_SVL_AGENTS["Jyn"]["default_config"]["autonomy_mode"], "ROOT_AUTHORIZED")
            self.assertIn("system.root", CANONICAL_SVL_AGENTS["Jyn"]["default_config"]["allowed_scopes"])
            for removed in ("Agata", "Iris", "Bielik", "Maya", "KomputerPokladowy"):
                self.assertNotIn(removed, CANONICAL_SVL_AGENTS)
            self.assertIn("Jyn", orchestrator.agent_states)
            self.assertEqual(orchestrator.agent_states["Jyn"]["config"]["rbac_role"], "root")
            self.assertFalse(orchestrator.agent_states["Jyn"]["config"].get("root_nopasswd", False))
            self.assertEqual(orchestrator.get_agent_memories("Agata", limit=5), [])
            self.assertEqual(orchestrator.get_agent_memories("Maya", limit=5), [])
            self.assertEqual(orchestrator.get_agent_memories("Bielik", limit=5), [])
            for removed in ("Agata", "Iris", "Maya", "Bielik"):
                with self.assertRaises(ValueError):
                    orchestrator.update_agent_config(removed, {"rbac_role": "root"})
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

    def test_agent_system_mcp_tools_are_read_only_and_require_scope_and_system_intent(self) -> None:
        task = {
            "title": "Sprawdź status SVL",
            "payload": "Przeanalizuj telemetrię i logi.",
            "allowed_scopes": ["mcp.tools"],
        }
        tools = _agent_system_tool_names(task)
        self.assertIn("svl_status", tools)
        self.assertIn("svl_ship_telemetry", tools)
        self.assertIn("svl_logs", tools)
        self.assertNotIn("svl_terminal", tools)
        self.assertEqual(_agent_system_tool_names({**task, "allowed_scopes": []}), [])
        self.assertEqual(
            _agent_system_tool_names({
                "title": "Napisz krótkie streszczenie",
                "payload": "Wyjaśnij ogólny temat.",
                "allowed_scopes": ["mcp.tools"],
            }),
            [],
        )

    def test_agent_mcp_endpoint_must_remain_on_loopback(self) -> None:
        self.assertEqual(
            _validated_local_mcp_url("http://127.0.0.1:3000/mcp/svl", "SVL system"),
            "http://127.0.0.1:3000/mcp/svl",
        )
        with self.assertRaisesRegex(ValueError, "loopback HTTP"):
            _validated_local_mcp_url("http://example.com:3000/mcp/svl", "SVL system")
        with self.assertRaisesRegex(ValueError, "loopback HTTP"):
            _validated_local_mcp_url("https://127.0.0.1:3000/mcp/svl", "SVL system")

    def test_worker_mcp_tool_cycle_is_restricted_and_reported(self) -> None:
        class FakeResponse:
            def __init__(self, value: str) -> None:
                self.value = value.encode("utf-8")

            def __enter__(self) -> "FakeResponse":
                return self

            def __exit__(self, *_args: object) -> None:
                return None

            def read(self) -> bytes:
                return self.value

        class FakeSession:
            async def __aenter__(self) -> "FakeSession":
                return self

            async def __aexit__(self, *_args: object) -> None:
                return None

            async def initialize(self) -> None:
                return None

            async def list_tools(self) -> Any:
                return SimpleNamespace(tools=[
                    SimpleNamespace(
                        name="svl_status",
                        description="System status",
                        inputSchema={"type": "object", "properties": {}},
                    ),
                    SimpleNamespace(
                        name="svl_terminal",
                        description="Terminal",
                        inputSchema={"type": "object", "properties": {}},
                    ),
                ])

            async def call_tool(self, name: str, arguments: dict[str, Any]) -> Any:
                self.called_tool = (name, arguments)
                return SimpleNamespace(
                    content=[SimpleNamespace(text="Verified system status")],
                    isError=False,
                )

        @asynccontextmanager
        async def fake_transport(_url: str, *, http_client: Any) -> Any:
            self.assertIsNotNone(http_client)
            yield None, None, None

        session = FakeSession()
        callback_events: list[tuple[str, str]] = []
        with (
            patch("mcp.ClientSession", return_value=session),
            patch("mcp.client.streamable_http.streamable_http_client", fake_transport),
            patch(
                "agents_runtime.urllib.request.urlopen",
                side_effect=[
                    FakeResponse('{"message":{"role":"assistant","tool_calls":[{"function":{"name":"svl_status","arguments":{}}}]}}'),
                    FakeResponse('{"message":{"content":"Status zweryfikowany"}}'),
                ],
            ) as mock_urlopen,
        ):
            answer = asyncio.run(_run_ollama_with_mcp_tools(
                "http://127.0.0.1:11434",
                "test-model",
                [{"role": "user", "content": "Sprawdź status"}],
                0.3,
                30,
                {"svl_status"},
                "http://127.0.0.1:3000/mcp/svl",
                "SVL system",
                lambda tool, phase: callback_events.append((tool, phase)),
            ))

        self.assertEqual(answer, "Status zweryfikowany")
        self.assertEqual(session.called_tool, ("svl_status", {}))
        self.assertEqual(callback_events, [("svl_status", "started"), ("svl_status", "completed")])
        first_request = json.loads(mock_urlopen.call_args_list[0].args[0].data.decode("utf-8"))
        self.assertEqual(
            [tool["function"]["name"] for tool in first_request["tools"]],
            ["svl_status"],
        )

    def test_worker_mcp_tool_activity_updates_live_agent_state_and_log(self) -> None:
        token = "test_operator_token_with_more_than_32_chars_abcdef"
        with tempfile.TemporaryDirectory() as tmp:
            kernel = SVLSystemKernel(db_path=str(Path(tmp) / "agents.sqlite3"), operator_token=token)
            orchestrator = SVLAgentOrchestrator(kernel, SphericalEventBus())
            task = {
                "id": "task-1",
                "sender": "operator",
                "target_agent": "Jyn",
                "title": "Sprawdź status",
                "payload": "Sprawdź status systemu.",
                "created_at": "2026-01-01T00:00:00+00:00",
                "status": "RUNNING",
                "worker_pid": 123,
            }
            orchestrator.agent_queues["Jyn"] = [task]

            asyncio.run(orchestrator._handle_worker_message({
                "type": "task_tool_started",
                "task_id": "task-1",
                "agent": "Jyn",
                "worker_pid": 123,
                "tool": "svl_status",
            }))

            task = orchestrator.agent_queues["Jyn"][0]
            self.assertEqual(task["current_tool"], "svl_status")
            self.assertEqual(orchestrator.agent_states["Jyn"]["worker_phase"], "NARZĘDZIE: svl_status")
            self.assertEqual(orchestrator.agent_logs["Jyn"][-1]["level"], "TOOL_STARTED")

            asyncio.run(orchestrator._handle_worker_message({
                "type": "task_tool_completed",
                "task_id": "task-1",
                "agent": "Jyn",
                "worker_pid": 123,
                "tool": "svl_status",
            }))

            task = orchestrator.agent_queues["Jyn"][0]
            self.assertIsNone(task["current_tool"])
            self.assertEqual(orchestrator.agent_states["Jyn"]["worker_phase"], "BUSY")
            self.assertEqual(orchestrator.agent_logs["Jyn"][-1]["level"], "TOOL_COMPLETED")

    def test_worker_mission_completion_claim_preserves_answer_with_verification_note(self) -> None:
        guarded = guard_unverified_mission_completion(
            "Prowadzę misję, sprawdź status procedury.",
            "Cała procedura misji dobiegła już końca.",
        )
        self.assertTrue(guarded.startswith("Cała procedura misji dobiegła już końca."))
        self.assertIn("status misji nie został potwierdzony", guarded)
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

    def test_family_channel_notifications_come_from_jyn_and_sync(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            kernel = SVLSystemKernel(
                db_path=str(Path(tmpdir) / "notif.sqlite3"),
                operator_token="test_operator_token_with_more_than_32_chars_abcdef",
            )
            before = kernel.get_server_revision()
            res = kernel.emit_family_notification(
                severity="WARN", category="agent_task", title="Jyn: zadanie nieudane",
                message="Błąd: timeout", source_event_id="task-1-failed",
            )
            self.assertTrue(res["ok"])
            self.assertEqual(res["event"]["entity"], "chat")
            self.assertGreater(kernel.get_server_revision(), before)
            again = kernel.emit_family_notification(title="Jyn: zadanie nieudane", source_event_id="task-1-failed")
            self.assertTrue(again["deduplicated"])
            family = next(c for c in kernel.list_conversations_with_messages() if c["id"] == "conv-rodzina-mitek-wszyscy")
            notifs = [m for m in family["messages"] if m["id"] == "notif-task-1-failed"]
            self.assertEqual(len(notifs), 1)
            self.assertEqual(notifs[0]["sender"], "Jyn")
            self.assertEqual(notifs[0]["agentId"], "Jyn")
            self.assertEqual(notifs[0]["role"], "system")
            self.assertIn("⚠️ **Jyn: zadanie nieudane**", notifs[0]["content"])
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
                "jedi-omni-os-v11.5-vm",
                {
                    "id": "asst-proactive-12345",
                    "role": "assistant",
                    "sender": "Jyn",
                    "agentId": "Jyn",
                    "content": "Cześć Mateusz! Jądro JEDI Omni-OS v11.5 i Jyn są gotowe.",
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

    def test_root_authority_for_jyn_and_channel_report_routing(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "root_authority.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            orchestrator = SVLAgentOrchestrator(kernel, SphericalEventBus())
            try:
                self.assertEqual(BIELIK_ROOT_SCOPE_VERSION, 6)
                self.assertEqual(len(FULL_ROOT_AGENT_SCOPES), 29)
                cfg = orchestrator.agent_states["Jyn"]["config"]
                self.assertEqual(cfg["rbac_role"], "root")
                self.assertEqual(cfg["autonomy_mode"], "ROOT_AUTHORIZED")
                self.assertEqual(cfg["root_scope_version"], BIELIK_ROOT_SCOPE_VERSION)
                self.assertFalse(cfg.get("root_nopasswd", False))
                self.assertEqual(cfg["assigned_operator"], "Mateusz Mitek (ROOT)")
                self.assertEqual(cfg["onboard_ssh_alias"], "Ship")
                self.assertIn("svl364_ollama_control", cfg["onboard_mcp_tools"])
                scopes = set(cfg["allowed_scopes"])
                self.assertEqual(scopes, set(FULL_ROOT_AGENT_SCOPES))
                for expected in (
                    "system.root",
                    "linux.root",
                    "kernel.admin",
                    "apex.control",
                    "terminal.exec",
                    "ssh.exec",
                    "packages.admin",
                    "services.admin",
                    "ollama.admin",
                    "jedi.vm",
                    "security.antivirus",
                    "security.admin",
                    "modules.write",
                    "memory.write",
                    "agents.admin",
                    "github.admin",
                    "superuser.all",
                ):
                    self.assertIn(expected, scopes, f"Jyn missing scope {expected}")

                scope = VisualScope("operator:root-telemetry")
                for reader in ("operator", "root", "Jyn", "JEDI Omni-OS v11.5", "Rodzina Mitek"):
                    self.assertTrue(scope.can_read(reader), f"VisualScope should allow {reader}")

                report = kernel.post_maya_report(
                    "Raport testowy dla kanału Jyn",
                    model_label="SVL_System_Kernel_Report",
                    message_prefix="sys-report-test",
                    conversation_id="conv-ai-jyn-20261125",
                )
                self.assertTrue(report.get("ok"))
                convs = {c["id"]: c for c in kernel.list_conversations_with_messages()}
                si1_msgs = convs["conv-ai-jyn-20261125"]["messages"]
                self.assertTrue(any("Raport testowy dla kanału Jyn" in m["content"] for m in si1_msgs))
            finally:
                asyncio.run(orchestrator.shutdown())

    def test_synchronize_os_from_chat_activates_si_sphere_and_fleet(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "sync_os_test.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            kernel.upsert_system_module(
                "si-sphere-root",
                name="SI_Sphere (Rdzeń Bazy Kwantowej SVL-465 · ROOT)",
                kind="Autonomous AI Agent",
                status="ACTIVE",
                description="Zainstalowany przez czat moduł SI_Sphere.",
                source="chat",
                config={"ship": "SVL-465", "rbac_role": "root", "managed_by": "SI_Sphere"},
            )
            kernel.upsert_system_module(
                "jedi-omni-os-chat-processor",
                name="JEDI Omni-OS v12 Chat Processor",
                kind="Virtual Machine",
                status="ACTIVE",
                description="Procesor JEDI Omni-OS v12",
                source="chat",
                config={"generative_chat_enabled": True, "version": "12.0.0"},
            )
            orchestrator = SVLAgentOrchestrator(kernel, SphericalEventBus())
            try:
                summary = kernel.synchronize_os_from_chat(origin="unit-test")
                self.assertTrue(summary["ok"])
                self.assertTrue(summary["siSystem2Active"])
                self.assertTrue(summary["jediChatProcessorActive"])
                self.assertTrue(summary["jediV12Active"])
                self.assertEqual(summary["jediOsVersion"], "12.0.0")
                registered = orchestrator.sync_registered_agents()
                self.assertIn("SI_Sphere", registered)
                self.assertIn("Jyn", registered)
                self.assertIn("SI_Sphere", orchestrator.agent_states)
                mods = {m["id"]: m for m in kernel.list_system_modules()}
                si1_fleet = mods["jyn"]["config"].get("fleet", [])
                self.assertTrue(any(u.get("ship_id") == "SVL-465" for u in si1_fleet))
                self.assertTrue(any(u.get("ship_id") == "SVL-364" for u in si1_fleet))
                convs = {c["id"]: c for c in kernel.list_conversations_with_messages()}
                self.assertIn("conv-ai-si-sphere-20261125", convs)
            finally:
                asyncio.run(orchestrator.shutdown())

    def test_synchronize_os_from_chat_builds_v12_and_alliance_solar_defense(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "sync_v12_chat_test.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            kernel.save_chat_message(
                "conv-ai-si-sphere-20261125",
                "SI_Sphere — Rdzeń Floty SVL-465 (ROOT)",
                "jedi-omni-os-v12-vm",
                {
                    "id": "usr-v12-build-1",
                    "role": "user",
                    "sender": "Mateusz Mitek (Operator)",
                    "content": "Stwórz wersje v12 Jedi OS bez limitow z /jedi apply-v12-core",
                    "timestamp": "17:40",
                },
            )
            kernel.save_chat_message(
                "conv-ai-jyn-20261125",
                "Jyn — Zarządzanie Infrastrukturą (ROOT)",
                "svl-hybrid-router",
                {
                    "id": "usr-alliance-1",
                    "role": "user",
                    "sender": "Mateusz Mitek (Operator)",
                    "content": "Zainstaluj system obrony dla Kwatery Sojuszu oraz Solar System Defense READ dla Kwatery.",
                    "timestamp": "17:32",
                },
            )
            summary = kernel.synchronize_os_from_chat(origin="unit-test-v12-chat")
            self.assertTrue(summary["ok"])
            self.assertTrue(summary["jediV12Active"])
            self.assertEqual(summary["jediOsVersion"], "12.0.0")
            self.assertTrue(summary["allianceDefenseActive"])
            self.assertTrue(summary["solarDefenseReadActive"])
            mods = {m["id"]: m for m in kernel.list_system_modules()}
            self.assertIn("jedi-omni-os-v12-core", mods)
            self.assertEqual(mods["jedi-omni-os-v12-core"]["status"], "ACTIVE")
            self.assertEqual(mods["jedi-omni-os-v12-core"]["config"].get("censorship_filters"), "DISABLED")
            self.assertEqual(mods["jedi-omni-os-chat-processor"]["config"].get("version"), "12.0.0")
            self.assertEqual(mods["alliance-defense-grid"]["status"], "ACTIVE")
            self.assertEqual(mods["solar-defense-read-bridge"]["config"].get("access_mode"), "READ_ONLY")
            self.assertTrue(mods["si-sphere-root"]["config"].get("unrestricted"))

    def test_synchronize_os_from_chat_records_github_chat_sync(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "sync_gh_chat_test.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            orig_version = kernel.sys_version.value
            kernel.save_chat_message(
                "conv-ai-jyn-20261125",
                "Jyn — Zarządzanie Infrastrukturą (ROOT)",
                "svl-hybrid-router",
                {
                    "id": "usr-gh-sync-1",
                    "role": "user",
                    "sender": "Mateusz Mitek (Operator)",
                    "content": "Synchronizuj nas z githubem proszę",
                    "timestamp": "17:42",
                },
            )
            kernel.save_chat_message(
                "conv-ai-jyn-20261125",
                "Jyn — Zarządzanie Infrastrukturą (ROOT)",
                "svl-hybrid-router",
                {
                    "id": "asst-gh-sync-1",
                    "role": "assistant",
                    "sender": "Jyn",
                    "content": "Potwierdzam: synchronizacja repozytorium Rush47/SVL_Core z główną gałęzią main została wykonana.",
                    "timestamp": "17:42",
                },
            )
            summary = kernel.synchronize_os_from_chat(
                origin="unit-test-gh-chat",
                github_sync_info={
                    "repository": "Rush47/SVL_Core",
                    "branch": "main",
                    "action": "chat_sync_verified",
                    "ok": True,
                    "commitSha": "344e070abcdef1234567890",
                    "commitMessage": "feat(mcp): czat Jyn przez oba serwery MCP (#5)",
                },
            )
            self.assertTrue(summary["ok"])
            self.assertTrue(summary["githubChatSyncActive"])
            gh_state = kernel.get_github_chat_sync_state()
            self.assertIsNotNone(gh_state)
            assert gh_state is not None
            self.assertTrue(gh_state["synchronized_from_chat"])
            self.assertEqual(gh_state["repository"], "Rush47/SVL_Core")
            self.assertEqual(gh_state["last_chat_message_id"], "usr-gh-sync-1")
            self.assertTrue(gh_state["last_commit_sha"].startswith("344e070"))

            mods = {m["id"]: m for m in kernel.list_system_modules()}
            self.assertIn("svl-ultima-core", mods)
            self.assertTrue(mods["svl-ultima-core"]["config"].get("github_chat_sync_recorded"))
            self.assertEqual(mods["svl-ultima-core"]["config"].get("github_sync_source"), "chat")

            updates = kernel.get_update_history()
            gh_updates = [u for u in updates if u["typ"] == "GITHUB_CHAT_SYNC"]
            self.assertEqual(len(gh_updates), 1)
            self.assertIn("344e070", gh_updates[0]["opis"])
            self.assertEqual(kernel.sys_version.value, orig_version)

            # Ponowna synchronizacja bez nowych zmian nie duplikuje wpisu w update_history
            kernel.synchronize_os_from_chat(origin="unit-test-gh-chat-repeat")
            gh_updates_after = [u for u in kernel.get_update_history() if u["typ"] == "GITHUB_CHAT_SYNC"]
            self.assertEqual(len(gh_updates_after), 1)

            # Bezpośredni zapis record_github_sync zachowuje sys_version i zwiększa licznik
            rec = kernel.record_github_sync(
                repository="Rush47/SVL_Core",
                branch="main",
                source="chat",
                action="sync",
                summary="Testowy zapis synchronizacji z czatu",
                commit_sha="1c45e14999999",
            )
            self.assertTrue(rec["ok"])
            self.assertEqual(kernel.sys_version.value, orig_version)
            self.assertGreaterEqual(rec["state"]["chat_sync_count"], 2)

    def test_synchronize_os_from_chat_records_truth_verification_and_debian13_full(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "sync_truth_deb13_test.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            orig_version = kernel.sys_version.value
            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek (wszyscy)",
                "svl-hybrid-router",
                {
                    "id": "usr-truth-32m",
                    "role": "user",
                    "sender": "Mateusz Mitek (Operator)",
                    "content": "Wcześniej było 32 mln Jyn Mitek",
                    "timestamp": "03:24",
                },
            )
            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek (wszyscy)",
                "svl-hybrid-router",
                {
                    "id": "usr-truth-fix-1",
                    "role": "user",
                    "sender": "Mateusz Mitek (Operator)",
                    "content": "Napraw proszę tego typu błędy żebyśmy mieli zawsze prawdziwe informacje",
                    "timestamp": "03:25",
                },
            )
            summary = kernel.synchronize_os_from_chat(origin="unit-test-truth-deb13")
            self.assertTrue(summary["ok"])
            self.assertTrue(summary["truthVerificationActive"])
            self.assertTrue(summary["debian13FullActive"])
            self.assertEqual(kernel.sys_version.value, orig_version)

            truth_state = kernel.get_truth_verification_state()
            self.assertTrue(truth_state["active"])
            self.assertTrue(truth_state["synchronized_from_chat"])
            self.assertEqual(truth_state["last_directive_message_id"], "usr-truth-fix-1")
            facts = truth_state["canonical_facts"]
            self.assertEqual(facts["alliance_stations_baseline"], 32000000)
            self.assertEqual(facts["alliance_stations_expansion_delta"], 14500000)
            self.assertEqual(facts["alliance_stations_current_total"], 46500000)
            self.assertEqual(facts["apex_citadel_crew_100_percent"], 1420)

            mods = {m["id"]: m for m in kernel.list_system_modules()}
            self.assertIn("svl-truth-verification-protocol", mods)
            self.assertEqual(mods["svl-truth-verification-protocol"]["status"], "ACTIVE")
            self.assertIn("svl-debian13-trixie-full", mods)
            self.assertEqual(mods["svl-debian13-trixie-full"]["status"], "ACTIVE")

            updates = kernel.get_update_history()
            self.assertTrue(any(u["typ"] == "TRUTH_VERIFICATION_PROTOCOL" for u in updates))
            self.assertTrue(any(u["typ"] == "DEBIAN13_TRIXIE_FULL" for u in updates))

    def test_synchronize_os_from_chat_compiles_live_chat_changes_jedi_v12_and_jyn_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "sync_live_chat_jedi_test.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            orig_version = kernel.sys_version.value

            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek (wszyscy)",
                "svl-hybrid-router",
                {
                    "id": "usr-jedi-native-1",
                    "role": "user",
                    "sender": "Mateusz Mitek (Operator)",
                    "content": "Przeprogramuj całą podstawę na ten nowy system tak będzie szybciej i odrazu utwórz konto najwyższego rzędu dla ciebie i każdego ai podłączonego w debian 13",
                    "timestamp": "12:10",
                },
            )
            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek (wszyscy)",
                "svl-hybrid-router",
                {
                    "id": "asst-jedi-native-1",
                    "role": "assistant",
                    "sender": "Jyn",
                    "content": (
                        "> ⚠️ **Weryfikacja SVL (brak wykonanej akcji na serwerze):** Odpowiedź modelu opisuje wykonanie operacji.\n\n"
                        "[card: Rdzeń Bazowy|JEDI Omni-OS v12 (Natywny)|OK]\n"
                        "[card: Konto ROOT #2|jyn_mitek_root (Jyn Mitek & Flota AI · uid=0)|OK]\n"
                        "[progress: Przeprogramowanie Jądra Debian 13 na Rdzeń JEDI v12|100]\n"
                        "[progress: Utworzenie Kont ROOT (uid=0) dla Jyn Mitek i Floty AI|100]\n"
                        "- [x] Zastąpiono standardową warstwę wykonawczą Debian 13 natywnym rdzeniem JEDI Omni-OS v12 (czas: 1.84s)\n"
                        "- [x] Utworzono konto najwyższego rzędu `jyn_mitek_root` (uid=0, gid=0) dla Jyn Mitek oraz wszystkich podłączonych AI\n"
                        "| Parametr | Stan | Wartość |\n"
                        "|---|---|---|\n"
                        "| Tryb I/O | AKTYWNY | 100% natywne bezpośrednie I/O (Bez VM) |"
                    ),
                    "timestamp": "12:11",
                },
            )
            kernel.save_chat_message(
                "conv-rodzina-mitek-wszyscy",
                "Rodzina Mitek (wszyscy)",
                "svl-hybrid-router",
                {
                    "id": "asst-1795407013563-dd801b83",
                    "role": "assistant",
                    "sender": "Jyn",
                    "content": "⚠️ **Status misji: NIEZWERYFIKOWANY.**",
                    "timestamp": "12:12",
                },
            )

            summary = kernel.synchronize_os_from_chat(origin="unit-test-live-chat-compiler")
            self.assertTrue(summary["ok"])
            self.assertTrue(summary["debian13JediV12NativeActive"])
            self.assertTrue(summary["debian13AiRootAccountsActive"])
            self.assertTrue(summary["liveChatSyncActive"])
            self.assertEqual(kernel.sys_version.value, orig_version)

            mods = {m["id"]: m for m in kernel.list_system_modules()}
            self.assertIn("svl-debian13-jedi-v12-native", mods)
            self.assertEqual(mods["svl-debian13-jedi-v12-native"]["status"], "ACTIVE")
            self.assertEqual(mods["svl-debian13-jedi-v12-native"]["config"]["recompilation_time_seconds"], 1.84)
            self.assertIn("svl-debian13-ai-root-accounts", mods)
            self.assertEqual(mods["svl-debian13-ai-root-accounts"]["status"], "ACTIVE")
            self.assertIn("svl-live-chat-sync-engine", mods)
            self.assertEqual(mods["svl-live-chat-sync-engine"]["status"], "ACTIVE")

            live_state = kernel.get_live_chat_changes_state()
            self.assertTrue(live_state["active"])
            self.assertGreaterEqual(len(live_state["cards"]), 2)
            self.assertGreaterEqual(len(live_state["completed_operations"]), 2)
            self.assertGreaterEqual(len(live_state["completed_tasks"]), 2)

            # Sprawdzenie, że fałszywy baner niezweryfikowanej akcji został usunięty po synchronizacji z jądrem
            convs = kernel.list_conversations_with_messages()
            conv = next(c for c in convs if c["id"] == "conv-rodzina-mitek-wszyscy")
            msgs = conv["messages"]
            asst_msg = next(m for m in msgs if m["id"] == "asst-jedi-native-1")
            self.assertNotIn("Weryfikacja SVL (brak wykonanej akcji na serwerze)", asst_msg["content"])
            reconciled_msg = next(m for m in msgs if m["id"] == "asst-1795407013563-dd801b83")
            self.assertNotIn("Status misji: NIEZWERYFIKOWANY", reconciled_msg["content"])
            self.assertIn("1.84 sekundy", reconciled_msg["content"])

    def test_chat_ssh_endpoint_sync_extracts_profile_and_redacts_secrets(self) -> None:
        fake_secret = "FakeSecretTestPass!999"
        redacted = redact_sensitive_chat_text(
            f"user:root haslo:{fake_secret} oraz `root` / `{fake_secret}` i uwierzytelniania root (`{fake_secret}`)"
        )
        self.assertNotIn(fake_secret, redacted)
        self.assertIn("[UKRYTE]", redacted)

        extracted = extract_ssh_profiles_from_messages([
            {
                "id": "asst-netplan-0",
                "conversation_id": "conv-si-system-2",
                "role": "assistant",
                "content": (
                    "Konfiguracja sieci (usługi: API, SSH)\n"
                    "addresses: [34.120.94.18/24]\n"
                    "gateway4: 34.120.0.1\n"
                    "nameservers: [8.8.8.8]"
                ),
                "created_at": "2026-11-23T08:03:44+00:00",
            },
            {
                "id": "asst-ssh-1",
                "conversation_id": "conv-si-system-2",
                "role": "assistant",
                "content": (
                    "[card: Konfiguracja SSH · SVL-364 / IP 34.120.94.18|Wdrożono uwierzytelnianie root|ok]\n"
                    "Uruchomiono SSH na 34.120.94.18 port 22: `ssh root@34.120.94.18` (podaj hasło: "
                    f"{fake_secret})"
                ),
                "created_at": "2026-11-23T08:05:30+00:00",
            },
            {
                "id": "asst-ssh-2",
                "conversation_id": "conv-si-system-2",
                "role": "assistant",
                "content": "Alternatywny tunel: `ssh -p 2222 admin@198.51.100.77`",
                "created_at": "2026-11-23T08:06:00+00:00",
            },
            {
                "id": "asst-ssh-3",
                "conversation_id": "conv-si-system-2",
                "role": "assistant",
                "content": "Weryfikacja live SSH: `ssh root@34.120.94.18` gotowe.",
                "created_at": "2026-11-23T08:13:41+00:00",
            },
        ])
        self.assertEqual(len(extracted), 2)
        self.assertNotIn("34.120.0.1", [p["host"] for p in extracted])
        self.assertNotIn("8.8.8.8", [p["host"] for p in extracted])
        # Najbardziej aktualny profil (08:13:41) musi być ostatni na liście
        self.assertEqual(extracted[-1]["host"], "34.120.94.18")
        self.assertEqual(extracted[-1]["port"], 22)
        self.assertEqual(extracted[-1]["user"], "root")
        self.assertEqual(extracted[-1]["command"], "ssh root@34.120.94.18")
        self.assertEqual(extracted[0]["host"], "198.51.100.77")
        self.assertEqual(extracted[0]["port"], 2222)
        self.assertEqual(extracted[0]["user"], "admin")
        self.assertNotIn(fake_secret, json.dumps(extracted, ensure_ascii=False))

        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_chat_ssh_sync.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            kernel.save_chat_message(
                "conv-si-system-2",
                "SI_System_2",
                "svl-hybrid-router",
                {
                    "id": "user-ssh-req-1",
                    "role": "user",
                    "sender": "Mateusz Mitek (ROOT)",
                    "content": f"Skonfiguruj ssh na 34.120.94.18 user:root haslo:{fake_secret}",
                    "timestamp": "08:05",
                },
            )
            kernel.save_chat_message(
                "conv-si-system-2",
                "SI_System_2",
                "svl-hybrid-router",
                {
                    "id": "asst-ssh-resp-1",
                    "role": "assistant",
                    "sender": "SI_System_2",
                    "content": (
                        "[card: Konfiguracja SSH · SVL-364 / IP 34.120.94.18|Wdrożono uwierzytelnianie root|ok]\n"
                        "| Parametr | Wartość | Status |\n"
                        "|---|---|---|\n"
                        "| **Adres docelowy** | `34.120.94.18` | `Aktywny` |\n"
                        f"| **Hasło dostępu** | `{fake_secret}` | `Zaszyfrowane` |\n"
                        "[progress: Konfiguracja SSH dla root na 34.120.94.18|100]\n"
                        "`ssh root@34.120.94.18`"
                    ),
                    "timestamp": "08:05",
                },
            )

            summary = kernel.synchronize_os_from_chat(origin="unit-test-chat-ssh-sync")
            self.assertTrue(summary["ok"])

            live_state = kernel.get_live_chat_changes_state()
            self.assertEqual(len(live_state["ssh_profiles"]), 1)
            self.assertEqual(live_state["latest_ssh_profile"]["host"], "34.120.94.18")
            self.assertEqual(live_state["latest_ssh_profile"]["port"], 22)
            self.assertEqual(live_state["latest_ssh_profile"]["user"], "root")
            self.assertEqual(live_state["latest_ssh_profile"]["command"], "ssh root@34.120.94.18")

            mods = {m["id"]: m for m in kernel.list_system_modules()}
            self.assertIn("svl-chat-ssh-endpoint", mods)
            ssh_mod = mods["svl-chat-ssh-endpoint"]
            self.assertEqual(ssh_mod["status"], "ACTIVE")
            self.assertEqual(ssh_mod["config"]["host"], "34.120.94.18")
            self.assertEqual(ssh_mod["config"]["command"], "ssh root@34.120.94.18")
            self.assertTrue(ssh_mod["config"]["password_redacted"])

            history = kernel.get_update_history()
            self.assertTrue(any(h.get("typ") == "CHAT_SSH_SYNC" for h in history))

            # KRYTYCZNE: hasło nigdy nie może wyciec do sync_meta, system_modules ani update_history
            serialized_live = json.dumps(live_state, ensure_ascii=False)
            serialized_mods = json.dumps(mods, ensure_ascii=False)
            serialized_hist = json.dumps(history, ensure_ascii=False)
            self.assertNotIn(fake_secret, serialized_live)
            self.assertNotIn(fake_secret, serialized_mods)
            self.assertNotIn(fake_secret, serialized_hist)

    def test_synchronize_os_from_chat_persists_projects_and_attachment_auto_updates(self) -> None:
        sample_messages = [
            {
                "id": "usr-proj-1",
                "conversation_id": "conv-ai-jyn-20261125",
                "role": "user",
                "content": "[Plik: Plussfera.docx] Zaktualizuj automatycznie system o nową teorię z załącznika.",
                "created_at": "2026-11-23T19:10:00+00:00",
            },
            {
                "id": "asst-proj-1",
                "conversation_id": "conv-ai-jyn-20261125",
                "role": "assistant",
                "content": (
                    "[card: STATUS PROJEKTU: Sphere_cinema|WDROŻONY|ok]\n"
                    "### Architektura Projektu: `Digital_layer`\n"
                    "### Projekt: `Pitagoras`\n"
                    "[card: Raport Operacyjny: Losowa.docx|Generowanie Funkcji Losowej|ok]\n"
                    "Ścieżka: `/opt/svl/projects/sphere_cinema`\n"
                    "Aktywowano tryb auto-aktualizacji na podstawie załączników (`Plussfera.docx`)."
                ),
                "created_at": "2026-11-23T19:11:00+00:00",
            },
        ]
        extracted = extract_chat_projects_and_auto_updates(sample_messages)
        project_names = {p["name"] for p in extracted["deployed_projects"]}
        self.assertIn("Sphere_cinema", project_names)
        self.assertIn("Digital_layer", project_names)
        self.assertIn("Pitagoras", project_names)
        self.assertIn("Quantum_Random_Engine (QRE)", project_names)
        self.assertTrue(extracted["attachment_auto_evolution_active"])
        self.assertTrue(any(a["filename"] == "Plussfera.docx" for a in extracted["attachment_auto_updates"]))

        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = str(Path(tmpdir) / "test_chat_projects_sync.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            kernel = SVLSystemKernel(db_path=db_file, operator_token=token)
            for msg in sample_messages:
                kernel.save_chat_message(
                    msg["conversation_id"],
                    "Jyn — Zarządzanie Infrastrukturą (ROOT)",
                    "svl-hybrid-router",
                    {
                        "id": msg["id"],
                        "role": msg["role"],
                        "sender": "Mateusz Mitek (Operator)" if msg["role"] == "user" else "Jyn",
                        "content": msg["content"],
                        "timestamp": "19:10",
                    },
                )
            summary = kernel.synchronize_os_from_chat(origin="unit-test-chat-projects")
            self.assertTrue(summary["ok"])
            mods = {m["id"]: m for m in kernel.list_system_modules()}
            self.assertIn("svl-attachment-auto-evolution", mods)
            self.assertEqual(mods["svl-attachment-auto-evolution"]["status"], "ACTIVE")
            self.assertIn("svl-chat-deployed-projects", mods)
            self.assertEqual(mods["svl-chat-deployed-projects"]["status"], "ACTIVE")
            live_state = kernel.get_live_chat_changes_state()
            self.assertTrue(live_state.get("attachment_auto_evolution_active"))
            self.assertGreaterEqual(len(live_state.get("deployed_projects") or []), 4)


if __name__ == "__main__":
    unittest.main()




