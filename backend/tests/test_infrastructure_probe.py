"""Sonda infrastruktury: wyłącznie prawdziwe źródła (ssh config, /proc, systemd, docker, SQLite)."""

from __future__ import annotations

import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import infrastructure_probe as probe
from svl_core import SVLSystemKernel

SSH_CONFIG = """
Host Ship
    HostName 192.168.1.50
    User root
    Port 2222

Host backup nas
  HostName nas.local

Host *.internal !excluded
    User admin

Host *
    ServerAliveInterval 30
"""

PROC_NET_TCP = """  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
   1: 0100007F:1F95 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 2 1 0000000000000000 100 0 0 10 0
   2: 0100007F:1F95 0100007F:A000 01 00000000:00000000 00:00000000 00000000     0        0 3 1 0000000000000000 100 0 0 10 0
"""
PROC_NET_TCP6 = """  sl  local_address                         remote_address                        st
   0: 00000000000000000000000000000000:0016 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 4 1
"""

MOUNTS = """/dev/sda1 / ext4 rw,relatime 0 0
proc /proc proc rw 0 0
tmpfs /run tmpfs rw 0 0
/dev/sdb1 /data xfs rw 0 0
/dev/sda1 /var/lib/docker ext4 rw 0 0
overlay /var/lib/docker/overlay2/x/merged overlay rw 0 0
"""


class ParserTests(unittest.TestCase):
    def test_ssh_config_lists_concrete_hosts_only(self) -> None:
        hosts = probe.parse_ssh_config(SSH_CONFIG)
        self.assertEqual(
            hosts,
            [
                {"alias": "Ship", "hostname": "192.168.1.50", "port": 2222, "user": "root"},
                {"alias": "backup", "hostname": "nas.local", "port": 22, "user": None},
                {"alias": "nas", "hostname": "nas.local", "port": 22, "user": None},
            ],
        )

    def test_listening_ports_from_proc_net(self) -> None:
        ports = probe.parse_listening_ports(PROC_NET_TCP, PROC_NET_TCP6)
        self.assertEqual(
            ports,
            [
                {"address": "::", "port": 22, "service": "SSH"},
                {"address": "0.0.0.0", "port": 3000, "service": "SVL Gateway"},
                {"address": "127.0.0.1", "port": 8085, "service": "SVL Python Kernel"},
            ],
        )

    def test_mounts_keep_real_filesystems_once_per_device(self) -> None:
        self.assertEqual(
            probe.parse_mounts(MOUNTS),
            [
                {"device": "/dev/sda1", "mountpoint": "/", "fstype": "ext4"},
                {"device": "/dev/sdb1", "mountpoint": "/data", "fstype": "xfs"},
            ],
        )

    def test_address_parsing(self) -> None:
        self.assertEqual(probe.parse_address("nas.local:445"), ("nas.local", 445))
        self.assertEqual(probe.parse_address("[::1]:8080"), ("::1", 8080))
        self.assertIsNone(probe.parse_address("nas.local"))
        self.assertIsNone(probe.parse_address("host:99999"))
        self.assertIsNone(probe.parse_address("bad host:22"))

    def test_systemctl_show_output(self) -> None:
        text = "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=1234\nActiveEnterTimestamp=Mon 2026-11-16 10:00:00 UTC\n"
        self.assertEqual(
            probe.parse_systemctl_show(text),
            {"load_state": "loaded", "active_state": "active", "sub_state": "running", "main_pid": 1234,
             "active_since": "Mon 2026-11-16 10:00:00 UTC"},
        )

    def test_docker_ps_json_lines(self) -> None:
        text = '{"Names":"comfyui","Image":"svl/comfyui:latest","State":"running","Status":"Up 2 hours"}\nnot json\n'
        self.assertEqual(
            probe.parse_docker_ps(text),
            [{"name": "comfyui", "image": "svl/comfyui:latest", "state": "running", "status": "Up 2 hours"}],
        )


class ProbeTests(unittest.TestCase):
    def test_systemd_unavailable_is_reported_not_invented(self) -> None:
        with patch("infrastructure_probe.find_real_binary", return_value=None):
            result = probe.systemd_units()
        self.assertFalse(result["available"])
        self.assertEqual(result["units"], [])
        self.assertIn("systemctl", result["reason"])

    def test_docker_permission_error_is_reported(self) -> None:
        denied = subprocess.CompletedProcess(args=["docker"], returncode=1, stdout="", stderr="permission denied while trying to connect")
        with (
            patch("infrastructure_probe.find_real_binary", return_value="/usr/bin/docker"),
            patch("infrastructure_probe.subprocess.run", return_value=denied),
        ):
            result = probe.docker_containers()
        self.assertFalse(result["available"])
        self.assertIn("permission denied", result["reason"])

    def test_tcp_probe_against_closed_port(self) -> None:
        result = probe.tcp_probe("127.0.0.1", 1, timeout=1.0)
        self.assertFalse(result["reachable"])
        self.assertIsNone(result["rtt_ms"])
        self.assertTrue(result["error"])

    def test_build_report_reads_tasks_and_monitored_modules_from_sqlite(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            kernel = SVLSystemKernel(db_path=str(Path(tmp) / "infra.sqlite3"), operator_token="t" * 40)
            kernel.upsert_system_module(
                module_id="svl-infra-nas",
                name="NAS",
                kind="Monitored Host",
                status="ACTIVE",
                description="",
                config={"category": "infrastructure", "address": "127.0.0.1:1"},
            )
            kernel.upsert_system_module(
                module_id="svl-infra-legacy",
                name="Stara placówka",
                kind="Planetary Outpost",
                status="ACTIVE",
                description="",
                config={"category": "infrastructure", "location": "Mars", "eta": "04h"},
            )
            with patch("infrastructure_probe.Path.home", return_value=Path(tmp)):
                report = probe.build_infrastructure_report(kernel)

        self.assertTrue(report["ok"])
        monitored = {m["id"]: m for m in report["monitored"]}
        self.assertFalse(monitored["svl-infra-nas"]["probe"]["reachable"])
        self.assertIsNone(monitored["svl-infra-legacy"]["probe"])
        self.assertIn("adres", monitored["svl-infra-legacy"]["note"])
        self.assertEqual(report["ssh_hosts"]["hosts"], [])
        self.assertIsInstance(report["tasks"], list)
        self.assertTrue(any(p["port"] for p in report["listening_ports"]) or report["listening_ports"] == [])
        self.assertTrue(report["mounts"])
        self.assertIn("hosts", report["discovered"])
        self.assertIn("neighbors", report["discovered"]["sources"])


class InfrastructureRegistryTests(unittest.TestCase):
    def test_registry_totals_navigation_sync_crud_and_mcp_tool(self) -> None:
        from svl364_ssh_mcp import SVL364SshMcpController

        with tempfile.TemporaryDirectory() as tmp:
            kernel = SVLSystemKernel(db_path=str(Path(tmp) / "infra-reg.sqlite3"), operator_token="t" * 40)
            ctrl = SVL364SshMcpController(kernel)

            # Zmień pozycję SVL-364 na Marsa i sprawdź synchronizację lokalizacji w rejestrze infrastruktury
            ctrl.ship_hub.update_navigation({"currentBody": "mars", "missionStatus": "ORBIT_HOLD"}, origin="test")

            with patch("infrastructure_probe.Path.home", return_value=Path(tmp)):
                overview = ctrl.infrastructure_registry.get_overview(sync_mcp=False)

            self.assertTrue(overview["ok"])
            totals = overview["totals"]
            self.assertEqual(totals["outpostsCount"], 6)
            self.assertEqual(totals["shipsCount"], 10003)
            self.assertEqual(totals["infrastructureObjectsCount"], 500)
            self.assertEqual(totals["allianceStationsTotal"], 46_500_000)
            self.assertGreaterEqual(totals["botanyModulesCount"], 6)
            self.assertGreaterEqual(totals["installedUpgradesCount"], 4)

            svl364_asset = next(a for a in overview["assets"] if a["id"] == "ship-svl-364")
            self.assertIn("Mars", svl364_asset["location"])
            self.assertAlmostEqual(svl364_asset["au"], 1.524, places=2)

            svl365_asset = next(a for a in overview["assets"] if a["id"] == "ship-svl-365")
            self.assertIn("Mars", svl365_asset["location"])
            self.assertAlmostEqual(svl365_asset["au"], 1.524, places=2)

            # Dodanie nowej placówki zwiększa dokładną liczbę placówek i zapisuje się w SQLite
            added_asset = ctrl.infrastructure_registry.upsert_asset(
                {
                    "type": "outpost",
                    "name": "Baza Księżycowa Kopernik",
                    "location": "Księżyc · Krater Kopernik",
                    "sector": "Sektor Ziemski",
                    "au": 1.002,
                    "unitCount": 1,
                    "crew": 55,
                    "hasBotany": True,
                },
                origin="test",
            )
            self.assertTrue(added_asset["ok"])
            self.assertEqual(added_asset["totals"]["outpostsCount"], 7)

            # Dodanie misji, badania, aktualizacja botaniki oraz zamówienie pozaziemskie przez MCP svl364_infrastructure_registry
            mcp_mission = ctrl.call_mcp_tool(
                "svl364_infrastructure_registry",
                {
                    "action": "upsert_mission",
                    "payload": {"title": "Dostawa nasion na Marsa", "progressPct": 45},
                },
                origin="test",
            )
            self.assertTrue(mcp_mission["ok"])
            self.assertEqual(mcp_mission["data"]["mission"]["progressPct"], 45)

            mcp_res = ctrl.call_mcp_tool(
                "svl364_infrastructure_registry",
                {
                    "action": "upsert_research",
                    "payload": {"title": "Fotosynteza głębokokosmiczna LED", "researchersCount": 32},
                },
                origin="test",
            )
            self.assertTrue(mcp_res["ok"])
            self.assertEqual(mcp_res["data"]["research"]["researchersCount"], 32)

            mcp_bot = ctrl.call_mcp_tool(
                "svl364_infrastructure_registry",
                {
                    "action": "update_botany",
                    "payload": {
                        "id": "botany-apex-citadel",
                        "o2OutputPct": 116.4,
                        "eventText": "Zakończono zbiór 140 kg biomasy z sektora B2.",
                    },
                },
                origin="test",
            )
            self.assertTrue(mcp_bot["ok"])
            self.assertEqual(mcp_bot["data"]["botany"]["o2OutputPct"], 116.4)
            self.assertIn("140 kg", mcp_bot["data"]["botany"]["recentEvents"][0]["text"])

            mcp_ord = ctrl.call_mcp_tool(
                "svl364_infrastructure_registry",
                {
                    "action": "order_upgrade",
                    "payload": {
                        "title": "Koprocesor QKD + Tarcza SVL-365 Mk7",
                        "targetHost": "SVL-365 Sentinel Aegis",
                        "tier": "OMEGA-MK7",
                    },
                },
                origin="test",
            )
            self.assertTrue(mcp_ord["ok"])
            self.assertEqual(mcp_ord["data"]["order"]["status"], "DELIVERED_AND_INTEGRATED")
            self.assertEqual(mcp_ord["data"]["upgrade"]["tier"], "OMEGA-MK7")


if __name__ == "__main__":
    unittest.main()
