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
INPUT_MOTION="${INPUT_MOTION:-hybrid}" # hybrid = absolute low-memory anchor + ADB-relative deltas.
FPS="${FPS:-6}"        # Page-side framebuffer cap; FPS=0 disables the cap.
RES="${RES:-640x480}"  # e.g. RES=800x600 to override the compact dev viewport
NET="${NET:-}"          # NET=1 to enable the wasmbridge NIC + relay bridge
NET_ZONE="${NET_ZONE:-}" # Optional pinned Dialtone relay zone for auxagent.
PTY_MIN="${PTY_MIN:-}"  # Optional QEMU PTY bounded-wait floor in ms.
PTY_IDLE="${PTY_IDLE:-}" # Optional QEMU PTY idle bounded-wait cap in ms.
CURSOR="${CURSOR:-host}"
LOW_OVERHEAD_UI="${LOW_OVERHEAD_UI:-1}"
TB="${TB:-128}"
DISK_CACHE_MB="${DISK_CACHE_MB:-128}"
SERIAL_MS="${SERIAL_MS:-300}"
SERIAL_VISIBLE_LINES="${SERIAL_VISIBLE_LINES:-140}"
SERIAL_VISIBLE_CHARS="${SERIAL_VISIBLE_CHARS:-28000}"
PROBE_MS="${PROBE_MS:-5000}"
INSTRUMENT_MS="${INSTRUMENT_MS:-10000}"
DISK_STATS_MS="${DISK_STATS_MS:-10000}"
FRAME_PROBE_MS="${FRAME_PROBE_MS:-10000}"
CURSOR_MS="${CURSOR_MS:-1000}"
BREADCRUMB_MS="${BREADCRUMB_MS:-5000}"
HEALTH_MS="${HEALTH_MS:-5000}"
HEALTH_LAG_MS="${HEALTH_LAG_MS:-1500}"
LOG_MIRROR_MS="${LOG_MIRROR_MS:-5000}"
LIVE_CHARTS="${LIVE_CHARTS:-0}"
CHART_MS="${CHART_MS:-30000}"
HOST_PREFLIGHT="${HOST_PREFLIGHT:-1}"
HOST_PREFLIGHT_STRICT="${HOST_PREFLIGHT_STRICT:-0}"
PREFLIGHT_ONLY="${PREFLIGHT_ONLY:-0}"
URL_EXTRA="${URL_EXTRA:-}"
PROFILE=""

warn_host_pressure() {
  [ "${HOST_PREFLIGHT}" = "0" ] && return 0

  local warned=0
  local fatal=0
  local hot_native
  hot_native="$(
    ps -axo pid=,pcpu=,rss=,args= | awk '
      /qemu-system-m68k/ && $0 !~ /awk/ {
        cpu = $2 + 0
        if (cpu >= 50) {
          args = ""
          for (i = 4; i <= NF; i++) args = args (i > 4 ? " " : "") $i
          if (length(args) > 150) args = substr(args, 1, 150) "..."
          printf "  pid=%s cpu=%.0f%% rss=%.0fMB %s\n", $1, cpu, $3 / 1024, args
        }
      }'
  )"
  if [ -n "${hot_native}" ]; then
    warned=1
    fatal=1
    printf '%s\n' "host preflight warning: native desktop qemu-system-m68k is already hot."
    printf '%s\n' "${hot_native}"
    printf '%s\n' "  For manual Chrome feel, close/stop the desktop QEMU first; two Quadras will fight for the machine."
  fi

  local hot_renderers
  hot_renderers="$(
    ps -axo pid=,pcpu=,rss=,args= | awk '
      (/Google Chrome Helper .*--type=renderer/ || /Codex \(Renderer\)/) && $0 !~ /awk/ {
        cpu = $2 + 0
        if (cpu >= 75) {
          label = /Codex \(Renderer\)/ ? "Codex renderer" : "Chrome renderer"
          printf "  pid=%s cpu=%.0f%% rss=%.0fMB %s\n", $1, cpu, $3 / 1024, label
        }
      }'
  )"
  if [ -n "${hot_renderers}" ]; then
    warned=1
    fatal=1
    printf '%s\n' "host preflight warning: a browser/Codex renderer is already hot."
    printf '%s\n' "${hot_renderers}"
  fi

  local hot_background
  hot_background="$(
    ps -axo pid=,pcpu=,rss=,args= | awk '
      /(mediaanalysisd|photoanalysisd|mdworker|mds_stores|backupd|syspolicyd)/ && $0 !~ /awk/ {
        cpu = $2 + 0
        if (cpu >= 90) {
          args = ""
          for (i = 4; i <= NF; i++) args = args (i > 4 ? " " : "") $i
          if (length(args) > 150) args = substr(args, 1, 150) "..."
          printf "  pid=%s cpu=%.0f%% rss=%.0fMB %s\n", $1, cpu, $3 / 1024, args
        }
      }'
  )"
  if [ -n "${hot_background}" ]; then
    warned=1
    fatal=1
    printf '%s\n' "host preflight warning: a macOS background system service is already consuming a core."
    printf '%s\n' "${hot_background}"
    printf '%s\n' "  Let that settle or pause it before headed A/UX testing; Chrome+WASM needs the main thread breathing room."
  fi

  local hot_virtualization
  hot_virtualization="$(
    ps -axo pid=,pcpu=,rss=,args= | awk '
      /com.apple.Virtualization.VirtualMachine/ && $0 !~ /awk/ {
        cpu = $2 + 0
        if (cpu >= 75) {
          args = ""
          for (i = 4; i <= NF; i++) args = args (i > 4 ? " " : "") $i
          if (length(args) > 150) args = substr(args, 1, 150) "..."
          printf "  pid=%s cpu=%.0f%% rss=%.0fMB %s\n", $1, cpu, $3 / 1024, args
        }
      }'
  )"
  if [ -n "${hot_virtualization}" ]; then
    warned=1
    fatal=1
    printf '%s\n' "host preflight warning: an Apple Virtualization VM is already consuming a core."
    printf '%s\n' "${hot_virtualization}"
    printf '%s\n' "  Pause Docker/VM workloads before headed browser-QEMU testing; the foreground Chrome tab needs that CPU."
  fi

  local df_line free_kb capacity
  df_line="$(df -k /System/Volumes/Data 2>/dev/null | awk 'NR == 2 { print $4 " " $5 }' || true)"
  free_kb="${df_line%% *}"
  capacity="${df_line##* }"
  if [[ "${free_kb}" =~ ^[0-9]+$ ]] && (( free_kb < 20 * 1024 * 1024 )); then
    warned=1
    printf 'host preflight warning: low disk headroom on /System/Volumes/Data (%s free, %s full).\n' \
      "$(( free_kb / 1024 / 1024 ))GB" "${capacity}"
    if (( free_kb < 10 * 1024 * 1024 )); then
      fatal=1
    fi
  fi

  if command -v curl >/dev/null 2>&1 && command -v node >/dev/null 2>&1; then
    local session_note
    session_note="$(
      curl -fsS "http://127.0.0.1:${PORT}/__session.json?ts=$(date +%s)" 2>/dev/null |
        node -e '
          let s = "";
          process.stdin.on("data", d => s += d);
          process.stdin.on("end", () => {
            try {
              const p = JSON.parse(s || "{}");
              if ((p.runningCount || 0) > 0) {
                console.log(`host preflight warning: ${p.runningCount} browser-QEMU session(s) already reported by the dev server; run make browser-stop or close the old tab first.`);
              }
            } catch {}
          });
        ' 2>/dev/null || true
    )"
    if [ -n "${session_note}" ]; then
      warned=1
      printf '%s\n' "${session_note}"
    fi
  fi

  if [ "${warned}" = "0" ]; then
    printf '%s\n' "host preflight: no hot native QEMU/session pressure detected."
  fi
  if [ "${HOST_PREFLIGHT_STRICT}" = "1" ] && [ "${fatal}" = "1" ]; then
    printf '%s\n' "host preflight: refusing to launch headed Chrome under fatal host pressure."
    printf '%s\n' "  Set HOST_PREFLIGHT_STRICT=0 to override for diagnostics."
    return 1
  fi
}

add_param() {
  local key="$1"
  local value="$2"
  [ -n "${value}" ] || return 0
  URL="${URL}&${key}=${value}"
}

if [ "${AUTOSTART}" = "none" ]; then
  URL="http://127.0.0.1:${PORT}/?ram=${RAM}&heap=${HEAP}&pace=${PACE}&input=${INPUT}&fps=${FPS}&build=${BUILD}"
else
  URL="http://127.0.0.1:${PORT}/?ram=${RAM}&heap=${HEAP}&pace=${PACE}&input=${INPUT}&fps=${FPS}&autostart=${AUTOSTART}&build=${BUILD}"
fi
add_param res "${RES}"
add_param net "${NET}"
add_param netZone "${NET_ZONE}"
add_param icount "${ICOUNT}"
add_param ptyMin "${PTY_MIN}"
add_param ptyIdle "${PTY_IDLE}"
add_param cursor "${CURSOR}"
add_param inputMotion "${INPUT_MOTION}"
add_param lowOverheadUi "${LOW_OVERHEAD_UI}"
add_param tb "${TB}"
add_param diskCacheMb "${DISK_CACHE_MB}"
add_param serialMs "${SERIAL_MS}"
add_param serialVisibleLines "${SERIAL_VISIBLE_LINES}"
add_param serialVisibleChars "${SERIAL_VISIBLE_CHARS}"
add_param probeMs "${PROBE_MS}"
add_param instrumentMs "${INSTRUMENT_MS}"
add_param diskStatsMs "${DISK_STATS_MS}"
add_param frameProbeMs "${FRAME_PROBE_MS}"
add_param cursorMs "${CURSOR_MS}"
add_param breadcrumbMs "${BREADCRUMB_MS}"
add_param healthMs "${HEALTH_MS}"
add_param healthLagMs "${HEALTH_LAG_MS}"
add_param logMirrorMs "${LOG_MIRROR_MS}"
add_param liveCharts "${LIVE_CHARTS}"
add_param chartMs "${CHART_MS}"
if [ "${AUTOSTART}" = "lazy-pulse" ] && [ -n "${PULSE_MS}" ]; then
  add_param pulseMs "${PULSE_MS}"
fi
if [ "${AUTOSTART}" = "lazy-pulse" ] && [ -n "${PULSE_MODE}" ]; then
  add_param pulseMode "${PULSE_MODE}"
fi
if [ -n "${URL_EXTRA}" ]; then
  URL_EXTRA="${URL_EXTRA#\?}"
  URL_EXTRA="${URL_EXTRA#&}"
  URL="${URL}&${URL_EXTRA}"
fi

warn_host_pressure
if [ "${PREFLIGHT_ONLY}" = "1" ]; then
  echo "url:     ${URL}"
  echo "preflight only: not launching Chrome"
  exit 0
fi

PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/c89-aux-chrome-XXXXXX")"
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
