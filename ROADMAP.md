# browser-qemu: Status and Roadmap

Snapshot date: 2026-06-12. Numbers below were measured against the live dev
server (`make serve` on 127.0.0.1:8088) and the current `public/qemu-lazy/`
artifacts.

## Where we are

QEMU (m68k, Quadra 800 machine) cross-compiled to WebAssembly with Emscripten
boots A/UX 3.1.1 to a usable login screen inside Chrome, no plugins, served
as static files plus HTTP range requests.

What works today:

- Full boot to the A/UX login screen in roughly 94 seconds
  (`make watch-browser-boot`, ram=128, pace=0, lazy-pulse 30s cadence).
- Lazy disk: the 2.0 GB A/UX disk image is never downloaded up front; the
  Emscripten lazyfile patch fetches it through HTTP range requests on demand.
- Display, mouse, and keyboard bridges (SDL canvas plus an HMP fallback path).
  The double-keystroke bug (dual injection via both the direct runtime
  `AuxQemu.sendKey` path and the HMP `sendkey` path) was fixed 2026-06-12.
- A deep diagnostic harness: ~57 boot probes, headless smoke targets, VIA/ESP
  SCSI tracing builds, screenshot watchers, a dev server that mirrors browser
  logs and tracks range-request traffic (`/__range-stats.json`).
- Disk byte-corruption bug (charCodeAt recovery) fixed 2026-06-12.

Known issues:

- Post-write SCSI manager stall, RAM-size dependent, suspected upstream ESP
  FIFO behavior. Worked around well enough to reach login; still the top
  emulation-correctness risk.
- Guest writes go to an in-memory snapshot overlay and are lost on reload.
- Networking UI exists in the shell but has no backend and the wasm side does
  not emit frames yet.
- The repository has no commits. All of this work is untracked on disk only.

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
(`~/Documents/source/68k_mac`, apps/relay), already runs a
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

### Phase 0: Stop the bleeding (now)

1. `git init` discipline: commit the tree (vendor split into its own branch
   or submodule), push to a remote. Everything is currently unversioned.
2. Verify the double-type fix at the login prompt; log in as root.
3. Capture a clean single-boot range-stats baseline (reset, boot, snapshot
   the JSON) so later disk work has a before/after number.

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
5. Ethernet: emit guest NIC frames (the dp8393x SONIC device is already in
   the machine, currently peerless) through `AuxQemuNet.sendFrame` to the
   dialtone `/ethernet` endpoint; slirp gives outbound TCP (telnet, ftp,
   early web) and zones give user-to-user AppleTalk. Reconcile framing:
   dialtone speaks JSON frames to its BasiliskII client today; add or
   negotiate a binary WebSocket mode for QEMU.
6. Auth and sessions: reuse the dialtone JWT model; one disk overlay and
   one network zone per session.

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
    COOP/COEP (config exists in 68k_mac); Helm chart already provisions
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

- Per-boot disk transfer number (cumulative stats only, needs a clean run).
- Whether the relay ethernet endpoint should grow a binary frame mode or the
  QEMU shell should adapt to its JSON framing.
- Whether UDP/ICMP support in slirp is needed for the A/UX experience
  (NTP, ping) or TCP-only is acceptable for v1.
