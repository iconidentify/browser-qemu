#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOCAL_ASSET_ROOT="${LOCAL_ASSET_ROOT:-${HOME}/aux_qemu_local}"

AUX_ROM="${AUX_ROM:-${LOCAL_ASSET_ROOT}/Quadra800.ROM}" \
AUX_DISK="${AUX_DISK:-${LOCAL_ASSET_ROOT}/AUX3.img}" \
AUX_PRAM="${AUX_PRAM:-${LOCAL_ASSET_ROOT}/pram-aux.img}" \
AUX_JAG_DISK="${AUX_JAG_DISK:-${LOCAL_ASSET_ROOT}/JAG.img}" \
"${ROOT}/scripts/package-aux-assets.sh"
