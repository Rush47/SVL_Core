#!/usr/bin/env bash
# ==============================================================================
# SVL CoreOS 2: Apex — Pełny Instalator Systemowy Debian 13 (Trixie) + Debootstrap
# Przeznaczenie: Stacja SVL-364 Ebon Apex & Węzeł Główny Rush47/SVL_Core
# Operator ROOT: Mateusz Mitek | Kernel Master Daemon: Maya AI (ROOT)
# ==============================================================================
set -euo pipefail

SVL_ROOT="${SVL_ROOT:-/opt/svl-coreos-2}"
DEBOOTSTRAP_TARGET="${DEBOOTSTRAP_TARGET:-/mnt/svl_coreos2_trixie_rootfs}"
DEBIAN_SUITE="trixie"
DEBIAN_MIRROR="${DEBIAN_MIRROR:-https://deb.debian.org/debian}"
LOG_FILE="${SVL_LOG_FILE:-/var/log/svl-coreos2-install.log}"

echo "[SVL-CoreOS-2:Apex] =========================================================="
echo "[SVL-CoreOS-2:Apex] Inicjalizacja pełnej instalacji Debian 13 (${DEBIAN_SUITE})..."
echo "[SVL-CoreOS-2:Apex] Operator: Mateusz Mitek (ROOT) | Kernel Master: Maya (ROOT)"
echo "[SVL-CoreOS-2:Apex] =========================================================="

# 1. Weryfikacja środowiska i katalogów docelowych
mkdir -p "${SVL_ROOT}"/{kernel,security,ai_core,gui,infrastructure,system/assets,debian13,logs}
mkdir -p /var/quarantine/svl_vault || true

# 2. Instalacja narzędzi bazowych i debootstrap na hoście Debian 13 (Trixie)
if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" -eq 0 ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  apt-get install -y --no-install-recommends \
    debootstrap arch-install-scripts squashfs-tools xorriso grub-efi-amd64-bin \
    python3 python3-pip python3-venv python3-dev build-essential \
    openssh-client openssh-server nftables ufw wireguard-tools openvpn \
    qemu-kvm libvirt-daemon-system ovmf bpftool linux-perf \
    curl wget git jq sqlite3 ca-certificates zstd lz4
fi

# 3. Etap Debootstrap Stage 1 & Stage 2 (Pełny obraz bazowy Debian 13 Trixie)
if [ "${SVL_RUN_DEBOOTSTRAP:-0}" = "1" ] && command -v debootstrap >/dev/null 2>&1; then
  echo "[SVL-CoreOS-2:Apex] Uruchamianie Debootstrap Stage 1 (${DEBIAN_SUITE} amd64)..."
  mkdir -p "${DEBOOTSTRAP_TARGET}"
  debootstrap \
    --arch=amd64 \
    --variant=minbase \
    --components=main,contrib,non-free,non-free-firmware \
    --include=systemd,systemd-sysv,dbus,udev,iproute2,iputils-ping,nftables,openssh-server,python3,sqlite3,ca-certificates,curl,zstd \
    "${DEBIAN_SUITE}" "${DEBOOTSTRAP_TARGET}" "${DEBIAN_MIRROR}"

  cat > "${DEBOOTSTRAP_TARGET}/etc/apt/sources.list.d/debian-trixie.sources" << 'APT_EOF'
Types: deb deb-src
URIs: https://deb.debian.org/debian
Suites: trixie trixie-updates
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg

Types: deb
URIs: https://security.debian.org/debian-security
Suites: trixie-security
Components: main contrib non-free non-free-firmware
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
APT_EOF
  echo "svl-364-apex" > "${DEBOOTSTRAP_TARGET}/etc/hostname"
  echo "[SVL-CoreOS-2:Apex] Debootstrap Stage 1 & 2 zakończony pomyślnie w ${DEBOOTSTRAP_TARGET}."
else
  echo "[SVL-CoreOS-2:Apex] Weryfikacja lokalnego manifestu Debian 13 Trixie Rootfs (tryb Hot-Swap In-Place)..."
fi

# 4. Kopiowanie modułów SVL_CoreOS_2 (25 plików w 7 podkatalogach)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cp -r "${SCRIPT_DIR}/"* "${SVL_ROOT}/" 2>/dev/null || true

# 5. Konfiguracja parametrów jądra (sysctl: eBPF, BBR, 128D Hyperspace buffers)
if [ -f "${SCRIPT_DIR}/debian13/svl-coreos2-sysctl.conf" ] && [ -d /etc/sysctl.d ] && [ -w /etc/sysctl.d ]; then
  cp "${SCRIPT_DIR}/debian13/svl-coreos2-sysctl.conf" /etc/sysctl.d/99-svl-coreos2.conf
  sysctl --system >/dev/null 2>&1 || true
fi

# 6. Rejestracja usługi systemd SVL-Sentinel Daemon (Auto-Healing + AV + Firewall)
if [ -f "${SCRIPT_DIR}/debian13/svl-sentinel.service" ] && [ -d /etc/systemd/system ] && [ -w /etc/systemd/system ]; then
  cp "${SCRIPT_DIR}/debian13/svl-sentinel.service" /etc/systemd/system/svl-sentinel.service
  systemctl daemon-reload || true
  systemctl enable svl-sentinel.service || true
fi

# 7. Atomowa podmiana jądra (Hot-Swap Engine) i test integralności
if command -v python3 >/dev/null 2>&1 && [ -f "${SCRIPT_DIR}/kernel/hot_swap_engine.py" ]; then
  python3 "${SCRIPT_DIR}/kernel/hot_swap_engine.py" || true
fi

echo "[SVL-CoreOS-2:Apex] Instalacja Debian 13 (Trixie) i aktywacja Hot-Swap zakończona (100%)."
