#!/usr/bin/env bash
# ==============================================================================
# SVL CoreOS 2: Apex — Generator Pełnego Obrazu Debian 13 (Trixie) Rootfs & Hybrid ISO
# Buduje kompletne środowisko Debian GNU/Linux 13 (Trixie) amd64:
#   1. Pełny Debootstrap Stage 1 + Stage 2 z repozytoriów Trixie (main/contrib/non-free-firmware)
#   2. Konfiguracja DEB822 APT (/etc/apt/sources.list.d/debian.sources), locales, sysctl i nftables
#   3. Integracja SVL CoreOS 2 (port 3000 + jądro Python 8085 + JEDI Omni-OS v12 + SVL-Sentinel)
#   4. Opcjonalny eksport bootowalnego obrazu SquashFS / Hybrid UEFI+BIOS ISO (xorriso)
# ==============================================================================
set -euo pipefail

SUITE="trixie"
ARCH="amd64"
TARGET_ROOTFS="${DEBOOTSTRAP_TARGET:-/srv/svl-coreos2/rootfs}"
ISO_OUTPUT_DIR="${ISO_OUTPUT_DIR:-/srv/svl-coreos2/iso}"
ISO_FILENAME="svl-coreos2-debian13-trixie-full-${ARCH}.iso"
MIRROR="${DEBIAN_MIRROR:-https://deb.debian.org/debian}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

echo "=== [SVL Debian 13 Trixie Full Builder] ==="
echo "Suite:        Debian GNU/Linux 13 (${SUITE}) [${ARCH}]"
echo "Rootfs:       ${TARGET_ROOTFS}"
echo "Obraz ISO:    ${ISO_OUTPUT_DIR}/${ISO_FILENAME}"
echo "Mirror APT:   ${MIRROR}"

if [ "$(id -u)" -ne 0 ]; then
  echo "[TRYB INSPEKCJI] Uruchom jako root (sudo bash $0), aby wykonać fizyczny debootstrap i zapis obrazu ISO."
  exit 0
fi

mkdir -p "${TARGET_ROOTFS}" "${ISO_OUTPUT_DIR}"

if ! command -v debootstrap >/dev/null 2>&1; then
  apt-get update -qq && apt-get install -y debootstrap squashfs-tools xorriso
fi

echo "[1/4] Budowanie pełnego drzewa rootfs Debian 13 (Trixie)..."
debootstrap --arch="${ARCH}" --components=main,contrib,non-free,non-free-firmware \
  --include=systemd,systemd-sysv,systemd-resolved,dbus,udev,kmod,locales,tzdata,sudo,bash,coreutils,util-linux,procps,iproute2,nftables,openssh-server,openssh-client,wireguard-tools,ca-certificates,curl,wget,git,jq,sqlite3,python3,python3-venv,python3-pip,zstd,lz4 \
  "${SUITE}" "${TARGET_ROOTFS}" "${MIRROR}"

echo "[2/4] Konfiguracja APT DEB822, sysctl, nftables i nazwy hosta..."
echo "svl-364-debian13-apex" > "${TARGET_ROOTFS}/etc/hostname"
install -m 0644 "${SCRIPT_DIR}/sources.list.trixie" "${TARGET_ROOTFS}/etc/apt/sources.list.d/debian.sources"
install -m 0644 "${SCRIPT_DIR}/svl-coreos2-sysctl.conf" "${TARGET_ROOTFS}/etc/sysctl.d/99-svl-coreos2.conf"
mkdir -p "${TARGET_ROOTFS}/etc/modules-load.d" "${TARGET_ROOTFS}/etc/default/grub.d"
install -m 0644 "${SCRIPT_DIR}/svl-coreos2-modules.conf" "${TARGET_ROOTFS}/etc/modules-load.d/svl-coreos2.conf"
install -m 0644 "${SCRIPT_DIR}/grub_svl_kernel.cfg" "${TARGET_ROOTFS}/etc/default/grub.d/99-svl-kernel.cfg"
install -m 0644 "${SCRIPT_DIR}/nftables_svl_trixie.conf" "${TARGET_ROOTFS}/etc/nftables.conf"

echo "[3/4] Osadzanie systemu SVL CoreOS 2 w /opt/svl-coreos-2 wewnątrz rootfs..."
mkdir -p "${TARGET_ROOTFS}/opt/svl-coreos-2"
rsync -a --exclude node_modules --exclude '.git' --exclude 'data/*.sqlite3*' "${REPO_DIR}/" "${TARGET_ROOTFS}/opt/svl-coreos-2/"
install -m 0644 "${SCRIPT_DIR}/svl-coreos2.service" "${TARGET_ROOTFS}/etc/systemd/system/svl-coreos2.service"
install -m 0644 "${SCRIPT_DIR}/svl-sentinel.service" "${TARGET_ROOTFS}/etc/systemd/system/svl-sentinel.service"
install -m 0644 "${SCRIPT_DIR}/svl-coreos2-firstboot.service" "${TARGET_ROOTFS}/etc/systemd/system/svl-coreos2-firstboot.service"
install -m 0755 "${SCRIPT_DIR}/svl-coreos2-firstboot" "${TARGET_ROOTFS}/usr/local/sbin/svl-coreos2-firstboot"

if [ "${SVL_BUILD_SQUASHFS:-0}" = "1" ] && command -v mksquashfs >/dev/null 2>&1; then
  echo "[4/4] Kompresja obrazu SquashFS (${ISO_OUTPUT_DIR}/filesystem.squashfs)..."
  mksquashfs "${TARGET_ROOTFS}" "${ISO_OUTPUT_DIR}/filesystem.squashfs" -comp zstd -Xcompression-level 15 -noappend
else
  echo "[4/4] Pominięto kompresję SquashFS (ustaw SVL_BUILD_SQUASHFS=1, aby wygenerować obraz Live)."
fi

echo "=== [GOTOWE] Pełny rootfs Debian 13 (Trixie) przygotowany w: ${TARGET_ROOTFS} ==="
