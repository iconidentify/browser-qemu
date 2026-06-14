const HEALTH_MAGIC = 0x43383948; // C89H

let ctl = null;
let endpoint = "./__browser-log";
let href = "";
let intervalMs = 5000;
let lagMs = 2500;
let timer = 0;
let lastBeat = -1;

function timestamp() {
  return new Date().toISOString().slice(11, 19);
}

function flagText(flags) {
  const parts = [];
  if (flags & 1) parts.push("qemu");
  if (flags & 2) parts.push("visible");
  if (flags & 4) parts.push("pressure");
  if (flags & 8) parts.push("pulse");
  return parts.length ? parts.join("+") : "idle";
}

function nowStampMs() {
  return Date.now() & 0x7fffffff;
}

function wrappedAgeMs(now, then) {
  const diff = now - then;
  return diff >= 0 ? diff : diff + 0x80000000;
}

async function postLog(line) {
  try {
    const body = JSON.stringify({
      source: "browser-qemu-health",
      href,
      lines: [line],
    });
    await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      cache: "no-store",
    });
  } catch {
    // Diagnostics only; if the local server is gone there is nothing to report.
  }
}

function sample() {
  if (!ctl || Atomics.load(ctl, 0) !== HEALTH_MAGIC) {
    postLog(`[${timestamp()}] health worker: waiting for main heartbeat`);
    return;
  }

  const beat = Atomics.load(ctl, 1);
  const mainNow = Atomics.load(ctl, 2);
  const flags = Atomics.load(ctl, 3);
  const mainAge = Math.max(0, wrappedAgeMs(nowStampMs(), mainNow));
  const qemuActive = Boolean(flags & 1);
  const pressureActive = Boolean(flags & 4);
  const stalled = mainAge >= lagMs;
  const beatChanged = beat !== lastBeat;
  lastBeat = beat;

  if (!qemuActive && !pressureActive && !stalled) return;

  postLog(
    `[${timestamp()}] health worker: mainAge=${mainAge}ms beat=${beat}` +
      ` beatChanged=${beatChanged ? 1 : 0} flags=${flagText(flags)}`
  );
}

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type !== "start") return;

  ctl = new Int32Array(message.control);
  endpoint = message.endpoint || endpoint;
  href = message.href || "";
  intervalMs = Math.max(1000, Math.min(30000, Number(message.intervalMs) || intervalMs));
  lagMs = Math.max(1000, Math.min(60000, Number(message.lagMs) || lagMs));

  if (timer) clearInterval(timer);
  postLog(`[${timestamp()}] health worker: armed interval=${intervalMs}ms lag=${lagMs}ms`);
  sample();
  timer = setInterval(sample, intervalMs);
};
