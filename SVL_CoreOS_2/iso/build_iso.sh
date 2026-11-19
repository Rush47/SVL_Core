#!/usr/bin/env bash
# ==============================================================================
# SVL CoreOS 2: Apex — budowa bootowalnego obrazu ISO (Debian 13 Trixie + SVL)
#
# Uruchamiać jako root w Debianie 13 (np. kontener debian:trixie --privileged):
#   docker run --rm --privileged -v "$PWD:/src" -w /src debian:trixie bash SVL_CoreOS_2/iso/build_iso.sh
# Wynik: out/svl-coreos2-apex-<data>-amd64.iso (+ .sha256)
#
# Obraz: Debian 13 live (z instalatorem na dysk), SVL CoreOS 2 w /opt/svl-coreos-2,
# usługi svl-coreos2 + svl-sentinel startują przy rozruchu, token tworzony przy pierwszym starcie.
# ==============================================================================
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK_DIR="${SVL_ISO_WORKDIR:-/tmp/svl-coreos2-iso}"
OUT_DIR="${SVL_ISO_OUT:-${SRC_DIR}/out}"
MIRROR="${DEBIAN_MIRROR:-http://deb.debian.org/debian/}"
STAMP="$(date -u +%Y%m%d)"

if [ "$(id -u)" -ne 0 ]; then echo "[BŁĄD] Uruchom jako root." >&2; exit 1; fi
. /etc/os-release
if [ "${VERSION_CODENAME:-}" != "trixie" ]; then
  echo "[BŁĄD] Budowa wymaga Debiana 13 (trixie); wykryto: ${PRETTY_NAME:-?}" >&2
  exit 1
fi

echo "=== [1/5] Narzędzia budowy (live-build) ==="
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends live-build rsync ca-certificates

echo "=== [2/5] Konfiguracja live-build ==="
rm -rf "${WORK_DIR}" && mkdir -p "${WORK_DIR}" && cd "${WORK_DIR}"
lb config \
  --distribution trixie \
  --architectures amd64 \
  --archive-areas "main contrib non-free non-free-firmware" \
  --mirror-bootstrap "${MIRROR}" \
  --mirror-binary "${MIRROR}" \
  --binary-images iso-hybrid \
  --debian-installer live \
  --iso-application "SVL CoreOS 2 Apex" \
  --iso-volume "SVL_COREOS2" \
  --iso-publisher "Rush47/SVL_Core" \
  --bootappend-live "boot=live components hostname=svl-coreos2 username=svl locales=pl_PL.UTF-8 keyboard-layouts=pl timezone=Europe/Warsaw" \
  --memtest none

cat > config/package-lists/svl-coreos2.list.chroot <<'PKG'
linux-image-amd64
systemd-sysv
live-boot
live-config
live-config-systemd
locales
keyboard-configuration
sudo
network-manager
openssh-server
openssh-client
nftables
curl
ca-certificates
git
gh
rsync
jq
sqlite3
nodejs
npm
python3
python3-venv
python3-pip
PKG

echo "=== [3/5] Pliki SVL CoreOS 2 w obrazie ==="
INC=config/includes.chroot
mkdir -p "${INC}/opt/svl-coreos-2" "${INC}/etc/systemd/system" "${INC}/usr/local/sbin" "${INC}/etc"
rsync -a \
  --exclude node_modules --exclude dist --exclude out --exclude '__pycache__' \
  --exclude 'logi/*.txt' --exclude 'data/*.sqlite3*' --exclude 'data/*.secret' --exclude 'data/svl_coreos2_*.json' \
  --exclude '.env' --exclude '.git' \
  "${SRC_DIR}/" "${INC}/opt/svl-coreos-2/"
install -m 0644 "${SRC_DIR}/SVL_CoreOS_2/debian13/svl-coreos2.service" "${INC}/etc/systemd/system/"
install -m 0644 "${SRC_DIR}/SVL_CoreOS_2/debian13/svl-coreos2-firstboot.service" "${INC}/etc/systemd/system/"
install -m 0644 "${SRC_DIR}/SVL_CoreOS_2/debian13/svl-sentinel.service" "${INC}/etc/systemd/system/"
install -m 0755 "${SRC_DIR}/SVL_CoreOS_2/debian13/svl-coreos2-firstboot" "${INC}/usr/local/sbin/"
mkdir -p "${INC}/etc/sysctl.d"
install -m 0644 "${SRC_DIR}/SVL_CoreOS_2/debian13/svl-coreos2-sysctl.conf" "${INC}/etc/sysctl.d/99-svl-coreos2.conf"
GIT_REV="$(git -C "${SRC_DIR}" rev-parse --short HEAD 2>/dev/null || echo nieznany)"
cat > "${INC}/etc/svl-coreos-release" <<REL
NAME="SVL CoreOS 2"
VERSION="2.0.0-Apex"
BASE="Debian GNU/Linux 13 (trixie)"
SOURCE="https://github.com/Rush47/SVL_Core@${GIT_REV}"
BUILD_DATE="${STAMP}"
REL
cat > "${INC}/etc/motd" <<'MOTD'

  SVL CoreOS 2: Apex (Debian 13 Trixie)
  Interfejs:  http://<adres-tego-komputera>:3000
  Token:      sudo grep SVL_OPERATOR_TOKEN /etc/svl-coreos2/svl.env
  Stan:       systemctl status svl-coreos2 svl-sentinel
  Klucze AI/GitHub: sudo nano /etc/svl-coreos2/svl.env && sudo systemctl restart svl-coreos2

MOTD

cat > config/hooks/normal/0500-svl-coreos2.hook.chroot <<'HOOK'
#!/bin/sh
# Budowa SVL CoreOS 2 wewnątrz obrazu: zależności Node i Python, interfejs, usługi.
set -e
cd /opt/svl-coreos-2
npm ci --no-audit --no-fund
npx vite build
python3 -m venv /opt/svl-coreos-2/.venv
/opt/svl-coreos-2/.venv/bin/pip install --no-cache-dir -r backend/requirements.txt
npm cache clean --force || true
systemctl enable svl-coreos2-firstboot.service svl-coreos2.service svl-sentinel.service ssh.service
echo "svl-coreos2" > /etc/hostname
HOOK
chmod +x config/hooks/normal/0500-svl-coreos2.hook.chroot

echo "=== [4/5] Budowa obrazu (lb build) ==="
lb build 2>&1 | tee "${WORK_DIR}/lb-build.log"
ISO="$(ls -1 "${WORK_DIR}"/*.iso 2>/dev/null | head -n 1 || true)"
if [ -z "${ISO}" ]; then
  echo "[BŁĄD] lb build nie utworzył obrazu ISO — zobacz ${WORK_DIR}/lb-build.log" >&2
  exit 1
fi

echo "=== [5/5] Wynik ==="
mkdir -p "${OUT_DIR}"
TARGET="${OUT_DIR}/svl-coreos2-apex-${STAMP}-amd64.iso"
mv "${ISO}" "${TARGET}"
( cd "${OUT_DIR}" && sha256sum "$(basename "${TARGET}")" > "$(basename "${TARGET}").sha256" )
ls -lh "${TARGET}"
echo "Gotowe: ${TARGET}"
