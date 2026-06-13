#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
QEMU_BUILD="${ROOT}/build/qemu"
PUBLIC_QEMU_DIRS=("${ROOT}/public/qemu" "${ROOT}/public/qemu-smoke" "${ROOT}/public/qemu-lazy")

for artifact in out.js qemu-system-m68k.wasm qemu-system-m68k.worker.js; do
  if [[ ! -f "${QEMU_BUILD}/${artifact}" ]]; then
    cat >&2 <<EOF
Missing ${QEMU_BUILD}/${artifact}.

Run:
  make build-qemu
EOF
    exit 1
  fi
done

for public_qemu in "${PUBLIC_QEMU_DIRS[@]}"; do
  mkdir -p "${public_qemu}"
  cp "${QEMU_BUILD}/out.js" "${public_qemu}/out.js"
  cp "${QEMU_BUILD}/qemu-system-m68k.wasm" "${public_qemu}/qemu-system-m68k.wasm"
  cp "${QEMU_BUILD}/qemu-system-m68k.worker.js" "${public_qemu}/qemu-system-m68k.worker.js"
  echo "Synced QEMU runtime artifacts into ${public_qemu}"
done
