import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))


class ApexControllerHonestyTest(unittest.TestCase):
    """SVL CoreOS 2: stan z pomiarów — żadnych wpisanych na sztywno „wykonanych” operacji."""

    def test_status_is_measured_and_controls_do_not_fake_actions(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(
                "os.environ",
                {
                    "SVL_SQLITE_PATH": str(Path(tmpdir) / "apex.sqlite3"),
                    "SVL_LOG_FILE": str(Path(tmpdir) / "brak-logu.log"),
                    "SVL_COREOS2_ROOTFS": str(Path(tmpdir) / "brak-rootfs"),
                },
            ):
                import app as backend_app

                ctl = backend_app.SVLCoreOS2ApexController(backend_app.runtime)
                ctl.state_path = Path(tmpdir) / "scenario.json"
                st = ctl.get_status()
                import platform

                self.assertEqual(st["kernel_release"], platform.release())
                self.assertEqual(st["debootstrap_status"], "NIE URUCHOMIONO")
                self.assertIn("NIE WYKONANO", st["hot_swap_status"])
                self.assertIsNone(st["install_log"])
                self.assertEqual(st["fighter_incidents_count"], 0)
                self.assertEqual(st["remote_desktop_fps"], 0)
                for daemon in st["daemons"].values():
                    self.assertTrue(daemon["measured"])
                    self.assertIn(daemon["status"], ("ONLINE", "NIEAKTYWNY"))

                refused = ctl.handle_control({"action": "toggle_daemon", "daemonId": "double_vpn", "emitToChat": False})
                self.assertFalse(refused["ok"])
                self.assertIn("zmieniał wcześniej tylko napis", refused["error"])

                shield = ctl.handle_control({"action": "set_e_shield", "value": 125, "emitToChat": False})
                self.assertTrue(shield["ok"])
                self.assertIn("scenariusza", shield["notice"])
                self.assertEqual(shield["status"]["e_shield_percent"], 125.0)

                # Debootstrap „zbudowany” tylko, gdy istnieje prawdziwy rootfs.
                rootfs = Path(tmpdir) / "brak-rootfs" / "etc"
                rootfs.mkdir(parents=True)
                (rootfs / "debian_version").write_text("13.0\n")
                self.assertTrue(ctl.get_status()["debootstrap_status"].startswith("ZBUDOWANY"))


if __name__ == "__main__":
    unittest.main()
