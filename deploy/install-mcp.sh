#!/usr/bin/env bash
# Instaluje cloudflared (jeśli brak) i usługę systemd svl-mcp (start po network-online.target).
# Użycie: sudo bash deploy/install-mcp.sh [katalog_aplikacji=/opt/svl-python-os] [użytkownik=svlos]
set -euo pipefail
APP_DIR="${1:-/opt/svl-python-os}"
SVC_USER="${2:-svlos}"
HERE="$(cd "$(dirname "$0")" && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Uruchom jako root (sudo)." >&2
  exit 1
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  arch="$(dpkg --print-architecture 2>/dev/null || uname -m)"
  case "$arch" in
    amd64|x86_64) cf_arch=amd64 ;;
    arm64|aarch64) cf_arch=arm64 ;;
    armhf|armv7l) cf_arch=arm ;;
    *) echo "Nieobsługiwana architektura: $arch — zainstaluj cloudflared ręcznie." >&2; exit 1 ;;
  esac
  echo "Instaluję cloudflared ($cf_arch)…"
  curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}"
  chmod 0755 /usr/local/bin/cloudflared
fi
cloudflared --version

install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$APP_DIR/data"
install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 /var/log/svl-os
sed -e "s#/opt/svl-python-os#${APP_DIR}#g" -e "s#^User=.*#User=${SVC_USER}#" -e "s#^Group=.*#Group=${SVC_USER}#" \
  "$HERE/systemd/svl-mcp.service" > /etc/systemd/system/svl-mcp.service
systemctl enable systemd-networkd-wait-online.service NetworkManager-wait-online.service 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now svl-mcp.service

echo
echo "Gotowe. Za ~15 s publiczny adres będzie w: $APP_DIR/data/svl_mcp_tunnel.json"
echo "Token i gotowe konfiguracje klientów (tylko root/$SVC_USER): $APP_DIR/data/svl_mcp_connector.secret"
echo "Logi: journalctl -u svl-mcp -f"
