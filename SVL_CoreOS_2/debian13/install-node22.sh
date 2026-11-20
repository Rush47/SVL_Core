#!/bin/sh
# Install official Node.js 22 (LTS). Debian 13 (Trixie) ships Node 20 / npm 9,
# but this project requires node >= 22 (package.json engines and the lockfile).
# npm ci on Node 20 fails with: missing @emnapi/* from the lock file, plus EBADENGINE.
set -eu

node_major() {
  node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1
}

if command -v node >/dev/null 2>&1; then
  major="$(node_major || true)"
  if [ -n "${major}" ] && [ "${major}" -ge 22 ]; then
    echo "Node $(node -v) already satisfies >=22; leaving it in place."
    exit 0
  fi
  echo "Found Node $(node -v); replacing it with official Node.js 22."
fi

if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get remove -y nodejs npm libnode-dev libnode109 libnode115 2>/dev/null || true
  apt-get install -y --no-install-recommends curl ca-certificates xz-utils
fi

ARCH="$(uname -m)"
case "${ARCH}" in
  x86_64|amd64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *)
    echo "[BŁĄD] Nieobsługiwana architektura dla Node.js 22: ${ARCH}" >&2
    exit 1
    ;;
esac

TMP="$(mktemp -d)"
trap 'rm -rf "${TMP}"' EXIT
curl -fsSL "https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt" -o "${TMP}/SHASUMS256.txt"
FILE="$(awk -v arch="${NODE_ARCH}" '$2 ~ ("^node-v[0-9.]+-linux-" arch "[.]tar[.]xz$") { print $2; exit }' "${TMP}/SHASUMS256.txt")"
if [ -z "${FILE}" ]; then
  echo "[BŁĄD] Nie znaleziono archiwum Node.js 22 dla linux-${NODE_ARCH}." >&2
  exit 1
fi
curl -fsSL "https://nodejs.org/dist/latest-v22.x/${FILE}" -o "${TMP}/${FILE}"
(cd "${TMP}" && grep " ${FILE}$" SHASUMS256.txt | sha256sum -c -)
tar -xJf "${TMP}/${FILE}" -C /usr/local --strip-components=1

# Keep ExecStart=/usr/bin/npx and other hardcoded Debian paths working.
for bin in node npm npx corepack; do
  if [ -x "/usr/local/bin/${bin}" ]; then
    ln -sfn "/usr/local/bin/${bin}" "/usr/bin/${bin}"
  fi
done

hash -r 2>/dev/null || true
echo "Zainstalowano $(node -v) / npm $(npm -v)"
major="$(node_major)"
if [ -z "${major}" ] || [ "${major}" -lt 22 ]; then
  echo "[BŁĄD] Node.js 22 jest wymagany, a w PATH jest: $(node -v 2>/dev/null || echo brak)" >&2
  exit 1
fi
