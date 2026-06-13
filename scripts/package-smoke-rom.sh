#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_IMAGE="${DOCKER_IMAGE:-c89-qemu-wasm-build}"
LOCAL_ASSET_ROOT="${LOCAL_ASSET_ROOT:-${HOME}/aux_qemu_local}"
QEMU_BUILD="${ROOT}/build/qemu"
PACK_DIR="${ROOT}/build/smoke-pack"
PUBLIC_QEMU="${ROOT}/public/qemu-smoke"
AUX_ROM="${AUX_ROM:-${LOCAL_ASSET_ROOT}/Quadra800.ROM}"
AUX_PRAM="${AUX_PRAM:-${LOCAL_ASSET_ROOT}/pram-aux.img}"

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

if [[ ! -f "${AUX_ROM}" ]]; then
  echo "Missing AUX_ROM: ${AUX_ROM}" >&2
  exit 1
fi

if ! docker image inspect "${DOCKER_IMAGE}" >/dev/null 2>&1; then
  echo "Docker image '${DOCKER_IMAGE}' not found. Run make build-qemu first." >&2
  exit 1
fi

mkdir -p "${PACK_DIR}" "${PUBLIC_QEMU}"
rm -rf "${PACK_DIR:?}/"*

cp "${AUX_ROM}" "${PACK_DIR}/Quadra800.rom"
if [[ -f "${AUX_PRAM}" ]]; then
  cp "${AUX_PRAM}" "${PACK_DIR}/pram.img"
fi

cp "${QEMU_BUILD}/out.js" "${PUBLIC_QEMU}/out.js"
cp "${QEMU_BUILD}/qemu-system-m68k.wasm" "${PUBLIC_QEMU}/qemu-system-m68k.wasm"
cp "${QEMU_BUILD}/qemu-system-m68k.worker.js" "${PUBLIC_QEMU}/qemu-system-m68k.worker.js"

node "${ROOT}/scripts/patch-qemu-out-js-input.mjs" "${PUBLIC_QEMU}/out.js"

docker run --rm \
  -v "${PACK_DIR}:/pack:ro" \
  -v "${PUBLIC_QEMU}:/public-qemu" \
  "${DOCKER_IMAGE}" \
  sh -lc "cd /public-qemu && /emsdk/upstream/emscripten/tools/file_packager.py qemu-system-m68k.data --preload /pack > load.js"

cat > "${PUBLIC_QEMU}/module.js" <<'EOF'
(function (root) {
var args = [
  "-M", "q800",
  "-m", "128",
  "-accel", "tcg,tb-size=500",
  "-L", "/pack/",
  "-bios", "/pack/Quadra800.rom",
  "-display", "sdl,gl=off,show-cursor=off",
  "-g", "1152x870x8",
  "-audio", "none",
EOF

if [[ -f "${AUX_PRAM}" ]]; then
  cat >> "${PUBLIC_QEMU}/module.js" <<'EOF'
  "-drive", "file=/pack/pram.img,format=raw,if=mtd,file.locking=off",
EOF
fi

cat >> "${PUBLIC_QEMU}/module.js" <<'EOF'
  "-nic", "none",
  "-monitor", "stdio",
  "-serial", "none"
];
root.AuxQemuModuleArguments = args;
root.Module = root.Module || {};
root.Module.arguments = args;
})(typeof window !== "undefined" ? window : globalThis);
EOF

rm -rf "${PACK_DIR:?}/"*
du -sh "${PUBLIC_QEMU}" || true
echo "Packaged ROM smoke artifacts into ${PUBLIC_QEMU}"
