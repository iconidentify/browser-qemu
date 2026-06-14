# browser-qemu: headed-testing handoff

This document hands off **headed-browser validation** to a second agent (Codex)
working with the user. The headless analysis side (boots, metrics, code) is
progressing well; the remaining unknowns can only be confirmed in a **real,
focused, normal browser tab** (not headless, not a CDP-attached/anti-throttle
launcher). Read the whole thing once, then run the tests in order and report
back the observations requested.

Repo: `~/Documents/c89summer/browser-qemu` (branch `main`).

## June 13 status update

Current state:

- TEST 1 has passed in normal headed Chrome with the growable-memory build:
  boot reaches the "Welcome to A/UX" login without the old frozen disk-stats
  symptom.
- The served runtime has been rebuilt/package-tested with Emscripten growable
  memory (`INITIAL_MEMORY=384MB`, `MAXIMUM_MEMORY=2048MB`). Use `heap=384` for
  manual sessions; the old `heap=1280` requirement is historical.
- The served runtime has also been rebuilt with the 68k_web-style shared ADB
  input bridge. Early headed verification confirms canvas mouse and keyboard
  events reach QEMU through `wasminput` (`sharedInput.backendMouse` and
  `sharedInput.backendKeys` advance; `KeyX` maps to ADB `0x07`).
- The served runtime now has the display-decouple patch applied in the
  reproducible build pipeline (`scripts/patch-qemu-out-js-display.mjs`).
  Verify with `#probeState.renderer.framesRendered > 0`; if it stays `0`, the
  browser is still on stock SDL blits.
- The `res=` URL parameter requests the startup display mode, but the browser
  now adopts the first real guest framebuffer size it sees. This prevents a
  stale 800x600 shell from wrapping A/UX's 640x480 login framebuffer. The canvas
  visual frame is drawn with a shadow ring instead of a DOM border, so
  Emscripten/SDL sees the exact guest pixel plane; `#probeState.canvas` reports
  client and content-box sizes for verification.
- The served `out.js` has a tunable bounded PTY wait. Defaults remain
  conservative (`ptyMin=8`, `ptyIdle=32`), while the headed interactive profile
  uses `ptyMin=2&ptyIdle=16` for lower input latency.
- The served wasm now includes the 68k_web-style cursor/click-alignment patch:
  QEMU exports `TheCrsr`, suppresses the Mac software cursor draw path, and
  anchors absolute mouse input through the Classic Mac low-memory mouse globals
  while forwarding bounded ADB-relative deltas for the A/UX kernel/login path.
  A real headed retest still needs to judge remaining drift/click feel.
- The browser shell now exposes queued guest text:
  `make hmp-text TEXT=root`, `make hmp-key KEY=tab`,
  `make hmp-text TEXT=31337leet`, `make hmp-key KEY=ret`.
- Networking is live, not just planned: with Dialtone listening on
  `ws://127.0.0.1:8080/ethernet`, a headed `?net=1&netZone=codex-net` boot
  connected the wasmbridge NIC, `scripts/probe-guest-net.mjs --zone codex-net`
  got ARP/ICMP/TCP replies from A/UX at `10.1.1.20`, and
  `scripts/auxctl-zone.mjs --zone codex-net exec 'uname -a; id'` ran in the
  guest as root.
- Remaining high-value work: reduce headed boot/cold-disk churn, prove long
  headed sessions with `heap=384`, finish headed cursor/click validation, and
  continue CPU/perf tuning.

## June 14 checkpoint

- A headed post-login watcher now exists: `make watch-login-session`
  (`scripts/watch-login-session.mjs`). It starts stock headed Chrome, waits at
  least 90 seconds for the real A/UX login framebuffer to settle, clicks the
  Name field, types `root`, tabs, types `31337leet`, presses Return, captures
  screenshots, and watches page responsiveness after login.
- The manual Chrome burn was not reproduced by automation: a real login +
  three-minute post-login watch stayed responsive (`maxEvalMs=2`, no long
  tasks). The run did expose memory pressure: the old default
  `tcg,tb-size=500` grew the WASM heap to about 1188 MB by login and the disk
  worker cache climbed toward 200 MB.
- New default browser launches lower avoidable memory pressure:
  `tb=128` (`-accel tcg,tb-size=128`) and `diskCacheMb=128`. A valid real-login
  comparison reached login around 123 s, stayed responsive, and peaked at about
  881 MB WASM heap plus 128 MB disk cache. Use `&tb=500&diskCacheMb=384` only
  when intentionally comparing against the old profile.
- The page now emits periodic `breadcrumb` lines to the server-mirrored browser
  log with UI lag, frame generation, memory, disk, and input counters. If the
  visible tab is too busy to click Copy log, run `make browser-log` after
  closing or while it is still open.

---

## Codex: start here

You are taking over for a stretch. Suggested flow:

1. **Read sections 0-2** (what this is, the architecture problem, what just
   changed). Then **run TEST 1** in section 4 — does the `:8088` build still
   freeze in a normal tab? That single yes/no (section 9) gates everything else.
2. **If it no longer freezes:** move to the optimization goal — work TEST 2/3
   (input + pauses), then the **OOM rebuild** (section 5, item 1; it is prepared
   and one command), then CPU perf. Measure changes with `scripts/bench-boot.mjs`.
3. **If it still freezes:** capture the serial log (Copy log button) + DevTools
   console and hunt the next main-thread coupling. Start by comparing the
   conservative `ptyMin=8&ptyIdle=32` profile against the interactive
   `ptyMin=2&ptyIdle=16` profile so we know whether lower latency changed the
   freeze surface.
4. Build/runtime source edits must persist through `scripts/` patches, never
   the vendor tree (section 8). If QEMU C patches changed, rebuild/package
   before testing their runtime effect.
5. **Golden rule:** verify functional changes with a headless boot
   (`make watch-browser-boot` or `bench-boot.mjs`) AND confirm UX/stability in a
   real **normal, focused tab** — headless and `make browser` hide the throttling
   bugs (section 8). Do not run headless boots while a human is testing headed
   (CPU contention). When you change `public/qemu-lazy/out.js` via a patch script,
   re-apply it to the live file too (it is the served copy).

---

## 0. What this project is + the goal

browser-qemu runs **A/UX 3.1.1 (System 7-era Unix) on an emulated Quadra 800**
via **QEMU m68k compiled to WebAssembly**, in a browser tab. There are two
front-ends sharing the same packaged runtime in `public/qemu-lazy/`:

- **`public/index.html` + `public/app.js`** — the original vanilla loader. This
  is the **full-featured, primary** path: working input, disk worker, auxagent,
  networking, serial console. Served at **`:8088`**. **Test this one.**
- **`web/`** — an imported React "computer-bezel" shell (a port of the sibling
  68k_web project) that drives the same QEMU runtime via a page-host adapter.
  Served at `:8090` with `?core=qemu`. Looks nicer but still missing input/disk
  wiring. **Secondary; not the focus of headed testing yet.**

**The standing goal (user's words):** make this QEMU-wasm experience *superior to
BasiliskII*: **mouse perfect, keyboard perfect, no long pauses, optimized hard,
and rock-solid in a normal browser tab.**

**The core problem we are chasing:** it works great **headless** and under the
anti-throttle launcher (`make browser`), but a **normal tab** has been
unreliable — intermittent insta-freezes, sluggishness, and an out-of-memory
crash on longer sessions. The user has logged into A/UX *and* AOL in a normal
tab once (sluggish), so it is not fundamentally broken — it is **unreliable**,
and we are removing the causes one by one.

---

## 1. The architectural insight (the "something big")

QEMU-wasm here is built with `-sPROXY_TO_PTHREAD=1 -sASYNCIFY=1`: the guest CPU
runs on a **worker pthread**, but SDL display/input/cursor and the monitor PTY
historically had to be serviced on the **page main thread**. A normal/background
tab **throttles the main thread**, so anything the QEMU pthread needs from it
stalls. **BasiliskII never has this problem because it runs entirely in a Worker
with zero main-thread dependency.** Matching its robustness means removing every
main-thread dependency from QEMU's critical path. Progress so far:

| Coupling | Status |
| --- | --- |
| Display blit (full-screen putImageData proxied every frame) | **DECOUPLED** — SDL blit writes a shared block; page renders on its own rAF |
| Guest disk reads (synchronous XHR on the main thread) | **MOVED OFF** — `public/disk-worker.js` services reads via a SAB worker |
| Monitor PTY idle wait (could park the loop forever) | **FIXED + TUNABLE** — see test 1 below |
| Cursor shape change (`toDataURL` proxied to main) | **ACTIVE** — page shows an instant host CSS cursor generated from guest `TheCrsr`; QEMU suppresses Mac software cursor drawing |
| Fixed 1280 MB wasm heap (commits 1.28 GB/tab) | **REBUILT** — growable-memory runtime is packaged in `public/qemu-lazy/` |

---

## 2. What has been changed this round

All verified with headless smoke/watch runs unless noted.

1. **PTY idle-wait freeze fix (the big one this round).**
   `scripts/patch-qemu-out-js-lazyfile.mjs` + live `public/qemu-lazy/out.js`.
   The QEMU main loop did `Atomics.wait(HEAP32, PTY_atomicIndex, -1, Infinity)`
   whenever the monitor idle-waited for stdin (`PTY_pollTimeout < 0`). That is an
   **unbounded park**: guest input does not wake that index, and the only waker
   is page-main-thread-armed (throttled in a normal tab). So the whole VM freezes
   (symptom: serial "disk worker stats" line stops advancing; "Uncaught unwind"
   log lines stop). **Fixed:** the idle wait is bounded and tunable through
   `ptyMin`/`ptyIdle`, so the loop always ticks, runs CPU/timers, and services
   input. Defaults are `8/32`; headed interactive runs now use `2/16`.

2. **Reverted an experimental disk readahead.** It boots headless but regressed
   the headed boot (hard stall ~2.4 MB into boot). `public/disk-worker.js` is
   back to the known-good simple read path.

3. **Serial log usability.** `public/index.html` + `public/app.js` +
   `public/styles.css`: added a **"Copy log"** button, and selecting text no
   longer gets wiped by incoming log lines (the renderer pauses while a selection
   is active in the serial pane). Use this to capture logs for reports.

4. **Default resolution 800x600.** `public/qemu-lazy/module.js` (and its
   generator). The emulated macfb only supports **640x480, 800x600, 1152x870** —
   **1024x768 is NOT a hardware mode** and cannot be set without adding it to
   `hw/display/macfb.c` + a wasm rebuild. Override per-session with `&res=1152x870`.

5. **Native canvas geometry and content-box input mapping.** `res=800x600`
   still requests the startup mode, but the browser switches to the first real
   guest framebuffer size. In headed A/UX login testing this changes the canvas
   from the requested 800x600 shell to the actual 640x480 framebuffer and keeps
   mouse/click coordinates in that same guest coordinate plane. The visual ring
   is CSS shadow, not a DOM border.

6. **Native cursor/click path packaged.** The served wasm includes the
   `wasminput` patch that exports guest cursor bytes, suppresses Mac software
   cursor drawing, writes absolute mouse coordinates to `MTemp`/`RawMouse`/`Mouse`,
   and forwards bounded browser deltas through ADB. The hybrid is intentional:
   ROM/Classic Mac cursor bookkeeping can follow low-memory points, while A/UX
   after kernel boot still needs real ADB-relative motion for the login/click
   target.

7. **Memory probe** added to the page's `#probeState` snapshot (`wasmMb`,
   `diskCacheMb`, `jsHeapMb`) for diagnostics.

---

## 3. How to run it (headed)

```sh
cd ~/Documents/c89summer/browser-qemu
make serve            # python server with COOP/COEP + range support on :8088
```

Then open, in a **normal browser tab you keep focused and visible**:

```
http://127.0.0.1:8088/?ram=128&heap=384&pace=1&input=shared&cursor=host&fps=8&res=800x600&autostart=lazy-pulse&pulseMode=yield&pulseMs=2000&ptyMin=2&ptyIdle=16
```

- `autostart=lazy-pulse&pulseMode=yield` starts QEMU paused, continues it, and
  then uses a lightweight worker-backed `stop; cont` cadence every 2s. This is
  the current headed default because full continuous guest CPU still pegs a
  browser renderer.
- Leave yield pulse running for login and X11 interaction. Use the heavier
  `pulseMode=sample` / `Pulse 30s` path only for diagnostics, and use pulse-off
  only together with `make hmp-stop` before screenshots or page inspection.
- `pace=1` is the current headed default because it adds `-icount
  shift=10,sleep=on`, keeping Chrome responsive enough for display/input work.
  The older `pace=0` route stays useful for headless/instrumented ROM/SCSI
  probes, but a normal headed tab can still grey-screen/freeze before the first
  pulse stop is serviced.
- `input=shared` is the active path: browser events are translated to Mac ADB
  codes in `public/shared-input.js`, written to wasm memory, and drained by a
  QEMU timer into the q800 ADB keyboard/mouse devices. `input=hmp`,
  `input=hybrid`, and `input=sdl` are diagnostic-only escape hatches.
  `#probeState.sharedInput` exposes the latest absolute pointer coordinate,
  frontend button mask, button-release hold time, and backend key/mouse/button
  counters for drift reports. `autoKeyReleases` increments when the bridge had
  to release a non-modifier key because the browser did not deliver keyup in
  time; watch that for `roooooot`-style headed typing stalls. The nested
  `pointer` object records the last browser client coordinate, content-box
  rectangle, scale, and resulting guest coordinate for cursor/click drift.
- `make smoke-shared-input` is the quick regression check before headed work:
  it starts paused `qemu-lazy` in a temp headless Chrome, runs the page's
  structured shared-input self-test, asserts exact 800x600 shared geometry,
  checks a center pointer press/release reaches QEMU with both button edges,
  confirms the backend saw a nonzero ADB mouse delta while absolute mode was
  active,
  verifies `KeyX` arrives as Mac ADB `0x07`, and confirms the missing-keyup
  auto-release guard is active.
- `cursor=host` uses the Classic Mac CSS cursor path copied from 68k_web. It is
  instant host-side feedback, and the served wasm now exports guest cursor bytes
  while suppressing the guest software cursor. The QEMU-side bridge now sends
  bounded ADB-relative mouse deltas in absolute mode too, which specifically
  targets the "cursor works before A/UX, then clicks in a corner at login"
  failure. Retest headed cursor drift/click alignment here.
- `fps=8` caps the page-side framebuffer loop. Use `fps=20` for smoother
  screen updates or `fps=0` only for display benchmarks; X11 can peg Chrome
  hard when uncapped.
- The Input panel now includes `UI lag`, and `#probeState.responsiveness`
  mirrors the same timer-drift data. During headed runs, spikes over 1000 ms are
  the signal that the page thread itself is stalling, separate from guest CPU or
  disk progress.
- Use `heap=384` with the current growable-memory build. Older fixed-memory
  packages required `heap=1280`; that note is historical.
- Default resolution is 800x600; append `&res=1152x870` for full size.
- Boot to the "Welcome to A/UX" login takes roughly **90-150 s** on a cold cache
  (it range-fetches the 2 GB disk on demand). The screen is black/grey for the
  first ~30 s — that is normal.

**Diagnostics while testing:**
- The on-page **Serial** panel mirrors the log; click **Copy log** to grab it.
- Or fetch the server-mirrored log directly:
  `curl -s http://127.0.0.1:8088/__browser-log.json | python3 -m json.tool`
- The browser **DevTools Console** shows uncaught errors (the benign
  `Uncaught unwind` is ASYNCIFY yielding — see test 1).
- "Frozen" looks like: the `disk worker stats:` line **stops advancing** for
  30 s+ and the screen never progresses.

---

## 4. Headed test plan (run in order; report each result)

### TEST 1 - the freeze fix (highest priority)
**Goal:** confirm the PTY idle-wait cap stopped the intermittent freeze.
**Steps:** open the `:8088` URL above in a normal focused tab. Let it boot.
Try it **2-3 times** (the freeze was intermittent — it stalled on some loads).
Also try briefly switching to another tab/app for ~20 s and back (simulates
throttling) during boot.
**PASS:** it reaches the A/UX login every time; `disk worker stats:` keeps
advancing; it never sits frozen with stalled stats.
**FAIL:** it freezes (stalled disk stats, screen stuck). If so: **Copy log** and
report the last ~30 lines + whether DevTools shows any error other than
`Uncaught unwind`.

If the tab becomes unusable immediately after pulse-off, that is expected with
the current qemu-wasm runtime: the pulse cadence is also the scheduling yield.
Restart with `pulseMode=yield&pulseMs=2000` and leave that mode on while testing
input. If the frozen screen is just grey/checkered and DevTools cannot even
evaluate `#probeState`, the QEMU/Emscripten proxy path has probably monopolized
Chrome's renderer thread. Close the dedicated test Chrome window, keep the
`pace=1` headed recipe for manual work, and reproduce `pace=0` only with the
headless probe scripts.

### TEST 2 - input quality (mouse + keyboard)
**Goal:** the "mouse perfect, keyboard perfect" bar.
**Steps:** at the A/UX login, click the **Registered User** radio, click the
**Name** field, type a username, tab/click to **Password**, type, click **Login**.
Then move the mouse around the desktop, open the Apple menu, drag a window.
**Report:** Is the mouse **accurate** (cursor lands where you click) and
**responsive** (no lag following the pointer)? Does **every keystroke register**
(no dropped/duplicated keys)? Do **modifiers** work (shift for capitals/symbols)?
Note anything that feels off — this directly drives the input work.

### TEST 3 - pauses / sluggishness
**Goal:** the "no long pauses" bar.
**Steps:** once logged in, launch an app (e.g., open a Finder window, an
application, or AOL if present). Note any **multi-second freezes** when launching
or switching.
**Report:** where the long pauses happen (app launch? window draw? typing?), and
roughly how long. (Hypothesis: disk paging on cold cache, and/or CPU/TCG speed.)

### TEST 4 - long-session stability (the OOM)
**Goal:** confirm/repro the crash, and gauge whether it is memory.
**Steps:** use the VM for several minutes (browse, open apps). Watch for a crash.
**Report:** when it crashes, **what does it look like** — a browser "Aw, Snap"
/ tab reload (= memory OOM, the expected cause), a silent freeze (= a stall, see
test 1), or an error dialog/log line (= possibly a separate network/TCG bug)?
If DevTools is open, note memory (the page `#probeState` carries `wasmMb` +
`diskCacheMb`; the on-page metrics panel shows them too).

---

## 5. Open issues + next steps (headless side will keep working these)

1. **Growable-memory long-session validation.** The served runtime has been
   rebuilt with Emscripten growable memory, so normal headed testing should use
   `heap=384` rather than committing a fixed ~1.28 GB up front. Remaining work:
   run long headed sessions with `heap=384` and confirm there is no late browser
   memory crash.

2. **CPU/sluggishness.** Suspect lever: the main-loop PTY wait min-floor. The
   default `8/32` profile is conservative; the interactive launcher now uses
   `2/16` after a smoke pass. Continue A/B-ing the floor with
   `scripts/bench-boot.mjs` (below) before changing the default.

3. **Headed cursor and click alignment.** The host CSS cursor layer, native
   low-memory mouse anchor, and bounded ADB-relative movement are active in the
   served runtime. Retest in a real tab: after the A/UX kernel reaches the login
   window, the visible cursor, guest click target, and low-memory mouse position
   should stay in the same content-box coordinate plane. If drift remains,
   inspect whether the guest is publishing a non-800x600 mode internally while
   the UI is locked; if the click target is still stuck in a corner, inspect the
   ADB mouse-event path first.

4. **React shell (`:8090`)** still needs input + disk-worker wiring ported; it
   shares the same runtime fixes (the PTY fix applies to it too).

---

## 6. Tooling (headless, for the analysis side)

- **`scripts/bench-boot.mjs`** — boots a URL headless and prints metrics
  (`timeToLoginSec`, `genPerSec`, `fetchesToLogin`, `wireMBToLogin`, peak memory)
  for objective A/B comparison of optimization changes.
  `node scripts/bench-boot.mjs --url "http://127.0.0.1:8088/?...&autostart=lazy" --label baseline`
- **`scripts/watch-browser-boot.mjs`** — headless boot that records periodic
  screenshots + probe samples to `build/boot-watch/`.
- Both need **Node >= 21** (use `~/.nvm/versions/node/v23.7.0/bin` on PATH).
- **Do not** run these while a human is using a headed instance — each is ~1 CPU
  core and will compete.

---

## 7. Key files

| File | Role |
| --- | --- |
| `public/app.js` | vanilla front-end: loader, decoupled renderer, shared ADB input, host cursor, serial, probe |
| `public/qemu-lazy/out.js` | packaged Emscripten glue (patched; the PTY-wait cap lives here) |
| `public/qemu-lazy/module.js` | QEMU command line (machine, RAM, `-g` resolution, drives) |
| `public/disk-worker.js` | SAB disk worker: range-fetches 128 KB chunks, LRU cache |
| `scripts/patch-qemu-out-js-lazyfile.mjs` | the out.js patches incl. the bounded PTY wait |
| `scripts/patch-qemu-out-js-display.mjs` | the decoupled-renderer blit patch |
| `scripts/patch-qemu-out-js-input.mjs` | exposes QEMU's `c89_input_shared_ptr()` export to page JS |
| `scripts/patches/qemu-wasm-wasminput.c` | QEMU wasm shared-input backend that drains browser events into q800 ADB devices |
| `scripts/build-qemu-m68k-wasm.sh` | the Docker wasm build (now with growable-memory option) |
| `scripts/serve_with_headers.py` | dev server: COOP/COEP + HTTP range support |

---

## 8. Hard-won gotchas (do not relearn these)

- **Headless != headed.** A CDP-attached or `make browser` (anti-throttle-flags)
  browser does **not** reproduce the normal-tab throttling that causes the
  freezes. Only a plain, focused/visible normal tab is a valid headed test.
- **Pointer lock is disabled** on purpose (the relative-mouse flood through
  synchronous input proxying wedged the renderer).
- The vendored `vendor/qemu-wasm` tree is **force-reset on every build** — all
  source changes must live in `scripts/build-qemu-m68k-wasm.sh` or
  `scripts/patches/`, never as manual edits in the vendor tree.
- `1024x768` is not an emulated macfb mode (only 640x480 / 800x600 / 1152x870).
- Repo convention: **no emojis** in code, docs, UI, or commit messages.

---

## 9. The single most important thing to tell us back

**Does the `:8088` build (test 1) still freeze in a normal tab, or does it stay
alive every time?** That one yes/no determines whether the PTY idle-wait cap was
the systemic fix or whether there is another main-thread coupling left to hunt.

---

## Appendix A: build / package / patch pipeline

The served runtime in `public/qemu-lazy/` is **generated**, not hand-authored.

1. **Build the wasm (Docker, long):**
   `make build-qemu-balanced` (fixed 1280 MB) or `make build-qemu-grow` (growable
   memory; the OOM fix). Both call `scripts/build-qemu-m68k-wasm.sh`, which builds
   in a Docker image (`c89-qemu-wasm-build`) and writes
   `build/qemu/{out.js, qemu-system-m68k.wasm, qemu-system-m68k.worker.js, qemu-system-m68k.data}`.
   Source-level experiments belong in that script or `scripts/patches/`
   (e.g. `scripts/patches/qemu-wasm-wasmnet.c` is the NIC backend; the net RX poll
   is `C89_WN_RX_POLL_MS`, default 15 ms).
2. **Package + patch into `public/qemu-lazy/`:** `make package-lazy`
   (`scripts/package-lazy-aux-assets.sh`) copies `build/qemu/*` over, regenerates
   `module.js` (the QEMU command line, incl. the `-g` resolution), and applies the
   out.js patches in order: `patch-qemu-out-js-lazyfile.mjs` (lazy disk + the
   bounded PTY wait), `-diskworker.mjs` (route `_fd_pread/_fd_pwrite` through the
   c89Disk SAB), `-net.mjs`, `-display.mjs` (decoupled blit), and
   `patch-qemu-worker-js.mjs`. All patch scripts are **idempotent**.
3. `make refresh-stable-runtime` = build-qemu-balanced + package-smoke + package-lazy.

**Important:** when you hand-edit the live `public/qemu-lazy/out.js` (as was done
for the PTY cap), also update the corresponding **patch script** so the next
`package-lazy` keeps your change. Otherwise a repackage silently reverts it.

The React front-end (`web/`) is built separately: `make build-ui` (vite build +
symlinks `web/dist/qemu-lazy` -> `public/qemu-lazy`), `make serve-ui` (serve
`web/dist` on `:8090`; open `/?core=qemu`). It shares the same runtime, so the
out.js fixes apply to it too.

## Appendix B: networking + disk writes (advanced; not needed for boot+login)

- **Networking:** a **dialtone relay** (Go service, in the sibling 68k_web repo
  `apps/relay`) bridges guest L2 Ethernet to the internet (slirp gateway
  `10.68.0.1`, source-NAT). `?net=1` enables the in-wasm `wasmbridge` NIC plus the
  page-side `public/net-bridge.js` (drains the guest TX ring -> relay WS, injects
  RX). Guest IP is configured in-VM by `scripts/aux-online.sh`.
- **auxagent** is THE reliable in-VM control channel (AAP, HTTP/1.0 over TCP) —
  the agent runs in A/UX at `10.1.1.20:8377`; `scripts/auxctl-zone.mjs` is the
  client (ping/exec/get/put). Use it to run commands inside the guest.
- **Disk writes:** the disk is **read-only by default** (range-fetched chunks +
  an in-memory `-snapshot` overlay that is discarded on reload). To change the
  base image: `make disk-relay [BROWSER=1]` runs the relay on a writable copy and
  prints an admin write URL (`?disk=rw&diskTransport=dialtone&...`); guest writes
  then flow through the disk worker's dialtone transport. `make disk-promote
  [FORCE=1]` publishes the edited disk back to `assets/AUX3.img`, after which
  `make package-lazy` re-bundles it. **Never** write to the `assets/` master
  directly without the promote step.

## Appendix C: current change map

Most of this handoff's original working-tree items have now been committed or
packaged. The files most relevant to the current headed-quality work are:

- `public/app.js` — loader, decoupled renderer, query-locked canvas geometry,
  content-box pointer fallback, PTY timing options, serial/probe state.
- `public/shared-input.js` — 68k_web-style browser event to shared-memory ADB
  bridge, including content-box absolute pointer mapping.
- `scripts/patches/qemu-wasm-wasminput.c` — QEMU-side shared ADB input backend,
  guest cursor export/suppression, and low-memory mouse anchoring.
- `scripts/patch-qemu-out-js-lazyfile.mjs` — generated-runtime lazy-file, PTY,
  net, input, display, and pthread glue patching.
- `public/qemu-lazy/out.js` and `public/qemu-lazy/qemu-system-m68k.wasm` —
  served growable-memory runtime artifacts; rebuild with
  `make build-qemu-grow && make package-lazy` after QEMU C changes.

Note: `public/disk-worker.js` is intentionally **unchanged vs HEAD** — the
readahead experiment was added and then fully reverted, so it shows no diff.
