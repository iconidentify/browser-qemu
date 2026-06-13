#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

DURATION="${DURATION:-360}"
INTERVAL="${INTERVAL:-30}"
BUILD_LABEL="${BUILD_LABEL:-instrumented-scsi-pc-trace}"
BUILD_HINT="${BUILD_HINT:-make build-qemu-balanced-t2-esp-pc-trace}"
EXTRA_QUERY="${EXTRA_QUERY:-pace=0}"
VIA="${VIA:-0}"
CONTINUOUS_LOG="${CONTINUOUS_LOG:-0}"
ARTIFACTS=(out.js qemu-system-m68k.wasm qemu-system-m68k.worker.js)
RESTORE_DIR=""

if ! [[ "${DURATION}" =~ ^[0-9]+$ ]] || (( DURATION < 1 || DURATION > 600 )); then
  echo "DURATION must be an integer from 1 to 600 seconds" >&2
  exit 2
fi

if ! [[ "${INTERVAL}" =~ ^[0-9]+$ ]] || (( INTERVAL < 0 || INTERVAL > 60 )); then
  echo "INTERVAL must be an integer from 0 to 60 seconds" >&2
  exit 2
fi

for artifact in "${ARTIFACTS[@]}"; do
  if [[ ! -f "build/qemu/${artifact}" ]]; then
    echo "missing build/qemu/${artifact}; run ${BUILD_HINT} first" >&2
    exit 1
  fi
  if [[ ! -f "public/qemu-lazy/${artifact}" ]]; then
    echo "missing public/qemu-lazy/${artifact}; run make package-lazy first" >&2
    exit 1
  fi
done

restore_lazy() {
  if [[ -n "${RESTORE_DIR}" && -d "${RESTORE_DIR}" ]]; then
    for artifact in "${ARTIFACTS[@]}"; do
      cp "${RESTORE_DIR}/${artifact}" "public/qemu-lazy/${artifact}"
    done
    rm -rf "${RESTORE_DIR}"
  fi
}

RESTORE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/c89-qemu-lazy-restore.XXXXXX")"
for artifact in "${ARTIFACTS[@]}"; do
  cp "public/qemu-lazy/${artifact}" "${RESTORE_DIR}/${artifact}"
done

trap restore_lazy EXIT

for artifact in "${ARTIFACTS[@]}"; do
  cp "build/qemu/${artifact}" "public/qemu-lazy/${artifact}"
done

probe_args=(
  ./scripts/smoke-headless-browser.mjs
  --url "http://127.0.0.1:8088/?build=${BUILD_LABEL}&ram=16&heap=1280&trace=scsi&autostart=lazy-paused&${EXTRA_QUERY#&}"
  --probe-duration "${DURATION}"
  --probe-interval "${INTERVAL}"
)
if [[ "${VIA}" == "1" ]]; then
  probe_args+=(--via)
fi
if [[ "${CONTINUOUS_LOG}" == "1" ]]; then
  probe_args+=(--continuous-log)
fi

node "${probe_args[@]}"
