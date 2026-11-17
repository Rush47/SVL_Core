#!/usr/bin/env bash
# ============================================================================
# SVL CoreOS 2: Apex — Instalator Debian 13 (Trixie) & Ollama Ship-Host (SVL-364)
# Zarządzany przez: Maya (Kernel Master Daemon · ROOT)
# ============================================================================
set -euo pipefail

echo "[SVL CoreOS 2: Apex] Inicjalizacja środowiska Debian 13 (Trixie) dla jednostki SVL-364..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COREOS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

echo "[1/3] Weryfikacja manifestu: ${COREOS_ROOT}/build_manifest.json"
test -f "${COREOS_ROOT}/build_manifest.json"

echo "[2/3] Sprawdzanie silnika Ollama i modelu svl364-apex-uncensored..."
if command -v ollama >/dev/null 2>&1; then
  ollama create svl364-apex-uncensored -f "${COREOS_ROOT}/ai_core/Modelfile.apex-uncensored" || true
fi

echo "[3/3] SVL CoreOS 2: Apex gotowy do pracy pod nadzorem Mayi (Kernel Master Daemon)."
