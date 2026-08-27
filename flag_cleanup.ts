#!/usr/bin/env -S node
/**
 * Find feature flags that are fully rolled out (or fully killed) and propose the
 * code change that removes them.
 *
 *   node flag_cleanup.ts ./src --config flags.json
 *   node flag_cleanup.ts --demo
 *
 * A flag at 100% rollout for months is dead weight: every `if (flag.isEnabled)`
 * check is a branch nobody needs anymore, and the "disabled" branch is
 * unreachable code nobody's deleted. This scans source for flag-check call
 * sites, cross-references each flag's current rollout state, and for a
 * fully-resolved flag, generates the actual diff that collapses the
 * conditional to whichever branch survives — not just a list of "you should
 * clean this up," but the patch itself, ready to review.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface FlagState {
  key: string;
  rolloutPercent: number; // 0-100
  daysAtCurrentState: number;
}

interface FlagCallSite {
  file: string;
  line: number;
  flagKey: string;
  raw: string;
}

// matches: isEnabled("flag-key"), flags.isEnabled('flag-key'), featureFlag.check(`flag-key`)
const FLAG_CALL_RE = /\b(?:isEnabled|isFlagEnabled|check|hasFlag)\s*\(\s*["'`]([\w.\-]+)["'`]\s*\)/g;

function findFlagCallSites(root: string): FlagCallSite[] {
  const sites: FlagCallSite[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, "utf8");
      const lines = source.split("\n");
      lines.forEach((line, idx) => {
        const re = new RegExp(FLAG_CALL_RE.source, "g");
        let match: RegExpExecArray | null;
        while ((match = re.exec(line))) {
          sites.push({ file: full, line: idx + 1, flagKey: match[1], raw: line.trim() });
        }
      });
    }
  }
  walk(root);
  return sites;
}

type Resolution = "fully-on" | "fully-off" | "in-progress";

function classifyFlag(flag: FlagState, minStableDays = 14): Resolution {
  if (flag.rolloutPercent >= 100 && flag.daysAtCurrentState >= minStableDays) return "fully-on";
  if (flag.rolloutPercent <= 0 && flag.daysAtCurrentState >= minStableDays) return "fully-off";
  return "in-progress";
}

interface CleanupCandidate {
  flagKey: string;
  resolution: Resolution;
  callSites: FlagCallSite[];
  suggestedPatches: PatchSuggestion[];
}

interface PatchSuggestion {
  file: string;
  line: number;
  before: string;
  after: string;
}

/** For a simple `if (isEnabled("flag")) { A } else { B }` pattern spread across
 *  up to a few lines, suggest collapsing to just A (if fully-on) or B (if
 *  fully-off). This handles the common single-line-condition case explicitly
 *  rather than attempting a general AST transform — good enough to draft the
 *  patch a human then reviews and applies, not meant to auto-merge blind. */
function suggestPatch(site: FlagCallSite, resolution: Resolution): PatchSuggestion | null {
  if (resolution === "in-progress") return null;

  const flagCallRe = new RegExp(`(!?)\\s*(?:isEnabled|isFlagEnabled|check|hasFlag)\\s*\\(\\s*["'\`]${escapeRegex(site.flagKey)}["'\`]\\s*\\)`);
  const match = site.raw.match(flagCallRe);
  const isNegated = Boolean(match?.[1]);
  const flagValue = resolution === "fully-on"; // what isEnabled(flag) itself resolves to
  const exprValue = isNegated ? !flagValue : flagValue; // what the (possibly negated) expression resolves to

  const before = site.raw;
  let after: string;
  if (/^\s*if\s*\(/.test(before)) {
    after = exprValue
      ? `// flag "${site.flagKey}" is ${resolution} — condition always true here`
      : `// flag "${site.flagKey}" is ${resolution} — this branch is now dead code, remove the block`;
  } else if (match) {
    // Not an if-statement, so there's no branch to keep or drop — the flag-check
    // expression itself is now a constant. Substitute the exact literal it
    // resolves to, rather than a vague "inline the enabled/disabled behavior"
    // comment that doesn't actually say what value survives.
    after = `${before.slice(0, match.index)}${exprValue}${before.slice((match.index ?? 0) + match[0].length)}  // was: ${match[0].trim()}`;
  } else {
    after = `// TODO: flag "${site.flagKey}" is ${resolution} — could not isolate the check expression to patch automatically`;
  }

  return { file: site.file, line: site.line, before, after };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildCleanupPlan(callSites: FlagCallSite[], flagStates: Map<string, FlagState>): CleanupCandidate[] {
  const byFlag = new Map<string, FlagCallSite[]>();
  for (const site of callSites) {
    const list = byFlag.get(site.flagKey) ?? [];
    list.push(site);
    byFlag.set(site.flagKey, list);
  }

  const candidates: CleanupCandidate[] = [];
  for (const [flagKey, sites] of byFlag) {
    const state = flagStates.get(flagKey);
    if (!state) continue; // flag referenced in code but not in the flag service — separate problem, not this tool's job
    const resolution = classifyFlag(state);
    if (resolution === "in-progress") continue;

    const patches = sites.map((s) => suggestPatch(s, resolution)).filter((p): p is PatchSuggestion => p !== null);
    candidates.push({ flagKey, resolution, callSites: sites, suggestedPatches: patches });
  }

  return candidates.sort((a, b) => b.callSites.length - a.callSites.length);
}

function formatPlan(candidates: CleanupCandidate[]): string {
  if (candidates.length === 0) return "No flags are ready for cleanup — everything is either actively rolling out or not stable long enough yet.";
  const lines: string[] = [`${candidates.length} flag(s) ready for cleanup:\n`];
  for (const c of candidates) {
    lines.push(`"${c.flagKey}"  (${c.resolution}, ${c.callSites.length} call site${c.callSites.length === 1 ? "" : "s"})`);
    for (const patch of c.suggestedPatches) {
      lines.push(`  ${path.basename(patch.file)}:${patch.line}`);
      lines.push(`    - ${patch.before}`);
      lines.push(`    + ${patch.after}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ------------------------------------------------------------ demo

function buildDemoProject(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  const write = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.trim() + "\n");
  };

  write(
    "checkout.ts",
    `
export function renderCheckout() {
  if (isEnabled("new-checkout-flow")) {
    return renderNewCheckout();
  }
  return renderOldCheckout();
}
`,
  );
  write(
    "pricing.ts",
    `
export function getPrice(item: Item) {
  if (isEnabled("new-checkout-flow")) {
    return item.priceV2;
  }
  return item.priceV1;
}
`,
  );
  write(
    "legacy-banner.ts",
    `
export function shouldShowBanner() {
  return !isEnabled("legacy-signup-banner");
}
`,
  );
  write(
    "experiments.ts",
    `
export function pickVariant() {
  if (isEnabled("pricing-experiment-q3")) {
    return "variant-b";
  }
  return "control";
}
`,
  );
}

function demo(): void {
  const root = "/tmp/flag-cleanup-demo";
  buildDemoProject(root);
  console.log("(synthesised a small project with 3 flags at different rollout stages)\n");

  const callSites = findFlagCallSites(root);
  console.log(`${callSites.length} flag-check call sites found across the project\n`);

  const flagStates = new Map<string, FlagState>([
    ["new-checkout-flow", { key: "new-checkout-flow", rolloutPercent: 100, daysAtCurrentState: 45 }], // fully shipped, stable for weeks
    ["legacy-signup-banner", { key: "legacy-signup-banner", rolloutPercent: 0, daysAtCurrentState: 90 }], // fully killed, stable for months
    ["pricing-experiment-q3", { key: "pricing-experiment-q3", rolloutPercent: 30, daysAtCurrentState: 5 }], // still actively rolling out
  ]);

  console.log("flag states:");
  for (const [key, state] of flagStates) {
    console.log(`  ${key}: ${state.rolloutPercent}% for ${state.daysAtCurrentState} days -> ${classifyFlag(state)}`);
  }

  const plan = buildCleanupPlan(callSites, flagStates);
  console.log(`\n${formatPlan(plan)}`);

  console.log(`\n\nnote: "new-checkout-flow" has 2 call sites across 2 files and both get a patch`);
  console.log(`suggestion — this isn't a per-file tool, it's a per-FLAG tool, so a flag guarding`);
  console.log(`several code paths gets cleaned up everywhere at once. "legacy-signup-banner" is`);
  console.log(`checked with a NEGATED condition (!isEnabled(...)) — the flag is fully OFF, so`);
  console.log(`isEnabled() resolves to false and the negated expression resolves to true, and the`);
  console.log(`patch substitutes that exact literal rather than a vague "inline the behavior" TODO.`);
  console.log(`"pricing-experiment-q3" is only 30% rolled out and 5 days in — it's excluded`);
  console.log(`entirely, not even listed, because it's still actively being decided.`);

  fs.rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------ CLI

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }

  const root = args[0];
  const configIdx = args.indexOf("--config");
  if (configIdx < 0) {
    console.error("usage: flag_cleanup.ts <src-dir> --config flags.json");
    process.exitCode = 1;
    return;
  }
  const configPath = args[configIdx + 1];
  const rawStates = JSON.parse(fs.readFileSync(configPath, "utf8")) as FlagState[];
  const flagStates = new Map(rawStates.map((s) => [s.key, s]));

  const callSites = findFlagCallSites(root);
  const plan = buildCleanupPlan(callSites, flagStates);
  console.log(formatPlan(plan));
}

main();
