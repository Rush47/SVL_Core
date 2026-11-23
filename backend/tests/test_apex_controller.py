import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))


class ApexControllerHonestyTest(unittest.TestCase):
    """SVL CoreOS 2: stan z pomiarów — żadnych wpisanych na sztywno „wykonanych” operacji."""

    def tearDown(self) -> None:
        # Moduł app tworzy przy imporcie środowisko z bazą z SVL_SQLITE_PATH — zwalniamy je,
        # żeby kolejne testy importowały app z własną, tymczasową bazą.
        sys.modules.pop("app", None)

    def test_status_is_measured_and_controls_do_not_fake_actions(self) -> None:
        sys.modules.pop("app", None)
        with tempfile.TemporaryDirectory() as tmpdir:
            with patch.dict(
                "os.environ",
                {
                    "SVL_SQLITE_PATH": str(Path(tmpdir) / "apex.sqlite3"),
                    "SVL_LOG_FILE": str(Path(tmpdir) / "brak-logu.log"),
                    "SVL_COREOS2_ROOTFS": str(Path(tmpdir) / "brak-rootfs"),
                },
            ):
                sys.modules.pop("app", None)  # świeże środowisko z bazą tego testu
                import app as backend_app

                ctl = backend_app.SVLCoreOS2ApexController(backend_app.runtime)
                st = ctl.get_status()
                import platform

                self.assertEqual(st["kernel_release"], platform.release())
                self.assertEqual(st["debootstrap_status"], "NIE URUCHOMIONO")
                self.assertIn("nie dotyczy", st["hot_swap_status"])
                self.assertTrue(st["active"])
                self.assertEqual(st["version"], "2.0.0-Apex")
                self.assertIn("service_status", st)
                self.assertIsNone(st["install_log"])
                self.assertNotIn("e_shield_percent", st)
                self.assertNotIn("fusion_core_mw", st)
                self.assertNotIn("solar_lockdown", st)
                self.assertEqual(st["remote_desktop_fps"], 0)
                for daemon in st["daemons"].values():
                    self.assertTrue(daemon["measured"])
                    self.assertIn(daemon["status"], ("ONLINE", "NIEAKTYWNY"))

                refused = ctl.handle_control({"action": "toggle_daemon", "daemonId": "double_vpn", "emitToChat": False})
                self.assertFalse(refused["ok"])
                self.assertIn("zmieniał wcześniej tylko napis", refused["error"])

                shield = ctl.handle_control({"action": "set_e_shield", "value": 125, "emitToChat": False})
                self.assertFalse(shield["ok"])
                self.assertIn("usunięty", shield["error"])
                self.assertNotIn("e_shield_percent", shield["status"])

                # Debootstrap „zbudowany” tylko, gdy istnieje prawdziwy rootfs.
                rootfs = Path(tmpdir) / "brak-rootfs" / "etc"
                rootfs.mkdir(parents=True)
                (rootfs / "debian_version").write_text("13.0\n")
                self.assertTrue(ctl.get_status()["debootstrap_status"].startswith("ZBUDOWANY"))

                # Pełny status Debian 13 (Trixie) Full Edition + sumy kontrolne SHA-256
                deb_st = ctl.get_debian13_full_status(force_refresh=True)
                self.assertTrue(deb_st["ok"])
                self.assertTrue(deb_st["measured"])
                self.assertEqual(deb_st["codename"], "trixie")
                self.assertGreaterEqual(deb_st["package_summary"]["target_packages_total"], 50)
                self.assertEqual(deb_st["package_summary"]["group_count"], 6)
                self.assertGreaterEqual(deb_st["artifacts_count"], 12)
                self.assertTrue(all(len(a["sha256"]) == 64 for a in deb_st["artifacts"]))

                act_res = ctl.handle_debian13_action({"action": "verify_packages", "emitToChat": False}, origin="unit-test")
                self.assertTrue(act_res["ok"])
                self.assertTrue(act_res["status"]["truth_verification"]["active"])


if __name__ == "__main__":
    unittest.main()

