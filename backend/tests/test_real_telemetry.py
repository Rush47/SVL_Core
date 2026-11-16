"""Prawdziwa telemetria SVL-364 oraz usuwanie fałszywych wrapperów ssh/ufw/sudo."""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = Path(__file__).resolve().parent.parent
if str(BACKEND_DIR) not in sys.path:
    sys.path.insert(0, str(BACKEND_DIR))

import real_telemetry
from real_telemetry import (
    LEGACY_FAKE_SUDO,
    RealTelemetryCollector,
    find_real_binary,
    is_legacy_fake_wrapper,
    parse_cpuinfo,
    parse_meminfo,
    parse_net_dev,
    parse_nvidia_smi,
    parse_proc_stat,
    remove_legacy_fake_wrappers,
)

FAKE_PY_SSH = '#!/usr/bin/env python3\nenv["HOSTNAME"] = "svl-364-ship"\nenv["SVL_SSH_BRIDGE"] = "QKD-364-ROOT"\n'
FAKE_BASH_SSH = '#!/usr/bin/env bash\nexport USER=root LOGNAME=root HOME=/root HOSTNAME="svl-364-ship" SVL_SSH_HOST="${target}"\n'
FAKE_UFW = '#!/usr/bin/env bash\n  echo "Status: active (SVL-364 Ebon Apex QKD-364 Zero-Trust Shield)"\n'


class FakeWrapperTests(unittest.TestCase):
    def test_detects_only_files_written_by_the_old_application(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            for name, content in {
                "ssh": FAKE_PY_SSH,
                "ssh2": FAKE_BASH_SSH,
                "ufw": FAKE_UFW,
                "sudo": LEGACY_FAKE_SUDO,
                "real-ssh": "\x7fELF binary",
                "user-script": '#!/bin/sh\necho "my own sudo"\n',
            }.items():
                (d / name).write_text(content, encoding="utf-8")
            self.assertTrue(is_legacy_fake_wrapper(d / "ssh"))
            self.assertTrue(is_legacy_fake_wrapper(d / "ssh2"))
            self.assertTrue(is_legacy_fake_wrapper(d / "ufw"))
            self.assertTrue(is_legacy_fake_wrapper(d / "sudo"))
            self.assertFalse(is_legacy_fake_wrapper(d / "real-ssh"))
            self.assertFalse(is_legacy_fake_wrapper(d / "user-script"))
            self.assertFalse(is_legacy_fake_wrapper(d / "missing"))

    def test_cleanup_removes_fakes_and_keeps_everything_else(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            (d / "ssh").write_text(FAKE_BASH_SSH, encoding="utf-8")
            (d / "ufw").write_text(FAKE_UFW, encoding="utf-8")
            (d / "sudo").write_text('#!/bin/sh\nexec /usr/bin/sudo "$@"\n', encoding="utf-8")
            removed = remove_legacy_fake_wrappers([d])
            self.assertEqual(sorted(Path(p).name for p in removed), ["ssh", "ufw"])
            self.assertTrue((d / "sudo").exists())

    def test_find_real_binary_skips_fake_wrappers_on_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            fake_dir, real_dir = Path(tmp) / "fake", Path(tmp) / "real"
            fake_dir.mkdir()
            real_dir.mkdir()
            (fake_dir / "ssh").write_text(FAKE_PY_SSH, encoding="utf-8")
            (real_dir / "ssh").write_text("#!/bin/sh\n# OpenSSH\n", encoding="utf-8")
            for p in (fake_dir / "ssh", real_dir / "ssh"):
                p.chmod(0o755)
            found = find_real_binary("ssh", path=f"{fake_dir}:{real_dir}")
            self.assertEqual(found, str(real_dir / "ssh"))
            self.assertIsNone(find_real_binary("ssh", path=str(fake_dir)))


class ParserTests(unittest.TestCase):
    def test_cpu_percent_is_computed_from_two_proc_stat_samples(self) -> None:
        first = parse_proc_stat("cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 1 2 3 4\n")
        second = parse_proc_stat("cpu  150 0 150 900 0 0 0 0 0 0\n")
        # busy +100, total +200 -> 50 %
        self.assertAlmostEqual(real_telemetry.cpu_percent_between(first, second), 50.0)
        self.assertIsNone(real_telemetry.cpu_percent_between(first, first))

    def test_meminfo_cpuinfo_and_net_dev(self) -> None:
        mem = parse_meminfo("MemTotal: 2048000 kB\nMemAvailable: 1024000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n")
        self.assertEqual(mem["ram_total_mb"], 2000.0)
        self.assertEqual(mem["ram_used_mb"], 1000.0)
        self.assertEqual(mem["ram_percent"], 50.0)

        cpu = parse_cpuinfo("model name\t: AMD EPYC 7B13\ncpu MHz\t\t: 2450.000\nmodel name\t: AMD EPYC 7B13\ncpu MHz\t\t: 2550.000\n")
        self.assertEqual(cpu, {"model": "AMD EPYC 7B13", "mhz": 2500.0})
        self.assertEqual(parse_cpuinfo(""), {"model": None, "mhz": None})

        net = parse_net_dev(
            "Inter-|   Receive\n face |bytes packets\n"
            "    lo: 500 5 0 0 0 0 0 0 500 5 0 0 0 0 0 0\n"
            "  eth0: 1000 10 0 0 0 0 0 0 2000 20 0 0 0 0 0 0\n"
        )
        self.assertEqual(net, {"eth0": {"rx_bytes": 1000, "tx_bytes": 2000}})

    def test_disk_percent_matches_df_semantics(self) -> None:
        usage = shutil._ntuple_diskusage(total=252, used=9, free=30)
        self.assertEqual(real_telemetry.disk_used_percent(usage), 23.1)

    def test_nvidia_smi_output(self) -> None:
        self.assertEqual(
            parse_nvidia_smi("NVIDIA RTX 4090, 37, 9216, 24564, 51\n"),
            [{"name": "NVIDIA RTX 4090", "utilization_percent": 37.0, "memory_used_mb": 9216.0, "memory_total_mb": 24564.0, "temperature_c": 51.0}],
        )
        self.assertEqual(parse_nvidia_smi(""), [])


class CollectorTests(unittest.TestCase):
    def test_gpu_reports_absence_instead_of_inventing_values(self) -> None:
        collector = RealTelemetryCollector()
        with patch("real_telemetry.find_real_binary", return_value=None):
            gpu = collector.gpu()
        self.assertFalse(gpu["available"])
        self.assertEqual(gpu["devices"], [])
        self.assertIn("nvidia-smi", gpu["reason"])

    def test_firewall_is_unknown_when_status_cannot_be_read(self) -> None:
        collector = RealTelemetryCollector()
        denied = subprocess.CompletedProcess(args=["ufw"], returncode=1, stdout="", stderr="ERROR: You need to be root to run this script")
        with (
            patch("real_telemetry.find_real_binary", return_value="/usr/sbin/ufw"),
            patch("real_telemetry.subprocess.run", return_value=denied),
        ):
            fw = collector.firewall()
        self.assertEqual(fw["state"], "unknown")
        self.assertIn("root", fw["detail"])

    def test_firewall_active_and_inactive_states(self) -> None:
        collector = RealTelemetryCollector()
        for stdout, state in (("Status: active\n\nTo Action From\n22/tcp ALLOW Anywhere\n", "active"), ("Status: inactive\n", "inactive")):
            ok = subprocess.CompletedProcess(args=["ufw"], returncode=0, stdout=stdout, stderr="")
            with (
                patch("real_telemetry.find_real_binary", return_value="/usr/sbin/ufw"),
                patch("real_telemetry.subprocess.run", return_value=ok),
            ):
                self.assertEqual(collector.firewall()["state"], state)

    def test_ssh_target_is_unavailable_without_real_openssh(self) -> None:
        collector = RealTelemetryCollector()
        with patch("real_telemetry.find_real_binary", return_value=None):
            target = collector.ssh_target("Ship")
        self.assertFalse(target["reachable"])
        self.assertIn("OpenSSH", target["error"])

    def test_remote_ship_output_is_parsed(self) -> None:
        out = RealTelemetryCollector.parse_remote_ship(
            "ship-01\nLinux 6.12.0 x86_64\n86400.50 300000.00\n0.42 0.30 0.25 2/310 4242\n8\n"
            "MemTotal:       16384000 kB\nMemAvailable:    8192000 kB\n/dev/sda1 100000000 40000000 52428800 44% /\n"
        )
        self.assertEqual(out["hostname"], "ship-01")
        self.assertEqual(out["kernel"], "Linux 6.12.0 x86_64")
        self.assertEqual(out["uptime_sec"], 86400.5)
        self.assertEqual(out["load_avg"], [0.42, 0.3, 0.25])
        self.assertEqual(out["cores"], 8)
        self.assertEqual(out["ram_total_mb"], 16000.0)
        self.assertEqual(out["ram_available_mb"], 8000.0)
        self.assertEqual(out["disk_free_gb"], 50.0)

    def test_snapshot_on_this_host_contains_live_values(self) -> None:
        collector = RealTelemetryCollector()
        snap = collector.snapshot(include_ship=False, ollama_host="http://127.0.0.1:1", comfyui_url="http://127.0.0.1:1")
        self.assertTrue(snap["ok"])
        self.assertGreater(snap["host"]["cpu"]["cores"], 0)
        self.assertIsNotNone(snap["host"]["cpu"]["percent"])
        self.assertGreater(snap["host"]["memory"]["ram_total_mb"], 0)
        self.assertGreater(snap["host"]["uptime_sec"], 0)
        self.assertFalse(snap["services"]["ollama"]["reachable"])
        self.assertIsNone(snap["ship"])


if __name__ == "__main__":
    unittest.main()
