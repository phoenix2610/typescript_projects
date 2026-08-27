#!/usr/bin/env -S node
/**
 * Compare .env files across environments and flag missing, unused, or suspicious keys.
 *
 *   node envdiff.ts .env.example .env.production
 *   node envdiff.ts --demo
 *
 * A key present in .env.example but missing from .env.production is a deploy
 * waiting to fail the moment that code path runs. This also flags values that
 * look like a secret was accidentally left in an example file (a real-looking
 * API key committed as a "sample"), and keys that are quoted inconsistently
 * across files, which is the kind of thing that works until the value has a
 * space in it.
 */

import * as fs from "node:fs";

interface EnvEntry {
  key: string;
  value: string;
  raw: string;
  line: number;
  quoted: "single" | "double" | "none";
}

function parseEnv(text: string): Map<string, EnvEntry> {
  const entries = new Map<string, EnvEntry>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let rawValue = trimmed.slice(eq + 1).trim();
    let quoted: EnvEntry["quoted"] = "none";
    let value = rawValue;
    if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
      quoted = "double";
      value = rawValue.slice(1, -1);
    } else if (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2) {
      quoted = "single";
      value = rawValue.slice(1, -1);
    }
    entries.set(key, { key, value, raw: rawValue, line: i + 1, quoted });
  }
  return entries;
}

function looksLikeRealSecret(value: string): boolean {
  if (value.length < 16) return false;
  // placeholders: "your-api-key-here", "xxx", "changeme", "<value>", "TODO"
  if (/^(your[-_]|xxx+|changeme|todo|example|placeholder|<.*>|\$\{.*\}|test[-_]?key)/i.test(value)) return false;
  if (/^(sk_live_|pk_live_|AKIA|ghp_|gho_|glpat-)/.test(value)) return true; // known live-key prefixes
  // a URI only counts as a leak if it embeds credentials (scheme://user:pass@host) —
  // "postgres://localhost:5432/app" is a shape, not a secret
  if (/^\w+:\/\//.test(value)) return /:\/\/[^/@]+:[^/@]+@/.test(value);
  const hasEntropy = /[A-Za-z]/.test(value) && /[0-9]/.test(value) && value.length >= 24;
  const allOneClass = /^[a-z]+$/i.test(value) || /^\d+$/.test(value);
  return hasEntropy && !allOneClass;
}

interface Finding {
  severity: "error" | "warning" | "info";
  message: string;
}

function diff(baseName: string, base: Map<string, EnvEntry>, targetName: string, target: Map<string, EnvEntry>): Finding[] {
  const findings: Finding[] = [];
  const baseKeys = [...base.keys()];
  const targetKeys = [...target.keys()];

  const missing = baseKeys.filter((k) => !target.has(k));
  const extra = targetKeys.filter((k) => !base.has(k));

  for (const key of missing) {
    findings.push({ severity: "error", message: `${targetName} is missing "${key}" (present in ${baseName})` });
  }
  for (const key of extra) {
    findings.push({ severity: "warning", message: `${targetName} has "${key}" which is not in ${baseName} — unused, or ${baseName} needs updating` });
  }

  for (const key of baseKeys) {
    const baseEntry = base.get(key)!;
    const targetEntry = target.get(key);
    if (!targetEntry) continue;
    if (baseEntry.quoted !== "none" && targetEntry.quoted !== "none" && baseEntry.quoted !== targetEntry.quoted) {
      findings.push({
        severity: "info",
        message: `"${key}" is ${baseEntry.quoted}-quoted in ${baseName} but ${targetEntry.quoted}-quoted in ${targetName}`,
      });
    }
    if (targetEntry.value.trim() === "" && baseEntry.value.trim() !== "") {
      findings.push({ severity: "warning", message: `"${key}" is set in ${targetName} but the value is empty` });
    }
  }

  for (const [name, entries] of [[baseName, base], [targetName, target]] as const) {
    for (const entry of entries.values()) {
      if (name.includes("example") || name.includes("sample") || name.includes("template")) {
        if (looksLikeRealSecret(entry.value)) {
          findings.push({
            severity: "error",
            message: `${name}:${entry.line}  "${entry.key}" looks like a real credential, not a placeholder — do not commit this`,
          });
        }
      }
    }
  }

  return findings;
}

function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) return "no issues found";
  const order = { error: 0, warning: 1, info: 2 };
  const sorted = [...findings].sort((a, b) => order[a.severity] - order[b.severity]);
  const icon = { error: "error  ", warning: "warning", info: "info   " };
  return sorted.map((f) => `  ${icon[f.severity]}  ${f.message}`).join("\n");
}

// ------------------------------------------------------------ demo

function demo(): void {
  const example = `
# Application config
NODE_ENV=development
PORT=3000
DATABASE_URL="postgres://localhost:5432/app"
REDIS_URL='redis://localhost:6379'
API_SECRET_KEY=your-api-key-here
FEATURE_FLAG_NEW_CHECKOUT=false
LOG_LEVEL=info
`.trim();

  const production = `
NODE_ENV=production
PORT=8080
DATABASE_URL=postgres://prod-db.internal:5432/app
REDIS_URL="redis://prod-cache.internal:6379"
API_SECRET_KEY=sk_live_FAKEDEMOKEYNOTREAL0001
LOG_LEVEL=
DEPLOY_REGION=us-east-1
`.trim();

  console.log("comparing .env.example against .env.production\n");
  console.log(".env.example:");
  for (const line of example.split("\n")) console.log("  " + line);
  console.log("\n.env.production:");
  for (const line of production.split("\n")) console.log("  " + line);

  const baseEntries = parseEnv(example);
  const targetEntries = parseEnv(production);
  const findings = diff(".env.example", baseEntries, ".env.production", targetEntries);

  console.log(`\n${findings.length} findings:\n`);
  console.log(formatFindings(findings));

  console.log("\n\n--- a second scenario: a real key accidentally left in the example file ---\n");
  const leakyExample = `
API_SECRET_KEY=sk_live_FAKEDEMOKEYNOTREAL0002
DATABASE_URL=postgres://localhost/dev
`.trim();
  const normalProd = `
API_SECRET_KEY=sk_live_FAKEDEMOKEYNOTREAL0003
DATABASE_URL=postgres://prod/app
`.trim();
  const findings2 = diff(".env.example", parseEnv(leakyExample), ".env.production", parseEnv(normalProd));
  console.log(formatFindings(findings2));

  const totalErrors = findings.filter((f) => f.severity === "error").length + findings2.filter((f) => f.severity === "error").length;
  console.log(`\n\n${totalErrors} error-level findings across both scenarios`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length < 2) {
    demo();
    return;
  }
  const [baseFile, targetFile] = args;
  const base = parseEnv(fs.readFileSync(baseFile, "utf8"));
  const target = parseEnv(fs.readFileSync(targetFile, "utf8"));
  const findings = diff(baseFile, base, targetFile, target);
  console.log(formatFindings(findings));
  process.exit(findings.some((f) => f.severity === "error") ? 1 : 0);
}

main();
