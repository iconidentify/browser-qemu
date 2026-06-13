#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${QEMU_WASM_SRC:-${ROOT}/vendor/qemu-wasm}"
BUILD="${QEMU_WASM_NATIVE_BUILD:-${ROOT}/build/qemu-wasm-native}"
JOBS="${JOBS:-2}"
RECONFIGURE="${RECONFIGURE:-0}"
QEMU_PYTHON="${QEMU_PYTHON:-}"
EXTRA_CFLAGS="${QEMU_NATIVE_EXTRA_CFLAGS:-}"

if [[ ! -x "${SRC}/configure" ]]; then
  echo "qemu-wasm source not found at ${SRC}; run make fetch first" >&2
  exit 2
fi

if [[ "${RECONFIGURE}" == "1" || ! -f "${BUILD}/build.ninja" ]]; then
  rm -rf "${BUILD}"
  mkdir -p "${BUILD}"
  (
    cd "${BUILD}"
    "${SRC}/configure" \
      --target-list=m68k-softmmu \
      ${QEMU_PYTHON:+--python="${QEMU_PYTHON}"} \
      ${EXTRA_CFLAGS:+--extra-cflags="${EXTRA_CFLAGS}"} \
      --audio-drv-list= \
      --with-coroutine=sigaltstack \
      --disable-cocoa \
      --disable-coreaudio \
      --disable-curses \
      --disable-docs \
      --disable-gtk \
      --disable-guest-agent \
      --disable-sdl \
      --disable-slirp \
      --disable-spice \
      --disable-tools \
      --disable-vnc \
      --disable-vmnet \
      --disable-werror
  )
fi

ninja -C "${BUILD}" -j "${JOBS}" qemu-system-m68k

echo "native qemu-wasm comparator: ${BUILD}/qemu-system-m68k"
