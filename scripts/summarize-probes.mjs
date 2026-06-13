#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const options = {
  json: false,
  files: [],
};

function usage() {
  console.error(`Usage:
  node scripts/summarize-probes.mjs [--json] probe.json...

Examples:
  node scripts/summarize-probes.mjs build/probes/browser-via-scsi-120-30-*.json
  node scripts/summarize-probes.mjs --json native.json browser.json`);
}

for (const arg of args) {
  if (arg === "--json") {
    options.json = true;
  } else if (arg === "--help" || arg === "-h") {
    usage();
    process.exit(0);
  } else {
    options.files.push(arg);
  }
}

if (!options.files.length) {
  usage();
  process.exit(2);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactTargets(scsiSummary) {
  const targets = scsiSummary?.targets || {};
  const parts = [];
  for (const [target, info] of Object.entries(targets).sort()) {
    const sectors = asArray(info.readSectors);
    const lbas = asArray(info.lbas);
    const sectorText = sectors.length ? `sectors=${sectors.join(",")}` : "";
    const lbaText = lbas.length ? `lbas=${lbas.join(",")}` : "";
    const body = [sectorText, lbaText].filter(Boolean).join(" ");
    parts.push(`t${target}{${body || "no-reads"}}`);
  }
  return parts.join(" ");
}

function compactVia(viaSummary) {
  const via1 = viaSummary?.via1;
  const via2 = viaSummary?.via2;
  const timerText = (name, timer) => {
    if (!timer) return "";
    const due = Number.isFinite(timer.nextFromNowMs) ? `due=${timer.nextFromNowMs}ms` : "";
    const age = Number.isFinite(timer.loadAgeMs) ? `age=${timer.loadAgeMs}ms` : "";
    const bits = [timer.mode, timer.counter ? `ctr=${timer.counter}` : "", due, age].filter(Boolean);
    return `${name}{${bits.join(" ")}}`;
  };
  const format = (name, via) => {
    if (!via) return `${name}=n/a`;
    const active = asArray(via.activeIrqNames);
    const now = Number.isFinite(via.nowMs) ? ` now=${via.nowMs}ms` : "";
    const timers = [timerText("t1", via.t1), timerText("t2", via.t2)].filter(Boolean).join(" ");
    return `${name}{ifr=${via.ifr || "?"} ier=${via.ier || "?"} active=${active.length ? active.join("+") : "none"}${now}${timers ? ` ${timers}` : ""}}`;
  };
  return `${format("via1", via1)} ${format("via2", via2)}`;
}

function summarizeViaTimerFromInfo(timer, nowNs) {
  if (!timer) return undefined;
  const summary = {
    mode: timer.mode,
    counter: timer.counter,
    latch: timer.latch,
  };
  if (Number.isFinite(timer.nextIrqTimeNs) && Number.isFinite(timer.loadTimeNs)) {
    summary.nextMinusLoadMs = Math.round((timer.nextIrqTimeNs - timer.loadTimeNs) / 1_000_000);
  }
  if (Number.isFinite(nowNs) && Number.isFinite(timer.loadTimeNs)) {
    summary.loadAgeMs = Math.round((nowNs - timer.loadTimeNs) / 1_000_000);
  }
  if (Number.isFinite(nowNs) && Number.isFinite(timer.nextIrqTimeNs)) {
    summary.nextFromNowMs = Math.round((timer.nextIrqTimeNs - nowNs) / 1_000_000);
  }
  return summary;
}

function enrichViaSummary(viaSummary, viaInfo) {
  const result = JSON.parse(JSON.stringify(viaSummary || {}));
  for (const [viaName, via] of Object.entries(viaInfo || {})) {
    if (!result[viaName]) result[viaName] = {};
    if (!result[viaName].ifr && via.ifr) result[viaName].ifr = via.ifr;
    if (!result[viaName].ier && via.ier) result[viaName].ier = via.ier;
    if (!result[viaName].activeIrq && via.activeIrq) result[viaName].activeIrq = via.activeIrq;
    if (!result[viaName].activeIrqNames && via.activeIrqNames) {
      result[viaName].activeIrqNames = via.activeIrqNames;
    }
    if (!Number.isFinite(result[viaName].nowMs) && Number.isFinite(via.nowNs)) {
      result[viaName].nowMs = Math.round(via.nowNs / 1_000_000);
    }
    for (const timerName of ["t1", "t2"]) {
      const enrichedTimer = summarizeViaTimerFromInfo(via.timers?.[timerName], via.nowNs);
      if (!enrichedTimer) continue;
      result[viaName][timerName] = {
        ...enrichedTimer,
        ...(result[viaName][timerName] || {}),
      };
    }
  }
  return result;
}

function compactDisks(disks) {
  return asArray(disks)
    .filter((disk) => disk && disk.name)
    .map((disk) => {
      const nonZero = asArray(disk.nonZeroStarts);
      const unique = asArray(disk.uniqueStarts);
      return `${disk.name}{ranges=${disk.rangeGet || 0} unique=${unique.length ? unique.join(",") : "-"} nonzero=${nonZero.length ? nonZero.join(",") : "-"}}`;
    })
    .join(" ");
}

function normalize(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const probe = raw.probe || raw;
  const source = raw.probe ? "browser" : "native";
  const finalSample = raw.finalSample || probe.finalSample || null;
  const final = finalSample || probe;
  const samples = asArray(probe.samples || raw.samples);
  const scsiSummary = probe.scsiSummary || raw.scsiSummary || {};
  const viaSummary = enrichViaSummary(
    probe.viaSummary || raw.finalViaSummary || finalSample?.viaSummary,
    probe.viaInfo || raw.finalViaInfo || finalSample?.viaInfo,
  );
  const disks = probe.disks || finalSample?.disks || [];
  const sawScsiTrace = Boolean(probe.sawScsiTrace ?? raw.sawScsiTrace ?? (scsiSummary.count > 0));

  return {
    file,
    name: path.basename(file),
    source,
    ok: Boolean(raw.ok),
    url: raw.url || "",
    qemu: raw.qemu || "",
    durationSeconds: probe.durationSeconds || raw.durationSeconds || null,
    intervalSeconds: probe.intervalSeconds || raw.intervalSeconds || null,
    final: {
      pc: final.pc || "",
      sr: final.sr || "",
      phase: final.phase || "",
      viaSummary,
      scsiSummary,
      sawScsiTrace,
      disks,
    },
    firstScsiElapsedSeconds: raw.firstScsiElapsedSeconds ?? probe.firstScsiElapsedSeconds ?? null,
    samples: samples.map((sample) => ({
      elapsedSeconds: sample.elapsedSeconds,
      pc: sample.pc || "",
      sr: sample.sr || "",
      phase: sample.phase || "",
      viaSummary: enrichViaSummary(sample.viaSummary, sample.viaInfo),
      sawScsiTrace: Boolean(sample.sawScsiTrace ?? (sample.scsiSummary?.count > 0)),
      scsiCount: sample.scsiSummary?.count || 0,
    })),
  };
}

const summaries = options.files.map(normalize);

if (options.json) {
  console.log(JSON.stringify(summaries, null, 2));
  process.exit(0);
}

for (const summary of summaries) {
  console.log(`${summary.name}`);
  console.log(`  source: ${summary.source}${summary.ok ? "" : " (failed)"} duration=${summary.durationSeconds ?? "?"}s interval=${summary.intervalSeconds ?? "?"}s`);
  if (summary.url) console.log(`  url: ${summary.url}`);
  if (summary.qemu) console.log(`  qemu: ${summary.qemu}`);
  console.log(`  final: pc=${summary.final.pc || "?"} sr=${summary.final.sr || "?"} phase=${summary.final.phase || "?"}`);
  console.log(`  via: ${compactVia(summary.final.viaSummary)}`);
  const firstScsi = summary.firstScsiElapsedSeconds === null ? "-" : `${summary.firstScsiElapsedSeconds}s`;
  console.log(`  scsi: saw=${summary.final.sawScsiTrace ? "yes" : "no"} first=${firstScsi} count=${summary.final.scsiSummary?.count || 0} ${compactTargets(summary.final.scsiSummary)}`);
  const diskText = compactDisks(summary.final.disks);
  if (diskText) console.log(`  disks: ${diskText}`);
  if (summary.samples.length) {
    console.log("  samples:");
    for (const sample of summary.samples) {
      const via = compactVia(sample.viaSummary);
      console.log(`    ${String(sample.elapsedSeconds ?? "?").padStart(4)}s pc=${sample.pc || "?"} sr=${sample.sr || "?"} phase=${sample.phase || "?"} scsi=${sample.sawScsiTrace ? "yes" : "no"} count=${sample.scsiCount} ${via}`);
    }
  }
}
