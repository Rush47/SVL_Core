#!/usr/bin/env bash
# ==============================================================================
# SVL-364 — Modernizacja Universal MCP Hub (bez stałego IP, jak Hamachi)
#
# Uruchamiany bezpośrednio na hoście SVL-364. Nie przerywa ani nie nadpisuje
# żadnych istniejących usług (svl-coreos2, svl-sentinel, ollama, svl-comfyui,
# svl-ship-ollama-tunnel, ssh).
#
# Użycie:
#   sudo bash SVL_CoreOS_2/debian13/install_svl364_mcp_zeroip.sh
# Opcje:
#   SVL_ROOT=/opt/svl-coreos-2        katalog SVL na SVL-364 (auto-wykrywany)
#   SVL_INSTALL_TAILSCALE=1           zainstaluj też Tailscale (mesh + stały HTTPS Funnel)
#   MCP_TUNNEL=auto                   auto | cloudflared | tailscale | ngrok | ssh-reverse
# ==============================================================================
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "[BŁĄD] Uruchom jako root: sudo bash $0" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -n "${SVL_ROOT:-}" ]]; then
  TARGET_DIR="$SVL_ROOT"
elif [[ -d /opt/svl-coreos-2 ]]; then
  TARGET_DIR="/opt/svl-coreos-2"
elif [[ -d /opt/svl-python-os ]]; then
  TARGET_DIR="/opt/svl-python-os"
else
  TARGET_DIR="$REPO_DIR"
fi

ENV_FILE="/etc/svl-coreos2/svl.env"
[[ -f "$ENV_FILE" ]] || ENV_FILE="/etc/svl-os/svl.env"
[[ -f "$ENV_FILE" ]] || ENV_FILE="${TARGET_DIR}/.env"

mkdir -p "$(dirname "$ENV_FILE")"
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"

ensure_env() {
  local key="$1" val="$2"
  if ! grep -qE "^${key}=" "$ENV_FILE" 2>/dev/null; then
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

ensure_env "MCP_NODE_NAME" "svl-364"
ensure_env "MCP_TUNNEL" "${MCP_TUNNEL:-auto}"
ensure_env "MCP_PORT" "${MCP_PORT:-3334}"
ensure_env "MCP_ALLOW_SHELL" "1"
ensure_env "MCP_READ_ONLY" "0"
ensure_env "SVL_BASE_URL" "http://127.0.0.1:3000"

SVC_USER="${SVC_USER:-root}"
if [[ "$TARGET_DIR" == "/opt/svl-python-os" ]] && id -u svlos >/dev/null 2>&1; then
  SVC_USER="svlos"
fi

echo "=== SVL-364 Universal MCP Hub (Zero-IP / Mesh) ==="
echo "Katalog: ${TARGET_DIR} · Env: ${ENV_FILE} · Użytkownik usługi: ${SVC_USER}"

SVL_INSTALL_TAILSCALE="${SVL_INSTALL_TAILSCALE:-0}" \
  bash "${TARGET_DIR}/deploy/install-mcp.sh" "${TARGET_DIR}" "${SVC_USER}"

echo
echo "=== Weryfikacja wszystkich usług na SVL-364 ==="
for svc in svl-coreos2.service svl-python-os.service svl-gateway.service svl-sentinel.service svl-mcp.service svl-comfyui.service svl-ship-ollama-tunnel.service ollama.service tailscaled.service ssh.service; do
  if systemctl list-unit-files "$svc" >/dev/null 2>&1; then
    printf "  %-34s : %s\n" "$svc" "$(systemctl is-active "$svc" 2>/dev/null || echo inactive)"
  fi
done

echo
echo "Aby uzyskać publiczny adres MCP (bez stałego IP) oraz gotowy JSON konektora:"
echo "  sudo svl-mcp-info"
