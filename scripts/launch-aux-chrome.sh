#!/usr/bin/env bash
# Launch Chrome configured for reliable A/UX wasm boots.
#
# The lazy-disk path services every guest disk read with a synchronous XHR on
# the page's main thread while the QEMU worker spin-waits on the result. Stock
# Chrome deprioritizes renderers for unfocused or occluded windows, and that
# priority drop can permanently lose a wakeup in this handshake, wedging the
# boot (5 of 6 interactive boots on June 12, 2026). The flags below pin the
# renderer at full priority; with them the boot succeeded 4 of 4 times.
# Remove this workaround once disk I/O moves off the main thread.
set -euo pipefail

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
PORT="${PORT:-8088}"
RAM="${RAM:-128}"
HEAP="${HEAP:-1280}"
AUTOSTART="${AUTOSTART:-lazy}"
BUILD="${BUILD:-local-$$}"
DEBUG_PORT="${DEBUG_PORT:-9444}"
RES="${RES:-}"          # e.g. RES=800x600 to shrink the framebuffer
NET="${NET:-}"          # NET=1 to enable the wasmbridge NIC + relay bridge
PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/c89-aux-chrome-XXXXXX")"

if [ "${AUTOSTART}" = "none" ]; then
  URL="http://127.0.0.1:${PORT}/?ram=${RAM}&heap=${HEAP}&pace=0&build=${BUILD}"
else
  URL="http://127.0.0.1:${PORT}/?ram=${RAM}&heap=${HEAP}&pace=0&autostart=${AUTOSTART}&build=${BUILD}"
fi
[ -n "${RES}" ] && URL="${URL}&res=${RES}"
[ -n "${NET}" ] && URL="${URL}&net=${NET}"

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
