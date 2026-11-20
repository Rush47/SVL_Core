"""Automatyczne wykrywanie hostów z prawdziwych źródeł systemu (bez skanowania sieci)."""

from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import host_discovery as hd

PROC_ARP = """IP address       HW type     Flags       HW address            Mask     Device
192.168.1.1      0x1         0x2         aa:bb:cc:00:00:01     *        eth0
192.168.1.20     0x1         0x2         aa:bb:cc:00:00:20     *        eth0
192.168.1.99     0x1         0x0         00:00:00:00:00:00     *        eth0
"""

IP_NEIGH_JSON = """[
 {"dst":"192.168.1.1","dev":"eth0","lladdr":"aa:bb:cc:00:00:01","state":["REACHABLE"]},
 {"dst":"192.168.1.30","dev":"eth0","lladdr":"aa:bb:cc:00:00:30","state":["STALE"]},
 {"dst":"192.168.1.40","dev":"eth0","state":["FAILED"]},
 {"dst":"fe80::1","dev":"eth0","lladdr":"aa:bb:cc:00:00:01","router":null,"state":["REACHABLE"]},
 {"dst":"2001:db8::30","dev":"eth0","lladdr":"aa:bb:cc:00:00:30","state":["DELAY"]}
]"""

KNOWN_HOSTS = """nas.local,192.168.1.20 ssh-ed25519 AAAAC3Nza
[git.example.com]:2222 ssh-ed25519 AAAAC3Nzb
|1|hashedsalt=|hashedhost= ssh-ed25519 AAAAC3Nzc
@cert-authority *.example.com ssh-ed25519 AAAAC3Nzd
# komentarz
"""

ETC_HOSTS = """127.0.0.1 localhost
::1 localhost ip6-localhost
ff02::1 ip6-allnodes
192.168.1.20 nas nas.lan
10.0.0.5 printer # drukarka
"""


class ParserTests(unittest.TestCase):
    def test_proc_net_arp_keeps_only_complete_entries(self) -> None:
        self.assertEqual(
            hd.parse_proc_net_arp(PROC_ARP),
            [
                {"address": "192.168.1.1", "mac": "aa:bb:cc:00:00:01", "interface": "eth0", "state": "COMPLETE"},
                {"address": "192.168.1.20", "mac": "aa:bb:cc:00:00:20", "interface": "eth0", "state": "COMPLETE"},
            ],
        )

    def test_ip_neigh_skips_failed_and_link_local(self) -> None:
        entries = hd.parse_ip_neigh_json(IP_NEIGH_JSON)
        self.assertEqual([e["address"] for e in entries], ["192.168.1.1", "192.168.1.30", "2001:db8::30"])
        self.assertEqual(entries[0]["state"], "REACHABLE")
        self.assertEqual(hd.parse_ip_neigh_json("not json"), [])

    def test_known_hosts_skips_hashed_and_markers(self) -> None:
        hosts, hashed = hd.parse_known_hosts(KNOWN_HOSTS)
        self.assertEqual(
            hosts,
            [
                {"name": "nas.local", "port": 22},
                {"name": "192.168.1.20", "port": 22},
                {"name": "git.example.com", "port": 2222},
            ],
        )
        self.assertEqual(hashed, 1)

    def test_etc_hosts_skips_loopback_and_special(self) -> None:
        self.assertEqual(
            hd.parse_etc_hosts(ETC_HOSTS),
            [
                {"address": "192.168.1.20", "names": ["nas", "nas.lan"]},
                {"address": "10.0.0.5", "names": ["printer"]},
            ],
        )


class DiscoveryTests(unittest.TestCase):
    def _discovery(self, tmp: Path, **sources: str) -> hd.HostDiscovery:
        (tmp / ".ssh").mkdir(exist_ok=True)
        (tmp / ".ssh" / "known_hosts").write_text(sources.get("known_hosts", ""), encoding="utf-8")
        etc_hosts = tmp / "hosts"
        etc_hosts.write_text(sources.get("etc_hosts", ""), encoding="utf-8")
        arp = tmp / "arp"
        arp.write_text(sources.get("arp", ""), encoding="utf-8")
        return hd.HostDiscovery(home=tmp, etc_hosts_path=etc_hosts, proc_arp_path=arp)

    def test_merges_sources_by_address_and_probes_known_ssh_port(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            discovery = self._discovery(Path(tmp), arp=PROC_ARP, known_hosts=KNOWN_HOSTS, etc_hosts=ETC_HOSTS)
            fake_probe = {"reachable": True, "rtt_ms": 1.2, "error": None}
            with (
                patch("host_discovery.find_real_binary", return_value=None),
                patch("host_discovery.tcp_probe", return_value=fake_probe) as probe,
                patch("host_discovery.reverse_dns", return_value={}),
                patch("host_discovery.resolve_names", return_value={"nas.local": "192.168.1.20"}),
            ):
                result = discovery.discover(tracked_addresses={"192.168.1.1"})

        hosts = {h["key"]: h for h in result["hosts"]}
        nas = hosts["aa:bb:cc:00:00:20"]
        self.assertEqual(nas["addresses"], ["192.168.1.20"])
        self.assertEqual(sorted(nas["names"]), ["nas", "nas.lan", "nas.local"])
        self.assertEqual(sorted(nas["sources"]), ["arp", "etc_hosts", "known_hosts"])
        self.assertEqual(nas["ssh_port"], 22)
        self.assertEqual(nas["probe"], fake_probe)
        self.assertTrue(nas["seen_now"])

        self.assertTrue(hosts["aa:bb:cc:00:00:01"]["tracked"])
        self.assertIsNone(hosts["aa:bb:cc:00:00:01"]["probe"])  # brak znanego portu -> brak pomiaru
        self.assertIn("printer", hosts["10.0.0.5"]["names"])
        self.assertEqual(hosts["git.example.com"]["ssh_port"], 2222)
        self.assertEqual(result["hashed_known_hosts"], 1)
        # sondy TCP tylko dla hostów ze znanym portem SSH (nas + git.example.com)
        self.assertEqual(probe.call_count, 2)

    def test_hosts_that_leave_the_neighbor_table_are_remembered(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            discovery = self._discovery(Path(tmp), arp=PROC_ARP)
            with (
                patch("host_discovery.find_real_binary", return_value=None),
                patch("host_discovery.reverse_dns", return_value={}),
                patch("host_discovery.resolve_names", return_value={}),
            ):
                first = discovery.discover()
                (Path(tmp) / "arp").write_text(PROC_ARP.splitlines()[0] + "\n", encoding="utf-8")
                second = discovery.discover()

        self.assertEqual(len(first["hosts"]), 2)
        remembered = {h["key"]: h for h in second["hosts"]}
        self.assertFalse(remembered["aa:bb:cc:00:00:20"]["seen_now"])
        self.assertEqual(remembered["aa:bb:cc:00:00:20"]["first_seen"], {h["key"]: h for h in first["hosts"]}["aa:bb:cc:00:00:20"]["first_seen"])

    def test_forgets_hosts_after_retention(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            discovery = self._discovery(Path(tmp), arp=PROC_ARP)
            discovery.retention_sec = 0
            with (
                patch("host_discovery.find_real_binary", return_value=None),
                patch("host_discovery.reverse_dns", return_value={}),
                patch("host_discovery.resolve_names", return_value={}),
            ):
                discovery.discover()
                (Path(tmp) / "arp").write_text("", encoding="utf-8")
                self.assertEqual(discovery.discover()["hosts"], [])

    def test_reverse_dns_never_blocks_longer_than_timeout(self) -> None:
        import time

        def slow(_addr: str) -> tuple[str, list[str], list[str]]:
            time.sleep(3)
            return ("slow.example", [], [])

        started = time.monotonic()
        with patch("host_discovery.socket.gethostbyaddr", side_effect=slow):
            names = hd.reverse_dns(["192.0.2.10"], timeout=0.3)
        self.assertLess(time.monotonic() - started, 1.5)
        self.assertEqual(names, {})


if __name__ == "__main__":
    unittest.main()
