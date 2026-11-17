import sys
import tempfile
import unittest
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_DIR))

from ship_monitor import ShipMonitor, evaluate_ship  # noqa: E402
from svl_core import SVLSystemKernel  # noqa: E402

HEALTHY = {
    "online": True, "hostname": "svl-364", "kernel": "Linux 6.12", "uptime_sec": 90000.0,
    "load_avg": [0.5, 0.4, 0.3], "cores": 8, "ram_total_mb": 32000.0, "ram_available_mb": 20000.0,
    "disk_free_gb": 120.0,
}


class ShipMonitorEvaluationTest(unittest.TestCase):
    def test_healthy_first_run_is_silent(self) -> None:
        state, notes = evaluate_ship({}, HEALTHY, "Ship")
        self.assertEqual(notes, [])
        self.assertTrue(state["online"])

    def test_link_loss_and_restore_notify_once(self) -> None:
        state, _ = evaluate_ship({}, HEALTHY, "Ship")
        state, notes = evaluate_ship(state, {"online": False, "error": "Connection refused"}, "Ship")
        self.assertEqual([n["key"] for n in notes], ["link-lost"])
        self.assertEqual(notes[0]["severity"], "ALERT")
        self.assertIn("Connection refused", notes[0]["message"])
        state, notes = evaluate_ship(state, {"online": False, "error": "Connection refused"}, "Ship")
        self.assertEqual(notes, [])  # bez powtórek
        state, notes = evaluate_ship(state, HEALTHY, "Ship")
        self.assertEqual([n["key"] for n in notes], ["link-restored"])
        self.assertIn("RAM wolne 20000 z 32000 MB", notes[0]["message"])

    def test_reboot_and_thresholds_use_real_values_with_hysteresis(self) -> None:
        state, _ = evaluate_ship({}, HEALTHY, "Ship")
        stressed = {**HEALTHY, "uptime_sec": 120.0, "ram_available_mb": 1600.0, "disk_free_gb": 3.2,
                    "load_avg": [14.0, 10.0, 8.0]}
        state, notes = evaluate_ship(state, stressed, "Ship")
        keys = [n["key"] for n in notes]
        self.assertEqual(keys, ["reboot", "ram-low", "disk-low", "load-high"])
        self.assertIn("5.0%", notes[1]["title"])
        self.assertIn("3.2 GB", notes[2]["title"])
        # między progami (histereza) — cisza
        middle = {**stressed, "ram_available_mb": 4000.0, "disk_free_gb": 6.0, "load_avg": [10.0, 9.0, 8.0]}
        state, notes = evaluate_ship(state, middle, "Ship")
        self.assertEqual(notes, [])
        state, notes = evaluate_ship(state, {**HEALTHY, "uptime_sec": 400.0}, "Ship")
        self.assertEqual(sorted(n["key"] for n in notes), ["disk-ok", "load-ok", "ram-ok"])


class ShipMonitorPersistenceTest(unittest.TestCase):
    def test_notifications_come_from_maya_and_survive_restart_without_duplicates(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            db = str(Path(tmpdir) / "ship.sqlite3")
            token = "test_operator_token_with_more_than_32_chars_abcdef"
            readings = [{"online": False, "error": "No route to host"}]
            kernel = SVLSystemKernel(db_path=db, operator_token=token)
            monitor = ShipMonitor(kernel, probe=lambda _alias: readings[0], alias_getter=lambda: "Ship", interval_sec=0)
            self.assertEqual(len(monitor.check_once()), 1)

            restarted = SVLSystemKernel(db_path=db, operator_token=token)
            again = ShipMonitor(restarted, probe=lambda _alias: readings[0], alias_getter=lambda: "Ship", interval_sec=0)
            self.assertEqual(again.check_once(), [])  # stan z SQLite — brak powtórki po restarcie

            family = next(c for c in restarted.list_conversations_with_messages() if c["id"] == "conv-rodzina-mitek-wszyscy")
            notes = [m for m in family["messages"] if m["id"].startswith("notif-ship-")]
            self.assertEqual(len(notes), 1)
            self.assertEqual(notes[0]["sender"], "Maya")
            self.assertIn("No route to host", notes[0]["content"])
            self.assertFalse(monitor.start())  # interval 0 = wyłączony


if __name__ == "__main__":
    unittest.main()
