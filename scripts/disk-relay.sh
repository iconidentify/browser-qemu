#!/usr/bin/env bash
# Easy admin disk-write workflow for browser-qemu.
#
# Most visitors run the disk read-only off the shared base image. The admin
# (you) occasionally needs to CHANGE the disk contents -- install software,
# edit files -- and have those edits stick. This script makes that one command:
# it starts the dialtone relay serving a writable copy of the A/UX disk, mints
# an admin token, and prints the ready-to-open browser URL.
#
#   make disk-relay            # start relay + print the writable URL
#   make disk-relay BROWSER=1  # also launch pinned-priority Chrome into it
#
# Edits go to an EDITABLE COPY under build/relay-disks/, never to the known-good
# assets/AUX3.img master. The relay keeps the last 3 snapshots automatically.
# To publish your edits to the read-only disk that visitors boot, run
#   make disk-promote
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY_SRC="${RELAY_SRC:-${HOME}/Documents/source/68k_web/apps/relay}"
RELAY_BIND="${RELAY_BIND:-127.0.0.1:8080}"
SERVE_PORT="${SERVE_PORT:-8088}"
RAM="${RAM:-128}"
HEAP="${HEAP:-384}"
DISK_NAME="${DISK_NAME:-aux-3.1.1-disk.img}"

DISK_ROOT="${ROOT}/build/relay-disks"
EDITABLE="${DISK_ROOT}/bootable/${DISK_NAME}"
SECRET_FILE="${DISK_ROOT}/.jwt-secret"
MASTER="${ROOT}/assets/AUX3.img"

if ! command -v go >/dev/null 2>&1; then
  echo "error: 'go' is required to run the dialtone relay" >&2
  exit 1
fi
if [[ ! -d "${RELAY_SRC}" ]]; then
  echo "error: dialtone relay source not found at ${RELAY_SRC}" >&2
  echo "       set RELAY_SRC=/path/to/68k_web/apps/relay" >&2
  exit 1
fi
if [[ ! -f "${MASTER}" ]]; then
  echo "error: A/UX master image not found at ${MASTER}" >&2
  echo "       run make package-lazy first (see VENDOR.md)" >&2
  exit 1
fi

mkdir -p "${DISK_ROOT}/bootable"

# Persistent dev secret so tokens stay valid across relay restarts.
if [[ ! -f "${SECRET_FILE}" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32 > "${SECRET_FILE}"
  else
    node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" > "${SECRET_FILE}"
  fi
  chmod 600 "${SECRET_FILE}"
  echo "generated dev JWT secret: ${SECRET_FILE}"
fi
SECRET="$(cat "${SECRET_FILE}")"

# Editable copy: APFS-clone the master on first use so edits diverge from the
# known-good image but cost no extra disk until written. Kept across restarts.
if [[ ! -f "${EDITABLE}" ]]; then
  echo "creating editable disk copy from master (one-time clone)..."
  if ! cp -c "${MASTER}" "${EDITABLE}" 2>/dev/null; then
    cp "${MASTER}" "${EDITABLE}"
  fi
  echo "editable disk: ${EDITABLE}"
fi

TOKEN="$(DIALTONE_JWT_SECRET="${SECRET}" node "${ROOT}/scripts/mint-dialtone-token.mjs" 30)"

BASE="http://127.0.0.1:${SERVE_PORT}/?ram=${RAM}&heap=${HEAP}&pace=0&autostart=lazy&build=disk-rw-$$"
RW_URL="${BASE}&diskTransport=dialtone&disk=rw&diskToken=${TOKEN}"
RO_URL="${BASE}&diskTransport=dialtone"

cat <<EOF

dialtone relay starting on ${RELAY_BIND}, serving editable ${DISK_NAME}
  editable image: ${EDITABLE}
  dev server must be running separately:  make serve   (port ${SERVE_PORT})

WRITABLE session (your edits persist):
  ${RW_URL}

read-only session (what visitors get):
  ${RO_URL}

EOF

if [[ "${BROWSER:-0}" == "1" ]]; then
  CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
  PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/c89-aux-chrome-XXXXXX")"
  echo "launching Chrome into the writable session (profile ${PROFILE})"
  "${CHROME}" \
    --no-first-run --no-default-browser-check \
    --disable-background-networking --disable-dev-shm-usage \
    --disable-background-timer-throttling \
    --disable-backgrounding-occluded-windows \
    --disable-renderer-backgrounding \
    --window-size=1400,1200 \
    --remote-debugging-port="${DEBUG_PORT:-9444}" \
    --user-data-dir="${PROFILE}" \
    "${RW_URL}" &
fi

echo "relay logs follow (Ctrl-C to stop):"
exec env DIALTONE_JWT_SECRET="${SECRET}" go -C "${RELAY_SRC}" run . \
  -bind "${RELAY_BIND}" -disk-path "${DISK_ROOT}"
