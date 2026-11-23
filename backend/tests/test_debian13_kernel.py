import json
import sys
import unittest
from pathlib import Path

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
DEBIAN13_DIR = ROOT_DIR / "SVL_CoreOS_2" / "debian13"
if str(DEBIAN13_DIR) not in sys.path:
    sys.path.insert(0, str(DEBIAN13_DIR))

import jedi_v12_native_kernel_reprogrammer as jedi_reprog  # noqa: E402


class TestDebian13KernelUnlocked(unittest.TestCase):
    def test_manifest_is_unlocked_and_bare_metal_standalone(self) -> None:
        manifest_path = DEBIAN13_DIR / "debian13_trixie_rootfs_manifest.json"
        data = json.loads(manifest_path.read_text(encoding="utf-8"))
        native = data["native_jedi_v12_core"]
        self.assertTrue(native["bare_metal_standalone"])
        self.assertTrue(native["docker_detached"])
        self.assertTrue(native["kernel_unlocked"])
        self.assertIn("DISABLED", native["kernel_restrictions"])
        groups = data["installed_package_groups"]
        self.assertNotIn("virtualization_vtd", groups)
        self.assertIn("bare_metal_kernel_tuning", groups)
        self.assertIn("irqbalance", groups["bare_metal_kernel_tuning"])

    def test_sysctl_grub_and_systemd_fully_unlocked(self) -> None:
        sysctl = (DEBIAN13_DIR / "svl-coreos2-sysctl.conf").read_text(encoding="utf-8")
        for expected in (
            "kernel.sysrq = 1",
            "kernel.yama.ptrace_scope = 0",
            "kernel.unprivileged_bpf_disabled = 0",
            "kernel.kptr_restrict = 0",
            "kernel.dmesg_restrict = 0",
            "kernel.perf_event_paranoid = -1",
            "kernel.kexec_load_disabled = 0",
            "kernel.modules_disabled = 0",
            "net.core.default_qdisc = fq",
            "net.ipv4.tcp_congestion_control = bbr",
            "net.core.bpf_jit_enable = 1",
            "vm.swappiness = 10",
            "fs.inotify.max_user_watches = 524288",
        ):
            self.assertIn(expected, sysctl)

        grub = (DEBIAN13_DIR / "grub_svl_kernel.cfg").read_text(encoding="utf-8")
        self.assertIn("mitigations=off", grub)
        self.assertIn("iommu=pt", grub)
        self.assertIn("apparmor=0", grub)

        modules = (DEBIAN13_DIR / "svl-coreos2-modules.conf").read_text(encoding="utf-8")
        self.assertIn("msr", modules)
        self.assertIn("cpuid", modules)

        core_svc = (DEBIAN13_DIR / "svl-coreos2.service").read_text(encoding="utf-8")
        self.assertIn("ProtectKernelTunables=false", core_svc)
        self.assertIn("ProtectKernelModules=false", core_svc)

        svl_py_svc = (ROOT_DIR / "deploy" / "systemd" / "svl-python-os.service").read_text(encoding="utf-8")
        self.assertNotIn("docker.service", svl_py_svc)

    def test_jedi_v12_reprogrammer_unlocked_verification(self) -> None:
        pkt = jedi_reprog.verify_jedi_v12_native_packet()
        self.assertTrue(pkt["ok"])
        self.assertTrue(pkt["spec"]["bare_metal_standalone"])
        self.assertTrue(pkt["spec"]["kernel_unlocked"])
        self.assertTrue(pkt["bare_metal_verification"]["ok"])
        self.assertTrue(pkt["bare_metal_verification"]["kernel_unlocked"])
        self.assertTrue(all(pkt["bare_metal_verification"]["checks"].values()))


if __name__ == "__main__":
    unittest.main()
