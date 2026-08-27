#!/usr/bin/env -S node
/**
 * Compare daily cloud spend to a rolling baseline and alert on genuine outliers.
 *
 *   node cost_alerter.ts check --data spend.json
 *   node cost_alerter.ts --demo
 *
 * A flat "alert if spend > $X" threshold either fires every Black Friday or
 * misses a real leak on a quiet month. This computes a rolling baseline (mean
 * + standard deviation over a trailing window) per cost center, and flags a
 * day as anomalous only when it's a real statistical outlier — several
 * standard deviations out — not just "higher than yesterday," which is true
 * on roughly half of all days by definition.
 */

interface DailySpend {
  date: string; // YYYY-MM-DD
  costCenter: string;
  amountUsd: number;
}

interface Baseline {
  mean: number;
  stdDev: number;
  windowDays: number;
}

function computeBaseline(history: number[]): Baseline {
  const mean = history.reduce((a, b) => a + b, 0) / history.length;
  const variance = history.reduce((a, v) => a + (v - mean) ** 2, 0) / history.length;
  return { mean, stdDev: Math.sqrt(variance), windowDays: history.length };
}

interface Anomaly {
  costCenter: string;
  date: string;
  amountUsd: number;
  baseline: Baseline;
  zScore: number;
  severity: "info" | "warning" | "critical";
}

function zScoreSeverity(z: number): Anomaly["severity"] {
  if (z >= 5) return "critical";
  if (z >= 3) return "warning";
  return "info";
}

/** For each cost center, compute a rolling baseline from the N days BEFORE the
 *  point being checked (never including the point itself, or a spike inflates
 *  its own baseline and can never be flagged as anomalous relative to itself). */
function detectAnomalies(spend: DailySpend[], windowDays: number, zThreshold: number): Anomaly[] {
  const byCostCenter = new Map<string, DailySpend[]>();
  for (const s of spend) {
    const list = byCostCenter.get(s.costCenter) ?? [];
    list.push(s);
    byCostCenter.set(s.costCenter, list);
  }

  const anomalies: Anomaly[] = [];
  for (const [costCenter, entries] of byCostCenter) {
    const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = windowDays; i < sorted.length; i++) {
      const window = sorted.slice(i - windowDays, i).map((e) => e.amountUsd);
      const baseline = computeBaseline(window);
      const today = sorted[i];
      if (baseline.stdDev === 0) continue; // perfectly flat spend — no meaningful z-score, skip rather than divide by zero
      const zScore = (today.amountUsd - baseline.mean) / baseline.stdDev;
      if (Math.abs(zScore) >= zThreshold && zScore > 0) {
        // only flag SPIKES (positive z), never a cost DROP — an unusually cheap
        // day is not the kind of anomaly a cost-alerting tool exists to catch
        anomalies.push({ costCenter, date: today.date, amountUsd: today.amountUsd, baseline, zScore, severity: zScoreSeverity(zScore) });
      }
    }
  }
  return anomalies.sort((a, b) => b.zScore - a.zScore);
}

function formatAnomalies(anomalies: Anomaly[]): string {
  if (anomalies.length === 0) return "No cost anomalies detected — spend is within normal variance for every cost center.";
  const lines: string[] = [`${anomalies.length} anomal${anomalies.length === 1 ? "y" : "ies"} detected:\n`];
  for (const a of anomalies) {
    const overBaseline = ((a.amountUsd - a.baseline.mean) / a.baseline.mean) * 100;
    lines.push(`[${a.severity.toUpperCase()}] ${a.costCenter}  ${a.date}`);
    lines.push(`  $${a.amountUsd.toFixed(2)} vs baseline $${a.baseline.mean.toFixed(2)} ± $${a.baseline.stdDev.toFixed(2)}  (z=${a.zScore.toFixed(1)}, +${overBaseline.toFixed(0)}%)`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------ demo

function daysFrom(start: string, offset: number): string {
  const d = new Date(start + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

function buildDemoSpend(): DailySpend[] {
  const spend: DailySpend[] = [];
  const start = "2026-07-28";

  // "compute" cost center: stable around $400/day with normal noise, then a real
  // spike on day 25 (someone left a large instance running over a weekend)
  for (let day = 0; day < 30; day++) {
    const noise = Math.sin(day * 1.3) * 15 + (day % 3 === 0 ? 8 : -4); // deterministic pseudo-noise
    const isSpike = day === 25;
    const amount = isSpike ? 1850 : 400 + noise;
    spend.push({ costCenter: "compute", date: daysFrom(start, day), amountUsd: Math.round(amount * 100) / 100 });
  }

  // "storage" cost center: slowly, legitimately growing (more data every day) —
  // should NOT be flagged, since gradual growth doesn't produce a high z-score
  // against a rolling window that grows right along with it
  for (let day = 0; day < 30; day++) {
    const amount = 120 + day * 2.5;
    spend.push({ costCenter: "storage", date: daysFrom(start, day), amountUsd: Math.round(amount * 100) / 100 });
  }

  // "cdn" cost center: normal weekday/weekend pattern (traffic-driven, genuinely
  // variable) — should NOT trigger false alarms just for being naturally noisy
  for (let day = 0; day < 30; day++) {
    const dayOfWeek = (new Date(daysFrom(start, day) + "T00:00:00Z").getUTCDay() + 6) % 7;
    const isWeekend = dayOfWeek >= 5;
    const amount = isWeekend ? 60 + Math.sin(day) * 5 : 140 + Math.sin(day) * 10;
    spend.push({ costCenter: "cdn", date: daysFrom(start, day), amountUsd: Math.round(amount * 100) / 100 });
  }

  return spend;
}

function demo(): void {
  const spend = buildDemoSpend();
  console.log(`${spend.length} daily spend records across 3 cost centers, 30 days each\n`);

  const windowDays = 14;
  const anomalies = detectAnomalies(spend, windowDays, 3);
  console.log(formatAnomalies(anomalies));

  console.log(`\n\nsample of the "compute" cost center around the spike:\n`);
  const computeEntries = spend.filter((s) => s.costCenter === "compute").sort((a, b) => a.date.localeCompare(b.date));
  for (const entry of computeEntries.slice(22, 28)) {
    const flagged = anomalies.some((a) => a.costCenter === "compute" && a.date === entry.date);
    console.log(`  ${entry.date}  $${entry.amountUsd.toFixed(2)}${flagged ? "  <- FLAGGED" : ""}`);
  }

  console.log(`\n\nnote: "storage" grows from $120/day to ~$192/day over the month — a real, sustained`);
  console.log(`60% increase — but it's GRADUAL, so the 14-day rolling baseline grows right along`);
  console.log(`with it and no single day ever looks like a statistical outlier against its own`);
  console.log(`recent window. That's a real limitation of this technique (gradual drift needs a`);
  console.log(`different kind of check — a longer-term trend comparison, not point anomaly`);
  console.log(`detection) and it's worth knowing, not hiding. "cdn" has a real, legitimate`);
  console.log(`weekday/weekend pattern and produces zero false alarms despite genuine day-to-day`);
  console.log(`variance, because that variance IS the baseline, not a deviation from it.`);
}

// ------------------------------------------------------------ CLI

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }

  if (args[0] !== "check") {
    console.log("usage: cost_alerter.ts check --data spend.json [--window 14] [--z-threshold 3]");
    return;
  }
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const dataPath = get("--data");
  const windowDays = Number(get("--window") ?? "14");
  const zThreshold = Number(get("--z-threshold") ?? "3");
  if (!dataPath) {
    console.error("--data is required");
    process.exitCode = 1;
    return;
  }

  const fs = await import("node:fs");
  const spend = JSON.parse(fs.readFileSync(dataPath, "utf8")) as DailySpend[];
  const anomalies = detectAnomalies(spend, windowDays, zThreshold);
  console.log(formatAnomalies(anomalies));
  process.exitCode = anomalies.some((a) => a.severity === "critical") ? 1 : 0;
}

main();
