#!/usr/bin/env bash
# Instaluje SVL Universal MCP Hub (wszystkie usługi + tunel internetowy bez stałego IP).
# Domyślnie instaluje cloudflared (działa natychmiast bez konta, za NAT/CGNAT, z fallbackiem HTTP/2).
# Opcjonalnie: SVL_INSTALL_TAILSCALE=1 instaluje również Tailscale (sieć mesh jak Hamachi + stały HTTPS Funnel).
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

if [[ "${SVL_INSTALL_TAILSCALE:-0}" == "1" ]] && ! command -v tailscale >/dev/null 2>&1; then
  echo "Instaluję Tailscale (sieć mesh bez stałego IP jak Hamachi + Funnel HTTPS)…"
  curl -fsSL https://tailscale.com/install.sh | sh
  systemctl enable --now tailscaled.service || true
fi

if id -u "$SVC_USER" >/dev/null 2>&1; then
  install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 "$APP_DIR/data"
  install -d -o "$SVC_USER" -g "$SVC_USER" -m 0750 /var/log/svl-os
else
  install -d -m 0750 "$APP_DIR/data"
  install -d -m 0750 /var/log/svl-os
fi

sed -e "s#/opt/svl-python-os#${APP_DIR}#g" -e "s#^User=.*#User=${SVC_USER}#" -e "s#^Group=.*#Group=${SVC_USER}#" \
  "$HERE/systemd/svl-mcp.service" > /etc/systemd/system/svl-mcp.service

cat > /usr/local/bin/svl-mcp-info <<EOF
#!/usr/bin/env bash
set -euo pipefail
echo "=== SVL Universal MCP Hub (${APP_DIR}) ==="
systemctl is-active svl-mcp.service 2>/dev/null || true
if [[ -f "${APP_DIR}/data/svl_mcp_tunnel.json" ]]; then
  echo "--- Stan tunelu Zero-IP ---"
  cat "${APP_DIR}/data/svl_mcp_tunnel.json"
fi
if [[ -r "${APP_DIR}/data/svl_mcp_connector.secret" ]]; then
  echo "--- Dane konektora (z tokenem) ---"
  cat "${APP_DIR}/data/svl_mcp_connector.secret"
else
  echo "(Uruchom z sudo, aby zobaczyć token w ${APP_DIR}/data/svl_mcp_connector.secret)"
fi
EOF
chmod 0755 /usr/local/bin/svl-mcp-info

systemctl enable systemd-networkd-wait-online.service NetworkManager-wait-online.service 2>/dev/null || true
systemctl daemon-reload
systemctl enable --now svl-mcp.service

echo
echo "Gotowe! Wszystkie dotychczasowe usługi pozostały nienaruszone."
echo "Za ~15 s publiczny adres Zero-IP i mesh będzie w: $APP_DIR/data/svl_mcp_tunnel.json"
echo "Pełna konfiguracja klientów (tylko root/$SVC_USER): sudo svl-mcp-info"
echo "Logi: journalctl -u svl-mcp -f"
