#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_IMAGE="${DOCKER_IMAGE:-c89-qemu-wasm-build}"
LOCAL_ASSET_ROOT="${LOCAL_ASSET_ROOT:-${HOME}/aux_qemu_local}"
QEMU_BUILD="${ROOT}/build/qemu"
PACK_DIR="${ROOT}/build/lazy-pack"
PUBLIC_QEMU="${ROOT}/public/qemu-lazy"

# Defaults point at the project-owned copies in assets/ (cloned from
# ~/aux_qemu_local on June 12, 2026, after a verified clean native boot).
# JAG is intentionally no longer mounted; set AUX_JAG_DISK explicitly to
# restore a second SCSI disk.
AUX_ROM="${AUX_ROM:-${ROOT}/assets/Quadra800.ROM}"
AUX_DISK="${AUX_DISK:-${ROOT}/assets/AUX3.img}"
AUX_PRAM="${AUX_PRAM:-${ROOT}/assets/pram-aux.img}"
AUX_JAG_DISK="${AUX_JAG_DISK:-${AUX_DISK2:-}}"

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

for asset in "${AUX_ROM}" "${AUX_DISK}"; do
  if [[ ! -f "${asset}" ]]; then
    echo "Missing required asset: ${asset}" >&2
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

stage_small_asset() {
  local src="$1"
  local dest="$2"

  if [[ -f "${src}" ]]; then
    cp "${src}" "${dest}"
  fi
}

stage_public_asset() {
  local src="$1"
  local dest="$2"

  if [[ ! -f "${src}" ]]; then
    return
  fi

  rm -f "${dest}"

  # The A/UX images are large. Prefer links or APFS clones so this public,
  # ignored runtime does not duplicate several GB before the browser serves it.
  if ln "${src}" "${dest}" 2>/dev/null; then
    return
  fi

  if cp -c "${src}" "${dest}" 2>/dev/null; then
    return
  fi

  cp "${src}" "${dest}"
}

stage_small_asset "${AUX_ROM}" "${PACK_DIR}/Quadra800.rom"
stage_small_asset "${AUX_PRAM}" "${PACK_DIR}/pram.img"

cp "${QEMU_BUILD}/out.js" "${PUBLIC_QEMU}/out.js"
for artifact in qemu-system-m68k.wasm qemu-system-m68k.worker.js; do
  cp "${QEMU_BUILD}/${artifact}" "${PUBLIC_QEMU}/${artifact}"
done

# The patch scripts are idempotent; re-applying here covers build trees that
# predate a given patch (the lazyfile patch already ran at build time).
node "${ROOT}/scripts/patch-qemu-out-js-lazyfile.mjs" "${PUBLIC_QEMU}/out.js"
node "${ROOT}/scripts/patch-qemu-out-js-diskworker.mjs" "${PUBLIC_QEMU}/out.js"
node "${ROOT}/scripts/patch-qemu-worker-js.mjs" "${PUBLIC_QEMU}/qemu-system-m68k.worker.js"

stage_public_asset "${AUX_DISK}" "${PUBLIC_QEMU}/aux-3.1.1-disk.img"
SECOND_DISK_PRESENT=0
if [[ -n "${AUX_JAG_DISK}" && -f "${AUX_JAG_DISK}" ]]; then
  stage_public_asset "${AUX_JAG_DISK}" "${PUBLIC_QEMU}/jag-disk.img"
  SECOND_DISK_PRESENT=1
fi

docker run --rm \
  -v "${PACK_DIR}:/pack:ro" \
  -v "${PUBLIC_QEMU}:/public-qemu" \
  "${DOCKER_IMAGE}" \
  sh -lc "cd /public-qemu && /emsdk/upstream/emscripten/tools/file_packager.py qemu-system-m68k.data --preload /pack > load.js"

cat > "${PUBLIC_QEMU}/module.js" <<'EOF'
(function (root) {
var runtimeDir = "qemu-lazy";
var args = [
  "-M", "q800",
  "-m", "128",
  "-accel", "tcg,tb-size=500",
  "-snapshot",
  "-L", "/pack/",
  "-bios", "/pack/Quadra800.rom",
  "-display", "sdl,gl=off,show-cursor=on",
  "-g", "1152x870x8",
  "-audio", "none",
EOF

if [[ -f "${AUX_PRAM}" ]]; then
  cat >> "${PUBLIC_QEMU}/module.js" <<'EOF'
  "-drive", "file=/pack/pram.img,format=raw,if=mtd,file.locking=off",
EOF
fi

cat >> "${PUBLIC_QEMU}/module.js" <<'EOF'
  "-drive", "file=/pack/aux-3.1.1-disk.img,media=disk,format=raw,if=none,id=hd2,file.locking=off,snapshot=on,cache=unsafe",
  "-device", "scsi-hd,scsi-id=1,drive=hd2",
EOF

if [[ "${SECOND_DISK_PRESENT}" == "1" ]]; then
  cat >> "${PUBLIC_QEMU}/module.js" <<'EOF'
  "-drive", "file=/pack/jag-disk.img,media=disk,format=raw,if=none,id=hd3,file.locking=off,snapshot=on,cache=unsafe",
  "-device", "scsi-hd,scsi-id=0,drive=hd3",
EOF
fi

cat >> "${PUBLIC_QEMU}/module.js" <<'EOF'
  "-nic", "none",
  "-monitor", "stdio",
  "-serial", "none"
];

function lazyUrl(name) {
  var base = root.location ? root.location.href : "";
  return new URL("./" + runtimeDir + "/" + name, base).href;
}

function mountLazyDisks(Module) {
  Module.FS_createPath("/", "pack", true, true);
  Module.FS_createLazyFile("/pack", "aux-3.1.1-disk.img", lazyUrl("aux-3.1.1-disk.img"), true, false);
EOF

if [[ "${SECOND_DISK_PRESENT}" == "1" ]]; then
  cat >> "${PUBLIC_QEMU}/module.js" <<'EOF'
  Module.FS_createLazyFile("/pack", "jag-disk.img", lazyUrl("jag-disk.img"), true, false);
EOF
fi

cat >> "${PUBLIC_QEMU}/module.js" <<'EOF'
}

root.AuxQemuModuleArguments = args;
root.Module = root.Module || {};
root.Module.arguments = args;
root.Module.preRun = root.Module.preRun || [];
root.Module.preRun.push(mountLazyDisks);
})(typeof window !== "undefined" ? window : globalThis);
EOF

rm -rf "${PACK_DIR:?}/"*
du -sh "${PUBLIC_QEMU}" || true
echo "Packaged lazy browser artifacts into ${PUBLIC_QEMU}"
