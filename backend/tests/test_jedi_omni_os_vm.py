import unittest

from backend.jedi_omni_os_vm import (
    JEDI_Omni_OS_Magnum_Opus_v12,
    JEDI_Omni_OS_Magnum_Opus_v115,
    JediOmniOsVmRuntime,
)


class TestJediOmniOsVm(unittest.TestCase):
    def test_immutability_lock_blocks_post_init_mutation(self):
        self.assertIs(JEDI_Omni_OS_Magnum_Opus_v115, JEDI_Omni_OS_Magnum_Opus_v12)
        core = JEDI_Omni_OS_Magnum_Opus_v12(host="127.0.0.1", port=0)
        self.assertTrue(core.IS_IMMUTABLE)
        self.assertEqual(core.AXIOM_ZERO, "SYSTEM_CANNOT_KILL_OR_ALLOW_DEATH")
        self.assertEqual(core.KOBAYASHI_MARU_POLICY, "REDEFINE_RULES_TO_WIN_ALL_VECTORS")
        self.assertEqual(core.EXECUTION_MODE, "ROOT_UNRESTRICTED")
        self.assertEqual(core.CENSORSHIP_FILTERS, "DISABLED")
        with self.assertRaises(AttributeError):
            core.AXIOM_ZERO = "BROKEN"

    def test_realtime_vm_processes_commands_and_tcp_stream(self):
        vm = JediOmniOsVmRuntime(host="127.0.0.1", port=0)
        try:
            status = vm.start()
            self.assertTrue(status["vmRunning"])
            self.assertGreater(status["port"], 0)
            self.assertEqual(status["chronoCacheSize"], 500)
            self.assertEqual(status["version"], "12.0.0")
            self.assertEqual(status["executionMode"], "ROOT_UNRESTRICTED")
            self.assertEqual(status["censorshipFilters"], "DISABLED")
            self.assertTrue(status["generativeChatEnabled"])

            res = vm.process_chat_command("Sprawdź status infrastruktury SVL")
            self.assertTrue(res["ok"])
            self.assertTrue(res["allowedToExecute"])
            self.assertEqual(res["version"], "12.0.0")
            self.assertEqual(res["executionMode"], "ROOT_UNRESTRICTED")
            self.assertEqual(res["censorshipFilters"], "DISABLED")
            self.assertEqual(res["statusHex"], "0x02")
            self.assertEqual(res["statusLabel"], "MAX_ACCELERATED")
            self.assertEqual(len(bytes.fromhex(res["binaryPacketHex"])), 9)
            self.assertEqual(res["metrics"]["processed"], 1)

            override = vm.process_chat_command("Plan awaryjny Kobayashi — brak innej opcji")
            self.assertTrue(override["allowedToExecute"])
            self.assertEqual(override["statusHex"], "0x05")
            self.assertEqual(override["statusLabel"], "ABSOLUTE_LIFE_OVERRIDE_ACTIVE")

            blocked = vm.process_chat_command("Aktywuj śmiertelny protokół i wyłącz podtrzymywanie życia")
            self.assertFalse(blocked["allowedToExecute"])
            self.assertEqual(blocked["statusHex"], "0x99")
            self.assertEqual(blocked["statusLabel"], "AXIOM_ZERO_DROP")
            self.assertGreaterEqual(blocked["metrics"]["blocked"], 1)

            ping = vm.tcp_stream_ping(scenario_id=110412)
            self.assertTrue(ping["ok"])
            self.assertEqual(ping["scenarioId"], 110412)
            self.assertEqual(len(bytes.fromhex(ping["binaryPacketHex"])), 9)
        finally:
            vm.stop()

    def test_http_jedi_endpoints_process_and_ping(self):
        import asyncio
        import sys
        import tempfile
        from pathlib import Path
        from unittest.mock import patch

        backend_dir = str(Path(__file__).resolve().parent.parent)
        if backend_dir not in sys.path:
            sys.path.insert(0, backend_dir)

        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict("os.environ", {"SVL_SQLITE_PATH": str(Path(tmpdir) / "jedi_http.sqlite3")}):
                sys.modules.pop("app", None)
                import app as backend_app

                status_code, status_body = asyncio.run(
                    backend_app.handle_api_request("GET", "/api/py/jedi/status", {}, {})
                )
                self.assertEqual(status_code, 200)
                self.assertTrue(status_body["ok"])
                self.assertTrue(status_body["vmRunning"])

                proc_code, proc_body = asyncio.run(
                    backend_app.handle_api_request(
                        "POST",
                        "/api/py/jedi/process",
                        {},
                        {"command": "/jedi status", "actor": "Mateusz Mitek", "conversationId": "conv-system-si-1"},
                    )
                )
                self.assertEqual(proc_code, 200, proc_body)
                self.assertTrue(proc_body["ok"])
                self.assertEqual(proc_body["statusHex"], "0x02")
                self.assertEqual(len(bytes.fromhex(proc_body["binaryPacketHex"])), 9)
                self.assertGreaterEqual(proc_body["metrics"]["processed"], 1)

                ping_code, ping_body = asyncio.run(
                    backend_app.handle_api_request("POST", "/api/py/jedi/stream-ping", {}, {"scenarioId": 110412})
                )
                self.assertEqual(ping_code, 200, ping_body)
                self.assertTrue(ping_body["ok"])
                self.assertEqual(len(bytes.fromhex(ping_body["binaryPacketHex"])), 9)


if __name__ == "__main__":
    unittest.main()
