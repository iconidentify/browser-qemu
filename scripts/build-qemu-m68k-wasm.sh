#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENDOR_DIR="${ROOT}/vendor"
QEMU_DIR="${QEMU_DIR:-${VENDOR_DIR}/qemu-wasm}"
QEMU_WASM_REPO="${QEMU_WASM_REPO:-https://github.com/ktock/qemu-wasm.git}"
QEMU_WASM_REF="${QEMU_WASM_REF:-0ef7b4e2814b231705d8371dd7997f5b72e70baf}"
KEYCODEMAPDB_REPO="${KEYCODEMAPDB_REPO:-https://gitlab.com/qemu-project/keycodemapdb.git}"
KEYCODEMAPDB_REF="${KEYCODEMAPDB_REF:-f5772a62ec52591ff6870b7e8ef32482371f22c6}"
SOFTFLOAT_REPO="${SOFTFLOAT_REPO:-https://gitlab.com/qemu-project/berkeley-softfloat-3.git}"
SOFTFLOAT_REF="${SOFTFLOAT_REF:-b64af41c3276f97f0e181920400ee056b9c88037}"
TESTFLOAT_REPO="${TESTFLOAT_REPO:-https://gitlab.com/qemu-project/berkeley-testfloat-3.git}"
TESTFLOAT_REF="${TESTFLOAT_REF:-e7af9751d9f9fd3b47911f51a5cfd08af256a9ab}"
DOCKER_IMAGE="${DOCKER_IMAGE:-c89-qemu-wasm-build}"
DOCKER_PROGRESS="${DOCKER_PROGRESS:-plain}"
CONTAINER="${CONTAINER:-c89-qemu-wasm-build}"
BUILD_DIR="${BUILD_DIR:-/build/m68k-wasm}"
HOST_JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo 4)"
if [[ -z "${JOBS:-}" ]]; then
  if [[ "${HOST_JOBS}" =~ ^[0-9]+$ && "${HOST_JOBS}" -gt 4 ]]; then
    JOBS=4
  else
    JOBS="${HOST_JOBS}"
  fi
fi
DOCKER_CPUS="${DOCKER_CPUS:-${JOBS}}"
WASM32_INSTANTIATE_NUM="${WASM32_INSTANTIATE_NUM:-2147483647}"
WASM32_QUEUE_PUMP_INTERVAL="${WASM32_QUEUE_PUMP_INTERVAL:-128}"
QEMU_WASM_THREAD_YIELD="${QEMU_WASM_THREAD_YIELD:-0}"
QEMU_WASM_ASC_READY_HACK="${QEMU_WASM_ASC_READY_HACK:-1}"
QEMU_WASM_ROM_RAMTEST_HACK="${QEMU_WASM_ROM_RAMTEST_HACK:-1}"
QEMU_WASM_ROM_DELAY_HACK="${QEMU_WASM_ROM_DELAY_HACK:-1}"
QEMU_WASM_VIA_T2_ONESHOT_HACK="${QEMU_WASM_VIA_T2_ONESHOT_HACK:-1}"
QEMU_WASM_VIA_TRACE="${QEMU_WASM_VIA_TRACE:-0}"
QEMU_WASM_ESP_TRACE="${QEMU_WASM_ESP_TRACE:-0}"
QEMU_WASM_ESP_PDMA_FIFO_CAPACITY="${QEMU_WASM_ESP_PDMA_FIFO_CAPACITY:-16}"
QEMU_WASM_ESP_UPSTREAM="${QEMU_WASM_ESP_UPSTREAM:-0}"
QEMU_ESP_UPSTREAM_REF="${QEMU_ESP_UPSTREAM_REF:-v9.1.2}"
QEMU_WASM_TCG_EXIT_PUMP_INTERVAL="${QEMU_WASM_TCG_EXIT_PUMP_INTERVAL:-0}"
QEMU_WASM_TCI_CHAIN_PUMP="${QEMU_WASM_TCI_CHAIN_PUMP:-0}"
QEMU_WASM_TCI_CHAIN_PUMP_INTERVAL="${QEMU_WASM_TCI_CHAIN_PUMP_INTERVAL:-1024}"
QEMU_WASM_TCG_SLEEP_PUMP_INTERVAL="${QEMU_WASM_TCG_SLEEP_PUMP_INTERVAL:-0}"
QEMU_WASM_TCG_SLEEP_PUMP_MS="${QEMU_WASM_TCG_SLEEP_PUMP_MS:-0}"
QEMU_WASM_MMIO_BACKOFF_INTERVAL="${QEMU_WASM_MMIO_BACKOFF_INTERVAL:-0}"
QEMU_WASM_MMIO_BACKOFF_NS="${QEMU_WASM_MMIO_BACKOFF_NS:-500000}"
QEMU_WASM_M68K_PC_TRACE="${QEMU_WASM_M68K_PC_TRACE:-0}"
QEMU_WASM_M68K_EXC_TRACE="${QEMU_WASM_M68K_EXC_TRACE:-0}"
QEMU_WASM_M68K_TB_TRACE="${QEMU_WASM_M68K_TB_TRACE:-0}"
QEMU_WASM_M68K_MOVEC_TLB_FLUSH="${QEMU_WASM_M68K_MOVEC_TLB_FLUSH:-0}"
QEMU_WASM_M68K_MMU_WALK_TRACE="${QEMU_WASM_M68K_MMU_WALK_TRACE:-0}"
QEMU_WASM_WASM32_PGTABLE_TRACE="${QEMU_WASM_WASM32_PGTABLE_TRACE:-0}"
QEMU_WASM_ADB_AUTOPOLL_SUPPRESS="${QEMU_WASM_ADB_AUTOPOLL_SUPPRESS:-0}"
QEMU_WASM_MAX_ICOUNT_SHIFT="${QEMU_WASM_MAX_ICOUNT_SHIFT:-10}"
QEMU_WASM_TOTAL_MEMORY_MB="${QEMU_WASM_TOTAL_MEMORY_MB:-2300}"
QEMU_WASM_EMULATE_FUNCTION_POINTER_CASTS="${QEMU_WASM_EMULATE_FUNCTION_POINTER_CASTS:-1}"

if ! [[ "${QEMU_WASM_TOTAL_MEMORY_MB}" =~ ^[0-9]+$ ]]; then
  echo "QEMU_WASM_TOTAL_MEMORY_MB must be an integer megabyte value" >&2
  exit 2
fi

# Growable memory (browser-qemu OOM fix). The stock build links a FIXED
# -sTOTAL_MEMORY, so every tab commits that much upfront (1280MB as shipped) and
# the in-memory -snapshot overlay grows it further until a normal tab OOM-crashes.
# With QEMU_WASM_GROW_MEMORY=1 we instead commit a small INITIAL_MEMORY and grow
# on demand up to MAXIMUM_MEMORY, so a light session stays small. Opt-in; the
# default keeps the fixed-memory behavior so existing build targets are unchanged.
QEMU_WASM_GROW_MEMORY="${QEMU_WASM_GROW_MEMORY:-0}"
QEMU_WASM_INITIAL_MEMORY_MB="${QEMU_WASM_INITIAL_MEMORY_MB:-384}"
QEMU_WASM_MAXIMUM_MEMORY_MB="${QEMU_WASM_MAXIMUM_MEMORY_MB:-2048}"
if [[ "${QEMU_WASM_GROW_MEMORY}" == "1" ]]; then
  MEMORY_FLAGS="-sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=${QEMU_WASM_INITIAL_MEMORY_MB}MB -sMAXIMUM_MEMORY=${QEMU_WASM_MAXIMUM_MEMORY_MB}MB"
else
  MEMORY_FLAGS="-sTOTAL_MEMORY=${QEMU_WASM_TOTAL_MEMORY_MB}MB"
fi
if ! [[ "${QEMU_WASM_ESP_PDMA_FIFO_CAPACITY}" =~ ^[0-9]+$ ]] || [[ "${QEMU_WASM_ESP_PDMA_FIFO_CAPACITY}" -lt 16 ]]; then
  echo "QEMU_WASM_ESP_PDMA_FIFO_CAPACITY must be an integer >= 16" >&2
  exit 2
fi
if ! [[ "${QEMU_WASM_TCG_EXIT_PUMP_INTERVAL}" =~ ^[0-9]+$ ]]; then
  echo "QEMU_WASM_TCG_EXIT_PUMP_INTERVAL must be a non-negative integer" >&2
  exit 2
fi
if ! [[ "${QEMU_WASM_MAX_ICOUNT_SHIFT}" =~ ^[0-9]+$ ]] || [[ "${QEMU_WASM_MAX_ICOUNT_SHIFT}" -lt 10 ]] || [[ "${QEMU_WASM_MAX_ICOUNT_SHIFT}" -gt 20 ]]; then
  echo "QEMU_WASM_MAX_ICOUNT_SHIFT must be an integer from 10 to 20" >&2
  exit 2
fi

mkdir -p "${VENDOR_DIR}" "${ROOT}/build"

if [[ ! -d "${QEMU_DIR}/.git" ]]; then
  git clone --depth 1 "${QEMU_WASM_REPO}" "${QEMU_DIR}"
fi

git -C "${QEMU_DIR}" fetch --depth 1 origin "${QEMU_WASM_REF}" >/dev/null
git -C "${QEMU_DIR}" checkout --force --detach FETCH_HEAD >/dev/null

ensure_wrap_git() {
  local name="$1"
  local repo="$2"
  local ref="$3"
  local dir="${QEMU_DIR}/subprojects/${name}"
  local packagefiles="${QEMU_DIR}/subprojects/packagefiles/${name}"

  if [[ ! -d "${dir}/.git" ]]; then
    rm -rf "${dir}"
    git clone --depth 1 "${repo}" "${dir}"
  fi
  git -C "${dir}" fetch --depth 1 origin "${ref}" >/dev/null
  git -C "${dir}" checkout --force --detach FETCH_HEAD >/dev/null

  if [[ -d "${packagefiles}" ]]; then
    cp -R "${packagefiles}/." "${dir}/"
  fi
}

ensure_wrap_git keycodemapdb "${KEYCODEMAPDB_REPO}" "${KEYCODEMAPDB_REF}"
ensure_wrap_git berkeley-softfloat-3 "${SOFTFLOAT_REPO}" "${SOFTFLOAT_REF}"
ensure_wrap_git berkeley-testfloat-3 "${TESTFLOAT_REPO}" "${TESTFLOAT_REF}"

apply_qemu_wasm_source_patches() {
  local config_file="${QEMU_DIR}/util/qemu-config.c"
  local meson_file="${QEMU_DIR}/meson.build"
  local wasm32_file="${QEMU_DIR}/tcg/wasm32.c"
  local wasm32_header="${QEMU_DIR}/tcg/wasm32.h"
  local icount_file="${QEMU_DIR}/accel/tcg/icount-common.c"
  local cputlb_file="${QEMU_DIR}/accel/tcg/cputlb.c"
  local asc_file="${QEMU_DIR}/hw/audio/asc.c"
  local via_file="${QEMU_DIR}/hw/misc/mac_via.c"
  local via_trace_patch="${ROOT}/scripts/patches/qemu-wasm-via-trace.patch"
  local esp_trace_patch="${ROOT}/scripts/patches/qemu-wasm-esp-trace.patch"
  local esp_pdma_longword_patch="${ROOT}/scripts/patches/qemu-wasm-esp-pdma-longword.patch"
  local esp_pdma_fifo_patch="${ROOT}/scripts/patches/qemu-wasm-esp-pdma-fifo-capacity.patch"
  local adb_autopoll_suppress_patch="${ROOT}/scripts/patches/qemu-wasm-adb-autopoll-suppress.patch"
  local ramtest_patch="${ROOT}/scripts/patches/qemu-wasm-m68k-rom-ramtest-fast-forward.patch"
  local wasm32_tci_endian_patch="${ROOT}/scripts/patches/qemu-wasm-wasm32-tci-endian-fastpath.patch"
  local wasm32_pgtable_trace_patch="${ROOT}/scripts/patches/qemu-wasm-wasm32-page-table-trace.patch"
  local t2_oneshot_patch="${ROOT}/scripts/patches/qemu-wasm-via-t2-one-shot.patch"
  local pc_trace_patch="${ROOT}/scripts/patches/qemu-wasm-m68k-pc-trace.patch"
  local exc_trace_patch="${ROOT}/scripts/patches/qemu-wasm-m68k-exception-trace.patch"
  local tb_trace_patch="${ROOT}/scripts/patches/qemu-wasm-m68k-tb-trace.patch"
  local movec_tlb_flush_patch="${ROOT}/scripts/patches/qemu-wasm-m68k-movec-tlb-flush.patch"
  local mmu_walk_trace_patch="${ROOT}/scripts/patches/qemu-wasm-m68k-mmu-walk-trace.patch"

  # The browser build can register more option groups than the upstream
  # NULL-terminated static tables allow before m68k/q800 startup completes.
  # Keep the change local to the ignored vendor tree and make it reproducible.
  perl -0pi -e 's/static QemuOptsList \*vm_config_groups\[[0-9]+\];/static QemuOptsList *vm_config_groups[256];/' "${config_file}"
  perl -0pi -e 's/static QemuOptsList \*drive_config_groups\[[0-9]+\];/static QemuOptsList *drive_config_groups[32];/' "${config_file}"

  # qemu-wasm's Meson file comments out the compiler-version loop but still
  # references that loop-local variable in the Darwin branch. Use QEMU's C
  # compiler object there so native comparator builds can regenerate.
  perl -0pi -e "s/^(\\s*)if compiler\\.get_id\\(\\) == 'gcc'/\\1if cc.get_id() == 'gcc'/mg" "${meson_file}"

  # qemu-wasm initializes the dynamic TCG wasm state from the mttcg CPU-thread
  # entrypoint. q800 can also reach tcg_qemu_tb_exec() before that JS state is
  # populated in the executing pthread, which leaves Module.__wasm32_tb undefined.
  if ! grep -q 'C89 browser-qemu: ensure wasm32 TCG JS state exists' "${wasm32_file}"; then
    perl -0pi -e 's/(uintptr_t QEMU_DISABLE_CFI tcg_qemu_tb_exec\(CPUArchState \*env,\n\s+const void \*v_tb_ptr\)\n\{\n)/$1    \/* C89 browser-qemu: ensure wasm32 TCG JS state exists in this pthread. *\/\n    if (!initdone) {\n        init_wasm32();\n    }\n/' "${wasm32_file}"
  fi

  # qemu-wasm's direct wasm32 TCI TLB-hit path bypasses helper_ld/st_mmu().
  # Keep that fast path, but make it honor MemOp endianness for big-endian
  # guests like m68k/q800 before the ROM builds 68040 MMU descriptors in RAM.
  if ! grep -q 'c89_browser_qemu_wasm32_tci_ld_fast' "${wasm32_file}"; then
    git -C "${QEMU_DIR}" apply "${wasm32_tci_endian_patch}"
  fi

  # Optional wasm32 TCI page-table arena trace. This is a narrow diagnostic for
  # the q800 ROM's 68040 MMU handoff: it records guest stores/loads in the high
  # RAM descriptor arena where native QEMU sees valid SRP/root/page entries.
  if ! grep -q 'C89_BROWSER_QEMU_WASM32_PGTABLE_TRACE' "${wasm32_file}"; then
    git -C "${QEMU_DIR}" apply "${wasm32_pgtable_trace_patch}"
  fi

  # Dynamic mini-WASM TB compilation currently reaches Chrome with helper import
  # signatures that do not always match Emscripten's wasm table entries. Keep
  # the prototype on the TCI fallback path by default so display/input work can
  # continue; set WASM32_INSTANTIATE_NUM=1500 to re-test the upstream threshold.
  perl -0pi -e "s/#define INSTANTIATE_NUM\\s+[0-9]+/#define INSTANTIATE_NUM ${WASM32_INSTANTIATE_NUM}/" "${wasm32_header}"

  # Stock QEMU caps -icount shift=N at 10. Browser fallback TCG is slow enough
  # that shift=10 only advanced ~2s of virtual time in a 45s wall-clock probe,
  # while no-icount lets wall-clock timers outrun guest setup. Higher shifts are
  # deliberately opt-in for timer/progress balance experiments.
  perl -0pi -e "s/#define MAX_ICOUNT_SHIFT\\s+[0-9]+/#define MAX_ICOUNT_SHIFT ${QEMU_WASM_MAX_ICOUNT_SHIFT}/" "${icount_file}"

  # Keep SDL/display/input proxy calls moving while the CPU thread is busy in
  # the fallback TCG interpreter. Use the pthread queue/sleep APIs here instead
  # of forcing emscripten_sleep(), because the latter can leak Asyncify's
  # internal longjmp sentinel into Chrome as an uncaught worker error.
  perl -0pi -e "s/#define MAX_EXEC_NUM\\s+[0-9]+/#define MAX_EXEC_NUM ${WASM32_QUEUE_PUMP_INTERVAL}/" "${wasm32_file}"
  perl -0pi -e 's/static inline void trysleep\(\)\n\{\n    if \(--exec_cnt == 0\) \{\n        if \(!can_add_instance\(\)\) \{\n            emscripten_sleep\(0\); \/\/ return to the browser main loop\n            check_instance_garbage_collected\(\);\n        \}\n        exec_cnt = MAX_EXEC_NUM;\n    \}\n\}/static inline void trysleep()\n{\n    if (--exec_cnt == 0) {\n        emscripten_current_thread_process_queued_calls();\n#if C89_BROWSER_QEMU_THREAD_YIELD\n        emscripten_thread_sleep(0);\n#endif\n        if (!can_add_instance()) {\n            emscripten_thread_sleep(0);\n            check_instance_garbage_collected();\n        }\n        exec_cnt = MAX_EXEC_NUM;\n    }\n}/' "${wasm32_file}"

  # With -audio none in the browser, q800 ROM startup can poll the ASC FIFO IRQ
  # status forever while waiting for channel readiness bits that the muted audio
  # path never refreshes. Keep this behind a browser-build macro so it is easy to
  # disable with QEMU_WASM_ASC_READY_HACK=0 for comparison runs.
  if ! grep -q 'C89_BROWSER_QEMU_ASC_READY_HACK' "${asc_file}"; then
    perl -0pi -e 's/(case ASC_FIFOIRQ:\n        prev = \(s->fifos\[0\]\.int_status & 0x3\) \|\n                \(s->fifos\[1\]\.int_status & 0x3\) << 2;\n)/$1#ifdef C89_BROWSER_QEMU_ASC_READY_HACK\n        \/* C89 browser-qemu: no-audio q800 ROM unblock shim. *\/\n        prev |= (ASC_FIFO_STATUS_HALF_FULL |\n                 ASC_FIFO_STATUS_FULL_EMPTY) |\n                ((ASC_FIFO_STATUS_HALF_FULL |\n                  ASC_FIFO_STATUS_FULL_EMPTY) << 2);\n#endif\n/' "${asc_file}"
  fi

  # Optional rate-limited VIA1 instrumentation for debugging ROM/A/UX boot
  # stalls around VIA timer and interrupt polling. The patch is always applied
  # but is silent unless QEMU_WASM_VIA_TRACE=1 adds the compile-time flag below.
  if ! grep -q 'C89_BROWSER_QEMU_VIA_TRACE' "${via_file}"; then
    git -C "${QEMU_DIR}" apply "${via_trace_patch}"
  fi

  # Experimental upstream ESP overlay. The 8.2-era fork esp.c leaves both the
  # native comparator and the browser guest parked in the ROM SCSI Manager
  # TIB wait loop after the first jag-disk writes, while desktop QEMU 9.0.50
  # boots A/UX from the same images. With QEMU_WASM_ESP_UPSTREAM=1 the
  # vendored esp.c/esp.h are replaced by the pinned upstream versions and the
  # local esp patches below are skipped (they target the 8.2 file).
  if [[ "${QEMU_WASM_ESP_UPSTREAM}" == "1" ]]; then
    mkdir -p "${ROOT}/build/upstream-esp-${QEMU_ESP_UPSTREAM_REF}"
    for f in "hw/scsi/esp.c:esp.c" "include/hw/scsi/esp.h:esp.h" "hw/scsi/trace-events:trace-events" "util/fifo8.c:fifo8.c" "include/qemu/fifo8.h:fifo8.h" "chardev/msmouse.c:msmouse.c"; do
      src_path="${f%%:*}"; cache_name="${f##*:}"
      cache_file="${ROOT}/build/upstream-esp-${QEMU_ESP_UPSTREAM_REF}/${cache_name}"
      if [[ ! -s "${cache_file}" ]]; then
        curl -fsSL "https://gitlab.com/qemu-project/qemu/-/raw/${QEMU_ESP_UPSTREAM_REF}/${src_path}" -o "${cache_file}"
      fi
    done
    cp "${ROOT}/build/upstream-esp-${QEMU_ESP_UPSTREAM_REF}/esp.c" "${QEMU_DIR}/hw/scsi/esp.c"
    cp "${ROOT}/build/upstream-esp-${QEMU_ESP_UPSTREAM_REF}/esp.h" "${QEMU_DIR}/include/hw/scsi/esp.h"
    cp "${ROOT}/build/upstream-esp-${QEMU_ESP_UPSTREAM_REF}/trace-events" "${QEMU_DIR}/hw/scsi/trace-events"
    cp "${ROOT}/build/upstream-esp-${QEMU_ESP_UPSTREAM_REF}/fifo8.c" "${QEMU_DIR}/util/fifo8.c"
    cp "${ROOT}/build/upstream-esp-${QEMU_ESP_UPSTREAM_REF}/fifo8.h" "${QEMU_DIR}/include/qemu/fifo8.h"
    cp "${ROOT}/build/upstream-esp-${QEMU_ESP_UPSTREAM_REF}/msmouse.c" "${QEMU_DIR}/chardev/msmouse.c"
    # Remaining 8.2-era callers of the old fifo8_pop_buf/peek_buf semantics
    # keep their behavior under the 9.x names (the upstream rename).
    for legacy in ui/console-vc.c hw/char/goldfish_tty.c hw/net/allwinner_emac.c; do
      perl -0pi -e 's/\bfifo8_pop_buf\(/fifo8_pop_bufptr(/g unless /fifo8_pop_bufptr/' "${QEMU_DIR}/${legacy}"
      perl -0pi -e 's/\bfifo8_peek_buf\(/fifo8_peek_bufptr(/g unless /fifo8_peek_bufptr/' "${QEMU_DIR}/${legacy}"
    done
  fi

  # Optional ESP/SCSI instrumentation for the current browser disk-boot
  # blocker. It records register/status/IRQ/DRQ/PDMA transitions and is silent
  # unless QEMU_WASM_ESP_TRACE=1 adds the compile-time flag below.
  if [[ "${QEMU_WASM_ESP_UPSTREAM}" != "1" ]] && ! grep -q 'C89_BROWSER_QEMU_ESP_TRACE' "${QEMU_DIR}/hw/scsi/esp.c"; then
    git -C "${QEMU_DIR}" apply "${esp_trace_patch}"
  fi

  # q800 ROM disk reads use ESP pseudo-DMA through guest MMIO. QEMU already
  # accepts 32-bit accesses here but used to split them into 16-bit callbacks;
  # implement direct longword accesses to reduce browser fallback overhead.
  if [[ "${QEMU_WASM_ESP_UPSTREAM}" != "1" ]] && ! grep -q 'pdma-write", 0xfe, size' "${QEMU_DIR}/hw/scsi/esp.c"; then
    git -C "${QEMU_DIR}" apply "${esp_pdma_longword_patch}"
  fi

  # Optional browser-only pseudo-DMA throughput experiment: default behavior
  # remains a 16-byte ESP FIFO, but test builds can allocate a larger internal
  # FIFO while clamping the guest-visible RFLAGS count back to 16.
  if [[ "${QEMU_WASM_ESP_UPSTREAM}" != "1" ]] && ! grep -q 'C89_BROWSER_QEMU_ESP_PDMA_FIFO_CAPACITY' "${QEMU_DIR}/hw/scsi/esp.c"; then
    git -C "${QEMU_DIR}" apply "${esp_pdma_fifo_patch}"
  fi

  # Dump the first 16 bytes of the SCSI layer buffer when it is handed to the
  # ESP for a data-in transfer. Distinguishes block/lazy-file corruption from
  # ESP FIFO sequencing corruption. Silent unless QEMU_WASM_ESP_TRACE=1.
  if [[ "${QEMU_WASM_ESP_UPSTREAM}" != "1" ]] && ! grep -q 'c89-esp-buf' "${QEMU_DIR}/hw/scsi/esp.c"; then
    perl -0pi -e 's/(    C89_ESP_TRACE\(s, "transfer-data-enter", 0xff, len\);\n    s->async_len = len;\n    s->async_buf = scsi_req_get_buf\(req\);\n)/$1#ifdef C89_BROWSER_QEMU_ESP_TRACE\n    if (len >= 16 && s->async_buf) {\n        fprintf(stderr,\n                "[c89-esp-buf] len=%u buf=%02x%02x%02x%02x %02x%02x%02x%02x "\n                "%02x%02x%02x%02x %02x%02x%02x%02x\\n",\n                len,\n                s->async_buf[0], s->async_buf[1], s->async_buf[2],\n                s->async_buf[3], s->async_buf[4], s->async_buf[5],\n                s->async_buf[6], s->async_buf[7], s->async_buf[8],\n                s->async_buf[9], s->async_buf[10], s->async_buf[11],\n                s->async_buf[12], s->async_buf[13], s->async_buf[14],\n                s->async_buf[15]);\n        fflush(stderr);\n    }\n#endif\n/' "${QEMU_DIR}/hw/scsi/esp.c"
  fi

  # Log the assembled value of each ESP pseudo-DMA read so the bytes the ROM
  # actually receives can be compared against the disk image (jag-disk DDM
  # rejection diagnosis, June 12 2026). Silent unless QEMU_WASM_ESP_TRACE=1.
  if [[ "${QEMU_WASM_ESP_UPSTREAM}" != "1" ]] && ! grep -q 'pdma-read-val' "${QEMU_DIR}/hw/scsi/esp.c"; then
    perl -0pi -e 's/(    if \(fifo8_num_used\(&s->fifo\) < 2\) \{\n        esp_pdma_cb\(s\);\n    \}\n    return val;\n\})/    if (fifo8_num_used(&s->fifo) < 2) {\n        esp_pdma_cb(s);\n    }\n    C89_ESP_TRACE(s, "pdma-read-val", 0xfe, (uint32_t)val);\n    return val;\n}/' "${QEMU_DIR}/hw/scsi/esp.c"
  fi

  # Optional browser-only boot experiment: disable ADB autopoll-ready IRQs so
  # we can test whether the ROM reaches ESP/SCSI when ADB traffic is quiet.
  if ! grep -q 'C89_BROWSER_QEMU_ADB_AUTOPOLL_SUPPRESS' "${via_file}"; then
    git -C "${QEMU_DIR}" apply "${adb_autopoll_suppress_patch}"
  fi

  # Browser-only boot probe helper: the q800 ROM's destructive RAM test is
  # extremely slow on the wasm32 fallback TCG path. The patch is inert unless
  # QEMU_WASM_ROM_RAMTEST_HACK=1 adds the compile-time flag below.
  if ! grep -q 'C89_BROWSER_QEMU_ROM_RAMTEST_HACK' "${QEMU_DIR}/target/m68k/helper.c"; then
    git -C "${QEMU_DIR}" apply "${ramtest_patch}"
  fi

  # Optional wasm32 TCG progress tracing. This prints rate-limited m68k PC
  # phase/register snapshots from the browser-only execution loop.
  if ! grep -q 'C89_BROWSER_QEMU_M68K_PC_TRACE' "${QEMU_DIR}/target/m68k/helper.c"; then
    git -C "${QEMU_DIR}" apply "${pc_trace_patch}"
  fi

  # Optional wasm32 m68k exception/MMU frame trace for dynamic-TB double-fault
  # diagnostics. It is silent unless QEMU_WASM_M68K_EXC_TRACE=1 adds the flag.
  if ! grep -q 'C89_BROWSER_QEMU_M68K_EXC_TRACE' "${QEMU_DIR}/target/m68k/op_helper.c"; then
    git -C "${QEMU_DIR}" apply "${exc_trace_patch}"
  fi

  # Optional wasm32 m68k TB return/path trace for dynamic-TB diagnostics. This
  # logs TB enter/exit decode plus whether wasm32 used TCI or a mini-WASM TB.
  if ! grep -q 'C89_BROWSER_QEMU_M68K_TB_TRACE' "${QEMU_DIR}/accel/tcg/cpu-exec.c"; then
    git -C "${QEMU_DIR}" apply "${tb_trace_patch}"
  fi

  # Optional wasm32 m68k MMU-control experiment: flush QEMU's soft TLB after
  # 68040 MOVEC writes to TC/SRP/URP/TTR registers. This tests whether dynamic
  # mini-WASM TBs are reusing stale translation state across the ROM's MMU-on
  # jump at 0x408815e6 -> 0x408815a0 -> (A2).
  if ! grep -q 'C89_BROWSER_QEMU_M68K_MOVEC_TLB_FLUSH' "${QEMU_DIR}/target/m68k/helper.c"; then
    git -C "${QEMU_DIR}" apply "${movec_tlb_flush_patch}"
  fi

  # Optional 68040 MMU page-walk trace. This records the TTR/root/pointer/page
  # descriptor path for the ROM's MMU-on transition without changing default
  # runtime behavior.
  if ! grep -q 'C89_BROWSER_QEMU_M68K_MMU_WALK_TRACE' "${QEMU_DIR}/target/m68k/helper.c"; then
    git -C "${QEMU_DIR}" apply "${mmu_walk_trace_patch}"
  fi

  # Optional browser-only cooperative CPU-loop exit pump. A single bare HMP
  # "cont" currently stalls near the first sampled low-memory ROM PC, while
  # stop/sample/cont pulses make the q800 ROM reach SCSI. This experiment asks
  # QEMU's own TCG loop to return to the RR/main-loop path every N pthread queue
  # pump batches, mimicking the useful part of the external pulse without HMP.
  if ! grep -q 'C89_BROWSER_QEMU_TCG_EXIT_PUMP_INTERVAL' "${wasm32_file}"; then
    perl -0pi -e 's/(#include "wasm32\.h"\n)/$1\n#ifndef C89_BROWSER_QEMU_TCG_EXIT_PUMP_INTERVAL\n#define C89_BROWSER_QEMU_TCG_EXIT_PUMP_INTERVAL 0\n#endif\n\n#if C89_BROWSER_QEMU_TCG_EXIT_PUMP_INTERVAL > 0\n#include "hw\/core\/cpu.h"\n#endif\n/' "${wasm32_file}"
  fi
  if ! grep -q 'c89_browser_qemu_tcg_exit_pump' "${wasm32_file}"; then
    perl -0pi -e 's/(__thread int exec_cnt = MAX_EXEC_NUM;\n)/$1\n#if C89_BROWSER_QEMU_TCG_EXIT_PUMP_INTERVAL > 0\n__thread int c89_browser_qemu_tcg_exit_pump_cnt;\n\nstatic inline void c89_browser_qemu_tcg_exit_pump(void)\n{\n    if (++c89_browser_qemu_tcg_exit_pump_cnt <\n        C89_BROWSER_QEMU_TCG_EXIT_PUMP_INTERVAL) {\n        return;\n    }\n\n    c89_browser_qemu_tcg_exit_pump_cnt = 0;\n    if (current_cpu) {\n        cpu_exit(current_cpu);\n    }\n}\n#else\nstatic inline void c89_browser_qemu_tcg_exit_pump(void)\n{\n}\n#endif\n/' "${wasm32_file}"
  fi
  if ! grep -q 'c89_browser_qemu_tcg_exit_pump();' "${wasm32_file}"; then
    perl -0pi -e 's/(emscripten_current_thread_process_queued_calls\(\);\n)/$1        c89_browser_qemu_tcg_exit_pump();\n/' "${wasm32_file}"
  fi

  # Browser-only TCI-only guard. With dynamic mini-WASM TBs "disabled" via
  # INSTANTIATE_NUM=INT32_MAX, a hot TB's per-TB counter still crosses the
  # threshold after ~2.1e9 executions, after which goto_tb/goto_ptr bail out
  # of TCI and the outer loop calls instantiate_wasm() on a fallback build --
  # the known-broken dynamic-TB path. Under this flag the counter saturates,
  # chains never bail to wasm TBs, and the outer loop always takes TCI.
  if ! grep -q 'C89_BROWSER_QEMU_TCI_ONLY' "${wasm32_file}"; then
    perl -0pi -e 's/(#include "wasm32\.h"\n)/$1\n#ifndef C89_BROWSER_QEMU_TCI_ONLY\n#define C89_BROWSER_QEMU_TCI_ONLY 0\n#endif\n/' "${wasm32_file}"
    perl -0pi -e 's/if \(\(\*\(int32_t\*\)tb_counter_ptr >= 0\) && \(\*\(int32_t\*\)tb_counter_ptr < INSTANTIATE_NUM\)\) \{\n(\s+)\*\(int32_t\*\)tb_counter_ptr \+= 1;/if (C89_BROWSER_QEMU_TCI_ONLY ||\n$1((*(int32_t*)tb_counter_ptr >= 0) && (*(int32_t*)tb_counter_ptr < INSTANTIATE_NUM))) {\n$1if (!C89_BROWSER_QEMU_TCI_ONLY) {\n$1    *(int32_t*)tb_counter_ptr += 1;\n$1}/g' "${wasm32_file}"
    perl -0pi -e 's/int fidx = get_instance_running_local\(ctx\.tb_ptr\);/int fidx = C89_BROWSER_QEMU_TCI_ONLY ? 0 : get_instance_running_local(ctx.tb_ptr);/' "${wasm32_file}"
    perl -0pi -e 's/\} else if \(c89_counter < INSTANTIATE_NUM\) \{\n(\s+)c89_path = "tci-cold";\n(\s+)\*\(int32_t\*\)tb_counter_ptr \+= 1;/} else if (C89_BROWSER_QEMU_TCI_ONLY || c89_counter < INSTANTIATE_NUM) {\n$1c89_path = "tci-cold";\n$2if (!C89_BROWSER_QEMU_TCI_ONLY) {\n$2    *(int32_t*)tb_counter_ptr += 1;\n$2}/' "${wasm32_file}"
  fi

  # Browser-only MMIO backoff. Continuous browser runs permanently starve the
  # QEMU main-loop worker after 60-120s: the CPU thread's high-frequency MMIO
  # BQL lock/unlock churn wins every futex race against the parked main-loop
  # worker, so timers stop firing and HMP stop is never acknowledged (CPU
  # pegged at 100%, ptyQueuedBytes drained, no monitor output). Every Nth
  # MMIO completion, after the BQL is released, park this thread briefly with
  # a raw memory.atomic.wait32 -- a pure wasm instruction, safe at TCI/helper
  # depth where emscripten/asyncify machinery is not -- so the main-loop
  # worker gets a scheduling window to win the lock.
  if ! grep -q 'c89_browser_qemu_mmio_backoff' "${cputlb_file}"; then
    perl -0pi -e 's/(#include "qemu\/osdep\.h"\n)/$1\n#ifndef C89_BROWSER_QEMU_MMIO_BACKOFF_INTERVAL\n#define C89_BROWSER_QEMU_MMIO_BACKOFF_INTERVAL 0\n#endif\n#ifndef C89_BROWSER_QEMU_MMIO_BACKOFF_NS\n#define C89_BROWSER_QEMU_MMIO_BACKOFF_NS 500000\n#endif\n#if C89_BROWSER_QEMU_MMIO_BACKOFF_INTERVAL > 0\nstatic __thread int c89_browser_qemu_mmio_backoff_cnt;\nstatic inline void c89_browser_qemu_mmio_backoff(void)\n{\n    static __thread int c89_browser_qemu_mmio_backoff_dummy;\n    if (++c89_browser_qemu_mmio_backoff_cnt <\n        C89_BROWSER_QEMU_MMIO_BACKOFF_INTERVAL) {\n        return;\n    }\n    c89_browser_qemu_mmio_backoff_cnt = 0;\n    __builtin_wasm_memory_atomic_wait32(\n        &c89_browser_qemu_mmio_backoff_dummy, 0,\n        C89_BROWSER_QEMU_MMIO_BACKOFF_NS);\n}\n#else\nstatic inline void c89_browser_qemu_mmio_backoff(void)\n{\n}\n#endif\n/' "${cputlb_file}"
    perl -0pi -e 's/(    qemu_mutex_unlock_iothread\(\);\n\n    return ret;\n\})/    qemu_mutex_unlock_iothread();\n    c89_browser_qemu_mmio_backoff();\n\n    return ret;\n}/g' "${cputlb_file}"
    perl -0pi -e 's/(    qemu_mutex_unlock_iothread\(\);\n\n    return int128_make128\(b, a\);\n\})/    qemu_mutex_unlock_iothread();\n    c89_browser_qemu_mmio_backoff();\n\n    return int128_make128(b, a);\n}/' "${cputlb_file}"
  fi

  # Browser-only CPU-thread sleep pump. The known-good 30s HMP stop/cont
  # pulses park the CPU thread, letting the QEMU main-loop thread win the BQL
  # and run virtual-clock timer callbacks (VIA IFR updates the ROM polls).
  # cpu_exit() alone never parks the thread. This experiment makes the CPU
  # thread take a short real sleep between TBs every N pump batches, with the
  # BQL released, as an in-source micro-pulse.
  if ! grep -q 'c89_browser_qemu_tcg_sleep_pump' "${wasm32_file}"; then
    perl -0pi -e 's/(#include "wasm32\.h"\n)/$1\n#ifndef C89_BROWSER_QEMU_TCG_SLEEP_PUMP_INTERVAL\n#define C89_BROWSER_QEMU_TCG_SLEEP_PUMP_INTERVAL 0\n#endif\n#ifndef C89_BROWSER_QEMU_TCG_SLEEP_PUMP_MS\n#define C89_BROWSER_QEMU_TCG_SLEEP_PUMP_MS 0\n#endif\n/' "${wasm32_file}"
    perl -0pi -e 's/(__thread int exec_cnt = MAX_EXEC_NUM;\n)/$1\n#if C89_BROWSER_QEMU_TCG_SLEEP_PUMP_INTERVAL > 0 && C89_BROWSER_QEMU_TCG_SLEEP_PUMP_MS > 0\n__thread int c89_browser_qemu_tcg_sleep_pump_cnt;\n\nstatic inline void c89_browser_qemu_tcg_sleep_pump(void)\n{\n    if (++c89_browser_qemu_tcg_sleep_pump_cnt <\n        C89_BROWSER_QEMU_TCG_SLEEP_PUMP_INTERVAL) {\n        return;\n    }\n    c89_browser_qemu_tcg_sleep_pump_cnt = 0;\n    emscripten_thread_sleep(C89_BROWSER_QEMU_TCG_SLEEP_PUMP_MS);\n}\n#else\nstatic inline void c89_browser_qemu_tcg_sleep_pump(void)\n{\n}\n#endif\n/' "${wasm32_file}"
    perl -0pi -e 's/(        emscripten_current_thread_process_queued_calls\(\);\n)/$1        c89_browser_qemu_tcg_sleep_pump();\n/' "${wasm32_file}"
  fi

  # Browser-only TCI chain-pump experiment. trysleep() (queued-call pump,
  # optional exit pump, optional yield) only runs in tcg_qemu_tb_exec's outer
  # loop, but tcg_qemu_tb_exec_tci follows goto_tb/goto_ptr chains internally
  # without returning there. ROM wait loops are exactly such chains, so the
  # earlier exit-pump experiment could never fire while the guest was stuck.
  # This gated patch calls trysleep() at the two TCI chain-transition points;
  # cpu_exit() is then honored by the next chained TB's own generated
  # icount_decr prologue check, which exits with a genuine TB_EXIT_REQUESTED.
  # The chain-site pump must not run emscripten machinery: calling trysleep()
  # (process_queued_calls/thread_sleep) from inside the TCI interpreter frame
  # hard-wedged the runtime at any dose (chainpump probes, June 12 2026).
  # In chain context only request a CPU exit -- cpu_exit() is two atomic
  # stores -- and let the next chained TB's generated icount_decr prologue
  # exit to the outer loop, where the full trysleep() pump is safe.
  if ! grep -q 'C89_BROWSER_QEMU_TCI_CHAIN_PUMP' "${wasm32_file}"; then
    perl -0pi -e 's/(#include "wasm32\.h"\n)/$1\n#ifndef C89_BROWSER_QEMU_TCI_CHAIN_PUMP\n#define C89_BROWSER_QEMU_TCI_CHAIN_PUMP 0\n#endif\n#ifndef C89_BROWSER_QEMU_TCI_CHAIN_PUMP_INTERVAL\n#define C89_BROWSER_QEMU_TCI_CHAIN_PUMP_INTERVAL 1024\n#endif\n#if C89_BROWSER_QEMU_TCI_CHAIN_PUMP\n#include "hw\/core\/cpu.h"\nextern __thread int c89_browser_qemu_tci_chain_pump_cnt;\n#endif\n/' "${wasm32_file}"
    perl -0pi -e 's/(__thread uintptr_t tci_tb_ptr;\n\n\/\* Disassemble TCI bytecode\. \*\/\n)/#if C89_BROWSER_QEMU_TCI_CHAIN_PUMP\n__thread int c89_browser_qemu_tci_chain_pump_cnt;\n\nstatic inline void c89_browser_qemu_tci_chain_exit_request(void)\n{\n    if (++c89_browser_qemu_tci_chain_pump_cnt >=\n        C89_BROWSER_QEMU_TCI_CHAIN_PUMP_INTERVAL) {\n        c89_browser_qemu_tci_chain_pump_cnt = 0;\n        if (current_cpu) {\n            cpu_exit(current_cpu);\n        }\n    }\n}\n#endif\n\n$1/' "${wasm32_file}"
    perl -0pi -e 's/(tb_ptr = \*\(uint32_t \*\*\)ptr;\n                ctx\.tb_ptr = tb_ptr;\n)/$1#if C89_BROWSER_QEMU_TCI_CHAIN_PUMP\n                c89_browser_qemu_tci_chain_exit_request();\n#endif\n/' "${wasm32_file}"
    perl -0pi -e 's/(tb_ptr = ptr;\n\n            ctx\.tb_ptr = tb_ptr;\n)/$1#if C89_BROWSER_QEMU_TCI_CHAIN_PUMP\n            c89_browser_qemu_tci_chain_exit_request();\n#endif\n/' "${wasm32_file}"
  fi

  # Browser-only boot probe helper: the q800 ROM's early VIA timing self-test
  # treats T2 as a one-shot source. The qemu-wasm base reschedules T2 while IER
  # remains enabled, making the ROM's D5/T2 count run ahead of the 60Hz count.
  # Keep this patch gated so comparison runs can disable it easily.
  if ! grep -q 'C89_BROWSER_QEMU_VIA_T2_ONESHOT_HACK' "${QEMU_DIR}/hw/misc/mos6522.c"; then
    git -C "${QEMU_DIR}" apply "${t2_oneshot_patch}"
  fi

  # browser-qemu ethernet (Phase 1): a "wasmbridge" net backend that shuttles
  # raw L2 frames between the dp8393x NIC and JS via wasm-memory ring buffers.
  # The relay's slirp handles TCP/IP; this backend is deliberately dumb. The
  # source lives in scripts/patches/ and is copied in (the new file survives the
  # checkout --force above, but copy it every build for reproducibility); the
  # small edits to tracked QAPI/net files are idempotent perl splices.
  local wasmnet_src="${ROOT}/scripts/patches/qemu-wasm-wasmnet.c"
  local net_json="${QEMU_DIR}/qapi/net.json"
  local net_clients="${QEMU_DIR}/net/clients.h"
  local net_dispatch="${QEMU_DIR}/net/net.c"
  local net_meson="${QEMU_DIR}/net/meson.build"
  cp "${wasmnet_src}" "${QEMU_DIR}/net/wasmbridge.c"

  if ! grep -q 'NetdevWasmBridgeOptions' "${net_json}"; then
    # New options struct (with its own doc comment, inserted BEFORE the
    # NetClientDriver doc block so QAPI does not mis-associate doc comments),
    # the enum value, and the discriminated-union branch.
    perl -0pi -e "s/(##\\n# \@NetClientDriver:)/##\\n# \@NetdevWasmBridgeOptions:\\n#\\n# Bridge guest L2 Ethernet frames to JavaScript via wasm-memory ring\\n# buffers (browser-qemu).\\n#\\n# \@url: optional relay hint; ignored by the backend (the page-side\\n#     bridge uses it)\\n#\\n# Since: 9.0\\n##\\n\\{ 'struct': 'NetdevWasmBridgeOptions',\\n  'data': \\{\\n    '*url': 'str' \\} \\}\\n\\n\$1/" "${net_json}"
    perl -0pi -e "s/'hubport', 'netmap'/'hubport', 'wasmbridge', 'netmap'/" "${net_json}"
    perl -0pi -e "s/(    'hubport':  'NetdevHubPortOptions',\\n)/\$1    'wasmbridge': 'NetdevWasmBridgeOptions',\\n/" "${net_json}"
  fi

  if ! grep -q 'net_init_wasmbridge' "${net_clients}"; then
    perl -0pi -e "s/(int net_init_hubport\\(const Netdev \\*netdev, const char \\*name,\\n                     NetClientState \\*peer, Error \\*\\*errp\\);\\n)/\$1\\nint net_init_wasmbridge(const Netdev *netdev, const char *name,\\n                        NetClientState *peer, Error **errp);\\n/" "${net_clients}"
  fi

  if ! grep -q 'net_init_wasmbridge' "${net_dispatch}"; then
    perl -0pi -e "s/(\\[NET_CLIENT_DRIVER_HUBPORT\\]   = net_init_hubport,\\n)/\$1        [NET_CLIENT_DRIVER_WASMBRIDGE] = net_init_wasmbridge,\\n/" "${net_dispatch}"
  fi

  if ! grep -q "wasmbridge.c" "${net_meson}"; then
    perl -0pi -e "s/(  'util\\.c',\\n)\\)\\)/\$1  'wasmbridge.c',\\n))/" "${net_meson}"
  fi

  # browser-qemu input (Phase 1): a shared-memory input bridge inspired by
  # 68k_web. JS writes pointer/key events into wasm memory; a QEMU main-loop
  # timer injects directly into the q800 ADB devices, avoiding HMP monitor text
  # commands for headed browser interaction.
  local wasminput_src="${ROOT}/scripts/patches/qemu-wasm-wasminput.c"
  local ui_meson="${QEMU_DIR}/ui/meson.build"
  local adb_header="${QEMU_DIR}/include/hw/input/adb.h"
  local adb_kbd="${QEMU_DIR}/hw/input/adb-kbd.c"
  local adb_mouse="${QEMU_DIR}/hw/input/adb-mouse.c"
  local adb_button_queue_patch="${ROOT}/scripts/patches/qemu-wasm-adb-button-queue.patch"
  cp "${wasminput_src}" "${QEMU_DIR}/ui/wasminput.c"

  if ! grep -q "wasminput.c" "${ui_meson}"; then
    perl -0pi -e "s/(  'input\\.c',\\n)/\$1  'wasminput.c',\\n/" "${ui_meson}"
  fi

  perl -0pi -e 's{#define TYPE_ADB_MOUSE "adb-mouse".*?#endif /\* ADB_H \*/}{#define TYPE_ADB_MOUSE "adb-mouse"\n\ntypedef struct C89ADBMouseDebug {\n    int abs_x;\n    int abs_y;\n    int pending_dx;\n    int pending_dy;\n    int buttons_state;\n    int last_buttons_state;\n    int desired_buttons;\n    int queue_depth;\n    int last_poll_before_x;\n    int last_poll_before_y;\n    int last_poll_after_x;\n    int last_poll_after_y;\n    int last_poll_dx;\n    int last_poll_dy;\n    int last_poll_buttons;\n    uint32_t poll_count;\n    uint32_t empty_poll_count;\n} C89ADBMouseDebug;\n\nvoid c89_adb_kbd_put_key(int adb_keycode, bool down);\nvoid c89_adb_mouse_event(int dx, int dy, int buttons_state);\nvoid c89_adb_mouse_set_event(int dx, int dy, int buttons_state);\nvoid c89_adb_mouse_set_position(int x, int y);\nbool c89_adb_mouse_get_position(int *x, int *y, int *pending_dx, int *pending_dy);\nbool c89_adb_mouse_get_debug(C89ADBMouseDebug *debug);\n\n#endif /* ADB_H */}s' "${adb_header}"

  if ! grep -q 'c89_adb_keyboard' "${adb_kbd}"; then
    perl -0pi -e 's/(struct ADBKeyboardClass \{\n    \/\*< private >\*\/\n    ADBDeviceClass parent_class;\n    \/\*< public >\*\/\n\n    DeviceRealize parent_realize;\n\};\n)/$1\nstatic KBDState *c89_adb_keyboard;\n/' "${adb_kbd}"
    perl -0pi -e 's/(static int adb_kbd_poll\(ADBDevice \*d, uint8_t \*obuf\)\n)/void c89_adb_kbd_put_key(int adb_keycode, bool down)\n{\n    if (!c89_adb_keyboard || adb_keycode < 0 || adb_keycode > 0x7f) {\n        return;\n    }\n    adb_kbd_put_keycode(c89_adb_keyboard,\n                        down ? adb_keycode : (adb_keycode | 0x80));\n}\n\n$1/' "${adb_kbd}"
    perl -0pi -e 's/(static void adb_kbd_realizefn\(DeviceState \*dev, Error \*\*errp\)\n\{\n    ADBKeyboardClass \*akc = ADB_KEYBOARD_GET_CLASS\(dev\);\n    akc->parent_realize\(dev, errp\);\n)/$1    c89_adb_keyboard = ADB_KEYBOARD(dev);\n/' "${adb_kbd}"
  fi

  if ! grep -q 'c89_adb_mouse_button_queue' "${adb_mouse}"; then
    git -C "${QEMU_DIR}" apply "${adb_button_queue_patch}"
  fi
  if grep -q 'c89_adb_mouse_clear_button_queue(s->buttons_state);' "${adb_mouse}"; then
    perl -0pi -e 's/\n        c89_adb_mouse_clear_button_queue\(s->buttons_state\);//' "${adb_mouse}"
  fi
}

apply_qemu_wasm_source_patches

echo "Using qemu-wasm at $(git -C "${QEMU_DIR}" rev-parse HEAD)"
echo "Using keycodemapdb at $(git -C "${QEMU_DIR}/subprojects/keycodemapdb" rev-parse HEAD)"
echo "Using berkeley-softfloat-3 at $(git -C "${QEMU_DIR}/subprojects/berkeley-softfloat-3" rev-parse HEAD)"
echo "Using berkeley-testfloat-3 at $(git -C "${QEMU_DIR}/subprojects/berkeley-testfloat-3" rev-parse HEAD)"

if [[ "${QEMU_FETCH_ONLY:-0}" == "1" ]]; then
  exit 0
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required for this build script" >&2
  exit 1
fi

PATCHED_DOCKERFILE="${ROOT}/build/qemu-wasm.Dockerfile"
sed \
  -e 's#https://zlib.net/zlib-\$ZLIB_VERSION.tar.xz#https://zlib.net/fossils/zlib-\$ZLIB_VERSION.tar.gz#' \
  -e 's#tar xJC /zlib#tar xzC /zlib#' \
  "${QEMU_DIR}/Dockerfile" > "${PATCHED_DOCKERFILE}"

if [[ "${FORCE_DOCKER_BUILD:-0}" == "1" ]] || ! docker image inspect "${DOCKER_IMAGE}" >/dev/null 2>&1; then
  echo "Building Docker image ${DOCKER_IMAGE} with local zlib URL workaround"
  docker build --progress="${DOCKER_PROGRESS}" -t "${DOCKER_IMAGE}" - < "${PATCHED_DOCKERFILE}"
else
  echo "Using existing Docker image ${DOCKER_IMAGE}; set FORCE_DOCKER_BUILD=1 to rebuild it"
fi

docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
docker run --rm -d \
  --name "${CONTAINER}" \
  --cpus="${DOCKER_CPUS}" \
  -v "${QEMU_DIR}:/qemu:ro" \
  "${DOCKER_IMAGE}" \
  sleep infinity >/dev/null

cleanup() {
  if [[ "${KEEP_CONTAINER:-0}" != "1" ]]; then
    docker rm -f "${CONTAINER}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

ASC_READY_HACK_CFLAG=""
if [[ "${QEMU_WASM_ASC_READY_HACK}" == "1" ]]; then
  ASC_READY_HACK_CFLAG=" -DC89_BROWSER_QEMU_ASC_READY_HACK=1"
fi
ROM_RAMTEST_HACK_CFLAG=""
if [[ "${QEMU_WASM_ROM_RAMTEST_HACK}" == "1" ]]; then
  ROM_RAMTEST_HACK_CFLAG=" -DC89_BROWSER_QEMU_ROM_RAMTEST_HACK=1"
fi
ROM_DELAY_HACK_CFLAG=""
if [[ "${QEMU_WASM_ROM_DELAY_HACK}" == "1" ]]; then
  ROM_DELAY_HACK_CFLAG=" -DC89_BROWSER_QEMU_ROM_DELAY_HACK=1"
fi
VIA_TRACE_CFLAG=""
if [[ "${QEMU_WASM_VIA_TRACE}" == "1" ]]; then
  VIA_TRACE_CFLAG=" -DC89_BROWSER_QEMU_VIA_TRACE=1"
fi
ESP_TRACE_CFLAG=""
if [[ "${QEMU_WASM_ESP_TRACE}" == "1" ]]; then
  ESP_TRACE_CFLAG=" -DC89_BROWSER_QEMU_ESP_TRACE=1"
fi
ESP_PDMA_FIFO_CFLAG=""
if [[ "${QEMU_WASM_ESP_PDMA_FIFO_CAPACITY}" != "16" ]]; then
  ESP_PDMA_FIFO_CFLAG=" -DC89_BROWSER_QEMU_ESP_PDMA_FIFO_CAPACITY=${QEMU_WASM_ESP_PDMA_FIFO_CAPACITY}"
fi
TCG_EXIT_PUMP_CFLAG=""
if [[ "${QEMU_WASM_TCG_EXIT_PUMP_INTERVAL}" != "0" ]]; then
  TCG_EXIT_PUMP_CFLAG=" -DC89_BROWSER_QEMU_TCG_EXIT_PUMP_INTERVAL=${QEMU_WASM_TCG_EXIT_PUMP_INTERVAL}"
fi
TCI_CHAIN_PUMP_CFLAG=""
if [[ "${QEMU_WASM_TCI_CHAIN_PUMP}" == "1" ]]; then
  TCI_CHAIN_PUMP_CFLAG=" -DC89_BROWSER_QEMU_TCI_CHAIN_PUMP=1 -DC89_BROWSER_QEMU_TCI_CHAIN_PUMP_INTERVAL=${QEMU_WASM_TCI_CHAIN_PUMP_INTERVAL}"
fi
TCI_ONLY_CFLAG=""
if [[ "${QEMU_WASM_TCI_ONLY:-0}" == "1" ]]; then
  TCI_ONLY_CFLAG=" -DC89_BROWSER_QEMU_TCI_ONLY=1"
fi
SLEEP_PUMP_CFLAG=""
if [[ "${QEMU_WASM_TCG_SLEEP_PUMP_INTERVAL}" != "0" && "${QEMU_WASM_TCG_SLEEP_PUMP_MS}" != "0" ]]; then
  SLEEP_PUMP_CFLAG=" -DC89_BROWSER_QEMU_TCG_SLEEP_PUMP_INTERVAL=${QEMU_WASM_TCG_SLEEP_PUMP_INTERVAL} -DC89_BROWSER_QEMU_TCG_SLEEP_PUMP_MS=${QEMU_WASM_TCG_SLEEP_PUMP_MS}"
fi
MMIO_BACKOFF_CFLAG=""
if [[ "${QEMU_WASM_MMIO_BACKOFF_INTERVAL}" != "0" ]]; then
  MMIO_BACKOFF_CFLAG=" -DC89_BROWSER_QEMU_MMIO_BACKOFF_INTERVAL=${QEMU_WASM_MMIO_BACKOFF_INTERVAL} -DC89_BROWSER_QEMU_MMIO_BACKOFF_NS=${QEMU_WASM_MMIO_BACKOFF_NS}"
fi
M68K_PC_TRACE_CFLAG=""
if [[ "${QEMU_WASM_M68K_PC_TRACE}" == "1" ]]; then
  M68K_PC_TRACE_CFLAG=" -DC89_BROWSER_QEMU_M68K_PC_TRACE=1"
fi
M68K_EXC_TRACE_CFLAG=""
if [[ "${QEMU_WASM_M68K_EXC_TRACE}" == "1" ]]; then
  M68K_EXC_TRACE_CFLAG=" -DC89_BROWSER_QEMU_M68K_EXC_TRACE=1"
fi
M68K_TB_TRACE_CFLAG=""
if [[ "${QEMU_WASM_M68K_TB_TRACE}" == "1" ]]; then
  M68K_TB_TRACE_CFLAG=" -DC89_BROWSER_QEMU_M68K_TB_TRACE=1"
fi
M68K_MOVEC_TLB_FLUSH_CFLAG=""
if [[ "${QEMU_WASM_M68K_MOVEC_TLB_FLUSH}" == "1" ]]; then
  M68K_MOVEC_TLB_FLUSH_CFLAG=" -DC89_BROWSER_QEMU_M68K_MOVEC_TLB_FLUSH=1"
fi
M68K_MMU_WALK_TRACE_CFLAG=""
if [[ "${QEMU_WASM_M68K_MMU_WALK_TRACE}" == "1" ]]; then
  M68K_MMU_WALK_TRACE_CFLAG=" -DC89_BROWSER_QEMU_M68K_MMU_WALK_TRACE=1"
fi
WASM32_PGTABLE_TRACE_CFLAG=""
if [[ "${QEMU_WASM_WASM32_PGTABLE_TRACE}" == "1" ]]; then
  WASM32_PGTABLE_TRACE_CFLAG=" -DC89_BROWSER_QEMU_WASM32_PGTABLE_TRACE=1"
fi
ADB_AUTOPOLL_SUPPRESS_CFLAG=""
if [[ "${QEMU_WASM_ADB_AUTOPOLL_SUPPRESS}" == "1" ]]; then
  ADB_AUTOPOLL_SUPPRESS_CFLAG=" -DC89_BROWSER_QEMU_ADB_AUTOPOLL_SUPPRESS=1"
fi
VIA_T2_ONESHOT_HACK_CFLAG=""
if [[ "${QEMU_WASM_VIA_T2_ONESHOT_HACK}" == "1" ]]; then
  VIA_T2_ONESHOT_HACK_CFLAG=" -DC89_BROWSER_QEMU_VIA_T2_ONESHOT_HACK=1"
fi
THREAD_YIELD_CFLAG=""
if [[ "${QEMU_WASM_THREAD_YIELD}" == "1" ]]; then
  THREAD_YIELD_CFLAG=" -DC89_BROWSER_QEMU_THREAD_YIELD=1"
fi
EMULATE_FUNCTION_POINTER_CASTS_CFLAG=""
EMULATE_FUNCTION_POINTER_CASTS_LDFLAG=""
QEMU_WASM_DYNAMIC_TB_START_ABI="ii"
if [[ "${QEMU_WASM_EMULATE_FUNCTION_POINTER_CASTS}" == "1" ]]; then
  EMULATE_FUNCTION_POINTER_CASTS_CFLAG=" -sEMULATE_FUNCTION_POINTER_CASTS=1"
  EMULATE_FUNCTION_POINTER_CASTS_LDFLAG=" -sEMULATE_FUNCTION_POINTER_CASTS=1"
  QEMU_WASM_DYNAMIC_TB_START_ABI="fpcast"
fi

EXTRA_CFLAGS="-O3 -g -Wno-error=unused-command-line-argument -matomics -mbulk-memory -DNDEBUG -DG_DISABLE_ASSERT -D_GNU_SOURCE${ASC_READY_HACK_CFLAG}${ROM_RAMTEST_HACK_CFLAG}${ROM_DELAY_HACK_CFLAG}${VIA_TRACE_CFLAG}${ESP_TRACE_CFLAG}${ESP_PDMA_FIFO_CFLAG}${TCG_EXIT_PUMP_CFLAG}${TCI_CHAIN_PUMP_CFLAG}${TCI_ONLY_CFLAG}${SLEEP_PUMP_CFLAG}${MMIO_BACKOFF_CFLAG}${M68K_PC_TRACE_CFLAG}${M68K_EXC_TRACE_CFLAG}${M68K_TB_TRACE_CFLAG}${M68K_MOVEC_TLB_FLUSH_CFLAG}${M68K_MMU_WALK_TRACE_CFLAG}${WASM32_PGTABLE_TRACE_CFLAG}${ADB_AUTOPOLL_SUPPRESS_CFLAG}${VIA_T2_ONESHOT_HACK_CFLAG}${THREAD_YIELD_CFLAG} -sASYNCIFY=1 -pthread -sPROXY_TO_PTHREAD=1 -sFORCE_FILESYSTEM -sALLOW_TABLE_GROWTH ${MEMORY_FLAGS} -sWASM_BIGINT -sMALLOC=mimalloc -sUSE_SDL=2${EMULATE_FUNCTION_POINTER_CASTS_CFLAG} --js-library=/build/node_modules/xterm-pty/emscripten-pty.js -sEXPORT_ES6=1 -sASYNCIFY_IMPORTS=ffi_call_js"
EXTRA_LDFLAGS="-sUSE_SDL=2${EMULATE_FUNCTION_POINTER_CASTS_LDFLAG} -sEXPORTED_RUNTIME_METHODS=getTempRet0,setTempRet0,addFunction,removeFunction,TTY,FS"

docker exec "${CONTAINER}" sh -lc "
  cat > /tmp/emscripten-sdl2-config <<'EOSDL'
#!/bin/sh
case \"\$1\" in
  --cflags) echo '-sUSE_SDL=2' ;;
  --libs) echo '-sUSE_SDL=2' ;;
  --version) echo '2.24.2' ;;
  *) echo '' ;;
esac
EOSDL
  chmod +x /tmp/emscripten-sdl2-config &&
  rm -rf '${BUILD_DIR}' &&
  mkdir -p '${BUILD_DIR}' &&
  cd '${BUILD_DIR}' &&
  EXTRA_CFLAGS='${EXTRA_CFLAGS}' &&
  export SDL2_CONFIG=/tmp/emscripten-sdl2-config &&
  emconfigure /qemu/configure \
    --static \
    --target-list=m68k-softmmu \
    --cpu=wasm32 \
    --cross-prefix= \
    --without-default-features \
    --enable-system \
    --enable-sdl \
    --disable-sdl-image \
    --disable-opengl \
    --with-coroutine=fiber \
    --extra-cflags=\"\$EXTRA_CFLAGS\" \
    --extra-cxxflags=\"\$EXTRA_CFLAGS\" \
    --extra-ldflags='${EXTRA_LDFLAGS}' &&
  emmake make -j '${JOBS}' qemu-system-m68k
"

mkdir -p "${ROOT}/build/qemu"
docker cp "${CONTAINER}:${BUILD_DIR}/qemu-system-m68k" "${ROOT}/build/qemu/out.js"
for artifact in qemu-system-m68k.wasm qemu-system-m68k.worker.js; do
  docker cp "${CONTAINER}:${BUILD_DIR}/${artifact}" "${ROOT}/build/qemu/${artifact}" 2>/dev/null || true
done

QEMU_WASM_DYNAMIC_TB_START_ABI="${QEMU_WASM_DYNAMIC_TB_START_ABI}" node "${ROOT}/scripts/patch-qemu-out-js-lazyfile.mjs" "${ROOT}/build/qemu/out.js"
node "${ROOT}/scripts/patch-qemu-out-js-diskworker.mjs" "${ROOT}/build/qemu/out.js"
node "${ROOT}/scripts/patch-qemu-out-js-net.mjs" "${ROOT}/build/qemu/out.js"
node "${ROOT}/scripts/patch-qemu-out-js-input.mjs" "${ROOT}/build/qemu/out.js"
node "${ROOT}/scripts/patch-qemu-out-js-display.mjs" "${ROOT}/build/qemu/out.js"
if [[ -f "${ROOT}/build/qemu/qemu-system-m68k.worker.js" ]]; then
  node "${ROOT}/scripts/patch-qemu-worker-js.mjs" "${ROOT}/build/qemu/qemu-system-m68k.worker.js"
fi

echo "Build artifacts copied to ${ROOT}/build/qemu"
echo "Run KEEP_CONTAINER=1 ${0} if you want to keep the build container for packaging/debugging."
