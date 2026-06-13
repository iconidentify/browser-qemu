# browser-qemu: Status and Roadmap

Snapshot date: 2026-06-13. Numbers below were measured against the live dev
server (`make serve` on 127.0.0.1:8088) and the current `public/qemu-lazy/`
artifacts.

## Where we are

QEMU (m68k, Quadra 800 machine) cross-compiled to WebAssembly with Emscripten
boots A/UX 3.1.1 to a usable login screen inside Chrome, no plugins, served
as static files plus HTTP range requests.

What works today:

- Full boot to the A/UX login screen in roughly 94-96 seconds
  (`make watch-browser-boot`; ram=128, pace=0, autostart=lazy, no pulse
  cadence needed since the bounded PTY wait landed).
- Lazy disk: the 2.0 GB A/UX disk image is never downloaded up front; reads
  are fetched on demand in 128 KB chunks by the dedicated disk worker (the
  Emscripten lazyfile sync-XHR path remains only as a fallback).
- Display, mouse, and keyboard bridges (SDL canvas plus an HMP fallback path).
  The double-keystroke bug (dual injection via both the direct runtime
  `AuxQemu.sendKey` path and the HMP `sendkey` path) was fixed 2026-06-12.
- A deep diagnostic harness: ~57 boot probes, headless smoke targets, VIA/ESP
  SCSI tracing builds, screenshot watchers, a dev server that mirrors browser
  logs and tracks range-request traffic (`/__range-stats.json`).
- Disk byte-corruption bug (charCodeAt recovery) fixed 2026-06-12.
- Dedicated disk-I/O worker landed 2026-06-13 (Phase 1 item 4, first half):
  guest disk preads are served inside the QEMU pthread from SharedArrayBuffers
  filled by `public/disk-worker.js` (128 KB chunks, LRU cache, default 512 MB).
  Two transports, selected by `?diskTransport=`: `http` (range GETs, default)
  and `dialtone` (the 68k_web relay binary block protocol over WebSocket,
  including server prefetch pushes). Both verified booting headless to the
  A/UX login screen at the usual ~96 s with zero read errors. The page main
  thread is out of the disk path entirely; `?disk=legacy` restores the old
  main-thread sync-XHR path. Wire transfer for a cold boot-to-login dropped
  from ~840 MB (1 MB chunks) to ~284 MB total/207 MB-to-login (http).
  Wedge-class verification: a stock, headed, UNFOCUSED Chrome (no
  anti-throttling flags; previously 5 of 6 such boots wedged) booted to the
  login screen cleanly on the first attempt
  (`watch-browser-boot.mjs --stock`, the new regression probe for this).

Known issues:

- Post-write SCSI manager stall, RAM-size dependent, suspected upstream ESP
  FIFO behavior. Worked around well enough to reach login; still the top
  emulation-correctness risk.
- Guest writes default to an in-memory snapshot overlay (lost on reload).
  `?disk=rw` + a dialtone admin token now persists writes through the
  relay (Phase 1 item 4, done 2026-06-13), but writes hit the shared base
  image directly, so rw is single-session until per-session copy-on-write
  lands (item below / Phase 1 item 6).
- Cold-relay dialtone prefetch is over-eager: it pushed ~300 MB of predicted
  chunks on a first boot (total wire ~500 MB vs 284 MB for plain http).
  Needs relay-side tuning or a client hint to throttle pushes until the
  pattern model is warm.
- Networking UI exists in the shell but has no backend and the wasm side does
  not emit frames yet.

## Measured baseline (what a visitor's browser pays today)

| Asset | Size | Delivery |
| --- | --- | --- |
| qemu-system-m68k.wasm | 29.6 MB | full download before boot |
| out.js (glue) | 546 KB | full download |
| qemu-system-m68k.data (ROM/PRAM pack) | 1.0 MB | full download |
| aux-3.1.1-disk.img | 2,008 MB | range requests, on demand |

- Wire transfer for disk: the dev server has served 1.72 GB across 1,639
  range GETs at a fixed 1 MB chunk granularity (cumulative across boots;
  reset with `/__range-stats.json?reset=1` to measure a single boot). Even a
  512-byte SCSI read costs a 1 MB fetch, so wire amplification is severe and
  a large fraction of the disk crosses the wire per cold session.
- Memory: heap=1280 means a 1.28 GB wasm heap on top of browser overhead for
  a 128 MB guest. This excludes most mobile devices and low-RAM laptops.
- Boot time: ~94 s of mostly CPU-bound emulation (TCG in wasm) plus serial
  disk fetch latency on the boot path.

## Target architecture: pair with dialtone (the 68k_web Go relay)

Dialtone, the Go relay from the 68k_web project
(`~/Documents/source/68k_web`, apps/relay), already runs a
production-shaped backend built for exactly the two things this project
lacks:

- Block disk service: WebSocket binary protocol, 128 KB chunks with a 6-byte
  header, mmap-backed reads, prefetch learning, write-through persistence,
  copy-on-write snapshots (last 3 kept), and multi-tab locking via heartbeat.
- Ethernet service: frames over WebSocket (`/ethernet`), per-session zone
  switching, a built-in slirp TCP/IP gateway at 10.68.0.1 with DNS rewriting
  and IP/port filtering, AppleTalk/IPX broadcast support. TCP only today.
- Operational scaffolding: HS256 JWT on write endpoints, Docker Compose,
  Helm charts with PVCs, and an nginx config that already sets the COOP/COEP
  headers SharedArrayBuffer requires.

The browser-qemu shell already has the matching seams: `AuxQemuNet.sendFrame`
and `AuxQemu.receiveEthernetFrame` for ethernet, and the lazyfile patch is
the single choke point through which all disk reads flow. The relay currently
speaks JSON ethernet frames to its BasiliskII client; for QEMU prefer binary
WebSocket frames and add or negotiate a binary mode on `/ethernet`.

## Roadmap

### Phase 0: Stop the bleeding (DONE 2026-06-13)

1. DONE. Repo committed and pushed to
   https://github.com/iconidentify/browser-qemu (vendor tree, ROMs, and disk
   images excluded by policy; VENDOR.md records recreation steps).
2. DONE. Logged in as root to the X11/fvwm desktop (June 13, 00:47 UTC).
3. DONE. Baseline captured: ~840 MB over the wire per cold boot-to-login at
   1 MB chunks. Superseded the same day by the disk worker (~284 MB at
   128 KB chunks).

### Phase 0.5: Findings from the June 12 night session (input and boot reliability)

Diagnosed during live debugging; these reorder Phase 1 priorities.

- Double-typing: fixed. The shell injected keys via HMP sendkey while SDL's
  own listeners in out.js also delivered them. Shell input is now gated to
  fire only before the runtime is live (app.js). Same gate applied to mouse.
- Boot wedges: the lazy-disk patch services every guest disk read with a
  synchronous XHR on the page main thread while the QEMU worker spin-waits
  (patch-qemu-out-js-lazyfile.mjs removes the Emscripten worker guard). A
  renderer priority drop (unfocused or occluded window in stock Chrome) can
  permanently lose the wakeup: main thread and worker then spin on each
  other at 200 percent CPU. Confirmed by macOS process sampling of a wedged
  renderer. Interactive boots failed 5 of 6; pinned-priority Chrome
  (scripts/launch-aux-chrome.sh, make browser) booted 4 of 4.
- Canvas clicks during a session engage SDL grab/pointer lock and can
  deadlock the same way (two confirmed kills at the login screen).
- Pulse cadence is no longer required for disk progress: autostart=lazy
  (no pulses) boots to the login screen with the bounded PTY wait that is
  in the current build. Less monitor chatter also means fewer main-thread
  collisions. Keyboard input to the guest works; login via HMP sendkey is
  fully reliable and is how the first successful login was performed.
- Consequence: moving disk I/O off the main thread is the single highest
  reliability item and is the same work as the relay block protocol below.
  DELIVERED 2026-06-13: see Phase 1 item 4 status.

### Phase 1: Persistence, networking, and reliability via dialtone

This phase is also the permanent fix for the boot-wedge class documented in
Phase 0.5: the disk client moves into a dedicated worker speaking the
dialtone block protocol over WebSocket, taking the page main thread out of
the disk path entirely. No more synchronous XHR on the main thread, no more
renderer-scheduling roulette, and clicks and window resizes stop being
lethal.

4. Disk: replace raw HTTP range fetches in the lazyfile patch with the
   dialtone 128 KB chunk protocol, served from a dedicated worker with a
   SharedArrayBuffer handoff to the QEMU worker. Wins: 8x smaller minimum
   fetch, learned prefetch, write-through so a user's session survives
   reload, and main-thread isolation (the reliability fix). Keep per-user
   copy-on-write snapshots server-side; the base A/UX image stays immutable
   and shared.
   STATUS 2026-06-13: DONE for both transports. Reads intercept
   `_fd_pread` in the pthread realm (patch-qemu-out-js-diskworker.mjs)
   rather than the lazyfile getter, so the Emscripten FS proxy to the main
   thread is bypassed entirely; the legacy lazyfile path remains as an
   automatic fallback. Write-through DONE via the dialtone transport:
   `?disk=rw` plus a dialtone admin token drops `-snapshot`/`snapshot=on`
   and routes guest `_fd_pwrite` through the worker (MsgWriteRequest),
   gated on a verified admin JWT and the relay's multi-tab disk lock
   (5 s heartbeat). Verified: writes persist across reboots (three
   distinct disk md5s pristine->boot1->boot2, each booting cleanly).
   Admin write workflow is one command: `make disk-relay` (starts the
   relay on a writable copy under build/relay-disks/, mints a token,
   prints the writable URL), then `make disk-promote` to publish edits to
   the shipped read-only image. Use model (user, 2026-06-13): most
   visitors are read-only; the admin is the one who writes.
   Remaining: prefetch throttling on cold relays. Per-session
   copy-on-write (Phase 1 item 6) is DEPRIORITIZED -- with read-only as
   the common case it is not needed for v1; admin writes are single-tab
   by design and the relay's disk lock already enforces that.
5. Ethernet: emit guest NIC frames (the dp8393x SONIC device is already in
   the machine, currently peerless) through `AuxQemuNet.sendFrame` to the
   dialtone `/ethernet` endpoint; slirp gives outbound TCP (telnet, ftp,
   early web) and zones give user-to-user AppleTalk. Reconcile framing:
   dialtone speaks JSON frames to its BasiliskII client today; add or
   negotiate a binary WebSocket mode for QEMU.
6. Auth and sessions: reuse the dialtone JWT model. DEPRIORITIZED for the
   disk side -- the v1 model is one shared read-only base for visitors plus
   single-tab admin writes (done, see item 4); per-session disk overlays
   only matter once multiple users need independent writable disks. Network
   zones per session stay relevant for ethernet (item 5).

### Phase 2: Make it fast enough to feel like a product

7. Boot snapshot: the single highest-leverage item. Boot once server-side
   (or in CI), snapshot guest RAM plus device state at the login screen, and
   have the web shell restore it. Turns ~94 s into a few seconds plus a
   compressed ~128 MB state download (much less after zstd; lazy-load RAM
   pages the same way as disk if needed).
8. Asset diet: brotli-compress the 29.6 MB wasm (typically 4-5x smaller),
   strip remaining trace builds from the shipped runtime, serve from a CDN.
9. Disk image diet: zero-fill unused blocks and compress chunks at rest;
   the relay's chunk store can serve zstd-compressed chunks.
10. Heap tuning: find the real floor for heap= with ram=128 and default to
    it; document a ram=64 low-memory profile if A/UX tolerates it.

### Phase 3: Public web property

11. Hosting: static assets (wasm, shell) on CDN; relay behind nginx with
    COOP/COEP (config exists in 68k_web); Helm chart already provisions
    PVCs for disk overlays.
12. Front door: landing page, machine picker (A/UX now, room for System 7
    via the BasiliskII path later), session list, snapshot save/restore UI.
13. Legal review before going public: Apple ROM and A/UX are still Apple
    copyrights. Decide between bring-your-own-image (upload), a
    click-through hobbyist posture, or gating images behind auth.
14. Telemetry worth keeping: boot-time histogram, bytes-per-session,
    crash/stall reporting (the probe infrastructure already exists; give it
    a production endpoint).

### Phase 4: Emulation quality

15. Root-cause the ESP FIFO/SCSI stall instead of pacing around it; the
    fifo512/pdma patch series and trace builds are the starting point.
16. Promote the dynamic TB experiment if it holds up; it is the main lever
    on raw guest CPU speed after boot.
17. Audio, color depth above the current mode, and clipboard integration as
    polish items.

## Open questions

- ANSWERED 2026-06-13: per-boot disk transfer is ~284 MB total (207 MB to
  the login screen) over 2,262 range GETs with the 128 KB disk worker;
  it was ~840 MB at the old 1 MB granularity.
- Whether the relay ethernet endpoint should grow a binary frame mode or the
  QEMU shell should adapt to its JSON framing (the relay's ethernet socket
  is JSON-only today; protocol map confirmed 2026-06-13).
- Whether UDP/ICMP support in slirp is needed for the A/UX experience
  (NTP, ping) or TCP-only is acceptable for v1.
- How to throttle dialtone prefetch pushes on a cold pattern model (client
  hint vs relay-side cap); see Known issues.
