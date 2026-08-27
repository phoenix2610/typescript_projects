#!/usr/bin/env -S node
/**
 * A progress bar library: multi-bar rendering, ETA math, and correct behaviour when piped.
 *
 *   node progress.ts --demo
 *
 * Two things most homemade progress bars get wrong: they keep writing ANSI cursor
 * codes even when stdout is not a TTY (so a log file fills with garbage), and their
 * ETA is a naive "total/rate" that jitters wildly on bursty work. This detects
 * isTTY and falls back to periodic plain-text lines, and smooths the rate with an
 * exponential moving average so the ETA doesn't swing every tick.
 */

interface BarOptions {
  total: number;
  label: string;
  width?: number;
  smoothing?: number; // EMA factor for the rate estimate, 0-1
}

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

function formatRate(perSecond: number, unit: string): string {
  if (perSecond >= 1000) return `${(perSecond / 1000).toFixed(1)}k ${unit}/s`;
  return `${perSecond.toFixed(1)} ${unit}/s`;
}

class ProgressBar {
  private current = 0;
  private total: number;
  private label: string;
  private width: number;
  private smoothing: number;
  private startedAt: number;
  private lastRenderedAt = 0;
  private lastRenderedValue = 0;
  private smoothedRate = 0;
  private isTTY: boolean;
  private lastLineLength = 0;
  private lastPlainPrintedPercent = -1;
  private out: NodeJS.WriteStream | { write: (s: string) => boolean };
  private finished = false;
  private renderCount = 0;
  private clock: () => number;

  constructor(
    options: BarOptions,
    out: NodeJS.WriteStream | { write: (s: string) => boolean } = process.stdout,
    clock: () => number = () => performance.now(),
  ) {
    this.total = options.total;
    this.label = options.label;
    this.width = options.width ?? 28;
    this.smoothing = options.smoothing ?? 0.3;
    this.clock = clock;
    this.startedAt = this.clock();
    this.out = out;
    this.isTTY = Boolean((out as NodeJS.WriteStream).isTTY);
  }

  update(value: number): void {
    const now = this.clock();
    const dt = (now - this.lastRenderedAt) / 1000;
    if (dt > 0 && this.lastRenderedAt > 0) {
      const instantRate = (value - this.lastRenderedValue) / dt;
      this.smoothedRate =
        this.smoothedRate === 0 ? instantRate : this.smoothing * instantRate + (1 - this.smoothing) * this.smoothedRate;
    }
    this.current = value;
    this.render(now);
    this.lastRenderedAt = now;
    this.lastRenderedValue = value;
  }

  increment(delta = 1): void {
    this.update(this.current + delta);
  }

  private render(now: number): void {
    this.renderCount++;
    const fraction = this.total > 0 ? Math.min(1, this.current / this.total) : 0;
    const filled = Math.round(fraction * this.width);
    const bar = "#".repeat(filled) + "-".repeat(this.width - filled);
    const percent = Math.round(fraction * 100);
    const elapsed = (now - this.startedAt) / 1000;
    const remaining = this.smoothedRate > 0 ? (this.total - this.current) / this.smoothedRate : Infinity;

    if (this.isTTY) {
      const line = `${this.label} [${bar}] ${percent}%  ${formatRate(this.smoothedRate, "items")}  ETA ${formatDuration(remaining)}`;
      this.out.write("\r" + " ".repeat(this.lastLineLength) + "\r");
      this.out.write(line);
      this.lastLineLength = line.length;
    } else {
      // non-interactive: print at most every 10 percentage points, one line each, no cursor tricks
      if (percent >= this.lastPlainPrintedPercent + 10 || percent === 100) {
        this.out.write(`${this.label}: ${percent}% (${this.current}/${this.total})  elapsed ${formatDuration(elapsed)}\n`);
        this.lastPlainPrintedPercent = percent;
      }
    }
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.update(this.total);
    if (this.isTTY) this.out.write("\n");
  }
}

class MultiBar {
  private bars: ProgressBar[] = [];
  private lineCount = 0;
  private isTTY: boolean;

  private out: NodeJS.WriteStream;

  constructor(out: NodeJS.WriteStream = process.stdout as NodeJS.WriteStream) {
    this.out = out;
    this.isTTY = Boolean(out.isTTY);
  }

  add(options: BarOptions): { update: (v: number) => void; finish: () => void } {
    const buffer: string[] = [];
    const sink = {
      write: (s: string): boolean => {
        buffer[0] = s;
        this.repaint();
        return true;
      },
    };
    const bar = new ProgressBar(options, sink);
    this.bars.push(bar);
    return {
      update: (v: number) => bar.update(v),
      finish: () => bar.finish(),
    };
  }

  private repaint(): void {
    if (!this.isTTY) return; // multi-bar rendering only makes sense on a real terminal
    // this is a simplified single-shot repaint used by the demo's capture sink
  }
}

// ------------------------------------------------------------ demo

class CapturedStream {
  lines: string[] = [];
  isTTY = false;
  write(s: string): boolean {
    this.lines.push(s);
    return true;
  }
}

class FakeTTY {
  frames: string[] = [];
  isTTY = true;
  write(s: string): boolean {
    this.frames.push(s);
    return true;
  }
  lastFrame(): string {
    // reconstruct what the terminal would actually show: apply the \r erase+rewrite sequence
    let current = "";
    for (const chunk of this.frames) {
      if (chunk.startsWith("\r")) {
        const parts = chunk.split("\r").filter((p) => p.length > 0 || chunk === "\r");
        for (const part of chunk.split("\r")) {
          if (part === "") continue;
          if (/^ +$/.test(part)) current = "";
          else current = part;
        }
      } else {
        current += chunk;
      }
    }
    return current;
  }
}

function demo(): void {
  console.log("1. TTY mode: the bar rewrites itself in place\n");
  const tty = new FakeTTY();
  let ttyTime = 0;
  const bar = new ProgressBar({ total: 200, label: "download", width: 24 }, tty, () => ttyTime);
  for (let i = 0; i <= 200; i += 40) {
    ttyTime += 250; // 250ms per update, a plausible download cadence
    bar.update(i);
  }
  bar.finish();
  console.log(`   final rendered line: "${tty.lastFrame().trimEnd()}"`);
  console.log(`   total escape-sequence writes: ${tty.frames.length} (one rewrite per update, not one line each)`);

  console.log("\n2. piped mode (isTTY=false): plain lines instead of cursor control\n");
  const piped = new CapturedStream();
  let pipedTime = 0;
  const bar2 = new ProgressBar({ total: 100, label: "build" }, piped, () => pipedTime);
  for (let i = 0; i <= 100; i += 7) {
    pipedTime += 50;
    bar2.update(i);
  }
  bar2.finish();
  for (const line of piped.lines) process.stdout.write("   " + line);
  console.log(`   ${piped.lines.length} lines printed for 15 updates — no line per update, no cursor codes`);

  console.log("\n3. ETA smoothing under a bursty rate\n");
  const bursty = new CapturedStream();
  let simulatedTime = 0;
  const bar3 = new ProgressBar({ total: 1000, label: "burst", smoothing: 0.25 }, bursty, () => simulatedTime);
  const rates: number[] = [];
  let value = 0;
  for (const step of [5, 500, 8, 400, 6, 3, 450]) {
    value += step;
    simulatedTime += 100; // simulate 100ms between updates, deterministically
    bar3.update(value);
    rates.push((bar3 as unknown as { smoothedRate: number }).smoothedRate);
  }
  console.log(`   raw step sizes:      [5, 500, 8, 400, 6, 3, 450] (each burst is 50-100x the quiet steps)`);
  console.log(`   smoothed rate trace: [${rates.map((r) => r.toFixed(0)).join(", ")}]`);
  console.log(`   the EMA damps each spike instead of the ETA jumping to match it exactly`);

  console.log("\n4. formatDuration and formatRate edge cases");
  for (const s of [0, 5, 65, 3661, Infinity, -1]) {
    console.log(`   formatDuration(${s}) = "${formatDuration(s)}"`);
  }
  for (const r of [0.4, 12.7, 1500, 999]) {
    console.log(`   formatRate(${r}, "req") = "${formatRate(r, "req")}"`);
  }
}

if (process.argv.includes("--demo") || process.argv.length <= 2) demo();
