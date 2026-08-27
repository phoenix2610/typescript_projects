#!/usr/bin/env -S node
/**
 * Diff what a bundler kept against what your source actually exports.
 *
 *   node treeshake.ts ./src --bundle dist/bundle.js
 *   node treeshake.ts --demo
 *
 * Tree-shaking failures are invisible until you go looking: a module exports
 * twelve things, twenty imports pull from it, and the bundler was supposed to
 * drop everything unreferenced from the entry point — but a barrel re-export or
 * a side-effectful import can pin the whole module in regardless. This scans
 * every export in your source tree, then greps the built bundle for each export
 * name, and flags exports that survived the build without a plausible reason.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface ExportSite {
  file: string;
  name: string;
  line: number;
}

const EXPORT_CONST_RE = /^export\s+(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_BRACE_RE = /^export\s*\{([^}]+)\}(?!\s*from)/gm;

function findExports(root: string): ExportSite[] {
  const sites: ExportSite[] = [];
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
      let match: RegExpExecArray | null;
      const constRe = new RegExp(EXPORT_CONST_RE);
      while ((match = constRe.exec(source))) {
        sites.push({ file: full, name: match[1], line: source.slice(0, match.index).split("\n").length });
      }
      const braceRe = new RegExp(EXPORT_BRACE_RE);
      while ((match = braceRe.exec(source))) {
        const line = source.slice(0, match.index).split("\n").length;
        for (const raw of match[1].split(",")) {
          const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
          if (name) sites.push({ file: full, name, line });
        }
      }
    }
  }
  walk(root);
  return sites;
}

interface ShakeReport {
  totalExports: number;
  survivingInBundle: ExportSite[];
  droppedFromBundle: ExportSite[];
  bundleBytes: number;
  possiblyUnshaken: ExportSite[];
}

/** A name "surviving" in the bundle by substring match is a weak signal (it could just
 *  be a string literal, or a coincidental identifier collision) — so this also checks that
 *  the export is used as an identifier boundary, not part of a longer word. */
function nameAppearsAsIdentifier(bundle: string, name: string): boolean {
  const re = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`);
  return re.test(bundle);
}

function analyseBundle(root: string, bundlePath: string): ShakeReport {
  const exportsFound = findExports(root);
  const bundle = fs.readFileSync(bundlePath, "utf8");

  const surviving: ExportSite[] = [];
  const dropped: ExportSite[] = [];
  for (const exp of exportsFound) {
    if (nameAppearsAsIdentifier(bundle, exp.name)) surviving.push(exp);
    else dropped.push(exp);
  }

  // "possibly unshaken": every export in a file survived, and the file has several
  // exports — a mixed result (some dropped, some kept) is normal per-export shaking,
  // but "kept every single one" from a multi-export module usually means the whole
  // module got pulled in by a re-export barrel or a side-effectful import, not shaken
  // export by export.
  const byFile = new Map<string, ExportSite[]>();
  for (const exp of exportsFound) {
    const list = byFile.get(exp.file) ?? [];
    list.push(exp);
    byFile.set(exp.file, list);
  }
  const possiblyUnshaken: ExportSite[] = [];
  for (const [, list] of byFile) {
    const allSurvived = list.every((e) => surviving.includes(e));
    if (allSurvived && list.length >= 3) possiblyUnshaken.push(...list);
  }

  return { totalExports: exportsFound.length, survivingInBundle: surviving, droppedFromBundle: dropped, bundleBytes: bundle.length, possiblyUnshaken };
}

// ------------------------------------------------------------ demo

function buildFakeProject(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  const write = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.trim() + "\n");
  };

  write(
    "math.ts",
    `
export function add(a: number, b: number) { return a + b; }
export function subtract(a: number, b: number) { return a - b; }
export function multiply(a: number, b: number) { return a * b; }
export function divide(a: number, b: number) { return a / b; }
`,
  );
  write(
    "strings.ts",
    `
export function capitalize(s: string) { return s[0].toUpperCase() + s.slice(1); }
export function truncate(s: string, n: number) { return s.slice(0, n); }
export function reverse(s: string) { return s.split("").reverse().join(""); }
`,
  );
  write(
    "index.ts",
    `
export * from "./math";
export * from "./strings";
`,
  );
}

function buildFakeBundle(): string {
  // simulates a bundler output where only `add` and `capitalize` were actually referenced
  // by the app entry point, but the barrel export in index.ts pinned the WHOLE strings
  // module in (a realistic tree-shaking failure with `export *` barrels)
  return `
function add(a, b) { return a + b; }
function capitalize(s) { return s[0].toUpperCase() + s.slice(1); }
function truncate(s, n) { return s.slice(0, n); }
function reverse(s) { return s.split("").reverse().join(""); }
console.log(add(1, 2), capitalize("hi"));
`;
}

function demo(): void {
  const root = "/tmp/treeshake-demo";
  buildFakeProject(root);
  const bundlePath = "/tmp/treeshake-demo-bundle.js";
  fs.writeFileSync(bundlePath, buildFakeBundle());

  console.log("(synthesised a fake project + fake bundle output to analyse)\n");
  console.log("source modules:");
  console.log("  math.ts     — add, subtract, multiply, divide (only `add` is actually called)");
  console.log("  strings.ts  — capitalize, truncate, reverse (only `capitalize` is actually called)");
  console.log("  index.ts    — a barrel: `export * from` both modules\n");

  const report = analyseBundle(root, bundlePath);

  console.log(`${report.totalExports} exports found in source, bundle is ${report.bundleBytes} bytes\n`);

  console.log(`dropped (correctly shaken, ${report.droppedFromBundle.length}):`);
  for (const exp of report.droppedFromBundle) console.log(`  ${path.relative(root, exp.file)}:${exp.line}  ${exp.name}`);

  console.log(`\nsurviving in the bundle (${report.survivingInBundle.length}):`);
  for (const exp of report.survivingInBundle) console.log(`  ${path.relative(root, exp.file)}:${exp.line}  ${exp.name}`);

  console.log(`\npossibly unshaken — every export in the file survived, which usually means`);
  console.log(`the whole module got pulled in rather than shaken per-export (${report.possiblyUnshaken.length}):`);
  for (const exp of report.possiblyUnshaken) console.log(`  ${path.relative(root, exp.file)}:${exp.line}  ${exp.name}`);

  console.log(`\nnote: strings.ts shows all 3 exports surviving even though only "capitalize" is`);
  console.log(`called — the "export * from" barrel in index.ts is the likely cause, and this is`);
  console.log(`exactly the kind of thing that stays invisible until you diff source against output.`);

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(bundlePath, { force: true });
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  const root = path.resolve(args[0]);
  const bundleIdx = args.indexOf("--bundle");
  if (bundleIdx < 0) {
    console.error("usage: treeshake.ts <src-dir> --bundle <bundle-file>");
    process.exit(1);
  }
  const report = analyseBundle(root, path.resolve(args[bundleIdx + 1]));
  console.log(`${report.totalExports} exports, ${report.droppedFromBundle.length} shaken, ${report.survivingInBundle.length} surviving`);
  console.log(`\npossibly unshaken (${report.possiblyUnshaken.length}):`);
  for (const exp of report.possiblyUnshaken) console.log(`  ${path.relative(root, exp.file)}:${exp.line}  ${exp.name}`);
}

main();
