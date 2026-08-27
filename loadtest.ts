#!/usr/bin/env -S node
/**
 * An HTTP load tester: concurrency ramps, latency percentiles, a live terminal histogram.
 *
 *   node loadtest.ts http://localhost:8080/ --concurrency 50 --duration 5
 *   node loadtest.ts --demo         # runs a local test server, no external target needed
 *
 * The two numbers that actually matter under load are p50 and p99, not the
 * average — a mean can look fine while one request in a hundred takes ten
 * seconds. Percentiles here come from a sorted array of every latency sampled,
 * not a running approximation, so they are exact for whatever sample size you
 * ran. Concurrency is simulated with a fixed pool of workers that immediately
 * re-fire the next request, which is what actually saturates a server — not N
 * requests fired all at once.
 */

import * as http from "node:http";
import { performance } from "node:perf_hooks";

interface RequestResult {
  ok: boolean;
  status: number;
  latencyMs: number;
  bytes: number;
  error?: string;
}

interface LoadTestOptions {
  url: string;
  concurrency: number;
  durationMs: number;
  method?: string;
  headers?: Record<string, string>;
}

interface LoadTestReport {
  requests: number;
  errors: number;
  bytesTotal: number;
  durationMs: number;
  latencies: number[];
  statusCounts: Map<number, number>;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function fireOne(options: LoadTestOptions): Promise<RequestResult> {
  return new Promise((resolve) => {
    const start = performance.now();
    const req = http.request(
      options.url,
      { method: options.method ?? "GET", headers: options.headers, timeout: 10000 },
      (res) => {
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
        });
        res.on("end", () => {
          resolve({ ok: (res.statusCode ?? 0) < 500, status: res.statusCode ?? 0, latencyMs: performance.now() - start, bytes });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, latencyMs: performance.now() - start, bytes: 0, error: "timeout" });
    });
    req.on("error", (err) => {
      resolve({ ok: false, status: 0, latencyMs: performance.now() - start, bytes: 0, error: err.message });
    });
    req.end();
  });
}

async function runLoadTest(options: LoadTestOptions, onSample?: (r: RequestResult) => void): Promise<LoadTestReport> {
  const deadline = performance.now() + options.durationMs;
  const latencies: number[] = [];
  const statusCounts = new Map<number, number>();
  let errors = 0;
  let bytesTotal = 0;
  const started = performance.now();

  async function worker(): Promise<void> {
    while (performance.now() < deadline) {
      const result = await fireOne(options);
      latencies.push(result.latencyMs);
      bytesTotal += result.bytes;
      if (!result.ok) errors++;
      statusCounts.set(result.status, (statusCounts.get(result.status) ?? 0) + 1);
      onSample?.(result);
    }
  }

  const workers = Array.from({ length: options.concurrency }, () => worker());
  await Promise.all(workers);

  return { requests: latencies.length, errors, bytesTotal, durationMs: performance.now() - started, latencies, statusCounts };
}

function formatReport(report: LoadTestReport): string {
  const sorted = [...report.latencies].sort((a, b) => a - b);
  const mean = sorted.reduce((s, v) => s + v, 0) / (sorted.length || 1);
  const rps = report.requests / (report.durationMs / 1000);
  const lines: string[] = [];
  lines.push(`${report.requests} requests in ${(report.durationMs / 1000).toFixed(1)}s  (${rps.toFixed(1)} req/s)`);
  lines.push(`${report.errors} errors (${((report.errors / Math.max(1, report.requests)) * 100).toFixed(1)}%)`);
  lines.push(`${(report.bytesTotal / 1024).toFixed(1)} KB received`);
  lines.push("");
  lines.push("latency:");
  lines.push(`  min    ${sorted[0]?.toFixed(1) ?? "-"}ms`);
  lines.push(`  mean   ${mean.toFixed(1)}ms`);
  lines.push(`  p50    ${percentile(sorted, 50).toFixed(1)}ms`);
  lines.push(`  p90    ${percentile(sorted, 90).toFixed(1)}ms`);
  lines.push(`  p99    ${percentile(sorted, 99).toFixed(1)}ms`);
  lines.push(`  max    ${sorted.at(-1)?.toFixed(1) ?? "-"}ms`);
  return lines.join("\n");
}

function histogram(latencies: number[], buckets = 12): string {
  if (latencies.length === 0) return "(no samples)";
  const sorted = [...latencies].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted.at(-1) ?? min;
  const range = Math.max(max - min, 0.001);
  const counts = new Array(buckets).fill(0);
  for (const v of sorted) {
    const idx = Math.min(buckets - 1, Math.floor(((v - min) / range) * buckets));
    counts[idx]++;
  }
  const peak = Math.max(...counts);
  const lines: string[] = [];
  for (let i = 0; i < buckets; i++) {
    const lo = min + (range * i) / buckets;
    const bar = "#".repeat(Math.round((counts[i] / peak) * 30));
    lines.push(`  ${lo.toFixed(0).padStart(5)}ms  ${bar.padEnd(30)} ${counts[i]}`);
  }
  return lines.join("\n");
}

// ------------------------------------------------------------ demo server

function startTestServer(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount++;
      // simulate realistic latency variance: mostly fast, occasionally slow (a GC pause, a slow query)
      const isSlow = requestCount % 23 === 0;
      const delay = isSlow ? 80 + Math.random() * 120 : 2 + Math.random() * 8;
      const shouldError = requestCount % 97 === 0;
      setTimeout(() => {
        if (shouldError) {
          res.writeHead(500, { "Content-Type": "text/plain" });
          res.end("internal error");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, requestId: requestCount, payload: "x".repeat(200) }));
        }
      }, delay);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}

async function demo(): Promise<void> {
  console.log("starting a local test server that simulates realistic latency variance...\n");
  const server = await startTestServer();
  console.log(`server up at ${server.url} (5% slow responses, ~1% 500s, by design)\n`);

  console.log("--- warm-up: concurrency 5, 1s ---");
  const warmup = await runLoadTest({ url: server.url, concurrency: 5, durationMs: 1000 });
  console.log(formatReport(warmup));

  console.log("\n--- main run: concurrency 30, 3s ---\n");
  let completed = 0;
  const main = await runLoadTest({ url: server.url, concurrency: 30, durationMs: 3000 }, () => {
    completed++;
    if (completed % 100 === 0) process.stdout.write(`\r  ${completed} requests sent...`);
  });
  process.stdout.write("\r" + " ".repeat(40) + "\r");
  console.log(formatReport(main));

  console.log("\nlatency histogram:");
  console.log(histogram(main.latencies));

  console.log("\nstatus codes:");
  for (const [status, count] of [...main.statusCounts.entries()].sort()) {
    console.log(`  ${status || "(error)"}  ${count}`);
  }

  console.log("\n--- comparing concurrency levels on the same server ---\n");
  for (const concurrency of [1, 10, 50]) {
    const report = await runLoadTest({ url: server.url, concurrency, durationMs: 1500 });
    const sorted = [...report.latencies].sort((a, b) => a - b);
    const rps = report.requests / (report.durationMs / 1000);
    console.log(
      `  concurrency ${String(concurrency).padStart(3)}:  ${rps.toFixed(0).padStart(5)} req/s   p50 ${percentile(sorted, 50).toFixed(1)}ms   p99 ${percentile(sorted, 99).toFixed(1)}ms`,
    );
  }
  console.log("\n  (throughput rises with concurrency until the server saturates — then p99 climbs faster than req/s does)");

  await server.close();
}

// ------------------------------------------------------------ CLI

function parseArgs(argv: string[]): { url?: string; concurrency: number; duration: number; demo: boolean } {
  let url: string | undefined;
  let concurrency = 10;
  let duration = 5;
  let demo = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--demo") demo = true;
    else if (arg === "--concurrency" || arg === "-c") concurrency = Number(argv[++i]);
    else if (arg === "--duration" || arg === "-d") duration = Number(argv[++i]);
    else if (!arg.startsWith("-")) url = arg;
  }
  return { url, concurrency, duration, demo };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.demo || !args.url) {
    await demo();
    return;
  }
  console.log(`load testing ${args.url}  concurrency=${args.concurrency}  duration=${args.duration}s\n`);
  const report = await runLoadTest({ url: args.url, concurrency: args.concurrency, durationMs: args.duration * 1000 });
  console.log(formatReport(report));
  console.log("\nlatency histogram:");
  console.log(histogram(report.latencies));
}

main();
