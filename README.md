# Browser QEMU A/UX Prototype

This directory is the first feasibility/prototype slice for booting the existing A/UX 3.1.1 Quadra-style QEMU setup in a browser via WebAssembly.

MILESTONE, June 13, 2026: A/UX boots to the login screen in a normal headed
Chrome tab with the growable-memory wasm build (`heap=384` initial,
2 GB max). The browser shell now has 68k_web-style shared ADB input, a fixed
guest-resolution canvas, a host-side Classic Mac cursor, queued guest-text
controls (`make hmp-text TEXT=root`), and a proven WebSocket Ethernet path:
`?net=1&netZone=codex-net` connected QEMU's `wasmbridge` NIC to the Dialtone
relay, `scripts/probe-guest-net.mjs` saw ARP/ICMP/TCP replies from
`10.1.1.20`, and `scripts/auxctl-zone.mjs --zone codex-net exec 'uname -a; id'`
ran inside A/UX as root.
The current served wasm also includes the native cursor/click-alignment patch:
guest `TheCrsr` is exported to the host CSS cursor, Mac software cursor drawing
is suppressed, and absolute mouse input anchors Classic Mac low-memory
`MTemp`/`RawMouse`/`Mouse` rather than draining stale ADB relative deltas.

Reliable headed recipe: `make serve`, then run `make browser-interactive` or
open
`http://127.0.0.1:8088/?ram=128&heap=384&pace=1&input=shared&cursor=host&fps=8&res=800x600&autostart=lazy-pulse&pulseMode=yield&pulseMs=2000&ptyMin=2&ptyIdle=16`.
Leave the lightweight yield pulse running during hands-on login with root /
31337leet; it gives qemu-wasm tiny stop/continue scheduling windows without the
heavy register/block diagnostic dump. `input=shared` writes browser mouse/keyboard
events into wasm memory and QEMU drains them directly into the q800 ADB devices;
`input=hmp`, `input=hybrid`, and `input=sdl` are diagnostic escape hatches.
`fps=8` caps page-side framebuffer repaint work so X11 does not bury Chrome;
`autostart=lazy-pulse&pulseMode=yield` uses the worker-backed `stop; cont`
cadence instead of leaving the emulator hot forever. The heavier
`pulseMode=sample` cadence is for diagnostics. The older headed
`pace=0` recipe can still grey-screen/freeze Chrome before the first pulse stop
is serviced; keep it for headless or instrumented ROM/SCSI probes. Use
continuous `autostart=lazy` only for focused debugging, then close or pause the
tab before interacting for long.
For networking, start/keep Dialtone on `:8080`, add `&net=1&netZone=<zone>`,
and drive auxagent with `node scripts/auxctl-zone.mjs --zone <zone> ...`.
See ROADMAP.md for the plan to production and VENDOR.md for how the vendor
tree and large artifacts are managed.

## Disk: read-only by default, easy admin writes

Visitors boot the disk read-only off a shared base image; no setup, served as
static files plus HTTP range requests (or via the dialtone relay). Guest disk
reads run in a dedicated worker off the page main thread, so the earlier
boot-wedge hazards (clicking the canvas, resizing the window) are gone.

To change the disk contents yourself -- install software, edit files, and have
the edits persist -- use the dialtone relay:

```
make serve                 # dev server on :8088 (one terminal)
make disk-relay            # relay on :8080 + prints a writable URL (another)
make disk-relay BROWSER=1  # ... and launch Chrome straight into it
```

`disk-relay` writes to an editable copy under `build/relay-disks/`, never the
known-good `assets/AUX3.img` master, and mints a 30-day admin token signed with
a per-machine dev secret. Open the printed WRITABLE url; your guest writes go
through the relay and survive reboots. To publish those edits as the new
read-only disk visitors boot:

```
make disk-promote          # backs up + overwrites assets/AUX3.img
make package-lazy          # reships it into public/qemu-lazy/
```

## Current status

The prototype now has a working SDL-enabled `qemu-system-m68k` WebAssembly runtime and a browser shell that can launch it.

- BREAKTHROUGH, June 12, 2026 (fourth pass): the disk-data corruption is found and fixed, and the browser ROM boot now follows the native read sequence into the jag-disk driver and HFS volume.
  - Root cause (proven byte-for-byte): the lazy-file patch's synchronous-XHR fallback returned `intArrayFromString(xhr.responseText, true)`, which UTF-8 encodes the x-user-defined string -- every disk byte >= 0x80 became the 3-byte sequence `ef 9e/9f xx`, silently shifting and corrupting sector data. Confirmations: jag DDM byte `0xa0` arrived as `ef 9e a0`; aux lba1 byte `0xb8` arrived as `ef 9e b8`; aux lba0 (no high bytes) was the only sector that ever parsed. This single bug explains the entire historic "ESP pseudo-DMA drain / post-target-1 transition" blocker family: the ROM was correctly rejecting corrupt data. The `[c89-esp-buf]` trace (new, dumps the SCSI buffer at ESP handoff) plus `pdma-read-val` localized it above the ESP layer; an overlay-free `read-only=on` control exonerated qcow2.
  - Fix: `scripts/patch-qemu-out-js-lazyfile.mjs` now recovers raw bytes with `charCodeAt(i) & 0xff` ("c89 raw byte recovery"); applied to `public/qemu-lazy/out.js` and `build/qemu/out.js` in place.
  - Result (`build/probes/browser-rawbytes-boot-continuous-420-0-20260612-090000.json`): continuous, pulse-free browser run reads `t1: 0,64,1-5` then `t0: 0,64,1-3,96,98,115,2147,3356,3355,2444,3132,2256` -- exactly the native qemu-wasm/desktop sequence -- and makes the first-ever lazy disk range fetch beyond 1 MiB (`jag-disk.img` ranges `[0, 1048576]`, non-zero start confirmed). A 540s stable-runtime run (`browser-rawbytes-longboot-540-0-20260612-093000.json`) continues in the ROM SCSI manager/boot path at `PC=0x408b9aba`.
  - RESOLVED (June 12, ~13:40): the post-write park is a RAM-SIZE configuration effect, not an emulation bug. The known-good desktop QEMU 9.0.50 binary parks in the IDENTICAL loop (`PC=0x408ba0a8/d6`, `A3=0`, `D7=0x00020000`) under the probe's `-m 16` configuration, and `make probe-native-qemu DURATION=60 RAM=128` boots straight through it (62 reads, max sector 1,738,148 -- deep System-volume loading). The fork's native build at `RAM=128` reaches `PC=0x000548e0` -- executing loaded boot code in low RAM, past the ROM. The browser shell's 16 MB default (chosen for fast ROM iteration) is what blocked the boot phase; use `?ram=128` for boot attempts. An upstream-ESP overlay (`QEMU_WASM_ESP_UPSTREAM=1 QEMU_ESP_UPSTREAM_REF=v9.1.2`, overlays esp.c/esp.h/fifo8/msmouse and renames legacy fifo8 callers) was built and probed along the way; it compiles and behaves identically at this stage and is kept as a gated option, default off.
  - Earlier (superseded) framing of the same stall (June 12, ~13:05): the post-write stall is NOT browser-specific. The browser guest parks at `PC=0x408ba0a8/0x408ba0d6`, `SR=0x2708`, `A3=0`, `D7=0x00020000`, `A5=0x408b98f2` polling low-RAM byte 2 bit 0 -- and `make probe-native-qemu-wasm DURATION=30 INTERVAL=10 NATIVE_ARGS="--continue-after-scsi"` shows the NATIVE build of the same fork in the SAME loop with IDENTICAL registers after the same 19 reads + 2 writes. The browser runtime has fully caught up to the native comparator; the remaining blocker is a fork-level q800/ESP emulation gap. The known-good desktop QEMU 9.0.50 boots A/UX from these same images, which brackets the fix to upstream changes after the fork's 8.2-era base (the ESP FIFO/PDMA series is the prime suspect). Next step: port/cherry-pick upstream `hw/scsi/esp.c` (+ any q800 deps) onto the vendored tree and iterate against the NATIVE comparator (seconds per cycle, no browser builds) until it advances past `0x408ba0d6` into the deep target-0 reads the desktop binary shows; then rebuild the wasm runtime.
  - Earlier framing of the same stall (browser-side observations, ~12:50): after the boot sequence completes its 19 reads and 2 WRITE(10)s to the jag volume (the last SCSI op ends cleanly: GOOD status, ICCS, MSGACC, disconnect -- tail of `build/write98-merged.txt`), the guest parks at `PC=0x408ba0a8`, `SR=0x2708` (IPL 7) with `info blockstats` frozen (`hd3: rd_bytes=14848 wr_bytes=1024 rd_ops=19 wr_ops=2`) and never issues another SCSI command. A live stop/cont pulse does NOT unstick it (unlike the historic pre-SCSI stalls). HMP disassembly of the loop (`x /24i 0x408ba080`, captured in this README's history) shows the ROM SCSI Manager's polled TIB dispatch engine: `jmp %a5@` dispatch, polling `%a3@(2)` bit 0 and `%d7` bit 17, with VIA pokes via `%a2`. Native qemu-wasm passes through this same PC in seconds, so a guest-visible device/flag difference remains. Next session: identify what `%a3` points to (dump `%a3` via `info registers` + `xp`) and which device flag native sets here that the browser runtime does not.
  - For reference, the boot is otherwise advancing: a 600s trace run confirmed the booter executing WRITE(10) commands to the jag volume (`build/write98-merged.txt`, commands `t0c42d2l512`); two fresh 600s legs cover the same ground each time. For long boots use a persistent session: `node ./scripts/smoke-headless-browser.mjs --url "http://127.0.0.1:8088/?build=longboot&ram=16&heap=1280&pace=0&autostart=lazy-paused" --no-probe --keep-open`, then `make hmp-cont`, then watch `curl http://127.0.0.1:8088/__range-stats.json` for jag range-fetch growth; stop with `make hmp-stop` and kill the detached headless Chrome when done. Next speed lever: revisit dynamic mini-WASM TBs (still disabled due to the known double-fault).
- Boot-path checkpoint, June 12, 2026 (third pass): with continuous execution fixed (below), the ROM disk scan now runs at full speed without pulses, and the next blocker is pinned to exact bytes:
  - The ROM completes the full aux-disk (target 1) scan continuously: DDM sector 0, driver read at lba 64 (count 11, exactly matching the DDM entry), then partition map lbas 1-5, twice. PDMA data integrity for target 1 is proven byte-for-byte: the logged pseudo-DMA longwords `45520200 00300060 00010001 ...` equal the image bytes.
  - The ROM then scans target 0 (jag-disk, which carries the Mac OS partition that A/UX boots through) and loops on its sector 0 forever at ~21 reads/s. Each read SELECTs cleanly, transfers all 512 bytes by 16-byte PDMA chunks, and completes with GOOD status -- but the drained byte stream is corrupt: `45 52 02 00 00 0f [ef 9e] a0 00 00 01 ...` -- two spurious bytes `0xef 0x9e` injected at offset 6 of the first FIFO chunk, shifting the rest of the sector by 2. The ROM therefore sees an invalid Driver Descriptor Map on the boot disk and rescans forever. The bytes appear nowhere in the real sector, so this is ESP-internal state leaking into the FIFO across the target 1 -> target 0 transition (suspects: esp.c FIFO flush on select/command, and the local esp-pdma-longword patch's mid-longword refill). A single-disk control (jag removed from `module.js`) confirms the aux scan simply ends quietly without it, so the jag/t0 path must be fixed, not bypassed.
  - The insertion happens mid-data-phase (6 good bytes, 2 alien, then the full remainder undisplaced), which matches the observed early `esp_command_complete` firing while the ROM had not yet drained: a completion-path FIFO push lands inside the live data stream. The pinned qemu-wasm base is QEMU 8.2-era `esp.c`; upstream fixed several ESP FIFO/PDMA sequencing bugs of exactly this class in the 9.x cycle (Mark Cave-Ayland's esp series), so the next concrete step is backporting upstream's esp.c FIFO/PDMA fixes onto the vendored tree (or rebasing the fork's esp.c) and re-running the t0 pdma-read-val comparison.
  - Probe harness requirement discovered along the way: `scripts/smoke-headless-browser.mjs` needs Node >= 21 for the global WebSocket; on this machine run probes with `export PATH="$HOME/.nvm/versions/node/v23.7.0/bin:$PATH"`.
  - Repro: `make build-qemu-balanced-t2-esp-trace` (the esp trace now also logs `pdma-read-val` assembled longwords and its cap is raised to 60000 events), then the 1s-snapshot capture flow saved in `build/pdma-val-long-merged.txt`; key probes `build/probes/browser-boundedwait-long-continuous-600-60-20260612-052000.json` (600s continuous, 566 t0 reads, healthy final stop at `PC=0x4088bc62`), `build/probes/browser-plain-esp-continuous-300-60-20260612-061500.json` (FIFO512 exonerated -- identical loop without it), `build/probes/browser-single-disk-continuous-300-60-20260612-070000.json` (single-disk control).
- Major checkpoint, June 12, 2026 (second pass): continuous execution without stop/cont pulses is fixed. Two independent root causes were isolated with CDP worker stack captures and a process of elimination:
- Runtime bug (the real "single bare cont stalls" cause): the xterm-pty atomic poll wait in the generated runtime parks the QEMU main-loop thread in `Atomics.wait(HEAP32, PTY_atomicIndex, -1)` with no timeout; its wakeup depends on a callback chain proxied to the browser main thread. When that page-side wake is lost, the main loop sleeps through every virtual-timer deadline forever: VIA IFR bits stop being set, the ROM polls them forever, and HMP `stop` blocks inside `vm_stop` waiting for a CPU thread that is still executing (CPU pegged at 100%, captured stack `PTY_waitForReadableWithAtomic <- ... <- qemu_poll_ns <- main_loop_wait`). `scripts/patch-qemu-out-js-lazyfile.mjs` now bounds that wait with the worker-realm `PTY_pollTimeout` and synthesizes the normal poll-timeout result on expiry. The default cap is conservative (`ptyMin=8`, `ptyIdle=32`), while the headed interactive launcher uses `ptyMin=2&ptyIdle=16` for lower keyboard/mouse latency. The patch applies to generated `out.js` without a QEMU rebuild and is active in `public/qemu-lazy/`.
  - Harness bug (why post-fix probes still looked dead): `scripts/smoke-headless-browser.mjs` ran the probe subprocess with `execFileSync`, blocking its event loop for the whole run so the CDP websocket went unread; the resulting DevTools backpressure stalled the renderer's HTTP fetches ~70s in (control worker reported every fetch aborting after 5s while its event loop stayed alive). The probe now runs via async `execFile`. The control worker and browser-log mirror also gained abort timeouts, overlap guards, and a poll heartbeat exposed as `probeState.controlWorkerPoll*`.
  - Proof: `build/probes/browser-asyncprobe-continuous-150-0-20260612-050000.json` -- a 150s continuous run with zero HMP pulses ends at `PC=0x408b2df6`, `SR=0x2104` (ROM SCSI-manager region, where the native qemu-wasm comparator runs), final stop inspection answers normally, and the control channel reports 199/200 clean polls. Earlier the same night, `build/probes/browser-scsi-stable-boundedwait-continuous-200-0-20260612-020900.json` showed 572 completed SCSI READ commands in a continuous run.
  - The diagnostic ladder that got here is preserved in `build/probes/browser-scsi-stable-continuous-*.json` (60s answered / 120s+ silent brackets), `scripts/diag-worker-stacks.mjs` (CDP `Debugger.pause` stack capture of all QEMU pthread workers; the captured main-loop and CPU-thread stacks pinned the wait), and the negative experiments below.
  - `?display=none` is now accepted by the browser shell (`applyDisplayMode`) -- added to exonerate the SDL display path during this investigation; useful for headless boot probes generally.
- Earlier checkpoint, June 12, 2026 (first pass): the June 11 exit-pump negative now has a structural explanation, and the continuous-mode probe baseline itself failed to reproduce. Details (note: the "wedge" attributions below were superseded by the second-pass root causes above; the structural code findings stand):
  - Code reading of `vendor/qemu-wasm/tcg/wasm32.c` proved that `trysleep()` (queued-call pump, exit pump, optional yield) only runs in `tcg_qemu_tb_exec()`'s outer loop, while `tcg_qemu_tb_exec_tci()` follows `goto_tb`/`goto_ptr` chains internally without returning there. A chained ROM wait loop therefore never executes any pump, so the June 11 exit-pump experiment could not fire at exactly the moments it was built for. The TB-exit contract was verified against `accel/tcg/translator.c`: every non-`CF_NOIRQ` TB begins with a generated `icount_decr` check that exits through the TB's own `exit_tb` with a genuine `TB_EXIT_REQUESTED`, so `cpu_exit()` is honored at every chained TB entry without synthesizing return values from `ctx.tb_ptr`.
  - A second latent defect was found while investigating: with dynamic mini-WASM TBs "disabled" via `WASM32_INSTANTIATE_NUM=2147483647`, a hot TB's per-TB counter still crosses `INT32_MAX` after ~2.1e9 executions, after which `goto_tb`/`goto_ptr` bail out of TCI and the outer loop calls `instantiate_wasm()` -- the known-broken dynamic-TB path -- on a fallback build. `QEMU_WASM_TCI_ONLY=1` (new, default off) saturates the counter and forces the TCI path unconditionally. Promoting it into the default fallback build is a recommended follow-up.
  - Three reversible chain-pump experiments were built and probed (`QEMU_WASM_TCI_CHAIN_PUMP` plus `QEMU_WASM_TCG_SLEEP_PUMP_INTERVAL`/`QEMU_WASM_TCG_SLEEP_PUMP_MS`): full `trysleep()` at every TCI chain transition, the same rate-limited via `QEMU_WASM_TCI_CHAIN_PUMP_INTERVAL=1024`, and a flag-only variant where chain context calls `cpu_exit()` (two atomic stores, no emscripten machinery) and leaves all pumping to the outer loop. Under the pulsed cadence the chain-pump runtime is healthy: `build/probes/browser-via-scsi-chainpump-pc-trace-60-15-20260611-232045.json` progressed `0x00006b0e -> 0x40803f84 -> 0x00006d24 -> 0x4080c098`, matching the stock runtime's progression.
  - All continuous (no recurring HMP stop) probes of those builds stopped emitting PC-trace lines 70-150s in and returned an empty final stop/registers inspection: `build/probes/browser-scsi-chainpump-continuous-360-30-20260611-231744.json`, `build/probes/browser-scsi-chainpump-continuous-360-30-20260611-232858.json`, `build/probes/browser-scsi-chainpump-tcionly-sleep-continuous-360-30-20260612-000310.json`, `build/probes/browser-scsi-chainpump-ratelimited-continuous-360-30-20260612-001100.json`, `build/probes/browser-scsi-chainpump-flagonly-continuous-360-30-20260612-002030.json`. Note the quiet trace alone is not proof of a stall: once a loop is chain-resident, periodic trace lines (every 200k outer iterations) become minutes apart by design; the empty final HMP inspection is the real failure signal.
  - The decisive control overturned the obvious attribution: `make smoke-headless-scsi-continuous DURATION=240 INTERVAL=30` against the unmodified stable FIFO512 runtime also returned an empty final inspection in the same environment (`build/probes/browser-scsi-stable-continuous-240-30-20260612-002800.json`). The June 11 baseline (a stable continuous run surviving 360s and sampling `PC=0x00006b0e` at the end) did not reproduce on June 12. None of the June 12 continuous chain-pump comparisons are therefore valid evidence about guest progress.
  - The sharpest next blocker: instrument why a continuous browser run stops answering HMP after ~80-150s on any build (main-loop/PTY liveness, e.g. a rate-limited main-loop heartbeat trace into the browser log plus an independent CPU-thread heartbeat), then re-run the chain-pump comparisons. A plausible unifying mechanism is QEMU main-loop starvation under Emscripten futex unfairness while the CPU thread monopolizes BQL/MMIO, which external `stop`/`cont` relieves by parking the CPU thread -- but the June 12 data cannot separate that from a harness/environment regression.
- Previous checkpoint, June 11, 2026: `make build-qemu-balanced-esp-pdma-fifo512-exitpump-esp-pc-trace EXIT_INTERVAL=1` builds, but it is a confirmed negative for the current run-loop blocker. `build/probes/browser-via-scsi-exitpump-pc-trace-480-60-20260611-222007.json` still saw no SCSI reads in 480s with 60s HMP stop/sample/continue cadence and ended at `PC=0x40809b60`, `SR=0x2100` in the VIA/autovector handler. `build/probes/browser-scsi-exitpump-continuous-360-30-20260611-222929.json` then ran the same traced exit-pump runtime without recurring HMP stops and ended at `PC=0x00006b0e`, `SR=0x2204`, with no SCSI trace and no non-zero lazy disk range reads.
- The useful browser workaround is still the worker-backed stop/sample/continue cadence, not a single bare `cont`. Short pulse-cadence probes move past `0x00006b0e` into later ROM/VIA paths, and the longer known-good FIFO512 comparison first saw SCSI at 347s in `build/probes/esp-pdma-fifo512-600-30-20260611-183717.json`.
- The current preferred served profile remains `make build-qemu-balanced-esp-pdma-fifo512` plus `make package-lazy`. The exit-pump target is intentionally kept as a reproducible negative/diagnostic experiment, not promoted to the default browser runtime.
- Fresh VIA/browser comparison, June 11, 2026: `make smoke-headless-via-scsi-series DURATION=120 INTERVAL=30` against the restored FIFO512/no-exit-pump served runtime produced `build/probes/browser-via-scsi-120-30-20260611-200525.json`. It did not reach SCSI; samples moved through `PC=0x00006b0e`, `0x40803f84`, `0x00006d24`, and ended at `PC=0x40809b60` in the VIA/autovector handler. The final `viaSummary` had VIA1 `IFR=0x66`, `IER=0x27`, active `sixty_hz`, `adb_ready`, and `t2`; VIA2 interrupts remained disabled.
- ADB-autopoll suppression is also a negative result, not the fix. `make build-qemu-balanced-esp-pdma-fifo512-adb-suppress && make package-lazy`, followed by `make smoke-headless-via-scsi-series DURATION=120 INTERVAL=30`, produced `build/probes/browser-adb-suppress-via-scsi-120-30-20260611-202302.json`. It still ended at `PC=0x40809b60`, `SR=0x2100` in the VIA/autovector handler, saw no SCSI trace, and made no non-zero lazy disk range reads. The normal interactive FIFO512 runtime was rebuilt and repackaged afterward.
- Host-native qemu-wasm is materially ahead on the same 16 MB profile. `make probe-native-qemu-wasm DURATION=45 INTERVAL=15 RAM=16 NATIVE_ARGS="--via --continue-after-scsi"` sampled `PC=0x408b98fa`, then `0x408ba0a8`/`0x408ba0b2` in the ROM SCSI manager, with VIA1 only enabling active `t2` (`IFR=0x27`, `IER=0x20`). That makes the next browser blocker sharper: reproduce native's timer/interrupt/run-loop shape in wasm fallback TCG before adding more disk FIFO tweaks.
- Fresh timer-summary browser probe, June 11, 2026: `build/probes/browser-via-scsi-45-15-timers-20260611-204630.json` still ended before SCSI at `PC=0x00006d24`, `SR=0x2214`. The virtual clock advanced normally (`now=41251ms` at the final 45s sample), but VIA1 had `one_second`, `sixty_hz`, and `t2` active with T1/T2 due in single/double-digit milliseconds. The native qemu-wasm comparator at the same elapsed time was already in the ROM SCSI manager with only T2 active, so the current gap is interrupt-service/progress balance in the browser runtime rather than lazy disk loading or a stopped clock.
- Instruction-counted virtual time is probeable now, but it remains a diagnostic negative. QEMU's stock numeric `-icount shift=N` cap is `10`: `build/probes/browser-via-scsi-icount-shift10-off-45-15-20260611-204858.json` and `build/probes/browser-via-scsi-icount-shift10-on-45-15-20260611-205159.json` held VIA active IRQs at zero, but advanced only about `2.18s` of virtual time after 45s wall time and ended in the ASC/EASC startup loop. `build/probes/browser-via-scsi-icount-auto-off-45-15-20260611-205052.json` advanced only `30ms` of virtual time and ended in the VIA interrupt wait loop.
- Extended icount shift is also a negative result, not the next fix. `make build-qemu-balanced-esp-pdma-fifo512-icount-shift MAX_ICOUNT_SHIFT=15` builds successfully and the temporary built-runtime probe restores the normal `qemu-lazy` artifacts after exit. However, `build/probes/browser-via-scsi-built-icount-shift15-off-45-15-20260611-210829.json`, `build/probes/browser-via-scsi-built-icount-shift14-off-45-15-20260611-210929.json`, and `build/probes/browser-via-scsi-built-icount-shift10-off-45-15-20260611-211028.json` all ended in the Quadra ROM checksum loop with no SCSI trace and no non-zero lazy disk reads. The current blocker is browser fallback TCG/TB progress and timer-interrupt balance, not simply the `-icount` scale.
- Current long-window trace proof: `make build-qemu-balanced-t2-esp-pc-trace`, then `make smoke-headless-via-scsi-pc-trace-long DURATION=360 INTERVAL=30`, produced `build/probes/browser-via-scsi-pc-trace-360-30-20260611-212949.json`. The browser run reached target 1 READ sector `0`, completed that transfer, then issued target 1 READ sector `64` (`count=11`). It ended in the VIA/autovector handler with ESP data-ready for that 5632-byte transfer: `stat=0x91`, `intr=0x18`, `ti_size=5632`, `async=5632`, `ready=1`. Disk range stats still showed only the initial 1 MiB lazy reads, so this remains a ROM/ESP pseudo-DMA drain/progress issue rather than a missing disk chunk.
- FIFO512 is a useful negative, not the fix. `make build-qemu-balanced-esp-pdma-fifo512-esp-pc-trace`, then `make smoke-headless-via-scsi-fifo512-pc-trace-long DURATION=360 INTERVAL=30`, produced `build/probes/browser-via-scsi-fifo512-pc-trace-360-30-20260611-214957.json`. It still reached only target 1 sectors `0` and `64`; the 5632-byte sector-64 data-ready edge happened right at the end of the window, with the same `stat=0x91`, `intr=0x18`, `ti_size=5632`, `async=5632`, `ready=1` state. Increasing the internal pseudo-DMA FIFO did not by itself produce later target 1 reads.
- Cadence is now the sharper blocker. A longer FIFO512 run with coarser external stop/sample/continue cadence, `build/probes/browser-via-scsi-fifo512-pc-trace-480-60-20260611-215816.json`, did not reach SCSI at all and ended around `PC=0x4080b140` with VIA1 active `one_second + sixty_hz + adb_ready + t2`. The follow-up exit-pump probe at the same 60s cadence also did not reach SCSI, and the continuous exit-pump run stayed at the early low-memory ROM loop. The browser needs either the known 30s worker-backed pulse workaround or a deeper qemu-wasm main-loop/TCG scheduling fix.
- The browser shell's `lazy-pulse` automation now accepts a tunable pulse cadence and mode: `?autostart=lazy-pulse&pulseMode=yield&pulseMs=2000` for interactive headed runs, or `pulseMode=sample&pulseMs=30000` for diagnostic stop/status/register/block/continue sampling. The matching smoke target is `make smoke-headless-lazy-pulse DURATION=45 INTERVAL=15 PULSE_MS=30000`.
- The focused blocker is QEMU/ROM progress under wasm fallback TCG and virtual timer/interrupt behavior. The display/input bridge is alive enough for continued boot work: canvas framebuffer samples update, the canvas captures focus, the stay-paused input self-test passes, and HMP-backed `sendkey`/mouse fallback controls are present.
- Dynamic mini-WASM TB execution is now past the original browser glue blockers but is not yet a usable boot path. The patcher decodes qemu-wasm helper import signatures, wraps helper imports, and registers the mini-WASM `start` export with an ABI-aware wrapper. With `EMULATE_FUNCTION_POINTER_CASTS=1`, the dynamic build gets past the previous `LinkError`, parser failure, and `function signature mismatch`, then aborts in guest execution with `qemu: fatal: DOUBLE MMU FAULT`.
- Latest dynamic diagnostic: `make build-qemu-balanced-dyn-tb-exc-trace` produced a runnable wasm with PC and m68k exception tracing. A 5s headless probe recorded 113 PC trace lines and 29 exception trace lines. The last normal PC trace was ROM code around `PC=0x408820ba`; then the guest took an instruction-fetch access fault at `PC=0x4080010e` (`qemu_access=2`, `SSW=0x0526`, `TCR=0xc000`, `SRP=0x00fffa00`). While building the 68040 access-fault frame, the first stack push (`label=data3`) wrote `0x0017fffc`; that stack write faulted (`qemu_access=1`, `SSW=0x0405`) while `mmu_fault=1`, causing the double fault.
- `make build-qemu-balanced-dyn-tb-no-fpcast` proves that disabling Emscripten function-pointer-cast emulation is not viable for this QEMU build: the browser runtime fails before guest execution with `RuntimeError: function signature mismatch` in `sysbus_connect_irq` during `q800_machine_init`.
- Decision for now: keep `make build-qemu-balanced` as the served/default profile and treat dynamic TB as an isolated research branch. The smallest useful dynamic next step is to compare fallback vs dynamic at the ROM/MMU transition that leaves the `0x408820ba` loop and lands at the unmapped `0x4080010e` instruction fetch.
- The display/input bridge has a repeatable stay-paused smoke test. The browser shell exposes `Input self-test` and `?autostart=lazy-paused&inputSelfTest=1`; the test focuses the canvas, dispatches keyboard/mouse events through the existing handlers, queues `sendkey a` without `cont`, and confirms HMP still reports `VM status: paused`.
- The browser shell now has a worker-backed `Pulse 30s` control. It mirrors the successful headless probe cadence by continuing the guest, then periodically queuing `stop`, `info status`, `info registers`, `info block`, and `cont` through the PTY worker so visible runs can reproduce the SCSI-progress workaround without manual HMP commands. The visible `Start lazy pulse` button now starts `qemu-lazy` paused first and then begins that worker cadence automatically; `?autostart=lazy-pulse` and `make smoke-headless-lazy-pulse DURATION=45 INTERVAL=15` exercise the same path for browser automation.
- The previous VIA timer/RAM-test blockers are no longer the active blocker in the patched browser runtime. The build now carries the browser-only VIA T2 one-shot experiment plus the corrected ROM RAM-test fast-forward, and fresh no-pacing runs move past those old loops into low-memory ROM/UI code.
- Current proof: `make smoke-headless-scsi-pc-trace-long DURATION=360 INTERVAL=30` reaches low-memory ROM/boot code, VIA/autovector handlers, ROM tick/delay code, and then ESP/SCSI READ commands. The final sampled PC in the breakthrough run was `PC=0x408d1f6c`, classified as ROM SCSI DMA/transfer path.
- The live framebuffer is no longer blank: smoke screenshots and page metrics show the q800 canvas updating to the ROM checkered pattern. The active question is what ROM state that pattern represents, not whether SDL/canvas is connected.
- The current boot blocker is no longer display/input or pre-SCSI ROM progress. It is now completing the early SCSI transfer path after the ROM issues READ sector `0` and READ sector `64`. Lazy disk stats still show only the first 1 MiB range for `aux-3.1.1-disk.img` because both confirmed reads are inside that opening cached range.
- Native qemu-wasm is the current comparator: a 12s `./build/qemu-wasm-native/qemu-system-m68k` probe sampled `PC=0x408ba0d6` in the ROM SCSI manager at 2-8s, then `PC=0x408b98fa` by 10-12s. The browser long run instead pauses around `PC=0x408d1f6c`, so the useful next trace is ESP status/interrupt/DMA completion state around that transfer.
- `make build-qemu-balanced-t2-esp-trace` is the current focused disk diagnostic build. It adds `[c89-esp]` lines for ESP register reads/writes, status/interrupt bits, DRQ/IRQ edges, DMA enable, pseudo-DMA callbacks, selected bus id, current device/request target, LUN, command-phase entry, and transfer completion while preserving the T2 one-shot experiment. Use `make build-qemu-balanced-t2-esp-pc-trace` only when ROM PC phase samples are more important than speed.
- The first ESP+PC diagnostic run showed forward progress, not a simple lost IRQ. QEMU raised ESP IRQ, the ROM read `RINTR=0x10`, then repeatedly issued `CMD_TI|CMD_DMA` and drained 16-byte pseudo-DMA chunks. The final sample stopped while a chunk was still live (`ti_size=64`, `async=64`, `fifo=16`).
- A lighter ESP+PC run still spent almost the full 360s before reaching the first sector-0 `esp_transfer_data transfer 0/512`. It ended at `PC=0x40809be6` in the VIA/autovector handler with ESP data-ready (`stat=0x91`, `intr=0x18`, `async=512`) but before ROM pseudo-DMA drain.
- The follow-up ESP-only 600s run proves that state was not a hard lost-IRQ dead end: the ROM/QEMU path continued to `scsi_disk_dma_command_READ` for sectors `2` and `3`, with the final sample at `PC=0x4088bc5e`, `SR=0x2208`. The active blocker is now browser fallback throughput and/or a later SCSI-manager divergence, not basic display/input or the first ESP data-ready handoff.
- The fresh stable non-ESP control run shows the cadence is material: `INTERVAL=60` stayed in the pre-SCSI ROM/VIA path for 600s, while `INTERVAL=30` reached SCSI and observed the target 1 sequence `0`, `64`, `1..5`, then `1`.
- `make hmp-status` and `make hmp-info-block` confirm the monitor is reachable and that the browser VM has `mtd0`, `hd2` (`aux-3.1.1-disk.img`), and `hd3` (`jag-disk.img`) attached.
- `scripts/probe-browser-rom-progress.mjs` and `scripts/probe-native-qemu-rom-progress.mjs` now emit target-aware `scsiSummary` objects with `readSectors`, `maxReadSector`, `lbas`, and per-target summaries. With `--via`, both probes also emit compact `viaSummary` objects for `IFR`, `IER`, active interrupt names, and timer counters. The JSON-producing smoke/native Make targets are quiet now, so saved probe files can be parsed directly.
- `make summarize-probes PROBES="build/probes/*.json"` prints compact browser/native probe summaries with final PC/SR phase, VIA active interrupts, timer `due`/`age` fields, SCSI reads, lazy disk ranges, and sample timelines. This is the quickest way to compare FIFO512, ADB-suppress, native qemu-wasm, and future timer/run-loop experiments.
- The native desktop comparator is much farther ahead: `make probe-native-qemu DURATION=5 INTERVAL=5 RAM=16 NATIVE_ARGS="--continue-after-scsi"` sees target 1 sectors `0`, `64`, `1..5`, then target 0 sectors including `96`, `98`, `115`, `2147`, `3356`, `3355`, `2444`, `3132`, and `2256`, plus writes to sector `98`. The browser blocker is specifically failing to make the post-target-1 transition that native reaches immediately.
- `make smoke-headless-browser DURATION=20` now captures the page's hidden `#probeState` JSON in its output. The June 11, 2026 smoke reported active canvas focus, 1152x870 framebuffer dimensions, `nonBlack=15696/15696`, checksum `1854490181`, `changes=2`, and clean `VM status: paused`.
- The in-app browser can still become sluggish if an unpaced run is left hot. The stable automated path is now the dependency-free headless Chrome smoke helper, which launches a temporary browser, waits for QEMU paused readiness, runs the ROM probe, prints JSON, and exits cleanly.
- Expected missing-runtime 404s are gone from smoke logs. The dev server now exposes `/__exists.json`, and the browser shell uses it for bundle availability checks instead of HEADing missing `public/qemu/` artifacts.
- The old `fault at f1ffffff` line is not sufficient by itself; it can remain in `info registers` while execution continues. The page-table walk for `0xf1ffffff` under `SRP=0x00ffac00` reaches an invalid pointer descriptor at `0x00ffabfc = 0x00000018`, but later probes proved the guest can leave that point.
- The ROM startup path is now mapped more clearly: checksum loop around `PC=0x40847a6e`, ASC/EASC startup sound/test loop around `PC=0x408bd3be`, then RAM test around `PC=0x408477e6`/`0x408477fc`.
- The ASC loop is finite when the FIFO-ready shim is enabled. A 128 MB run escaped ASC after additional bounded windows and reached the RAM-test pattern registers (`6db6db6d`, `b6db6db6`, `db6db6db`).
- The 128 MB RAM test is too slow for the prototype default: a 30s slice advanced the tested address from roughly `0x000ad0e8` to `0x005275b0`, with an apparent target near `0x07ffffac`.
- The browser shell now defaults to 16 MB RAM for faster ROM/RAM-test iteration while preserving the desktop 128 MB launch outside this prototype. A 16 MB run verified launch args with `-m 16`, escaped the ROM checksum loop, escaped the ASC/EASC loop, and reached the RAM test.
- 16 MB is the current best proof-of-progress profile: 10s windows moved from checksum (`PC=0x40847a74` / `0x40847a6e`) to ASC (`PC=0x408bd3b6` / `0x408bd3be`) to RAM test (`PC=0x408477e6`). RAM-test progress reached about `A2=0x00dd6df0` with a target near `A4=0x00ffffac`.
- A fresh 16 MB run with shorter windows got past the old hot checkpoint cleanly. The safe pattern was 5s checksum slices, 10s ASC slices while `D1` counted down, then 5s and 1s RAM-tail slices.
- The first RAM write sweep crossed the top successfully: `A2` climbed from `0x00083b80` to `0x00f0cbe8`, then a 1s step moved into the next RAM verification phase at `PC=0x40847882`.
- The previous second ROM RAM verification loop is no longer the active blocker when `QEMU_WASM_ROM_RAMTEST_HACK=1` is enabled. Keep that history because it explains why the browser build carries the ROM RAM-test fast-forward patch.
- HMP in this runtime does not expose a `set` command, so quick monitor-side register/IFR pokes are not available. The next blocker is a source-level VIA/autovector trace or emulation fix, not a monitor-only tweak.
- The browser shell now bounds the serial log, samples the framebuffer through a small probe canvas, and uses the shared ADB input bridge as the normal keyboard/mouse path. HMP commands such as `sendkey`, `mouse_move`, and `mouse_button` remain diagnostic-only escape hatches.

- `make build-qemu` builds `m68k-softmmu` from the inspected `ktock/qemu-wasm` fork with Emscripten SDL2 support enabled.
- `make build-qemu-responsive` rebuilds with `WASM32_QUEUE_PUMP_INTERVAL=32` and `QEMU_WASM_THREAD_YIELD=1` so the fallback TCG interpreter yields more often during long CPU-bound ROM code.
- `make build-qemu-lean` adds the responsive-yield settings and bakes `QEMU_WASM_TOTAL_MEMORY_MB=768` into the generated runtime for the current 16 MB guest profile.
- `make build-qemu-balanced` adds the same responsive-yield settings and bakes `QEMU_WASM_TOTAL_MEMORY_MB=1280` into the generated runtime; this is the current verified browser profile after the 768 MB startup OOM.
- `make build-qemu-balanced-esp-pdma-fifo512-chainpump EXIT_INTERVAL=32 SLEEP_INTERVAL=4 SLEEP_MS=4 CHAIN_INTERVAL=16384` (and the `-esp-pc-trace` variant) builds the TCI chain-transition pump experiment. It enables `QEMU_WASM_TCI_CHAIN_PUMP=1` (chain context requests a CPU exit every `CHAIN_INTERVAL` `goto_tb`/`goto_ptr` transitions through `cpu_exit()`, honored by the next chained TB's generated `icount_decr` prologue), `QEMU_WASM_TCI_ONLY=1` (saturates the per-TB counter and forces the TCI path, closing the latent `INT32_MAX` route into `instantiate_wasm()` on fallback builds), and the `QEMU_WASM_TCG_SLEEP_PUMP_INTERVAL`/`QEMU_WASM_TCG_SLEEP_PUMP_MS` outer-loop sleep pump (a short real `emscripten_thread_sleep` between TBs with the BQL released, mimicking the stop/cont park window). All four knobs are independent, default-off build flags; earlier same-day variants that called full `trysleep()` from inside the TCI chain context are superseded -- chain context must only do the `cpu_exit()` flag write, never emscripten machinery.
- `make smoke-headless-via-scsi-chainpump-pc-trace-long DURATION=480 INTERVAL=60` and `make smoke-headless-scsi-chainpump-continuous-long DURATION=360 INTERVAL=30` probe the traced chain-pump build through the temporary served-runtime swap, mirroring the exitpump probe targets.
- `make build-qemu-balanced-esp-pdma-fifo512-icount-shift MAX_ICOUNT_SHIFT=15` is an experimental timer/progress build. It keeps the FIFO512 disk path and raises QEMU's numeric `-icount shift=N` cap above upstream's default `10`; use only with the temporary built-runtime probe target until results are known.
- `make package-smoke` creates a ROM/PRAM-only q800 smoke runtime in ignored `public/qemu-smoke/`.
- `make package-lazy` creates an experimental A/UX runtime in ignored `public/qemu-lazy/` that preloads only ROM/PRAM and exposes the large A/UX/JAG disk images as range-served lazy files.
- `make package-local` still creates the original full preload bundle in ignored `public/qemu/`, but that path is no longer the preferred boot path because it pushes a 2.4 GB `.data` preload through MEMFS before QEMU can run.
- `make serve` now serves COOP/COEP/CORP headers and supports `Range: bytes=...`, which is required for lazy disk reads.
- The latest low-CPU build was verified with `JOBS=2 DOCKER_CPUS=2 WASM32_QUEUE_PUMP_INTERVAL=128 make build-qemu`; `128` is now the build-script default for future attempts.
- The browser shell now has a PTY-backed HMP debug input path. The HMP buttons and command box enqueue monitor commands through a dedicated `-monitor stdio` channel, bypassing the currently suspect SDL synthetic-key path.
- The HMP/control-file path now has a Web Worker + `SharedArrayBuffer` PTY input ring. This keeps terminal-driven monitor input working even after the QEMU runtime blocks normal page timers.
- The page-side HMP buttons now prefer that same worker path when it is available. `Run 2s`, `Run 10s`, and `Run 30s` queue `cont` from the worker and schedule worker-side `stop` + `info status`; `HMP Stop` gives the page a direct stop control while the VM is running.
- `Start lazy paused` launches `qemu-lazy` with `-S`; from there `make hmp-status`, `make hmp-cont`, `make hmp-stop`, and `make hmp-run-for DURATION=2` provide the current debug loop.
- Terminal control IDs are timestamp-sized now, so a live browser page will not silently discard fresh commands after `control.local.seq` is removed or after a crash/reload cycle.
- The browser shell has a default-on `Pace CPU` checkbox that adds `-icount shift=10,sleep=on` to lazy/smoke QEMU launches. That keeps the page more responsive, but it can distort the ROM timer/dispatch route: the long `shift=8,sleep=off` run did not reach SCSI by 480s, while the no-icount run did. Use `?pace=0` only for ROM/SCSI progress probes, preferably headless or already paused; in normal headed Chrome it can still monopolize the renderer before the pulse worker can stop it.
- The browser shell has a RAM selector (`16`, `32`, `64`, `128` MB) and accepts `?ram=16` in the URL. The selected value rewrites the packaged `-m` argument at launch time without repackaging the local ROM/disk assets.
- The browser shell accepts `?heap=768` or `?heap=1280` to set `Module.INITIAL_MEMORY` before importing `out.js`. The value must not exceed the memory maximum baked into the wasm binary, so raising it beyond the build target requires rebuilding.
- The browser shell accepts `?autostart=lazy-paused` and `?inputSelfTest=1` for repeatable smoke tests. Together they start `qemu-lazy` with `-S` and run the stay-paused input bridge diagnostic as soon as QEMU resolves its runtime promise.
- `make hmp-run-for DURATION=5` is experimental: it lets the guest run briefly, then queues `stop` and `info status`. `DURATION` is capped at 30 seconds because the current ROM/RAM-test loops can still leave the in-app renderer hot.
- `make hmp-step DURATION=5` wraps `hmp-run-for` and then queues `info registers`, which is the current preferred terminal probe loop.
- The browser shell now has a `ROM 5s probe` control, and the Makefile has `make hmp-rom-probe DURATION=5`, to queue status/block, run, stop, registers, and block inspection around the current ROM path.
- The browser shell publishes framebuffer sample/checksum data in `#probeState` and in the Input panel, which lets us tell a dead canvas apart from a live black or white guest framebuffer.
- The browser shell also renders a compact Diagnostics panel with heartbeat age, framebuffer checksum/change count, disk range-read stats, PTY drops, and serial tail.
- HMP `VM status:` responses now update the visible QEMU status pill, so terminal-driven `cont` and `stop` commands are reflected in the page.

Local browser verification:

- `qemu-smoke` reaches `Running...` with `-display sdl,gl=off,show-cursor=off`; Chrome screenshot capture shows the SDL canvas attached at 1152x870 while the page supplies the host cursor.
- `qemu-smoke` stayed at `QEMU running` with the DOM heartbeat/probe responsive after 18 seconds using the queue-pump build.
- A fresh in-app Browser check loaded the shell at `http://127.0.0.1:8088/` with `Isolation ready`, hidden `#probeState` present, and `smoke, lazy ready`.
- Starting `qemu-smoke` from the in-app Browser reached `QEMU running`; the serial log showed the launch args without `-monitor none`.
- Browser automation click dispatch can still be flaky against a running QEMU canvas, but terminal-driven HMP input no longer depends on page click/timer dispatch.
- A later `qemu-lazy` run initially hit `TypeError: Cannot convert ... to a BigInt` because `public/qemu-lazy/out.js` was stale and still used the raw `getWasmTableEntry(fn).apply(...)` path. `make sync-runtime` now syncs the patched runtime into `public/qemu/`, `public/qemu-smoke/`, and `public/qemu-lazy/` without rebuilding `.data` bundles.
- After syncing, `qemu-lazy` ran without the BigInt worker exception for the observed startup window. `Start lazy paused` reaches `QEMU paused`, the control worker starts, and `make hmp-status` returns `VM status: paused (prelaunch)`.
- Fresh dedicated-monitor verification after clearing stale commands:
  - `Start lazy paused` reaches the QEMU monitor prompt.
  - `make hmp-status` returns `VM status: paused (prelaunch)`.
  - `make hmp-cont` changes HMP status to `VM status: running`.
  - The framebuffer probe changes from black to nonblack/white after the guest is released.
  - `make hmp-stop` returns the VM to `VM status: paused`.
- Fresh worker-control verification:
  - `Pace CPU` starts QEMU with accepted `-icount shift=10,sleep=on` args.
  - `Run 2s` queues a timed worker run and returns to `VM status: paused`.
  - The framebuffer probe reports 1152x870 output, nonblack samples, and an incremented checksum/change count after the timed run.
- Balanced display/input verification:
  - `make build-qemu-balanced`, `make sync-runtime`, and `make package-lazy` produced a 1280 MB `qemu-lazy` runtime.
  - `Start lazy paused` with `?ram=16&heap=1280` reaches `QEMU paused`, the HMP monitor prompt, and `make hmp-info-block` shows `mtd0`, `hd2`, and `hd3`.
  - A 2s worker-controlled run emits VIA debug, returns to `VM status: paused`, and `info registers` reports `PC = 40847a70`, `SR = 2704`.
  - The stay-paused input smoke at `?autostart=lazy-paused&inputSelfTest=1` logs `input bridge key: a (stay paused)`, `input self-test: key 0 -> 2, mouse 0 -> 3, hmp worker`, then `VM status: paused (prelaunch)`.
  - The lazy-pulse smoke at `?autostart=lazy-pulse&ram=16&heap=1280&pace=0` reports `qemuAutoPulseMs=30000`, live framebuffer samples, zero PTY drops, and worker logs for `cont`, `stop`, `info status`, `info registers`, `info block`, and `cont`.
- HMP `info block` confirms the browser VM has `mtd0`, `hd2` (`aux-3.1.1-disk.img`), and `hd3` (`jag-disk.img`) attached through QEMU snapshot overlays. The range server sees the first 1 MiB lazy read from both disks during block open.
- The ASC FIFO ROM loop has been cleared in the browser build. The earlier stall was `PC=0x408bd3b2`, polling `ASC_BASE + 0x804`; HMP `xp /8bx 0x50014800` now shows the FIFO IRQ byte at `0x50014804` returning `0x0f`.
- Because this browser prototype runs with `-audio none`, the build includes an opt-out ASC/EASC FIFO readiness shim for q800 ROM progress. Disable it with `QEMU_WASM_ASC_READY_HACK=0 make build-qemu` when comparing against unmodified ASC behavior.
- The previous VIA1 interrupt-polling checkpoint at `PC=0x40809bca` is no longer the active blocker. Recent runs reach PRAM/ADB activity and then spend a long time in the Quadra ROM checksum loop around `PC=0x40847a6e`.
- While running, the in-app QEMU renderer uses roughly one full core. Pause with `make hmp-stop` before screenshots, navigation, browser reloads, or long inspection.
- The control worker ignores commands whose `issuedAt` timestamp predates the current VM start. This prevents stale `cont` commands in ignored `public/control.local.json` from replaying into a fresh paused launch.
- The temporary `pthread entry ptr=...` diagnostic was removed from the generated runtime patch; if it appears again, a stale `out.js` is being served.
- `qemu-lazy` starts the current growable-memory runtime and mounts the A/UX/JAG
  disk images as lazy files. Current headed runs can reach the A/UX login; the
  remaining work is making that path fast, smooth, and boringly repeatable.
- The browser shell focuses the SDL canvas, captures keyboard state, supports pointer lock/fullscreen, and keeps host page events from leaking while the emulator is focused.
- The initial browser failures are fixed: stale artifact 404s are avoided with `Cache-Control: no-store`, the missing `PTY.onSignal` shim is provided, `/tmp` and `/var/tmp` are created before QEMU startup, and pthread entry dispatch now calls the wasm table entry exactly once.
- The old full-preload generated bundle under `public/qemu/` was removed locally to save about 2 GB of disk. `make package-local` can regenerate it, but `package-smoke` and `package-lazy` are the preferred active paths.

## Current repo inventory

The workspace was empty apart from `.git` at the start of this pass. I found no existing QEMU build scripts, A/UX disk or ROM references, Dialtone source, m68k launch configs, or browser/WASM scaffolding in this checkout.

That means this prototype is deliberately isolated under `browser-qemu/` and does not alter any desktop QEMU workflow. ROMs, disks, packaged data files, vendored QEMU trees, and build outputs are ignored by git.

## Local A/UX runtime inventory

The known-good desktop QEMU assets were found outside the repo in `~/aux_qemu_local/`:

```text
Quadra800.ROM       Quadra 800 ROM/BIOS
AUX3.img            A/UX 3.1.1 raw disk image with Apple_UNIX_SVR2 root/usr and swap
JAG.img             secondary Apple/HFS raw disk image
pram-aux.img        512-byte PRAM image
qemu-system-m68k    local desktop QEMU 9.0.50 binary
start2.sh           graphical Cocoa/vmnet launch script
start3-slirp.sh     headless slirp launch script
```

Those files are intentionally not copied into git. The packaging scripts copy or hard-link them only into ignored local build/public output directories.

## Upstream findings

- QEMU upstream documents `m68k` as supporting both system and user emulation. Source: https://qemu-project.gitlab.io/qemu/about/emulation.html
- Upstream `q800` exists and wires the Quadra ethernet path through `dp8393x` / `dp83932`, with an Apple MAC prefix. Source: https://gitlab.com/qemu-project/qemu/-/blob/master/hw/m68k/q800.c
- The inspected `ktock/qemu-wasm` fork is a patched browser-oriented QEMU. It builds with Emscripten, uses pthreads, asyncify, a forced filesystem, and a Wasm TCG backend. Source: https://github.com/ktock/qemu-wasm
- The inspected `ktock/qemu-wasm` commit was `0ef7b4e2814b231705d8371dd7997f5b72e70baf`. It includes `configs/devices/m68k-softmmu/default.mak`, `CONFIG_Q800=y`, `CONFIG_MACFB`, and `CONFIG_DP8393X` through q800 Kconfig selection.
- The inspected QEMU upstream commit was `cc329c491768b2d91eb0b0984f3baa0bf805776d`. Upstream has Emscripten-specific support, but current master expects `--cpu=wasm64` for system emulators and requires `--enable-tcg-interpreter` on WebAssembly hosts. That path is slower TCI and not the same as the patched `qemu-wasm` wasm32 TCG backend.
- Emscripten pthread builds require browser cross-origin isolation headers. Source: https://emscripten.org/docs/porting/pthreads.html

## Feasibility read

`qemu-system-m68k` / `m68k-softmmu` is feasible enough for this prototype track: the patched `ktock/qemu-wasm` fork configured, compiled, and linked a wasm32 `qemu-system-m68k` locally after prefetching Meson wrap dependencies.

The highest-risk items are now boot progress, persistence, and networking rather than basic target availability:

- Display/input: the current prototype uses QEMU's SDL display frontend through Emscripten SDL2. The remaining display risk is proving the live q800/MACFB boot screen and adding instrumentation that browser automation can read reliably.
- Assets: A/UX disk and Quadra ROM assets must be provided locally and either packaged into Emscripten FS or exposed through a persistent browser disk backend. They must not be committed.
- Performance: upstream TCI-on-wasm64 may work eventually but is expected to be slow. The patched wasm32 TCG path in `qemu-wasm` is the better near-term proof-of-concept route.
- Networking: browser raw ethernet is impossible directly, so we should bridge frames over WebSocket rather than trying to use browser sockets as raw network devices.

## Prototype layout

- `public/index.html`, `public/styles.css`, `public/app.js`: static browser shell with a 1152x870 framebuffer canvas, keyboard capture, pointer-lock mouse capture, disk/ROM file pickers, RAM-size control, serial/debug log, ROM-loop diagnostics, and WebSocket network controls.
- `scripts/build-qemu-m68k-wasm.sh`: fetches the inspected `qemu-wasm` fork into `vendor/`, prefetches required Meson wrap projects, and runs a Docker/Emscripten build of `qemu-system-m68k`.
- `scripts/package-aux-assets.sh`: stages local ROM/disk paths into ignored build directories and uses Emscripten `file_packager.py` inside the build container.
- `scripts/package-local-aux-qemu.sh`: convenience wrapper that packages `~/aux_qemu_local/Quadra800.ROM`, `AUX3.img`, `JAG.img`, and `pram-aux.img`.
- `scripts/package-lazy-aux-assets.sh`: packages ROM/PRAM into a small preload bundle and hard-links or clone-copies large disk images into ignored `public/qemu-lazy/` for range-backed lazy reads.
- `scripts/package-smoke-rom.sh`: packages the small ROM/PRAM-only q800 smoke runtime.
- `scripts/sync-qemu-runtime.sh`: copies the rebuilt JS/Wasm runtime into ignored `public/qemu/`, `public/qemu-smoke/`, and `public/qemu-lazy/` without repackaging assets.
- `scripts/patch-qemu-out-js-lazyfile.mjs`: patches generated Emscripten `out.js` so `FS.createLazyFile` can use synchronous range reads on the browser main thread for this prototype.
- `scripts/smoke-headless-browser.mjs`: launches a temporary headless Chrome through CDP, waits for the browser QEMU runtime to initialize paused, optionally runs the HMP ROM-progress probe, captures range stats/browser logs, and exits cleanly.
- `scripts/probe-browser-rom-progress.mjs --continuous-log`: lets the guest run without recurring HMP stops while polling `/__browser-log.json` and `/__range-stats.json`, then performs one final HMP stop/status/register/block inspection. This isolates the cost/benefit of the current stop/sample/continue cadence.
- `scripts/patches/qemu-wasm-via-t2-one-shot.patch`: browser-only VIA Timer 2 one-shot experiment for the q800 ROM timing path. It is enabled by default in `make build-qemu-balanced` and can be disabled with `make build-qemu-balanced-no-via-t2-hack`.
- `scripts/patches/qemu-wasm-esp-pdma-fifo-capacity.patch`: opt-in ESP pseudo-DMA throughput experiment. The default internal FIFO remains 16 bytes; setting `QEMU_WASM_ESP_PDMA_FIFO_CAPACITY=512` via `make build-qemu-balanced-esp-pdma-fifo512` allocates a larger internal FIFO and clamps `ESP_RFLAGS` to 16 for the guest.
- `scripts/serve_with_headers.py`: tiny local static server that adds the COOP/COEP/CORP headers needed by Emscripten pthreads.
- `/__exists.json`: local dev-server endpoint used by the browser shell for bundle availability checks without producing expected 404 console noise.
- `public/qemu*/.gitkeep`: placeholders for generated `out.js`, `.wasm`, `.worker.js`, `.data`, `load.js`, `module.js`, and ignored disk artifacts.

## Build attempt

Prerequisites:

- Docker
- make
- enough disk and memory for an Emscripten QEMU build

Fetch only:

```sh
cd browser-qemu
make fetch
```

Attempt the patched QEMU-WASM m68k build:

```sh
cd browser-qemu
make build-qemu
```

The build script currently configures:

```sh
/qemu/configure \
  --static \
  --target-list=m68k-softmmu \
  --cpu=wasm32 \
  --cross-prefix= \
  --without-default-features \
  --enable-system \
  --enable-sdl \
  --disable-sdl-image \
  --disable-opengl \
  --with-coroutine=fiber
```

It then builds:

```sh
emmake make qemu-system-m68k
```

The script intentionally uses the patched `ktock/qemu-wasm` fork first. A later track can test upstream QEMU with `--cpu=wasm64 --wasm64-32bit-address-limit --enable-tcg-interpreter`, but that is likely a slower validation path.

Local result: `make build-qemu` succeeded and produced ignored artifacts in `build/qemu/`:

```text
out.js
qemu-system-m68k.wasm
qemu-system-m68k.worker.js
```

Build notes:

- SDL2 is enabled through Emscripten's SDL2 port with `-sUSE_SDL=2`. The local configure summary reports `SDL support: YES`, `SDL image support: NO`, and `OpenGL support: NO`.
- The script reuses the existing Docker image when present. Set `FORCE_DOCKER_BUILD=1` only when the build container itself needs to be rebuilt.
- The build is intentionally throttled for this machine: if `JOBS` is not set it caps at 4, and `DOCKER_CPUS` defaults to the selected job count. For a quieter run, use `JOBS=2 DOCKER_CPUS=2 make build-qemu`.
- The first local build attempt reached the Docker dependency stage and failed before QEMU configure because the pinned `qemu-wasm` Dockerfile fetches `https://zlib.net/zlib-1.3.1.tar.xz`, which now returns 404. The script applies a local, generated-Dockerfile workaround to use `https://zlib.net/fossils/zlib-1.3.1.tar.gz` with gzip extraction. The vendored tree is not modified.
- QEMU configure initially failed when Meson tried to download `keycodemapdb`, then `berkeley-softfloat-3`, then `berkeley-testfloat-3` into the read-only mounted source tree. The script now prefetches those pinned wrap repos into `vendor/qemu-wasm/subprojects/` and overlays QEMU's `subprojects/packagefiles/` Meson glue where required.
- The successful build still emits many Emscripten warnings about link-only settings being present during compile actions. These were non-fatal.
- The generated `out.js` is patched after build so `FS.createLazyFile` can be used from the main browser thread. This is a prototype-only workaround: it relies on synchronous range XHR and will freeze the JS thread during chunk reads. It lets us avoid a 2.4 GB preload while we design the proper persistent disk backend.
- The generated `out.js` is also patched with a minimal PTY shim and a direct pthread entry trampoline. This avoids the `PTY.onSignal` crash and avoids the duplicate QEMU initialization that happened when probing multiple `dynCall_*` signatures.
- The build script applies a local source patch to `util/qemu-config.c`, increasing `vm_config_groups` to 256 and `drive_config_groups` to 32. Without this, the wasm startup path aborts while registering QEMU option groups before q800 startup.
- The build script also patches `tcg/wasm32.c`/`tcg/wasm32.h` to initialize wasm32 TCG JS state in any executing pthread, disable dynamic mini-WASM TB compilation by default, and periodically pump queued pthread calls while QEMU is busy in the fallback execution path.
- `make build-qemu-balanced-dyn-tb` lowers `WASM32_INSTANTIATE_NUM` to `1500` to re-enable qemu-wasm dynamic mini-WASM TB compilation for diagnostics. This path currently reaches guest execution but double-faults early, so do not use it as the normal served runtime.
- `make build-qemu-balanced-dyn-tb-pc-trace` keeps the fpcast dynamic-TB setup but enables the local m68k PC trace patch so the first bad transition into `PC=0x4080010e` can be compared against the fallback runtime.
- `make build-qemu-balanced-dyn-tb-exc-trace` adds m68k exception/MMU-frame tracing on top of the PC trace. It confirmed the dynamic failure path: instruction fetch fault at `PC=0x4080010e`, followed by a fault on the first 68040 access-frame stack write to `0x0017fffc`.
- `QEMU_WASM_EMULATE_FUNCTION_POINTER_CASTS=1` is the default and currently required. The build script passes `QEMU_WASM_DYNAMIC_TB_START_ABI=fpcast` into the generated-`out.js` patcher so dynamic mini-WASM TB callbacks are registered with the signature Emscripten's fpcast shim expects.
- `make build-qemu-balanced-dyn-tb-no-fpcast` is a negative-control target. It sets `QEMU_WASM_EMULATE_FUNCTION_POINTER_CASTS=0` and `QEMU_WASM_DYNAMIC_TB_START_ABI=ii`; browser smoke testing shows this fails in QEMU device init at `sysbus_connect_irq`, before the m68k guest starts.
- `QEMU_WASM_THREAD_YIELD=1` adds an experimental `emscripten_thread_sleep(0)` to each fallback TCG queue-pump interval. `make build-qemu-responsive` enables it with `WASM32_QUEUE_PUMP_INTERVAL=32` for the next long ROM-loop responsiveness test.
- `QEMU_WASM_TOTAL_MEMORY_MB=768` lowers the generated runtime's fixed shared wasm heap but currently aborts OOM during startup. `QEMU_WASM_TOTAL_MEMORY_MB=1280` is the next balanced candidate; the default remains 2300 MB for compatibility with the earlier heavier profile.
- The build script also patches `hw/audio/asc.c` behind `C89_BROWSER_QEMU_ASC_READY_HACK`, enabled by default for browser builds. It synthesizes ASC/EASC FIFO-ready bits on `ASC_FIFOIRQ` reads so the q800 ROM is not blocked by a muted/no-audio browser runtime. The first draft only covered `ASC_TYPE_ASC`; q800 defaults to Enhanced ASC, so the shim must apply to both classic ASC and EASC.

## Asset packaging

Provide local paths through environment variables. Nothing is committed.

```sh
cd browser-qemu
AUX_ROM=/path/to/Quadra800.rom \
AUX_DISK=/path/to/aux-3.1.1-disk.img \
make package
```

Optional:

```sh
AUX_PRAM=/path/to/pram.img
AUX_JAG_DISK=/path/to/JAG.img
AUX_DISK2=/path/to/second-disk.img
AUX_CDROM=/path/to/install.iso
```

Generated browser artifacts are copied into `public/qemu/`, which is ignored except for `.gitkeep`.

For the local desktop stash found on this machine:

```sh
cd browser-qemu
make package-local
```

This uses:

```text
~/aux_qemu_local/Quadra800.ROM
~/aux_qemu_local/AUX3.img
~/aux_qemu_local/JAG.img
~/aux_qemu_local/pram-aux.img
```

Packaging writes a generated `public/qemu/module.js` with the matching q800 launch arguments. The script prefers hard links or APFS clone copies for staging so the 2.5 GB of local disk images are not duplicated before Emscripten writes `qemu-system-m68k.data`.

Local result: `make package-local` succeeded and produced ignored artifacts in `public/qemu/`:

```text
out.js
qemu-system-m68k.wasm
qemu-system-m68k.worker.js
qemu-system-m68k.data
load.js
module.js
```

Emscripten warned that the packaged data bundle is about 2416 MB. That is acceptable for this first local feasibility bundle, but the long-term browser path should move disk images to IndexedDB or user-selected persistent storage instead of preloading multi-GB disks into the startup package.

## Lazy disk packaging

The preferred local full-A/UX attempt is now:

```sh
cd browser-qemu
make package-lazy
make serve
```

This uses:

```text
~/aux_qemu_local/Quadra800.ROM
~/aux_qemu_local/AUX3.img
~/aux_qemu_local/JAG.img
~/aux_qemu_local/pram-aux.img
```

`package-lazy` writes ignored artifacts into `public/qemu-lazy/`:

```text
out.js
qemu-system-m68k.wasm
qemu-system-m68k.worker.js
qemu-system-m68k.data     small ROM/PRAM preload
load.js
module.js
aux-3.1.1-disk.img        hard link or clone copy
jag-disk.img              hard link or clone copy
```

The generated launch uses `-snapshot` and per-drive `snapshot=on` so the lazy disk files can be read-only. This is enough for a boot probe. Persistent writes need a later OPFS/IDBFS/custom block backend.

Local server verification:

```text
HEAD /qemu-lazy/aux-3.1.1-disk.img -> Accept-Ranges: bytes
GET  /qemu-lazy/aux-3.1.1-disk.img Range: bytes=0-15 -> 206 Partial Content
```

Browser runtime verification now gets through QEMU block open without the old `qemu_aio_coroutine_enter` abort. The local server sees initial range reads from both lazy disk images, but later A/UX boot reads have not appeared because the guest has not reached disk boot yet.

## Browser shell and display/input

Serve locally with isolation headers:

```sh
cd browser-qemu
make serve
```

Then open:

```text
http://127.0.0.1:8088/
```

The shell creates the host surface we need: canvas, asset pickers, keyboard/mouse capture, serial/debug output, and a WebSocket control for the network bridge.

The shell now launches the generated runtimes:

- `Start smoke`: `public/qemu-smoke/`, ROM/PRAM-only q800 sanity check.
- `Start lazy`: `public/qemu-lazy/`, A/UX/JAG disks as range-backed lazy files.
- `Start lazy paused`: `public/qemu-lazy/` with `-S`, useful for HMP/debug work before letting the guest CPU run.
- `Start`: `public/qemu/`, original full `.data` preload.

Display and input bridge shape:

- QEMU uses `-display sdl,gl=off,show-cursor=off`; the page supplies the host-side
  Classic Mac cursor.
- Emscripten SDL renders to `Module.canvas`, which is the page's `#canvas`.
- Browser keyboard/mouse events are translated in `public/shared-input.js`,
  written into wasm memory, and drained by `ui/wasminput.c` into the q800 ADB
  keyboard/mouse devices.
- The shell keeps focus on the canvas, prevents host page defaults while captured/running, and provides pointer-lock/fullscreen controls.
- Browser-side `sendKey`/`sendMouse` shims remain as future hooks, but the active
  bridge is shared ADB input, not SDL or monitor text injection.
- Debug input can now bypass SDL by writing to the Emscripten PTY that backs `-monitor stdio`. The HMP buttons and terminal helper enqueue plain HMP commands such as `sendkey a`.
- Terminal-driven HMP uses `public/control-worker.js`, which polls ignored `public/control.local.json` from a Web Worker and writes bytes into a shared PTY ring. The generated runtime patch exposes the PTY wait atomic index so the worker can wake QEMU after queuing bytes without relying on page timers.
- The generated launch modules intentionally use `-monitor stdio` and `-serial none` for now. A/UX has not provided useful browser serial output yet, and the dedicated monitor avoids serial/HMP mux state bugs.
- The page publishes a hidden JSON probe in `#probeState` with heartbeat, event counts, serial tail, canvas metrics, and PTY queued-byte count so browser automation can inspect liveness without relying on page globals. `scripts/smoke-headless-browser.mjs` now includes this probe snapshot in its JSON output.
- The probe also includes `framebuffer`: sampled canvas dimensions, alpha/nonblack counts, checksum, and change count. The visible Input panel mirrors this as a short framebuffer metric.
- The visible Diagnostics panel mirrors the useful `#probeState` fields and has a `Probe snapshot` button for manual checks while the browser automation pipe is unavailable.
- To bypass browser/CDP click/key dispatch entirely during debugging, the worker polls ignored `public/control.local.json` while QEMU is running. Use `make hmp-help`, `make hmp-status`, `make hmp-cont`, `make hmp-stop`, `make hmp-pulse-start INTERVAL=30`, `make hmp-pulse-stop`, or `make hmp-key KEY=a` to queue commands from the terminal.
- For manual browser use, prefer the page's timed run buttons over `HMP Cont` until the ROM checksum loop is understood. Timed runs schedule their stop in the worker, so they can recover even when the main page thread is busy.
- `public/control.local.json` stores a command queue. Multiple terminal commands issued back-to-back are preserved and processed by id order on the next browser poll.
- `make hmp-clear` removes the local queue file before a fresh browser run.
- The terminal helper only queues commands; QEMU responses appear in the browser Serial panel, not in the terminal.
- The terminal helper still accepts `--stay-monitor` for compatibility, but with `-monitor stdio` there is no serial mux to toggle.

Control-file examples:

```sh
make hmp-help
make hmp-status
make hmp-cont
make hmp-stop
make hmp-run-for DURATION=5
make hmp-pulse-start INTERVAL=30
make hmp-pulse-stop
make hmp-step DURATION=5
make hmp-rom-probe DURATION=5
make hmp CMD='x /24i 0x40809bc0'
node ./scripts/send-browser-control.mjs hmp 'info block' --stay-monitor
make hmp-key KEY=a
make hmp-key KEY=ret
node ./scripts/send-browser-control.mjs hmp 'info registers' --stay-monitor
```

Current input/display status:

- The SDL canvas attaches, QEMU/HMP are controllable, and the framebuffer is proven alive: paused prelaunch clears to black, then after `make hmp-cont` QEMU mode-sets the canvas back to 1152x870 and the framebuffer checksum changes.
- The display surface was previously distorted by the host page's `max-height` rule. The canvas CSS now preserves the Quadra 1152x870 aspect ratio instead of squashing the framebuffer vertically.
- `res=800x600` requests the startup display mode, but the browser now follows
  the actual guest framebuffer once QEMU publishes it. That lets A/UX's 640x480
  login framebuffer render as a true 640x480 canvas instead of a clipped image
  inside an 800x600 shell. Both the shared input bridge and HMP fallback map
  mouse coordinates through the active guest content box.
- The active browser input path is shared ADB input. Early headed verification
  shows mouse and keyboard counters moving through `sharedInput`, with `KeyX`
  reaching QEMU as ADB `0x07`; HMP/hybrid/SDL modes remain diagnostic-only.
  `#probeState.sharedInput` includes the latest absolute `absX/absY`, guest
  dimensions, frontend button mask, button-release hold time, and backend
  mouse/key/button counters. Its nested `pointer` object captures the latest
  browser client coordinate, content box, scale, and guest coordinate for
  cursor/click drift reports.
- Normal non-modifier keys are emitted as immediate ADB down/up taps. This avoids
  a delayed browser `keyup` turning into guest key repeat during headed UI stalls.
- `make smoke-shared-input` is the fast guardrail for this path. It launches a
  temporary headless Chrome against paused `qemu-lazy`, runs the page's
  structured shared-input self-test, verifies the 800x600 shared geometry,
  confirms a center pointer press/release reaches QEMU with both button edges,
  checks both the browser key-tap path and `KeyX` as ADB `0x07`, and verifies
  the missing-keyup auto-release guard for headed typing stalls.
- The page's `Yield 2s` button and `make hmp-yield-pulse-start INTERVAL=2` run the current interactive cadence: every two seconds the control worker queues only `stop; cont`, giving Chrome/QEMU a scheduling window with minimal HMP output. The `Pulse 30s` button and `make hmp-sample-pulse-start INTERVAL=30` keep the diagnostic stop/status/register/block/continue cadence. Do not switch to full pulse-off for normal interaction yet; pair pulse-off with `make hmp-stop` only before screenshots or page inspection.
- `make browser-interactive` and `make browser-shared-input` add `ptyMin=2&ptyIdle=16`, lowering the generated runtime's bounded monitor wait for headed interaction. Use `ptyMin=8&ptyIdle=32` for the conservative default profile, and compare boot/input behavior before changing the checked-in launcher again.
- The diagnostic `Input self-test` button and `?inputSelfTest=1` path exercise canvas focus, keyboard counters, mouse counters, and worker-backed HMP input without letting the paused VM run.
- For quick manual probes, use the page's `ROM 5s probe` button or `make hmp-rom-probe DURATION=5` to collect status/register/block/disk/framebuffer evidence in one pass.
- The remaining blocker is quality rather than basic guest progress: A/UX can
  reach login in headed Chrome, networking has proven auxagent command execution,
  and the active work is cursor/click polish, headed responsiveness, long-session
  stability, and boot/cold-disk performance.
- Running guest CPU can saturate the in-app renderer while the ROM sits in a tight CPU loop. Keep `Pace CPU` checked for casual manual page work, but use `?pace=0` for serious ROM/SCSI progress probes; start paused and run `make hmp-stop` before screenshots/navigation.
- Heavy browser screenshot capture can still time out while the guest is running. Prefer `#probeState.framebuffer` while running, then pause with `make hmp-stop` before taking screenshots.
- The host cursor is instant CSS copied from the 68k_web approach. The served
  wasm now exports `TheCrsr`, suppresses Mac software cursor vectors in the
  68k_web style, and anchors absolute mouse input through low-memory
  `MTemp`/`RawMouse`/`Mouse` instead of stale ADB relative deltas. The next work
  is headed cursor/click validation and any remaining drift tuning.
- The browser shell now includes a generic HMP command box plus `make hmp CMD="..."`; use those for disassembly and memory probes instead of adding temporary buttons.

## Known-Good Desktop A/UX Launch Shape

Imported from `~/aux_qemu_local/start2.sh`:

```sh
./qemu-system-m68k \
  -M q800 \
  -m 128 \
  -bios Quadra800.rom \
  -display cocoa \
  -g 1152x870x8 \
  -audio none \
  -nic vmnet-bridged,model=dp83932,mac=08:00:07:12:34:56,ifname=en0 \
  -drive file=pram-aux.img,format=raw,if=mtd,file.locking=off \
  -device scsi-hd,scsi-id=1,drive=hd2 \
  -drive file=AUX3.img,media=disk,format=raw,if=none,id=hd2,file.locking=off \
  -device scsi-hd,scsi-id=0,drive=hd3 \
  -drive file=JAG.img,media=disk,format=raw,if=none,id=hd3,file.locking=off
```

There is also a headless slirp variant in `start3-slirp.sh`:

```sh
-display none
-nic user,model=dp83932,mac=08:00:07:12:34:56,net=10.1.1.0/24,host=10.1.1.2,hostfwd=tcp::2323-10.1.1.20:23,hostfwd=tcp::2121-10.1.1.20:21
```

The browser POC currently emits a generated `public/qemu/module.js` that mirrors the storage/display parts and disables networking with `-nic none` until the WebSocket ethernet backend is wired. The next networking CLI shape should be equivalent to:

```sh
-nic socket,model=dp83932,mac=08:00:07:12:34:56,connect=localhost:8888
```

or the qemu-wasm/container2wasm delegated WebSocket equivalent if we reuse that backend path.

## Dialtone ethernet bridge design

North star path:

1. q800 guest emits ethernet frames through the emulated SONIC/dp8393x NIC.
2. QEMU net client hands those frames to a browser-facing net backend.
3. The browser/WASM layer serializes each ethernet frame as a binary WebSocket message.
4. Dialtone's Go proxy receives frames over WebSocket.
5. Dialtone bridges, routes, NATs, filters, or otherwise handles the frames using its existing ethernet-frame architecture.
6. Return frames travel back over the same WebSocket.
7. Browser/WASM injects return frames into QEMU's net backend.

This aligns with `qemu-wasm`'s existing networking example, which supports delegating networking to an outside WebSocket daemon through container2wasm's `c2w-net`. Source: https://github.com/ktock/qemu-wasm/blob/master/examples/networking/README.md

For our project, Dialtone can replace the generic `c2w-net` daemon if it speaks a simple binary frame protocol:

```text
client -> proxy: raw ethernet frame bytes
proxy -> client: raw ethernet frame bytes
```

Add a small envelope only if multiple virtual ports, metadata, tracing, or flow-control are needed:

```json
{"type":"frame","port":"aux0","timestamp":0,"length":1514}
```

followed by a binary frame payload, or use a compact binary header.

## Immediate blockers

- Early disk boot is now the active blocker. The balanced 1280 MB runtime reaches HMP, display, input self-test, block attach, low-memory ROM/UI code, and confirmed ESP/SCSI READ commands, but it has not yet completed enough disk boot to show A/UX output.
- The FIFO512 pseudo-DMA experiment is tested and currently not sufficient. It improves first-SCSI timing by about one 30s sample interval and records one extra READ command in 600s, but still does not advance past the same target 1 sector set or trigger non-zero lazy disk ranges.
- A single uninterrupted `cont` does not behave like the working pulse cadence. The latest continuous-log run against the traced exit-pump runtime still ended at `PC=0x00006b0e`, `SR=0x2204` after 360s, while the 30s HMP stop/sample/continue path can reach ESP/SCSI in long runs. The next source-level blocker is likely in qemu-wasm fallback TCG/main-loop yielding, pthread queued-call pumping, runstate transitions, or PTY/control wake semantics, not in the browser canvas/input layer.
- Keep using the 1280 MB path with `make build-qemu-balanced-t2-esp-trace`, `make package-lazy`, and `?ram=16&heap=1280&pace=0` for instrumented disk progress probes. The script target below temporarily serves `build/qemu` and restores `qemu-lazy` to the stable smoke runtime afterward. Use the ESP+PC target only to regain ROM PC phase context after the faster ESP-only run moves to a new state.
- PTY-backed HMP commands drain into QEMU through the worker-backed `public/control.local.json` path; prefer `make hmp CMD="..."`, `make hmp-help`, `make hmp-status`, `make hmp-cont`, `make hmp-stop`, `make hmp-pulse-start INTERVAL=30`, `make hmp-pulse-stop`, and `make hmp-key KEY=a` over clicking the HMP buttons during automation.
- The lazy A/UX path proves live framebuffer output, disk attachment, and lazy disk range reads. Confirmed SCSI reads are still inside the opening 1 MiB HTTP range, so non-zero HTTP ranges are not expected until the guest asks for sectors outside that first cached chunk.
- The next success criterion is the browser matching native's post-target-1 transition: after target 1 sector `5`, it should complete the transfer and move to target 0 high-sector reads/writes. A non-zero lazy disk range read or visible A/UX boot/installer text would also count.
- The current hot ROM PCs are `0x40899706` (ESP/SCSI status poll), `0x408d1f6c` (ROM SCSI DMA/transfer path), `0x4088bc5e` after the 600s ESP-only sector-3 run, and `0x40803f54`/`0x4088bc5e` during the stable 30s-cadence sector-5 run. Compare these against native qemu-wasm and desktop QEMU to see whether the browser path is only slow or diverges in the later SCSI-manager path.
- The lazy disk path is read-only plus QEMU snapshot writes. Persistent writes need OPFS/IDBFS or a custom block backend rather than this sync-XHR lazy-file patch.
- Dynamic mini-WASM TB compilation remains disabled by default through `WASM32_INSTANTIATE_NUM=2147483647`. The helper-import/signature bridge is now far enough to execute, but the fpcast dynamic build takes an instruction-fetch access fault at `PC=0x4080010e` and then double-faults when the first access-frame stack write to `0x0017fffc` faults. That correctness bug must be solved before the fast path is safe to serve.
- We need a QEMU net backend interface that can call JS/WebSocket directly or adapt the existing Emscripten socket bridge to Dialtone's frame protocol.
- We need to replace `-nic none` with a browser/WebSocket ethernet backend that can hand raw frames to Dialtone.

## Smallest next step

Use the headless smoke path first; it avoids wedging the in-app browser while still exercising the same browser runtime:

- `make smoke-headless-browser DURATION=20` proves paused startup, HMP control, framebuffer activity through `probeState.framebuffer`, ROM PC phase, and lazy range stats.
- `make smoke-headless-scsi DURATION=20` repeats the probe with narrow ESP/SCSI trace enabled against the currently served runtime.
- `make smoke-headless-via-series DURATION=120 INTERVAL=30` samples browser PC/register state plus HMP `info via` snapshots without SCSI trace noise.
- `make smoke-headless-via-scsi-series DURATION=120 INTERVAL=30` adds narrow SCSI trace patterns to the VIA snapshots and is the current first check after any timer/run-loop experiment.
- `make refresh-stable-runtime` is the stable packaging path after a QEMU rebuild. It rebuilds the current non-ESP balanced runtime, then refreshes both `public/qemu-smoke` and `public/qemu-lazy`.
- `make smoke-headless-scsi-series DURATION=600 INTERVAL=30` is the current low-overhead milestone: it keeps the stable fallback runtime served, enables QEMU's narrow SCSI trace only, and uses the proven 30s stop/sample/continue cadence. Its output now includes target-aware `probe.scsiSummary`; the same fresh runtime with `INTERVAL=60` did not reach SCSI in 600s.
- `make smoke-headless-scsi-exitpump-continuous-long DURATION=360 INTERVAL=30` repeats the completed no-recurring-stop comparison against the temporary `build/qemu` traced exit-pump runtime, then restores `qemu-lazy` on exit. The June 11 result ended at `PC=0x00006b0e` with no SCSI trace, so use it as a regression check after source-level scheduling changes rather than as a next hypothesis.
- `make build-qemu-balanced-esp-pdma-fifo512 && make package-lazy`, then `make smoke-headless-scsi-series DURATION=600 INTERVAL=30`, is now a completed throughput comparison rather than the next step. It reached SCSI earlier but did not pass target 1 sector `5`, so larger pseudo-DMA prefetching alone is not enough.
- `make build-qemu-balanced-t2-esp-trace`, then `make smoke-headless-scsi-esp-trace-long DURATION=600 INTERVAL=30`, remains the deeper ESP diagnostic test: it temporarily serves the instrumented `build/qemu` runtime, runs the no-icount ESP/SCSI probe without m68k PC tracing, and restores `qemu-lazy` to `qemu-smoke` on exit.
- The ESP+PC milestone run is still available as `make build-qemu-balanced-t2-esp-pc-trace`, then `make smoke-headless-scsi-pc-trace-long DURATION=360 INTERVAL=30`, but the June 11, 2026 light-trace result shows it can spend nearly the full window before the first sector-0 data-ready transition.
- The exit-pump trace experiment is wired as `make build-qemu-balanced-esp-pdma-fifo512-exitpump-esp-pc-trace EXIT_INTERVAL=1`, followed by `make smoke-headless-via-scsi-exitpump-pc-trace-long DURATION=480 INTERVAL=60`. It is currently a negative result: the bare `cpu_exit(current_cpu)` pump does not mimic the useful part of the external 30s stop/sample/continue cadence.
- The tempting next source patch is to make the wasm32 TCI loop return `TB_EXIT_REQUESTED` when the pump sets `cpu->exit_request`, but be careful: `tcg_qemu_tb_exec()` returns a `TranslationBlock *` plus low-bit exit code, while the wasm32 loop's `ctx.tb_ptr` is the translated code/blob pointer. Do not synthesize that return with `ctx.tb_ptr`; first identify the correct `TranslationBlock *` or add a safe chain-boundary hook that lets `cpu_exec` service the request normally.
- In the ESP run, inspect the `espTrace` summary around `select-enter`, `select-hit`, `get-cmd`, `message-identify`, `command-phase-cdb`, `command-phase-req`, `transfer-data-enter`, `transfer-data-defer-ti`, `handle-ti-after-dma`, `read RINTR`, and `dma-done`. The compact ESP trace now includes `busid`, `sel`, `dev`, `lun`, `req`, and `req_lun`, so the next diagnostic should identify whether target 0 is never selected, selected but no SCSI request is created, or selected/requested but not completed.
- `scripts/probe-browser-rom-progress.mjs` now includes a compact `espTrace` summary in its JSON output. Use that instead of manually scraping `/__browser-log.json` for `[c89-esp]` lines.
- Keep the active page on the fallback profile with `make build-qemu-balanced && make sync-runtime`. Only sync a dynamic-TB build when intentionally testing the `DOUBLE MMU FAULT` path.
- For dynamic-TB work, compare fallback vs `make build-qemu-balanced-dyn-tb-exc-trace` around the transition from the ROM loop near `0x408820ba` into the bad `PC=0x4080010e` instruction fetch. The next useful trace is likely the translated TB exit/branch target and 68040 MMU lookup inputs, not more frontend instrumentation.
- For manual work, open `http://127.0.0.1:8088/?ram=16&heap=1280&pace=0&autostart=lazy-paused`, then use the page's `Pulse 30s` control or `make hmp-pulse-start INTERVAL=30` instead of relying on ad hoc clicks while the VM is hot. Use `make hmp-pulse-stop && make hmp-stop` before inspecting the page.
- Compare the browser SCSI sequence with desktop QEMU and host-native qemu-wasm: target 1 sector `0`, target 1 sector `64`, target 1 sectors `1..5`, then native's transition to target 0 sectors `96+`.
- If the ESP-only browser run stalls where native continues, compare the final `espTrace.lastByEvent` target/request fields against native's target-aware `scsiSummary`, then add only the next missing trace around the exact transition after target 1 sector `5`.
- Keep using `#probeState.framebuffer` and `/__range-stats.json` as the lightweight proof that display and lazy disk plumbing remain alive.
