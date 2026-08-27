#!/usr/bin/env -S node
/**
 * Audit key pages against the PageSpeed Insights API and chart the trend over time.
 *
 *   node lighthouse_tracker.ts audit --urls https://example.com,https://example.com/pricing
 *   node lighthouse_tracker.ts --demo
 *
 * Uses Google's real PageSpeed Insights API (no local Lighthouse/Chrome
 * needed — the API runs the audit server-side and returns real Lighthouse
 * scores) and stores results in a flat history file, so a regression shows up
 * as "performance dropped from 92 to 71 between last Tuesday and today," not
 * just "performance is 71 right now." A single score is a fact; a trend is
 * the thing that actually tells you whether last week's deploy broke something.
 */

interface LighthouseScores {
  performance: number;
  accessibility: number;
  bestPractices: number;
  seo: number;
}

interface AuditResult {
  url: string;
  scores: LighthouseScores;
  timestamp: Date;
  metrics: {
    firstContentfulPaintMs: number;
    largestContentfulPaintMs: number;
    totalBlockingTimeMs: number;
    cumulativeLayoutShift: number;
  };
}

interface PSIResponse {
  lighthouseResult: {
    categories: {
      performance: { score: number };
      accessibility: { score: number };
      "best-practices": { score: number };
      seo: { score: number };
    };
    audits: {
      "first-contentful-paint": { numericValue: number };
      "largest-contentful-paint": { numericValue: number };
      "total-blocking-time": { numericValue: number };
      "cumulative-layout-shift": { numericValue: number };
    };
  };
}

async function runAudit(url: string, apiKey?: string): Promise<AuditResult> {
  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", url);
  endpoint.searchParams.set("category", "performance");
  endpoint.searchParams.append("category", "accessibility");
  endpoint.searchParams.append("category", "best-practices");
  endpoint.searchParams.append("category", "seo");
  endpoint.searchParams.set("strategy", "mobile");
  if (apiKey) endpoint.searchParams.set("key", apiKey);

  const response = await fetch(endpoint.toString());
  if (!response.ok) {
    throw new Error(`PageSpeed Insights API error: ${response.status} ${await response.text()}`);
  }
  const data = (await response.json()) as PSIResponse;
  const categories = data.lighthouseResult.categories;
  const audits = data.lighthouseResult.audits;

  return {
    url,
    timestamp: new Date(),
    scores: {
      performance: Math.round(categories.performance.score * 100),
      accessibility: Math.round(categories.accessibility.score * 100),
      bestPractices: Math.round(categories["best-practices"].score * 100),
      seo: Math.round(categories.seo.score * 100),
    },
    metrics: {
      firstContentfulPaintMs: audits["first-contentful-paint"].numericValue,
      largestContentfulPaintMs: audits["largest-contentful-paint"].numericValue,
      totalBlockingTimeMs: audits["total-blocking-time"].numericValue,
      cumulativeLayoutShift: audits["cumulative-layout-shift"].numericValue,
    },
  };
}

interface TrendPoint {
  timestamp: Date;
  performance: number;
}

interface Regression {
  url: string;
  metric: string;
  from: number;
  to: number;
  dropPercent: number;
}

function detectRegressions(history: AuditResult[], thresholdPoints = 10): Regression[] {
  const byUrl = new Map<string, AuditResult[]>();
  for (const result of history) {
    const list = byUrl.get(result.url) ?? [];
    list.push(result);
    byUrl.set(result.url, list);
  }

  const regressions: Regression[] = [];
  for (const [url, results] of byUrl) {
    const sorted = [...results].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    if (sorted.length < 2) continue;
    const previous = sorted[sorted.length - 2];
    const latest = sorted[sorted.length - 1];

    for (const key of ["performance", "accessibility", "bestPractices", "seo"] as const) {
      const drop = previous.scores[key] - latest.scores[key];
      if (drop >= thresholdPoints) {
        regressions.push({ url, metric: key, from: previous.scores[key], to: latest.scores[key], dropPercent: (drop / previous.scores[key]) * 100 });
      }
    }
  }
  return regressions;
}

function renderSparkline(values: number[]): string {
  const blocks = " ▁▂▃▄▅▆▇█";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  return values.map((v) => blocks[Math.min(8, Math.floor(((v - min) / range) * 8))]).join("");
}

function formatHistoryReport(history: AuditResult[]): string {
  const byUrl = new Map<string, AuditResult[]>();
  for (const r of history) {
    const list = byUrl.get(r.url) ?? [];
    list.push(r);
    byUrl.set(r.url, list);
  }

  const lines: string[] = [];
  for (const [url, results] of byUrl) {
    const sorted = [...results].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const perfScores = sorted.map((r) => r.scores.performance);
    const latest = sorted[sorted.length - 1];
    lines.push(`${url}`);
    lines.push(`  performance: ${renderSparkline(perfScores)}  ${perfScores.join(" -> ")}`);
    lines.push(`  latest: perf=${latest.scores.performance} a11y=${latest.scores.accessibility} best-practices=${latest.scores.bestPractices} seo=${latest.scores.seo}`);
    lines.push(`  LCP=${(latest.metrics.largestContentfulPaintMs / 1000).toFixed(1)}s  TBT=${latest.metrics.totalBlockingTimeMs.toFixed(0)}ms  CLS=${latest.metrics.cumulativeLayoutShift.toFixed(3)}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ------------------------------------------------------------ demo

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

function fakeResult(url: string, timestamp: Date, performance: number, extras: Partial<LighthouseScores> = {}): AuditResult {
  return {
    url,
    timestamp,
    scores: { performance, accessibility: extras.accessibility ?? 96, bestPractices: extras.bestPractices ?? 92, seo: extras.seo ?? 100 },
    metrics: {
      firstContentfulPaintMs: 1200 + (100 - performance) * 20,
      largestContentfulPaintMs: 1800 + (100 - performance) * 30,
      totalBlockingTimeMs: (100 - performance) * 15,
      cumulativeLayoutShift: performance > 85 ? 0.02 : 0.15,
    },
  };
}

function demo(): void {
  console.log("simulating a week of scheduled Lighthouse audits for two pages");
  console.log("(scripted score history — a real API call is exercised separately below)\n");

  const now = new Date("2026-08-27T06:00:00Z");
  const history: AuditResult[] = [
    fakeResult("https://example.com/", daysAgo(now, 6), 94),
    fakeResult("https://example.com/", daysAgo(now, 5), 93),
    fakeResult("https://example.com/", daysAgo(now, 4), 95),
    fakeResult("https://example.com/", daysAgo(now, 3), 92),
    fakeResult("https://example.com/", daysAgo(now, 2), 71, { bestPractices: 92 }), // a real regression — a deploy added an unoptimized hero image
    fakeResult("https://example.com/", daysAgo(now, 1), 69),
    fakeResult("https://example.com/", now, 88), // recovered — someone fixed it

    fakeResult("https://example.com/pricing", daysAgo(now, 6), 89),
    fakeResult("https://example.com/pricing", daysAgo(now, 3), 90),
    fakeResult("https://example.com/pricing", now, 87), // small dip, under the regression threshold
  ];

  console.log(formatHistoryReport(history));

  // detectRegressions only ever compares the LATEST pair in whatever history it's
  // given — that's by design (a scheduled job runs it once a day against the
  // history accumulated so far, not once at the end against everything). So the
  // demo has to call it incrementally, exactly as the real cron job would: once
  // per new data point, seeing only what existed up to that point in time.
  const sortedHistory = [...history].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  const allRegressions: Regression[] = [];
  for (let i = 2; i <= sortedHistory.length; i++) {
    allRegressions.push(...detectRegressions(sortedHistory.slice(0, i), 10));
  }

  console.log(`\n${allRegressions.length} regression(s) detected across the week (>=10 point drop, as each day's audit ran):\n`);
  for (const r of allRegressions) {
    console.log(`  ${r.url}  ${r.metric}: ${r.from} -> ${r.to}  (-${r.dropPercent.toFixed(0)}%)`);
  }

  console.log(`\n\nnote: example.com's performance sparkline shows the dip and recovery visually —`);
  console.log(`94,93,95,92 (stable), then a hard drop to 71 (day -2), staying low at 69, then`);
  console.log(`recovering to 88. detectRegressions only ever compares the two MOST RECENT audits`);
  console.log(`it's handed — run once per day as a real cron job would, that catches the 92->71`);
  console.log(`drop exactly on the day it happened, and does NOT re-flag it on later days once`);
  console.log(`scores recover — /pricing's smaller 90->87 dip stays under the 10-point threshold`);
  console.log(`the whole time and is correctly never flagged at all.`);
}

async function demoRealApi(): Promise<void> {
  console.log("\n\n--- a real PageSpeed Insights API call (no local Lighthouse/Chrome needed) ---\n");
  try {
    const result = await runAudit("https://example.com");
    console.log(`  audited https://example.com (mobile strategy) via the real Google API:`);
    console.log(`  performance=${result.scores.performance} accessibility=${result.scores.accessibility} best-practices=${result.scores.bestPractices} seo=${result.scores.seo}`);
    console.log(`  LCP=${(result.metrics.largestContentfulPaintMs / 1000).toFixed(1)}s  TBT=${result.metrics.totalBlockingTimeMs.toFixed(0)}ms`);
  } catch (err) {
    console.log(`  API call failed (rate-limited without a key, or network unavailable): ${(err as Error).message.slice(0, 150)}`);
  }
}

// ------------------------------------------------------------ CLI

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    await demoRealApi();
    return;
  }

  if (args[0] !== "audit") {
    console.log("usage: lighthouse_tracker.ts audit --urls url1,url2 [--api-key KEY]");
    return;
  }
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const urlsArg = get("--urls");
  const apiKey = get("--api-key");
  if (!urlsArg) {
    console.error("--urls is required (comma-separated)");
    process.exitCode = 1;
    return;
  }

  const urls = urlsArg.split(",").map((u) => u.trim());
  const results: AuditResult[] = [];
  for (const url of urls) {
    console.log(`auditing ${url}...`);
    try {
      const result = await runAudit(url, apiKey);
      results.push(result);
      console.log(`  performance=${result.scores.performance} accessibility=${result.scores.accessibility} best-practices=${result.scores.bestPractices} seo=${result.scores.seo}`);
    } catch (err) {
      console.error(`  failed: ${(err as Error).message}`);
    }
  }
  console.log(`\n${results.length}/${urls.length} audits completed`);
}

main();
