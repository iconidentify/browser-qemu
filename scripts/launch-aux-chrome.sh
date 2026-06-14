#!/usr/bin/env bash
# Launch Chrome configured for reliable A/UX wasm boots.
#
# Headed runs need to keep the page responsive while qemu-wasm's pthread build
# still performs a lot of synchronous proxy work on Chrome's renderer thread.
# The default URL therefore uses QEMU's paced CPU path plus the worker-backed
# pulse cadence. Keep pace=0 for headless/instrumented progress probes, not for
# casual headed sessions, because it can monopolize Chrome before the pulse stop
# timer gets a chance to fire.
set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-8088}"
RAM="${RAM:-128}"
HEAP="${HEAP:-384}"
PACE="${PACE:-1}"
ICOUNT="${ICOUNT:-}"
AUTOSTART="${AUTOSTART:-lazy-pulse}"
PULSE_MS="${PULSE_MS:-2000}"
PULSE_MODE="${PULSE_MODE:-yield}"
BUILD="${BUILD:-local-$$}"
DEBUG_PORT="${DEBUG_PORT:-9444}"
INPUT="${INPUT:-shared}" # shared = 68k_web-style browser buffer into QEMU ADB.
FPS="${FPS:-20}"       # Page-side framebuffer cap; FPS=0 disables the cap.
RES="${RES:-640x480}"  # e.g. RES=800x600 to override the compact dev viewport
NET="${NET:-}"          # NET=1 to enable the wasmbridge NIC + relay bridge
PTY_MIN="${PTY_MIN:-}"  # Optional QEMU PTY bounded-wait floor in ms.
PTY_IDLE="${PTY_IDLE:-}" # Optional QEMU PTY idle bounded-wait cap in ms.
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/c89-aux-chrome-XXXXXX")"

if [ "${AUTOSTART}" = "none" ]; then
  URL="http://127.0.0.1:${PORT}/?ram=${RAM}&heap=${HEAP}&pace=${PACE}&input=${INPUT}&fps=${FPS}&build=${BUILD}"
else
  URL="http://127.0.0.1:${PORT}/?ram=${RAM}&heap=${HEAP}&pace=${PACE}&input=${INPUT}&fps=${FPS}&autostart=${AUTOSTART}&build=${BUILD}"
fi
[ -n "${RES}" ] && URL="${URL}&res=${RES}"
[ -n "${NET}" ] && URL="${URL}&net=${NET}"
[ -n "${ICOUNT}" ] && URL="${URL}&icount=${ICOUNT}"
[ -n "${PTY_MIN}" ] && URL="${URL}&ptyMin=${PTY_MIN}"
[ -n "${PTY_IDLE}" ] && URL="${URL}&ptyIdle=${PTY_IDLE}"
if [ "${AUTOSTART}" = "lazy-pulse" ] && [ -n "${PULSE_MS}" ]; then
  URL="${URL}&pulseMs=${PULSE_MS}"
fi
if [ "${AUTOSTART}" = "lazy-pulse" ] && [ -n "${PULSE_MODE}" ]; then
  URL="${URL}&pulseMode=${PULSE_MODE}"
fi

echo "profile: ${PROFILE}"
echo "url:     ${URL}"

exec "${CHROME}" \
  --no-first-run \
  --no-default-browser-check \
  --disable-background-networking \
  --disable-dev-shm-usage \
  --disable-background-timer-throttling \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --window-size=1400,1200 \
  --remote-debugging-port="${DEBUG_PORT}" \
  --user-data-dir="${PROFILE}" \
  "${URL}"
