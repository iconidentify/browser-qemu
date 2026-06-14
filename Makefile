SHELL := /bin/bash
DURATION ?= 5
LOGIN_DURATION ?= 360
READY_TIMEOUT ?= 420
SNAPSHOT_INTERVAL ?= 30
INTERVAL ?= 5
RAM ?= 16
NATIVE_ARGS ?=
EXIT_INTERVAL ?= 1
SLEEP_INTERVAL ?= 32
SLEEP_MS ?= 4
CHAIN_INTERVAL ?= 1024
BACKOFF_INTERVAL ?= 128
BACKOFF_NS ?= 500000
PULSE_MS ?= 30000
ICOUNT ?= shift=10,sleep=off
MAX_ICOUNT_SHIFT ?= 15

.PHONY: help fetch build-qemu build-qemu-responsive build-qemu-lean build-qemu-balanced build-qemu-grow build-qemu-balanced-esp-pdma-fifo512 build-qemu-balanced-esp-pdma-fifo512-adb-suppress build-qemu-balanced-esp-pdma-fifo512-exitpump build-qemu-balanced-esp-pdma-fifo512-exitpump-esp-pc-trace build-qemu-balanced-esp-pdma-fifo512-chainpump build-qemu-balanced-esp-pdma-fifo512-chainpump-esp-pc-trace build-qemu-balanced-esp-pdma-fifo512-mmio-backoff-esp-pc-trace build-qemu-balanced-esp-pdma-fifo512-icount-shift build-qemu-balanced-esp-pdma-fifo512-esp-pc-trace build-qemu-balanced-t2-pc-trace build-qemu-balanced-t2-esp-trace build-qemu-balanced-t2-esp-pc-trace build-qemu-balanced-pgtable-trace build-qemu-balanced-dyn-tb build-qemu-balanced-dyn-tb-pc-trace build-qemu-balanced-dyn-tb-exc-trace build-qemu-balanced-dyn-tb-full-trace build-qemu-balanced-dyn-tb-mmu-walk-trace build-qemu-balanced-dyn-tb-pgtable-trace build-qemu-balanced-dyn-tb-movec-flush-trace build-qemu-balanced-dyn-tb-no-fpcast build-qemu-balanced-no-via-t2-hack build-qemu-balanced-pc-trace build-qemu-balanced-via-trace build-qemu-balanced-adb-suppress build-qemu-balanced-t2-adb-suppress build-native-qemu-wasm sync-runtime package package-local package-smoke package-lazy refresh-stable-runtime serve disk-relay disk-promote browser browser-interactive browser-shared-input browser-stop browser-log browser-log-clear browser-doctor hmp hmp-help hmp-status hmp-cont hmp-stop hmp-run-for hmp-pulse-start hmp-yield-pulse-start hmp-sample-pulse-start hmp-pulse-stop hmp-step hmp-rom-probe hmp-info-block hmp-info-registers hmp-info-qtree hmp-info-via hmp-key hmp-text hmp-clear probe-rom-progress summarize-probes smoke-headless-browser smoke-shared-input watch-browser-boot watch-login-session smoke-headless-lazy-pulse smoke-headless-scsi smoke-headless-scsi-series smoke-headless-scsi-continuous smoke-headless-via-series smoke-headless-via-scsi-series smoke-headless-via-scsi-icount-series smoke-headless-via-scsi-built-icount-series smoke-headless-via-scsi-pc-trace-long smoke-headless-via-scsi-fifo512-pc-trace-long smoke-headless-via-scsi-exitpump-pc-trace-long smoke-headless-scsi-exitpump-continuous-long smoke-headless-via-scsi-chainpump-pc-trace-long smoke-headless-scsi-chainpump-continuous-long smoke-headless-scsi-mmio-backoff-continuous-long smoke-headless-scsi-esp-trace-long smoke-headless-scsi-pc-trace-long probe-native-qemu probe-native-qemu-wasm build-ui serve-ui clean

help:
	@printf '%s\n' \
		'Targets:' \
		'  make fetch       Clone the inspected qemu-wasm fork into browser-qemu/vendor/' \
		'  make build-qemu  Attempt qemu-system-m68k WASM build in Docker' \
		'  make build-qemu-responsive Build with extra TCG fallback yields for long ROM-loop tests' \
		'  make build-qemu-lean Build responsive runtime with a smaller 768 MB wasm heap default' \
		'  make build-qemu-balanced Build responsive runtime with a 1280 MB wasm heap default' \
		'  make build-qemu-balanced-esp-pdma-fifo512 Build opt-in ESP pseudo-DMA FIFO throughput experiment' \
		'  make build-qemu-balanced-esp-pdma-fifo512-adb-suppress Build FIFO512 plus early ADB autopoll suppression experiment' \
		'  make build-qemu-balanced-esp-pdma-fifo512-exitpump EXIT_INTERVAL=1 Build FIFO512 plus opt-in TCG CPU-exit pump' \
		'  make build-qemu-balanced-esp-pdma-fifo512-exitpump-esp-pc-trace EXIT_INTERVAL=1 Build traced FIFO512 plus TCG CPU-exit pump' \
		'  make build-qemu-balanced-esp-pdma-fifo512-chainpump EXIT_INTERVAL=32 Build FIFO512 plus TCI chain-transition pump' \
		'  make build-qemu-balanced-esp-pdma-fifo512-chainpump-esp-pc-trace EXIT_INTERVAL=32 Build traced FIFO512 plus TCI chain-transition pump' \
		'  make build-qemu-balanced-esp-pdma-fifo512-icount-shift MAX_ICOUNT_SHIFT=15 Build FIFO512 plus opt-in higher -icount shift cap' \
		'  make build-qemu-balanced-esp-pdma-fifo512-esp-pc-trace Build FIFO512 plus ESP/SCSI + m68k PC trace' \
		'  make build-qemu-balanced-t2-pc-trace Build balanced runtime with T2 one-shot plus m68k PC trace' \
		'  make build-qemu-balanced-t2-esp-trace Build current disk-boot trace runtime with ESP/SCSI trace only' \
		'  make build-qemu-balanced-t2-esp-pc-trace Build current disk-boot trace runtime with ESP/SCSI + m68k PC trace' \
		'  make build-qemu-balanced-pgtable-trace Build pure-TCI trace runtime with 68040 MMU/page-table store trace enabled' \
		'  make build-qemu-balanced-dyn-tb Build balanced runtime with qemu-wasm dynamic mini-WASM TBs re-enabled' \
		'  make build-qemu-balanced-dyn-tb-pc-trace Build dynamic-TB runtime with m68k PC trace enabled' \
		'  make build-qemu-balanced-dyn-tb-exc-trace Build dynamic-TB runtime with m68k PC + exception trace enabled' \
		'  make build-qemu-balanced-dyn-tb-full-trace Build dynamic-TB runtime with PC + exception + TB path trace enabled' \
		'  make build-qemu-balanced-dyn-tb-mmu-walk-trace Build dynamic-TB trace runtime with 68040 MMU page-walk trace enabled' \
		'  make build-qemu-balanced-dyn-tb-pgtable-trace Build dynamic-TB trace runtime with wasm32 page-table store trace enabled' \
		'  make build-qemu-balanced-dyn-tb-movec-flush-trace Build dynamic-TB trace runtime with MOVEC MMU-control TLB flush experiment' \
		'  make build-qemu-balanced-dyn-tb-no-fpcast Build dynamic-TB runtime without Emscripten function-pointer-cast emulation' \
		'  make build-qemu-balanced-no-via-t2-hack Build balanced runtime without the VIA T2 one-shot experiment' \
		'  make build-qemu-balanced-pc-trace Build no-T2 balanced runtime with m68k PC trace enabled' \
		'  make build-qemu-balanced-via-trace Build no-T2 balanced runtime with VIA IRQ trace enabled' \
		'  make build-qemu-balanced-adb-suppress Build no-T2 balanced runtime with early ADB autopoll suppressed' \
		'  make build-qemu-balanced-t2-adb-suppress Build balanced runtime with T2 one-shot plus early ADB autopoll suppressed' \
		'  make build-native-qemu-wasm Build host-native qemu-wasm m68k comparator in build/' \
		'  make sync-runtime Copy rebuilt JS/Wasm runtime into ignored public/qemu*/ dirs' \
		'  make package     Package local ROM/disk assets into ignored public/qemu/ artifacts' \
		'  make package-local Package ~/aux_qemu_local into ignored public/qemu/ artifacts' \
		'  make package-smoke Package ROM/PRAM-only q800 smoke test into public/qemu-smoke/' \
		'  make package-lazy Package ROM/PRAM plus range-served lazy disk images into public/qemu-lazy/' \
		'  make refresh-stable-runtime Rebuild balanced runtime and refresh qemu-smoke/qemu-lazy packages' \
		'  make serve       Serve public/ with COOP/COEP headers for Emscripten pthreads' \
		'  make build-ui    Build the common-layer React frontend (web/) and link the QEMU runtime' \
		'  make serve-ui    Serve the React frontend on :8090 (open /?core=qemu for A/UX)' \
		'  make disk-relay [BROWSER=1] Start the dialtone relay on a writable disk copy and print the admin write URL' \
		'  make disk-promote [FORCE=1] Publish your disk edits to assets/AUX3.img (then make package-lazy)' \
		'  make browser-interactive Launch responsive headed Chrome with pulse boot cadence, shared ADB input, 8 fps cap' \
		'  make browser-shared-input Launch responsive headed Chrome with 68k_web-style shared input and pulse boot cadence' \
		'  make browser-stop Stop temp-profile Chrome instances launched by browser-qemu' \
		'  make browser-log Read mirrored browser serial/debug log from local dev server' \
		'  make browser-log-clear Clear mirrored browser serial/debug log on local dev server' \
		'  make browser-doctor Show hot QEMU/Chrome/Codex processes plus mirrored browser-log tail' \
		'  make hmp-help    Queue HMP help through public/control.local.json' \
		'  make hmp-status  Queue HMP info status and stay in monitor mode' \
		'  make hmp CMD="..." Queue an arbitrary HMP command and stay in monitor mode' \
		'  make hmp-cont    Queue HMP cont and return to guest mode' \
		'  make hmp-stop    Queue HMP stop and stay in monitor mode' \
		'  make hmp-run-for DURATION=5 Experimental short run, then stop/status' \
		'  make hmp-yield-pulse-start INTERVAL=2 Start lightweight stop/cont cadence for interaction' \
		'  make hmp-sample-pulse-start INTERVAL=30 Start diagnostic stop/status/register/block/cont cadence' \
		'  make hmp-pulse-start INTERVAL=2 Alias for lightweight yield pulse' \
		'  make hmp-pulse-stop Stop browser-worker pulse cadence without stopping the VM' \
		'  make hmp-step DURATION=5 Experimental short run, then stop/status/registers' \
		'  make hmp-rom-probe DURATION=5 Queue status/block, run, stop, registers/block' \
		'  make hmp-info-block Queue HMP info block' \
		'  make hmp-info-registers Queue HMP info registers' \
		'  make hmp-info-qtree Queue HMP info qtree' \
		'  make hmp-info-via Queue HMP info via' \
		'  make hmp-key KEY=a Queue an HMP sendkey command through public/control.local.json' \
		'  make hmp-text TEXT=root Queue guest text through public/control.local.json' \
		'  make hmp-clear   Clear queued browser control commands' \
		'  make probe-rom-progress DURATION=5 Summarize a timed browser ROM/HMP probe' \
		'  make summarize-probes PROBES="build/probes/*.json" Summarize saved browser/native probe JSON' \
		'  make smoke-headless-browser DURATION=5 Launch temp headless Chrome and run ROM probe' \
		'  make smoke-shared-input Verify shared-input canvas geometry, mouse edge latching, and KeyX ADB mapping' \
		'  make probe-click-alignment ARGS=--headless Boot to login and probe browser/client/guest mouse alignment' \
		'  make watch-browser-boot DURATION=600 INTERVAL=45 Boot lazy A/UX (128MB, pulse cadence) and record screenshots to build/boot-watch/' \
		'  make watch-login-session LOGIN_DURATION=360 Boot, login as root, and watch headed post-login responsiveness' \
		'  make smoke-headless-lazy-pulse DURATION=45 INTERVAL=15 PULSE_MS=30000 Smoke the visible Start lazy pulse path' \
		'  make smoke-headless-scsi DURATION=20 Launch headless probe with narrow ESP/SCSI trace' \
		'  make smoke-headless-scsi-series DURATION=600 INTERVAL=30 Sample stable browser SCSI progress with proven pulse cadence' \
		'  make smoke-headless-scsi-continuous DURATION=600 INTERVAL=30 Run SCSI trace without recurring HMP stop/sample cadence' \
		'  make smoke-headless-via-series DURATION=120 INTERVAL=30 Sample browser progress with HMP info via snapshots' \
		'  make smoke-headless-via-scsi-series DURATION=120 INTERVAL=30 Sample browser progress with SCSI trace + HMP info via snapshots' \
		'  make smoke-headless-via-scsi-icount-series ICOUNT=shift=10,sleep=off DURATION=120 INTERVAL=30 Sample browser progress with instruction-counted virtual time' \
		'  make smoke-headless-via-scsi-built-icount-series ICOUNT=shift=15,sleep=off DURATION=120 INTERVAL=30 Temporarily probe build/qemu with extended icount shift' \
		'  make smoke-headless-via-scsi-pc-trace-long DURATION=360 INTERVAL=30 Temporarily serve build/qemu and sample VIA plus PC/SCSI trace' \
		'  make smoke-headless-via-scsi-fifo512-pc-trace-long DURATION=360 INTERVAL=30 Temporarily probe FIFO512 PC/SCSI trace runtime' \
		'  make smoke-headless-via-scsi-exitpump-pc-trace-long DURATION=480 INTERVAL=60 Temporarily probe traced exit-pump runtime' \
		'  make smoke-headless-scsi-exitpump-continuous-long DURATION=360 INTERVAL=30 Probe traced exit-pump runtime without recurring HMP stops' \
		'  make smoke-headless-via-scsi-chainpump-pc-trace-long DURATION=480 INTERVAL=60 Temporarily probe traced chain-pump runtime' \
		'  make smoke-headless-scsi-chainpump-continuous-long DURATION=360 INTERVAL=30 Probe traced chain-pump runtime without recurring HMP stops' \
		'  make smoke-headless-scsi-esp-trace-long DURATION=360 INTERVAL=30 Temporarily serve build/qemu and probe ESP/SCSI without PC trace' \
		'  make smoke-headless-scsi-pc-trace-long DURATION=360 INTERVAL=30 Temporarily serve build/qemu and prove ESP/SCSI progress' \
		'  make probe-native-qemu DURATION=30 RAM=16 NATIVE_ARGS="--continue-after-scsi" Run sidecar native QEMU ROM/SCSI probe' \
		'  make probe-native-qemu-wasm DURATION=30 RAM=16 NATIVE_ARGS="--continue-after-scsi" Run sidecar native qemu-wasm comparator probe' \
		'  make clean       Remove ignored local build outputs'

fetch:
	QEMU_FETCH_ONLY=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu:
	./scripts/build-qemu-m68k-wasm.sh

build-qemu-responsive:
	WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-lean:
	QEMU_WASM_TOTAL_MEMORY_MB=768 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

# Growable-memory build: the OOM fix. Commits ~384MB upfront and grows on demand
# instead of the fixed 1280MB, so a normal tab stops crashing on long sessions.
# Long (~20-40 min, Docker, CPU-heavy). After it finishes: make package-lazy.
build-qemu-grow:
	QEMU_WASM_GROW_MEMORY=1 QEMU_WASM_INITIAL_MEMORY_MB=384 QEMU_WASM_MAXIMUM_MEMORY_MB=2048 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-esp-pdma-fifo512:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ESP_PDMA_FIFO_CAPACITY=512 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-esp-pdma-fifo512-adb-suppress:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ESP_PDMA_FIFO_CAPACITY=512 QEMU_WASM_ADB_AUTOPOLL_SUPPRESS=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-esp-pdma-fifo512-exitpump:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ESP_PDMA_FIFO_CAPACITY=512 QEMU_WASM_TCG_EXIT_PUMP_INTERVAL=$(EXIT_INTERVAL) WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-esp-pdma-fifo512-exitpump-esp-pc-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ESP_PDMA_FIFO_CAPACITY=512 QEMU_WASM_TCG_EXIT_PUMP_INTERVAL=$(EXIT_INTERVAL) QEMU_WASM_ESP_TRACE=1 QEMU_WASM_M68K_PC_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-esp-pdma-fifo512-chainpump:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ESP_PDMA_FIFO_CAPACITY=512 QEMU_WASM_TCI_CHAIN_PUMP=1 QEMU_WASM_TCI_CHAIN_PUMP_INTERVAL=$(CHAIN_INTERVAL) QEMU_WASM_TCI_ONLY=1 QEMU_WASM_TCG_EXIT_PUMP_INTERVAL=$(EXIT_INTERVAL) QEMU_WASM_TCG_SLEEP_PUMP_INTERVAL=$(SLEEP_INTERVAL) QEMU_WASM_TCG_SLEEP_PUMP_MS=$(SLEEP_MS) WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-esp-pdma-fifo512-chainpump-esp-pc-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ESP_PDMA_FIFO_CAPACITY=512 QEMU_WASM_TCI_CHAIN_PUMP=1 QEMU_WASM_TCI_CHAIN_PUMP_INTERVAL=$(CHAIN_INTERVAL) QEMU_WASM_TCI_ONLY=1 QEMU_WASM_TCG_EXIT_PUMP_INTERVAL=$(EXIT_INTERVAL) QEMU_WASM_TCG_SLEEP_PUMP_INTERVAL=$(SLEEP_INTERVAL) QEMU_WASM_TCG_SLEEP_PUMP_MS=$(SLEEP_MS) QEMU_WASM_ESP_TRACE=1 QEMU_WASM_M68K_PC_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-esp-pdma-fifo512-mmio-backoff-esp-pc-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ESP_PDMA_FIFO_CAPACITY=512 QEMU_WASM_TCI_ONLY=1 QEMU_WASM_MMIO_BACKOFF_INTERVAL=$(BACKOFF_INTERVAL) QEMU_WASM_MMIO_BACKOFF_NS=$(BACKOFF_NS) QEMU_WASM_ESP_TRACE=1 QEMU_WASM_M68K_PC_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-esp-pdma-fifo512-icount-shift:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ESP_PDMA_FIFO_CAPACITY=512 QEMU_WASM_MAX_ICOUNT_SHIFT=$(MAX_ICOUNT_SHIFT) WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-esp-pdma-fifo512-esp-pc-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ESP_PDMA_FIFO_CAPACITY=512 QEMU_WASM_ESP_TRACE=1 QEMU_WASM_M68K_PC_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-t2-pc-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_M68K_PC_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-t2-esp-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ESP_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-t2-esp-pc-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ESP_TRACE=1 QEMU_WASM_M68K_PC_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-pgtable-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_M68K_PC_TRACE=1 QEMU_WASM_M68K_EXC_TRACE=1 QEMU_WASM_M68K_MMU_WALK_TRACE=1 QEMU_WASM_WASM32_PGTABLE_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-dyn-tb:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 WASM32_INSTANTIATE_NUM=1500 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-dyn-tb-pc-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 WASM32_INSTANTIATE_NUM=1500 QEMU_WASM_M68K_PC_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-dyn-tb-exc-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 WASM32_INSTANTIATE_NUM=1500 QEMU_WASM_M68K_PC_TRACE=1 QEMU_WASM_M68K_EXC_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-dyn-tb-full-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 WASM32_INSTANTIATE_NUM=1500 QEMU_WASM_M68K_PC_TRACE=1 QEMU_WASM_M68K_EXC_TRACE=1 QEMU_WASM_M68K_TB_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-dyn-tb-mmu-walk-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 WASM32_INSTANTIATE_NUM=1500 QEMU_WASM_M68K_PC_TRACE=1 QEMU_WASM_M68K_EXC_TRACE=1 QEMU_WASM_M68K_TB_TRACE=1 QEMU_WASM_M68K_MMU_WALK_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-dyn-tb-pgtable-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 WASM32_INSTANTIATE_NUM=1500 QEMU_WASM_M68K_PC_TRACE=1 QEMU_WASM_M68K_EXC_TRACE=1 QEMU_WASM_M68K_TB_TRACE=1 QEMU_WASM_M68K_MMU_WALK_TRACE=1 QEMU_WASM_WASM32_PGTABLE_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-dyn-tb-movec-flush-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 WASM32_INSTANTIATE_NUM=1500 QEMU_WASM_M68K_PC_TRACE=1 QEMU_WASM_M68K_EXC_TRACE=1 QEMU_WASM_M68K_TB_TRACE=1 QEMU_WASM_M68K_MOVEC_TLB_FLUSH=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-dyn-tb-no-fpcast:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 WASM32_INSTANTIATE_NUM=1500 QEMU_WASM_EMULATE_FUNCTION_POINTER_CASTS=0 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-no-via-t2-hack:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_VIA_T2_ONESHOT_HACK=0 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-pc-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_VIA_T2_ONESHOT_HACK=0 QEMU_WASM_M68K_PC_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-via-trace:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_VIA_T2_ONESHOT_HACK=0 QEMU_WASM_VIA_TRACE=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-adb-suppress:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_VIA_T2_ONESHOT_HACK=0 QEMU_WASM_ADB_AUTOPOLL_SUPPRESS=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-qemu-balanced-t2-adb-suppress:
	QEMU_WASM_TOTAL_MEMORY_MB=1280 QEMU_WASM_ADB_AUTOPOLL_SUPPRESS=1 WASM32_QUEUE_PUMP_INTERVAL=32 QEMU_WASM_THREAD_YIELD=1 ./scripts/build-qemu-m68k-wasm.sh

build-native-qemu-wasm:
	./scripts/build-native-qemu-wasm-m68k.sh

sync-runtime:
	./scripts/sync-qemu-runtime.sh

package:
	./scripts/package-aux-assets.sh

package-local:
	./scripts/package-local-aux-qemu.sh

package-smoke:
	./scripts/package-smoke-rom.sh

package-lazy:
	./scripts/package-lazy-aux-assets.sh

refresh-stable-runtime: build-qemu-balanced package-smoke package-lazy

serve:
	python3 ./scripts/serve_with_headers.py ./public 8088

# Common-layer React frontend (web/): the 68k_web shell driving QEMU A/UX or
# Basilisk through one CoreAdapter interface. Needs node >= 18 (use the nvm 23
# toolchain if the shell default is older). build-ui produces web/dist and links
# the QEMU runtime in; serve-ui hosts it with range + COOP/COEP on :8090.
# Open http://127.0.0.1:8090/?core=qemu  (A/UX)  or  /?core=basilisk (default).
build-ui:
	cd web && npm install && npm run build
	ln -sfn ../../public/qemu-lazy web/dist/qemu-lazy

serve-ui:
	@[ -e web/dist/index.html ] || { echo "run 'make build-ui' first"; exit 1; }
	@[ -L web/dist/qemu-lazy ] || ln -sfn ../../public/qemu-lazy web/dist/qemu-lazy
	python3 ./scripts/serve_with_headers.py ./web/dist 8090

browser:
	./scripts/launch-aux-chrome.sh

browser-interactive:
	RES=640x480 INPUT=shared FPS=8 PACE=1 PTY_MIN=2 PTY_IDLE=16 AUTOSTART=lazy-pulse PULSE_MS=2000 PULSE_MODE=yield ./scripts/launch-aux-chrome.sh

browser-shared-input:
	RES=640x480 INPUT=shared FPS=8 PACE=1 PTY_MIN=2 PTY_IDLE=16 AUTOSTART=lazy-pulse PULSE_MS=2000 PULSE_MODE=yield ./scripts/launch-aux-chrome.sh

browser-stop:
	@pids="$$(pgrep -f 'c89-aux-chrome' || true)"; \
	  if [[ -z "$${pids}" ]]; then \
	    echo 'no browser-qemu temp-profile Chrome processes found'; \
	  else \
	    echo "$${pids}" | xargs kill; \
	    echo 'stopped browser-qemu Chrome process(es):'; \
	    printf '%s\n' "$${pids}"; \
	  fi

disk-relay:
	./scripts/disk-relay.sh

disk-promote:
	./scripts/disk-promote.sh

browser-log:
	@curl -sS 'http://127.0.0.1:8088/__browser-log.json' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s); for (const line of p.lines || []) console.log(line);})'

browser-log-clear:
	@curl -sS 'http://127.0.0.1:8088/__browser-log.json?reset=1' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s); console.log(`cleared browser log; $${p.count || 0} lines now stored`);})'

browser-doctor:
	@node ./scripts/browser-doctor.mjs

hmp:
	@if [[ -z "$${CMD:-}" ]]; then echo 'Usage: make hmp CMD="info registers"' >&2; exit 2; fi
	node ./scripts/send-browser-control.mjs hmp "$${CMD}" --stay-monitor

hmp-help:
	node ./scripts/send-browser-control.mjs hmp help --stay-monitor

hmp-status:
	node ./scripts/send-browser-control.mjs hmp 'info status' --stay-monitor

hmp-cont:
	node ./scripts/send-browser-control.mjs hmp cont

hmp-stop:
	node ./scripts/send-browser-control.mjs hmp stop --stay-monitor

hmp-run-for:
	@duration="$${DURATION:-5}"; \
	  if ! [[ "$${duration}" =~ ^[0-9]+$$ ]]; then echo 'DURATION must be integer seconds, max 180' >&2; exit 2; fi; \
	  if (( duration < 1 )); then duration=1; fi; \
	  if (( duration > 180 )); then duration=180; fi; \
	  node ./scripts/send-browser-control.mjs hmp cont; \
	  sleep "$${duration}"; \
	  node ./scripts/send-browser-control.mjs hmp stop --stay-monitor; \
	  sleep 1; \
	  node ./scripts/send-browser-control.mjs hmp 'info status' --stay-monitor

hmp-pulse-start:
	@$(MAKE) --no-print-directory hmp-yield-pulse-start

hmp-yield-pulse-start:
	@interval="$${INTERVAL:-2}"; \
	  if ! [[ "$${interval}" =~ ^[0-9]+$$ ]]; then echo 'INTERVAL must be integer seconds, 1..60' >&2; exit 2; fi; \
	  if (( interval < 1 )); then interval=1; fi; \
	  if (( interval > 60 )); then interval=60; fi; \
	  node ./scripts/send-browser-control.mjs pulse start --mode yield --interval-ms "$$(( interval * 1000 ))"

hmp-sample-pulse-start:
	@interval="$${INTERVAL:-30}"; \
	  if ! [[ "$${interval}" =~ ^[0-9]+$$ ]]; then echo 'INTERVAL must be integer seconds, 5..60' >&2; exit 2; fi; \
	  if (( interval < 5 )); then interval=5; fi; \
	  if (( interval > 60 )); then interval=60; fi; \
	  node ./scripts/send-browser-control.mjs pulse start --mode sample --interval-ms "$$(( interval * 1000 ))"

hmp-pulse-stop:
	node ./scripts/send-browser-control.mjs pulse stop

hmp-step:
	@$(MAKE) --no-print-directory hmp-run-for
	@$(MAKE) --no-print-directory hmp-info-registers

hmp-rom-probe:
	@duration="$${DURATION:-5}"; \
	  if ! [[ "$${duration}" =~ ^[0-9]+$$ ]]; then echo 'DURATION must be integer seconds, max 180' >&2; exit 2; fi; \
	  if (( duration < 1 )); then duration=1; fi; \
	  if (( duration > 180 )); then duration=180; fi; \
	  node ./scripts/send-browser-control.mjs hmp 'info status' --stay-monitor; \
	  node ./scripts/send-browser-control.mjs hmp 'info block' --stay-monitor; \
	  node ./scripts/send-browser-control.mjs hmp cont; \
	  sleep "$${duration}"; \
	  node ./scripts/send-browser-control.mjs hmp stop --stay-monitor; \
	  sleep 1; \
	  node ./scripts/send-browser-control.mjs hmp 'info status' --stay-monitor; \
	  node ./scripts/send-browser-control.mjs hmp 'info registers' --stay-monitor; \
	  node ./scripts/send-browser-control.mjs hmp 'info block' --stay-monitor

hmp-info-block:
	node ./scripts/send-browser-control.mjs hmp 'info block' --stay-monitor

hmp-info-registers:
	node ./scripts/send-browser-control.mjs hmp 'info registers' --stay-monitor

hmp-info-qtree:
	node ./scripts/send-browser-control.mjs hmp 'info qtree' --stay-monitor

hmp-info-via:
	node ./scripts/send-browser-control.mjs hmp 'info via' --stay-monitor

hmp-key:
	@if [[ -z "$${KEY:-}" ]]; then echo 'Usage: make hmp-key KEY=a' >&2; exit 2; fi
	node ./scripts/send-browser-control.mjs key "$${KEY}"

hmp-text:
	@if [[ -z "$${TEXT:-}" ]]; then echo 'Usage: make hmp-text TEXT=root' >&2; exit 2; fi
	node ./scripts/send-browser-control.mjs text "$${TEXT}"

hmp-clear:
	rm -f ./public/control.local.json ./public/control.local.seq

probe-rom-progress:
	@node ./scripts/probe-browser-rom-progress.mjs --duration "$(DURATION)" $(if $(VIA),--via,)

summarize-probes:
	@if [[ -z "$${PROBES:-}" ]]; then echo 'Usage: make summarize-probes PROBES="build/probes/*.json"' >&2; exit 2; fi
	@node ./scripts/summarize-probes.mjs $${PROBES}

smoke-headless-browser:
	@node ./scripts/smoke-headless-browser.mjs --probe-duration "$(DURATION)"

smoke-shared-input:
	@node ./scripts/smoke-shared-input.mjs

probe-click-alignment:
	@node ./scripts/probe-click-alignment.mjs $${ARGS:-}

watch-browser-boot:
	@node ./scripts/watch-browser-boot.mjs --duration "$(DURATION)" --interval "$(INTERVAL)" --url "http://127.0.0.1:8088/?build=aux-login-watch&ram=128&heap=384&pace=1&input=shared&cursor=host&fps=8&res=640x480&autostart=lazy-pulse&pulseMode=yield&pulseMs=2000&ptyMin=2&ptyIdle=16"

watch-login-session:
	@node ./scripts/watch-login-session.mjs --ready-timeout "$(READY_TIMEOUT)" --watch-secs "$(LOGIN_DURATION)" --snapshot-interval "$(SNAPSHOT_INTERVAL)"

smoke-headless-lazy-pulse:
	@node ./scripts/smoke-headless-browser.mjs --url "http://127.0.0.1:8088/?build=headless-lazy-pulse&ram=16&heap=1280&pace=0&autostart=lazy-pulse&pulseMs=$(PULSE_MS)" --probe-duration "$(DURATION)" --probe-interval "$(INTERVAL)"

smoke-headless-scsi:
	@node ./scripts/smoke-headless-browser.mjs --url "http://127.0.0.1:8088/?build=headless-scsi&ram=16&heap=1280&pace=0&trace=scsi&autostart=lazy-paused" --probe-duration "$(DURATION)"

smoke-headless-scsi-series:
	@node ./scripts/smoke-headless-browser.mjs --url "http://127.0.0.1:8088/?build=headless-scsi-series&ram=16&heap=1280&pace=0&trace=scsi&autostart=lazy-paused" --probe-duration "$(DURATION)" --probe-interval "$(INTERVAL)"

smoke-headless-scsi-continuous:
	@node ./scripts/smoke-headless-browser.mjs --url "http://127.0.0.1:8088/?build=headless-scsi-continuous&ram=16&heap=1280&pace=0&trace=scsi&autostart=lazy-paused" --probe-duration "$(DURATION)" --probe-interval "$(INTERVAL)" --continuous-log

smoke-headless-via-series:
	@node ./scripts/smoke-headless-browser.mjs --url "http://127.0.0.1:8088/?build=headless-via-series&ram=16&heap=1280&pace=0&autostart=lazy-paused" --probe-duration "$(DURATION)" --probe-interval "$(INTERVAL)" --via

smoke-headless-via-scsi-series:
	@node ./scripts/smoke-headless-browser.mjs --url "http://127.0.0.1:8088/?build=headless-via-scsi-series&ram=16&heap=1280&pace=0&trace=scsi&autostart=lazy-paused" --probe-duration "$(DURATION)" --probe-interval "$(INTERVAL)" --via

smoke-headless-via-scsi-icount-series:
	@node ./scripts/smoke-headless-browser.mjs --url "http://127.0.0.1:8088/?build=headless-via-scsi-icount-series&ram=16&heap=1280&pace=1&icount=$(ICOUNT)&trace=scsi&autostart=lazy-paused" --probe-duration "$(DURATION)" --probe-interval "$(INTERVAL)" --via

smoke-headless-via-scsi-built-icount-series:
	@BUILD_LABEL="instrumented-via-scsi-icount" BUILD_HINT="make build-qemu-balanced-esp-pdma-fifo512-icount-shift" EXTRA_QUERY="pace=1&icount=$(ICOUNT)" VIA=1 ./scripts/run-instrumented-scsi-probe.sh

smoke-headless-via-scsi-pc-trace-long:
	@BUILD_LABEL="instrumented-via-scsi-pc-trace" BUILD_HINT="make build-qemu-balanced-t2-esp-pc-trace" EXTRA_QUERY="pace=0" VIA=1 DURATION="$(DURATION)" INTERVAL="$(INTERVAL)" ./scripts/run-instrumented-scsi-probe.sh

smoke-headless-via-scsi-fifo512-pc-trace-long:
	@BUILD_LABEL="instrumented-via-scsi-fifo512-pc-trace" BUILD_HINT="make build-qemu-balanced-esp-pdma-fifo512-esp-pc-trace" EXTRA_QUERY="pace=0" VIA=1 DURATION="$(DURATION)" INTERVAL="$(INTERVAL)" ./scripts/run-instrumented-scsi-probe.sh

smoke-headless-via-scsi-exitpump-pc-trace-long:
	@BUILD_LABEL="instrumented-via-scsi-exitpump-pc-trace" BUILD_HINT="make build-qemu-balanced-esp-pdma-fifo512-exitpump-esp-pc-trace" EXTRA_QUERY="pace=0" VIA=1 DURATION="$(DURATION)" INTERVAL="$(INTERVAL)" ./scripts/run-instrumented-scsi-probe.sh

smoke-headless-scsi-exitpump-continuous-long:
	@BUILD_LABEL="instrumented-scsi-exitpump-continuous" BUILD_HINT="make build-qemu-balanced-esp-pdma-fifo512-exitpump-esp-pc-trace" EXTRA_QUERY="pace=0" CONTINUOUS_LOG=1 DURATION="$(DURATION)" INTERVAL="$(INTERVAL)" ./scripts/run-instrumented-scsi-probe.sh

smoke-headless-via-scsi-chainpump-pc-trace-long:
	@BUILD_LABEL="instrumented-via-scsi-chainpump-pc-trace" BUILD_HINT="make build-qemu-balanced-esp-pdma-fifo512-chainpump-esp-pc-trace" EXTRA_QUERY="pace=0" VIA=1 DURATION="$(DURATION)" INTERVAL="$(INTERVAL)" ./scripts/run-instrumented-scsi-probe.sh

smoke-headless-scsi-chainpump-continuous-long:
	@BUILD_LABEL="instrumented-scsi-chainpump-continuous" BUILD_HINT="make build-qemu-balanced-esp-pdma-fifo512-chainpump-esp-pc-trace" EXTRA_QUERY="pace=0" CONTINUOUS_LOG=1 DURATION="$(DURATION)" INTERVAL="$(INTERVAL)" ./scripts/run-instrumented-scsi-probe.sh

smoke-headless-scsi-mmio-backoff-continuous-long:
	@BUILD_LABEL="instrumented-scsi-mmio-backoff-continuous" BUILD_HINT="make build-qemu-balanced-esp-pdma-fifo512-mmio-backoff-esp-pc-trace" EXTRA_QUERY="pace=0" CONTINUOUS_LOG=1 DURATION="$(DURATION)" INTERVAL="$(INTERVAL)" ./scripts/run-instrumented-scsi-probe.sh

smoke-headless-scsi-esp-trace-long:
	@BUILD_LABEL="instrumented-scsi-esp-trace" BUILD_HINT="make build-qemu-balanced-t2-esp-trace" DURATION="$(DURATION)" INTERVAL="$(INTERVAL)" ./scripts/run-instrumented-scsi-probe.sh

smoke-headless-scsi-pc-trace-long:
	@BUILD_HINT="make build-qemu-balanced-t2-esp-pc-trace" DURATION="$(DURATION)" INTERVAL="$(INTERVAL)" ./scripts/run-instrumented-scsi-probe.sh

probe-native-qemu:
	@node ./scripts/probe-native-qemu-rom-progress.mjs --duration "$(DURATION)" --interval "$(INTERVAL)" --ram "$(RAM)" $(NATIVE_ARGS)

probe-native-qemu-wasm:
	@node ./scripts/probe-native-qemu-rom-progress.mjs --qemu ./build/qemu-wasm-native/qemu-system-m68k --duration "$(DURATION)" --interval "$(INTERVAL)" --ram "$(RAM)" $(NATIVE_ARGS)

clean:
	rm -rf ./build ./public/qemu/* ./public/qemu-smoke/* ./public/qemu-lazy/*
	touch ./public/qemu/.gitkeep
	touch ./public/qemu-smoke/.gitkeep
	touch ./public/qemu-lazy/.gitkeep
