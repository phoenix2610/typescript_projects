#!/usr/bin/env -S node
/**
 * Count implicit `any` across the project and fail a build over a threshold.
 *
 *   node typecov.ts ./src --threshold 95
 *   node typecov.ts --demo
 *
 * "Strict mode" is a per-file, all-or-nothing switch — a codebase with 400 files
 * and 3 legacy ones full of `any` either fails strict entirely or turns it off
 * everywhere. This instead scores type coverage as a percentage: every explicit
 * `: any` annotation, every untyped function parameter, and every bare `as any`
 * cast counts against the file it's in, so coverage can ratchet up file by file
 * instead of demanding one all-or-nothing jump.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface AnyUsage {
  file: string;
  line: number;
  kind: "explicit-any" | "as-any" | "untyped-param" | "any-array";
  context: string;
}

function stripStringsAndComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/.*/g, (m) => " ".repeat(m.length))
    .replace(/`(?:[^`\\]|\\.)*`/g, (m) => " ".repeat(m.length))
    .replace(/"(?:[^"\\]|\\.)*"/g, (m) => " ".repeat(m.length))
    .replace(/'(?:[^'\\]|\\.)*'/g, (m) => " ".repeat(m.length));
}

function lineAt(source: string, index: number): number {
  return source.slice(0, index).split("\n").length;
}

function findAnyUsages(file: string, source: string): AnyUsage[] {
  const usages: AnyUsage[] = [];
  const clean = stripStringsAndComments(source);

  // `: any` in a type position (parameter, return type, variable annotation)
  const explicitAnyRe = /:\s*any\b(?!\[\])/g;
  let match: RegExpExecArray | null;
  while ((match = explicitAnyRe.exec(clean))) {
    usages.push({ file, line: lineAt(source, match.index), kind: "explicit-any", context: contextLine(source, match.index) });
  }

  const anyArrayRe = /:\s*any\[\]/g;
  while ((match = anyArrayRe.exec(clean))) {
    usages.push({ file, line: lineAt(source, match.index), kind: "any-array", context: contextLine(source, match.index) });
  }

  const asAnyRe = /\bas\s+any\b/g;
  while ((match = asAnyRe.exec(clean))) {
    usages.push({ file, line: lineAt(source, match.index), kind: "as-any", context: contextLine(source, match.index) });
  }

  // untyped function parameters: `function f(x)` or `(x) =>` with no `: Type` before , or )
  const fnParamsRe = /(?:function\s+\w*\s*|=>|\bconstructor)?\(([^)]*)\)\s*(?::\s*\w|=>|\{)/g;
  while ((match = fnParamsRe.exec(clean))) {
    const params = match[1].split(",").map((p) => p.trim()).filter(Boolean);
    for (const param of params) {
      if (param.includes(":") || param.startsWith("...") || param === "" || /^\{|^\[/.test(param)) continue;
      if (/^(this|self)$/.test(param.split(/[?=]/)[0].trim())) continue;
      usages.push({ file, line: lineAt(source, match.index), kind: "untyped-param", context: contextLine(source, match.index) });
    }
  }

  return usages;
}

function contextLine(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end < 0 ? undefined : end).trim();
}

interface FileScore {
  file: string;
  totalSites: number;
  anySites: number;
  coverage: number;
}

/** Coverage per file: how many "typeable sites" (declared params + annotations we can see)
 *  are NOT `any`, out of every one we found. A crude proxy for `--strict` compliance,
 *  computable without running the compiler. */
function scoreFile(file: string, source: string): FileScore {
  const usages = findAnyUsages(file, source);
  const anySites = usages.length;
  // approximate total typeable sites: count colons that look like type annotations, plus params
  const clean = stripStringsAndComments(source);
  const annotationSites = (clean.match(/:\s*[\w<>[\]{}| .]+(?=[,;)=]|\s*$)/gm) ?? []).length;
  const totalSites = Math.max(annotationSites, anySites);
  const coverage = totalSites === 0 ? 100 : Math.round(((totalSites - anySites) / totalSites) * 1000) / 10;
  return { file, totalSites, anySites, coverage };
}

function findSourceFiles(root: string): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(full);
    }
  }
  walk(root);
  return files;
}

interface ProjectReport {
  files: FileScore[];
  totalSites: number;
  totalAny: number;
  overallCoverage: number;
  worstFiles: FileScore[];
}

function analyseProject(root: string): ProjectReport {
  const files = findSourceFiles(root).map((f) => scoreFile(f, fs.readFileSync(f, "utf8")));
  const totalSites = files.reduce((s, f) => s + f.totalSites, 0);
  const totalAny = files.reduce((s, f) => s + f.anySites, 0);
  const overallCoverage = totalSites === 0 ? 100 : Math.round(((totalSites - totalAny) / totalSites) * 1000) / 10;
  const worstFiles = [...files].filter((f) => f.anySites > 0).sort((a, b) => a.coverage - b.coverage).slice(0, 5);
  return { files, totalSites, totalAny, overallCoverage, worstFiles };
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
    "utils.ts",
    `
export function add(a: number, b: number): number {
  return a + b;
}

export function formatName(first: string, last: string): string {
  return \`\${first} \${last}\`;
}
`,
  );
  write(
    "legacy/parser.ts",
    `
export function parseConfig(raw: any): any {
  const result: any = JSON.parse(raw);
  return result;
}

export function transform(items) {
  return items.map((x) => x as any);
}
`,
  );
  write(
    "api/handler.ts",
    `
export function handleRequest(req: Request, res: any): void {
  const body: any[] = [];
  res.send(body);
}
`,
  );
}

function demo(): void {
  const root = "/tmp/typecov-demo";
  buildFakeProject(root);
  console.log("(synthesised a fake project with a clean file and two files with any leaks)\n");

  const report = analyseProject(root);

  console.log(`overall type coverage: ${report.overallCoverage}%  (${report.totalSites - report.totalAny}/${report.totalSites} typeable sites are not 'any')\n`);

  console.log("per-file scores:");
  for (const f of [...report.files].sort((a, b) => a.coverage - b.coverage)) {
    const bar = "#".repeat(Math.round(f.coverage / 5)).padEnd(20);
    console.log(`  ${f.coverage.toFixed(1).padStart(5)}%  ${bar}  ${path.relative(root, f.file)}  (${f.anySites} any)`);
  }

  console.log("\nworst offenders, with context:");
  for (const f of report.worstFiles) {
    console.log(`\n  ${path.relative(root, f.file)} (${f.coverage}%):`);
    const usages = findAnyUsages(f.file, fs.readFileSync(f.file, "utf8"));
    for (const u of usages.slice(0, 4)) console.log(`    line ${u.line}  [${u.kind}]  ${u.context}`);
  }

  console.log("\n--- CI gate check ---\n");
  for (const threshold of [70, 90, 95]) {
    const passes = report.overallCoverage >= threshold;
    console.log(`  threshold ${threshold}%: ${passes ? "PASS" : "FAIL"} (project is at ${report.overallCoverage}%)`);
  }

  fs.rmSync(root, { recursive: true, force: true });
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  const root = path.resolve(args[0]);
  const thresholdIdx = args.indexOf("--threshold");
  const threshold = thresholdIdx >= 0 ? Number(args[thresholdIdx + 1]) : 0;
  const report = analyseProject(root);
  console.log(`type coverage: ${report.overallCoverage}%`);
  for (const f of report.worstFiles) console.log(`  ${f.coverage}%  ${path.relative(root, f.file)}  (${f.anySites} any)`);
  if (threshold > 0 && report.overallCoverage < threshold) {
    console.error(`\nFAIL: coverage ${report.overallCoverage}% is below the ${threshold}% threshold`);
    process.exit(1);
  }
}

main();
