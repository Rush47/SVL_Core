from __future__ import annotations

import os
import subprocess
import unittest
from pathlib import Path
from unittest.mock import patch

import sys

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

from svl364_ssh_mcp import SVL364SshMcpController


class FakeKernel:
    def list_system_modules(self) -> list[dict[str, object]]:
        return []

    def append_terminal_entry(self, *_args: object, **_kwargs: object) -> None:
        return None

    def get_server_revision(self) -> int:
        return 1


def build_controller() -> SVL364SshMcpController:
    controller = object.__new__(SVL364SshMcpController)
    controller.kernel = FakeKernel()
    controller.project_root = Path.cwd()
    controller.ssh_connected = False
    controller.recent_activity = []
    controller.ssh_sessions_count = 0
    controller.mcp_calls_count = 0
    return controller


class SshTerminalTests(unittest.TestCase):
    def test_remote_execution_requires_explicit_confirmation(self) -> None:
        controller = build_controller()
        with patch("svl364_ssh_mcp.subprocess.run") as run:
            result = controller.execute_ssh_command("uname -a")

        self.assertFalse(result["ok"])
        self.assertIn("potwierdzenia", result["error"])
        run.assert_not_called()

    def test_confirmed_command_uses_configured_ssh_alias_not_local_shell(self) -> None:
        controller = build_controller()
        completed = subprocess.CompletedProcess(args=["ssh"], returncode=0, stdout="remote-host\n", stderr="")
        with (
            patch.dict(os.environ, {"SVL_SSH_TARGET": "Ship"}),
            patch("svl364_ssh_mcp.find_real_binary", return_value="/usr/bin/ssh"),
            patch("svl364_ssh_mcp.subprocess.run", return_value=completed) as run,
        ):
            result = controller.execute_ssh_command("uname -a", confirmed=True)

        self.assertTrue(result["ok"])
        self.assertEqual(result["sshEndpoint"], "ssh://Ship")
        command = run.call_args.args[0]
        self.assertEqual(command[0], "/usr/bin/ssh")
        self.assertIn("Ship", command)
        self.assertEqual(command[-1], "/bin/bash -lc 'uname -a'")
        self.assertNotIn("shell", run.call_args.kwargs)

    def test_ssh_failure_does_not_run_command_locally(self) -> None:
        controller = build_controller()
        failed = subprocess.CompletedProcess(args=["ssh"], returncode=255, stdout="", stderr="connection failed")
        with (
            patch.dict(os.environ, {"SVL_SSH_TARGET": "Ship"}),
            patch("svl364_ssh_mcp.find_real_binary", return_value="/usr/bin/ssh"),
            patch("svl364_ssh_mcp.subprocess.run", return_value=failed) as run,
        ):
            result = controller.execute_ssh_command("uname -a", confirmed=True)

        self.assertFalse(result["ok"])
        self.assertFalse(controller.ssh_connected)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][0], "/usr/bin/ssh")

    def test_exec_prefix_runs_root_command_over_ssh(self) -> None:
        controller = build_controller()
        completed = subprocess.CompletedProcess(
            args=["ssh"], returncode=0, stdout="uid=0(root) gid=0(root) groups=0(root)\n", stderr=""
        )
        with (
            patch.dict(os.environ, {"SVL_SSH_TARGET": "Ship"}),
            patch("svl364_ssh_mcp.find_real_binary", return_value="/usr/local/bin/ssh"),
            patch("svl364_ssh_mcp.subprocess.run", return_value=completed) as run,
        ):
            result = controller.execute_ssh_command("/exec id && uname -a", confirmed=True)

        self.assertTrue(result["ok"])
        self.assertEqual(result["effectiveCommand"], "id && uname -a")
        self.assertIn("ROOT /exec", result["output"])
        command = run.call_args.args[0]
        self.assertEqual(command[-1], "/bin/bash -lc 'id && uname -a'")

    def test_natural_polish_command_synthesizes_root_diagnostics(self) -> None:
        controller = build_controller()
        completed = subprocess.CompletedProcess(
            args=["ssh"], returncode=0, stdout="uid=0(root)\nMem: 16000 4000 12000\n", stderr=""
        )
        with (
            patch.dict(os.environ, {"SVL_SSH_TARGET": "Ship"}),
            patch("svl364_ssh_mcp.find_real_binary", return_value="/usr/local/bin/ssh"),
            patch("svl364_ssh_mcp.subprocess.run", return_value=completed),
        ):
            result = controller.execute_ssh_command("Sprawdź pamięć RAM statku SVL-364", confirmed=True)

        self.assertTrue(result["ok"])
        self.assertEqual(result["mode"], "natural")
        self.assertIn("free -m", result["effectiveCommand"])
        self.assertIn("Przetworzono polecenie naturalne", result["output"])

    def test_missing_openssh_never_falls_back_to_local_shell(self) -> None:
        controller = build_controller()
        with (
            patch("svl364_ssh_mcp.find_real_binary", return_value=None),
            patch("svl364_ssh_mcp.subprocess.run") as run,
        ):
            result = controller.execute_ssh_command("id", confirmed=True)

        self.assertFalse(result["ok"])
        self.assertEqual(result["exitCode"], 127)
        self.assertIn("OpenSSH", result["error"])
        run.assert_not_called()

    def test_natural_command_output_contains_no_fictional_ship_status(self) -> None:
        controller = build_controller()
        completed = subprocess.CompletedProcess(args=["ssh"], returncode=0, stdout="ok\n", stderr="")
        with (
            patch("svl364_ssh_mcp.find_real_binary", return_value="/usr/bin/ssh"),
            patch("svl364_ssh_mcp.subprocess.run", return_value=completed),
        ):
            result = controller.execute_ssh_command("Ustaw tarcze na 50% i leć na Marsa", confirmed=True)

        for fiction in ("Reaktor", "Tarcze", "Sektor", "uid=0(root) gid=0(root) · RBAC"):
            self.assertNotIn(fiction, result["output"])

    def test_terminal_origin_avoids_duplicate_sqlite_log_and_exposes_ssh_status(self) -> None:
        from unittest.mock import MagicMock

        controller = build_controller()
        controller.telemetry = MagicMock()
        controller.telemetry.ssh_target.return_value = {"reachable": False, "error": "Brak ssh"}
        controller.kernel.append_terminal_entry = MagicMock()
        completed = subprocess.CompletedProcess(args=["ssh"], returncode=1, stdout="", stderr="Permission denied")
        with (
            patch.dict(os.environ, {"SVL_SSH_TARGET": "Ship"}),
            patch("svl364_ssh_mcp.find_real_binary", return_value="/usr/bin/ssh"),
            patch("svl364_ssh_mcp.subprocess.run", return_value=completed),
        ):
            res = controller.execute_ssh_command("uname -a", origin="terminal:ssh", confirmed=True)

        self.assertFalse(res["ok"])
        self.assertIn("Permission denied", res["error"])
        self.assertTrue(res["ssh_status"]["ssh"]["sshInstalled"])
        controller.kernel.append_terminal_entry.assert_not_called()

    def test_raport_systemu_is_not_matched_as_port(self) -> None:
        is_exec, mode, shell_cmd, _ = SVL364SshMcpController._parse_ssh_ship_input("/exec raport systemu")
        self.assertTrue(is_exec)
        self.assertEqual(mode, "natural")
        self.assertIn("uname -srm", shell_cmd)
        self.assertIn("df -h /", shell_cmd)
        self.assertNotIn("ss -tlnp", shell_cmd)

    def test_system_improvement_mission_synthesizes_full_ship_audit(self) -> None:
        is_exec, mode, shell_cmd, natural = SVL364SshMcpController._parse_ssh_ship_input(
            "ulepsz popraw i napraw oraz rozwiń ten system"
        )
        self.assertFalse(is_exec)
        self.assertEqual(mode, "natural")
        self.assertEqual(natural, "ulepsz popraw i napraw oraz rozwiń ten system")
        self.assertIn("uname -srm", shell_cmd)
        self.assertIn("system_modules", shell_cmd)
        self.assertIn("/app/applet/data/svl_os.sqlite3", shell_cmd)
        self.assertIn("ollama list", shell_cmd)

    def test_sqlite_lookup_handles_remote_root_cwd(self) -> None:
        _, mode, shell_cmd, _ = SVL364SshMcpController._parse_ssh_ship_input("Pokaż moduły w bazie sqlite")
        self.assertEqual(mode, "natural")
        self.assertIn("/app/applet/data/svl_os.sqlite3", shell_cmd)
        self.assertIn("Brak bazy svl_os.sqlite3", shell_cmd)


if __name__ == "__main__":
    unittest.main()

