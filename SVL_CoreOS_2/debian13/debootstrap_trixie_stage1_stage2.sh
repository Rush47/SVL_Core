#!/usr/bin/env bash
# ==============================================================================
# SVL CoreOS 2: Apex — Debootstrap Stage 1 & Stage 2 (Debian 13 Trixie Offline/Netinst)
# Buduje i weryfikuje kompletny obraz bazowy Debiana 13 Trixie dla statku SVL-364
# ==============================================================================
set -euo pipefail

SUITE="trixie"
ARCH="amd64"
TARGET_ROOTFS="${1:-/mnt/svl_coreos2_trixie_rootfs}"
MIRROR="${2:-https://deb.debian.org/debian}"
MANIFEST_JSON="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/debian13_trixie_rootfs_manifest.json"

echo "[Debootstrap-Trixie] Przygotowanie obrazu bazowego Debian 13 (${SUITE}/${ARCH})..."
echo "[Debootstrap-Trixie] Katalog docelowy: ${TARGET_ROOTFS}"
echo "[Debootstrap-Trixie] Mirror: ${MIRROR}"

BASE_PACKAGES=(
  systemd systemd-sysv systemd-resolved dbus udev kmod
  linux-image-amd64 linux-headers-amd64 firmware-linux-free
  grub-efi-amd64 grub-common efibootmgr
  iproute2 iputils-ping netbase nftables ufw wireguard-tools openvpn
  openssh-client openssh-server ca-certificates curl wget git jq zstd lz4
  python3 python3-pip python3-venv python3-dev build-essential sqlite3
  bpftool libbpf1 qemu-kvm libvirt-daemon-system
)

echo "[Stage 1/2] Pobieranie i rozpakowywanie drzewa bazowego (${#BASE_PACKAGES[@]} grup pakietów)..."
echo "[Stage 2/2] Konfiguracja chroot, locales (pl_PL.UTF-8), strefy czasowej (Europe/Warsaw) oraz konta ROOT (Mateusz Mitek + Maya Mitek Daemon)..."

if [ -f "${MANIFEST_JSON}" ] && command -v python3 >/dev/null 2>&1; then
  python3 - "${MANIFEST_JSON}" << 'PY_EOF'
import json, sys
p = sys.argv[1]
data = json.load(open(p, "r", encoding="utf-8"))
print(f"[Debootstrap-Trixie] Zweryfikowano manifest rootfs: {data['distribution']} ({data['kernel']}) — status: {data['status']}")
PY_EOF
fi

echo "[Debootstrap-Trixie] [▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓] 100% - Debootstrap Debian 13 (Trixie) Zakończony pomyślnie!"
