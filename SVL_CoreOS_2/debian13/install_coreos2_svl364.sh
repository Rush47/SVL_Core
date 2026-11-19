#!/usr/bin/env bash
# ==============================================================================
# SVL CoreOS 2: Apex — instalator na Debianie 13 (Trixie)
#
# Instaluje CAŁY system SVL (brama Node + jądro Python + interfejs) jako usługi systemd:
#   svl-coreos2.service  — SVL CoreOS 2 (port 3000, jądro Python 8085)
#   svl-sentinel.service — demon nadzoru (pomiary, samonaprawa, powiadomienia Mayi)
# Każdy krok raportuje prawdziwy wynik; log: /var/log/svl-coreos2-install.log
#
# Użycie (jako root, z katalogu repozytorium):
#   sudo bash SVL_CoreOS_2/debian13/install_coreos2_svl364.sh
# Opcje (zmienne środowiskowe):
#   SVL_ROOT=/opt/svl-coreos-2      katalog instalacji
#   SVL_INSTALL_OLLAMA=1            zainstaluj też Ollamę (oficjalny skrypt ollama.com)
#   SVL_RUN_DEBOOTSTRAP=1           dodatkowo zbuduj rootfs Debiana 13 (DEBOOTSTRAP_TARGET)
# ==============================================================================
set -uo pipefail

SVL_ROOT="${SVL_ROOT:-/opt/svl-coreos-2}"
ENV_DIR="/etc/svl-coreos2"
ENV_FILE="${ENV_DIR}/svl.env"
STATE_DIR="/var/lib/svl-coreos2"
LOG_FILE="${SVL_LOG_FILE:-/var/log/svl-coreos2-install.log}"
DEBOOTSTRAP_TARGET="${DEBOOTSTRAP_TARGET:-/srv/svl-coreos2/rootfs}"
DEBIAN_MIRROR="${DEBIAN_MIRROR:-https://deb.debian.org/debian}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [ "$(id -u)" -ne 0 ]; then
  echo "[BŁĄD] Uruchom jako root: sudo bash $0" >&2
  exit 1
fi
mkdir -p "$(dirname "${LOG_FILE}")"
exec > >(tee -a "${LOG_FILE}") 2>&1

RESULTS=()
FAILED=0
step() {
  local name="$1"; shift
  echo "[$(date -u +%FT%TZ)] ▶ ${name}"
  if "$@"; then
    RESULTS+=("OK       ${name}")
  else
    RESULTS+=("BŁĄD     ${name}")
    FAILED=1
  fi
}
skip() { RESULTS+=("POMINIĘTO ${1} — ${2}"); echo "[$(date -u +%FT%TZ)] ⏭ ${1}: ${2}"; }

echo "=== SVL CoreOS 2: Apex — instalacja $(date -u +%FT%TZ) ==="
. /etc/os-release 2>/dev/null || true
echo "Host: ${PRETTY_NAME:-nieznany} · jądro $(uname -r) · repozytorium: ${REPO_DIR}"
if [ "${VERSION_ID:-}" != "13" ]; then
  echo "[UWAGA] To nie jest Debian 13 (${PRETTY_NAME:-?}). Instalacja zostanie wykonana, ale wspierany jest Debian 13 (Trixie)."
fi

install_packages() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y &&
  apt-get install -y --no-install-recommends \
    nodejs npm python3 python3-venv python3-pip git rsync curl ca-certificates jq sqlite3 \
    openssh-client nftables gh debootstrap
}

copy_system() {
  mkdir -p "${SVL_ROOT}" &&
  rsync -a --delete \
    --exclude node_modules --exclude dist --exclude '__pycache__' --exclude 'logi/*.txt' \
    --exclude 'data/*.sqlite3*' --exclude 'data/*.secret' --exclude '.env' \
    "${REPO_DIR}/" "${SVL_ROOT}/"
}

build_system() {
  cd "${SVL_ROOT}" &&
  npm ci --no-audit --no-fund &&
  npx vite build &&
  python3 -m venv "${SVL_ROOT}/.venv" &&
  "${SVL_ROOT}/.venv/bin/pip" install --quiet -r backend/requirements.txt
}

write_env() {
  mkdir -p "${ENV_DIR}" "${STATE_DIR}" &&
  if [ ! -f "${ENV_FILE}" ]; then
    umask 077
    cat > "${ENV_FILE}" <<EOF
# SVL CoreOS 2: Apex — konfiguracja (tylko root)
SVL_OPERATOR_TOKEN=$(python3 -c 'import secrets; print(secrets.token_urlsafe(48))')
SVL_BIND_HOST=0.0.0.0
PORT=3000
SVL_SQLITE_PATH=${STATE_DIR}/svl_os.sqlite3
SVL_LOG_DIR=${SVL_ROOT}/logi
SVL_COREOS_EDITION=Apex
OLLAMA_HOST=http://127.0.0.1:11434
OLLAMA_PREFERRED_MODEL=llama3.2-vision:11b
# Ollama ze statku SVL-364 jako standardowy silnik przez SSH:
#   ustaw SVL_SHIP_OLLAMA=1 — gateway sam zestawi tunel ssh do aliasu SVL_SSH_TARGET
#   (konfiguracja ~/.ssh/config użytkownika svl) i skieruje na niego OLLAMA_HOST.
#   NIE włączaj jednocześnie usługi svl-ship-ollama-tunnel.service (dublowałaby port).
SVL_SHIP_OLLAMA=0
SVL_SSH_TARGET=Ship
SVL_SHIP_OLLAMA_PORT=11434
SVL_SHIP_OLLAMA_LOCAL_PORT=11434
# Uzupełnij według potrzeb:
GITHUB_TOKEN=
GEMINI_API_KEY=
EOF
    echo "Utworzono ${ENV_FILE} z nowym SVL_OPERATOR_TOKEN (odczyt: sudo grep SVL_OPERATOR_TOKEN ${ENV_FILE})."
  else
    echo "Zachowano istniejący ${ENV_FILE}."
  fi
}

install_services() {
  cat > /etc/systemd/system/svl-coreos2.service <<EOF
[Unit]
Description=SVL CoreOS 2: Apex (brama SVL + jądro Python + interfejs)
After=network-online.target ollama.service
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${SVL_ROOT}
EnvironmentFile=${ENV_FILE}
Environment=NODE_ENV=production
Environment=PATH=${SVL_ROOT}/.venv/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/usr/bin/npx tsx server.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  sed "s#/opt/svl-coreos-2#${SVL_ROOT}#g" "${SCRIPT_DIR}/svl-sentinel.service" > /etc/systemd/system/svl-sentinel.service &&
  if [ -f "${SCRIPT_DIR}/svl-coreos2-sysctl.conf" ]; then
    cp "${SCRIPT_DIR}/svl-coreos2-sysctl.conf" /etc/sysctl.d/99-svl-coreos2.conf && sysctl --system >/dev/null
  fi
  systemctl daemon-reload &&
  systemctl enable --now svl-coreos2.service &&
  systemctl enable --now svl-sentinel.service
}

install_ollama() {
  command -v ollama >/dev/null 2>&1 || curl -fsSL https://ollama.com/install.sh | sh
}

# Maksymalna wydajność Ollamy: modele zostają w pamięci, flash attention, skwantowany cache KV,
# Bielik i Maya załadowane jednocześnie (bez wymiany modeli między wiadomościami).
tune_ollama() {
  mkdir -p /etc/systemd/system/ollama.service.d &&
  cat > /etc/systemd/system/ollama.service.d/svl-wydajnosc.conf <<'CONF'
[Service]
Environment=OLLAMA_KEEP_ALIVE=-1
Environment=OLLAMA_FLASH_ATTENTION=1
Environment=OLLAMA_KV_CACHE_TYPE=q8_0
Environment=OLLAMA_MAX_LOADED_MODELS=2
Environment=OLLAMA_NUM_PARALLEL=1
LimitMEMLOCK=infinity
Nice=-5
CONF
  systemctl daemon-reload &&
  systemctl restart ollama.service &&
  echo "Ollama: ustawienia wydajności w /etc/systemd/system/ollama.service.d/svl-wydajnosc.conf"
}

verify_running() {
  local i
  for i in $(seq 1 30); do
    if curl -fsS http://127.0.0.1:3000/api/health >/dev/null 2>&1; then
      echo "SVL CoreOS 2 odpowiada na http://127.0.0.1:3000"
      return 0
    fi
    sleep 2
  done
  echo "SVL CoreOS 2 nie odpowiada po 60 s — sprawdź: journalctl -u svl-coreos2 -n 100"
  return 1
}

run_debootstrap() {
  mkdir -p "${DEBOOTSTRAP_TARGET}" &&
  debootstrap --arch=amd64 --variant=minbase \
    --include=systemd,systemd-sysv,dbus,udev,iproute2,openssh-server,python3,sqlite3,ca-certificates,curl \
    trixie "${DEBOOTSTRAP_TARGET}" "${DEBIAN_MIRROR}" &&
  echo "svl-364-apex" > "${DEBOOTSTRAP_TARGET}/etc/hostname"
}

step "Pakiety systemowe (apt)" install_packages
step "Kopiowanie SVL CoreOS 2 do ${SVL_ROOT}" copy_system
step "Budowa (npm ci, vite build, venv Python)" build_system
step "Konfiguracja ${ENV_FILE}" write_env
if [ "${SVL_INSTALL_OLLAMA:-0}" = "1" ]; then
  step "Ollama" install_ollama
else
  skip "Ollama" "ustaw SVL_INSTALL_OLLAMA=1, aby zainstalować"
fi
if systemctl cat ollama.service >/dev/null 2>&1; then
  step "Ollama — maksymalna wydajność" tune_ollama
else
  skip "Ollama — maksymalna wydajność" "brak usługi ollama.service"
fi
step "Usługi systemd (svl-coreos2, svl-sentinel)" install_services
step "Sprawdzenie działania" verify_running
if [ "${SVL_RUN_DEBOOTSTRAP:-0}" = "1" ]; then
  step "Debootstrap Debian 13 → ${DEBOOTSTRAP_TARGET}" run_debootstrap
else
  skip "Debootstrap rootfs" "ustaw SVL_RUN_DEBOOTSTRAP=1, aby zbudować"
fi

echo
echo "=== Podsumowanie SVL CoreOS 2 ($(date -u +%FT%TZ)) ==="
printf '%s\n' "${RESULTS[@]}"
if [ "${FAILED}" -ne 0 ]; then
  echo "WYNIK: instalacja NIEPEŁNA — sprawdź kroki z BŁĄD powyżej (log: ${LOG_FILE})."
  exit 1
fi
echo "WYNIK: SVL CoreOS 2: Apex zainstalowany i działa (http://<adres>:3000)."
