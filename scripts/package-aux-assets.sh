#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_IMAGE="${DOCKER_IMAGE:-c89-qemu-wasm-build}"
PACK_DIR="${ROOT}/build/pack"
QEMU_BUILD="${ROOT}/build/qemu"
PUBLIC_QEMU="${ROOT}/public/qemu"
LOCAL_ASSET_ROOT="${LOCAL_ASSET_ROOT:-${HOME}/aux_qemu_local}"

if [[ -z "${AUX_ROM:-}" || -z "${AUX_DISK:-}" ]]; then
  cat >&2 <<'EOF'
AUX_ROM and AUX_DISK are required.

Example:
  AUX_ROM=/path/to/Quadra800.rom AUX_DISK=/path/to/aux.img make package

Optional:
  AUX_PRAM=/path/to/pram.img
  AUX_JAG_DISK=/path/to/JAG.img
  AUX_DISK2=/path/to/second-disk.img
  AUX_CDROM=/path/to/install.iso

Local aux_qemu_local example:
  AUX_ROM=${HOME}/aux_qemu_local/Quadra800.ROM \
  AUX_DISK=${HOME}/aux_qemu_local/AUX3.img \
  AUX_PRAM=${HOME}/aux_qemu_local/pram-aux.img \
  AUX_JAG_DISK=${HOME}/aux_qemu_local/JAG.img \
  make package
EOF
  exit 1
fi

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

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for Emscripten file_packager.py" >&2
  exit 1
fi

if ! docker image inspect "${DOCKER_IMAGE}" >/dev/null 2>&1; then
  echo "Docker image '${DOCKER_IMAGE}' not found. Run make build-qemu first." >&2
  exit 1
fi

mkdir -p "${PACK_DIR}" "${PUBLIC_QEMU}"
rm -rf "${PACK_DIR:?}/"*

stage_asset() {
  local src="$1"
  local dest="$2"

  if [[ ! -f "${src}" ]]; then
    echo "Missing asset: ${src}" >&2
    exit 1
  fi

  # These A/UX disk images are large. Prefer hard links so packaging does not
  # double local disk usage before file_packager writes the browser data file.
  if ln "${src}" "${dest}" 2>/dev/null; then
    return
  fi

  if cp -c "${src}" "${dest}" 2>/dev/null; then
    return
  fi

  cp "${src}" "${dest}"
}

stage_asset "${AUX_ROM}" "${PACK_DIR}/Quadra800.rom"
stage_asset "${AUX_DISK}" "${PACK_DIR}/aux-3.1.1-disk.img"

if [[ -n "${AUX_PRAM:-}" ]]; then
  stage_asset "${AUX_PRAM}" "${PACK_DIR}/pram.img"
fi

SECOND_DISK="${AUX_JAG_DISK:-${AUX_DISK2:-}}"
if [[ -n "${SECOND_DISK}" ]]; then
  stage_asset "${SECOND_DISK}" "${PACK_DIR}/jag-disk.img"
fi

if [[ -n "${AUX_CDROM:-}" ]]; then
  stage_asset "${AUX_CDROM}" "${PACK_DIR}/aux-cdrom.iso"
fi

cp "${QEMU_BUILD}/out.js" "${PUBLIC_QEMU}/out.js"
for artifact in qemu-system-m68k.wasm qemu-system-m68k.worker.js; do
  cp "${QEMU_BUILD}/${artifact}" "${PUBLIC_QEMU}/${artifact}"
done

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

if [[ -n "${AUX_PRAM:-}" ]]; then
  cat >> "${PUBLIC_QEMU}/module.js" <<'EOF'
  "-drive", "file=/pack/pram.img,format=raw,if=mtd,file.locking=off",
EOF
fi

cat >> "${PUBLIC_QEMU}/module.js" <<'EOF'
  "-drive", "file=/pack/aux-3.1.1-disk.img,media=disk,format=raw,if=none,id=hd2,file.locking=off",
  "-device", "scsi-hd,scsi-id=1,drive=hd2",
EOF

if [[ -n "${SECOND_DISK}" ]]; then
  cat >> "${PUBLIC_QEMU}/module.js" <<'EOF'
  "-drive", "file=/pack/jag-disk.img,media=disk,format=raw,if=none,id=hd3,file.locking=off",
  "-device", "scsi-hd,scsi-id=0,drive=hd3",
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

du -sh "${PUBLIC_QEMU}" "${PACK_DIR}" || true
if [[ "${KEEP_PACK:-0}" != "1" ]]; then
  rm -rf "${PACK_DIR:?}/"*
fi
echo "Packaged browser artifacts into ${PUBLIC_QEMU}"
