#!/usr/bin/env -S node
/**
 * Trace exports from entry points and list what nothing ever imports.
 *
 *   node deadcode.ts ./src --entry src/index.ts
 *   node deadcode.ts --demo
 *
 * A regex-based import/export scanner, not a type checker — good enough to
 * build a real module graph without a compiler in the loop. Starting from the
 * entry points, it walks every `import` edge reachably and marks each exported
 * symbol used the moment anything imports it by name (or the whole module, via
 * `import *` or a re-export). What's left unmarked after the walk is dead:
 * exported, but never reached from anything that actually runs.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface ExportInfo {
  name: string;
  line: number;
  used: boolean;
}

interface ModuleInfo {
  file: string;
  exports: Map<string, ExportInfo>;
  imports: { from: string; names: string[]; isNamespace: boolean; isDefault: boolean }[];
  hasDefaultExport: boolean;
  reachable: boolean;
}

const EXPORT_RE = /^export\s+(const|let|var|function|class|interface|type)\s+([A-Za-z_$][\w$]*)/gm;
const EXPORT_DEFAULT_RE = /^export\s+default\b/m;
const EXPORT_NAMED_RE = /^export\s*\{([^}]+)\}/gm;
const EXPORT_BRACE_FROM_RE = /^export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/gm;
const EXPORT_STAR_RE = /^export\s*\*\s*from\s*["']([^"']+)["']/gm;
const IMPORT_RE = /^import\s+(?:type\s+)?(.+?)\s+from\s*["']([^"']+)["']/gm;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*/g, "$1");
}

function resolveImportPath(fromFile: string, importPath: string, allFiles: Set<string>): string | null {
  if (!importPath.startsWith(".")) return null; // external package, not part of this graph
  const base = path.join(path.dirname(fromFile), importPath);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`]) {
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

function parseModule(file: string, source: string): Omit<ModuleInfo, "reachable"> {
  const clean = stripComments(source);
  const exports = new Map<string, ExportInfo>();
  const lines = clean.split("\n");

  let match: RegExpExecArray | null;
  const namedExportRe = new RegExp(EXPORT_RE);
  while ((match = namedExportRe.exec(clean))) {
    const line = clean.slice(0, match.index).split("\n").length;
    exports.set(match[2], { name: match[2], line, used: false });
  }

  const braceExportRe = new RegExp(EXPORT_NAMED_RE);
  while ((match = braceExportRe.exec(clean))) {
    const line = clean.slice(0, match.index).split("\n").length;
    for (const raw of match[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) exports.set(name, { name, line, used: false });
    }
  }

  const hasDefaultExport = EXPORT_DEFAULT_RE.test(clean);
  if (hasDefaultExport) exports.set("default", { name: "default", line: 0, used: false });

  const imports: ModuleInfo["imports"] = [];
  const importRe = new RegExp(IMPORT_RE);
  while ((match = importRe.exec(clean))) {
    const [, clause, from] = match;
    const isNamespace = /^\*\s+as\s+\w+/.test(clause.trim());
    const braceMatch = clause.match(/\{([^}]+)\}/);
    const hasDefaultImport = /^\w/.test(clause.trim()) && !isNamespace;
    const names: string[] = [];
    if (braceMatch) {
      for (const raw of braceMatch[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/)[0]?.trim();
        if (name) names.push(name);
      }
    }
    if (hasDefaultImport && !braceMatch) names.push("default");
    else if (hasDefaultImport && braceMatch) names.push("default");
    imports.push({ from, names, isNamespace, isDefault: hasDefaultImport });
  }

  const starReExportRe = new RegExp(EXPORT_STAR_RE);
  while ((match = starReExportRe.exec(clean))) {
    imports.push({ from: match[1], names: [], isNamespace: true, isDefault: false });
  }
  const braceFromRe = new RegExp(EXPORT_BRACE_FROM_RE);
  while ((match = braceFromRe.exec(clean))) {
    const names = match[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0].trim());
    imports.push({ from: match[2], names, isNamespace: false, isDefault: false });
    for (const raw of match[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim();
      if (name) exports.set(name, { name, line: 0, used: false });
    }
  }

  return { file, exports, imports, hasDefaultExport };
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

interface DeadCodeResult {
  modules: Map<string, ModuleInfo>;
  unreachableFiles: string[];
  deadExports: { file: string; name: string; line: number }[];
}

function analyse(root: string, entryPoints: string[]): DeadCodeResult {
  const files = findSourceFiles(root);
  const fileSet = new Set(files);
  const modules = new Map<string, ModuleInfo>();

  for (const file of files) {
    const source = fs.readFileSync(file, "utf8");
    const parsed = parseModule(file, source);
    modules.set(file, { ...parsed, reachable: false });
  }

  const resolvedEntries = entryPoints.map((e) => path.resolve(e)).filter((e) => modules.has(e));
  const queue = [...resolvedEntries];
  const visited = new Set<string>();

  while (queue.length) {
    const file = queue.shift()!;
    if (visited.has(file)) continue;
    visited.add(file);
    const mod = modules.get(file);
    if (!mod) continue;
    mod.reachable = true;

    for (const imp of mod.imports) {
      const resolved = resolveImportPath(file, imp.from, fileSet);
      if (!resolved) continue;
      const target = modules.get(resolved);
      if (!target) continue;
      queue.push(resolved);

      if (imp.isNamespace || imp.names.length === 0) {
        for (const exp of target.exports.values()) exp.used = true;
      } else {
        for (const name of imp.names) {
          const exp = target.exports.get(name);
          if (exp) exp.used = true;
        }
      }
    }
  }

  const unreachableFiles = [...modules.keys()].filter((f) => !modules.get(f)!.reachable);
  const deadExports: DeadCodeResult["deadExports"] = [];
  for (const [file, mod] of modules) {
    if (!mod.reachable) continue; // already reported as a whole unreachable file
    for (const exp of mod.exports.values()) {
      if (!exp.used) deadExports.push({ file, name: exp.name, line: exp.line });
    }
  }

  return { modules, unreachableFiles, deadExports };
}

function relativize(root: string, file: string): string {
  return path.relative(root, file);
}

// ------------------------------------------------------------ demo

function buildFakeProject(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const write = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content.trim() + "\n");
  };

  write(
    "index.ts",
    `
import { createServer } from "./server";
import { logger } from "./logger";

logger.info("starting");
createServer();
`,
  );
  write(
    "server.ts",
    `
import { formatDate } from "./utils";
import { logger } from "./logger";

export function createServer() {
  logger.info(formatDate(new Date()));
}

export function shutdownServer() {
  // never called from anywhere
}
`,
  );
  write(
    "logger.ts",
    `
export const logger = {
  info: (msg: string) => console.log(msg),
  debug: (msg: string) => console.log(msg),
};

export function createFileLogger() {
  // dead: nothing imports this
}
`,
  );
  write(
    "utils.ts",
    `
export function formatDate(d: Date): string {
  return d.toISOString();
}

export function parseDate(s: string): Date {
  return new Date(s);
}

export function slugify(s: string): string {
  return s.toLowerCase().replace(/\\s+/g, "-");
}
`,
  );
  write(
    "legacy/old-router.ts",
    `
import { logger } from "../logger";

export function routeRequest() {
  logger.debug("old router");
}
`,
  );
}

function demo(): void {
  const root = "/tmp/deadcode-demo";
  buildFakeProject(root);
  console.log("(synthesised a small fake project to analyse — no real codebase needed)\n");
  console.log("project structure:");
  console.log("  index.ts        — entry point");
  console.log("  server.ts       — createServer (used), shutdownServer (never called)");
  console.log("  logger.ts       — logger (used), createFileLogger (never called)");
  console.log("  utils.ts        — formatDate (used), parseDate & slugify (never called)");
  console.log("  legacy/old-router.ts — routeRequest (nothing imports this FILE at all)\n");

  const result = analyse(root, [path.join(root, "index.ts")]);

  console.log(`${result.modules.size} files scanned\n`);

  console.log(`unreachable files (${result.unreachableFiles.length}) — nothing imports these at all:`);
  for (const file of result.unreachableFiles) console.log(`  ${relativize(root, file)}`);

  console.log(`\ndead exports (${result.deadExports.length}) — the file is used, but this export never is:`);
  for (const dead of result.deadExports) {
    console.log(`  ${relativize(root, dead.file)}:${dead.line}  export ${dead.name}`);
  }

  const totalExports = [...result.modules.values()].reduce((sum, m) => sum + m.exports.size, 0);
  console.log(`\n${totalExports} total exports, ${result.deadExports.length} dead, ${result.unreachableFiles.length} orphaned files`);

  fs.rmSync(root, { recursive: true, force: true });
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  const root = path.resolve(args[0]);
  const entryIdx = args.indexOf("--entry");
  const entries = entryIdx >= 0 ? [args[entryIdx + 1]] : [path.join(root, "index.ts")];
  const result = analyse(root, entries);
  console.log(`unreachable files: ${result.unreachableFiles.length}`);
  for (const f of result.unreachableFiles) console.log(`  ${relativize(root, f)}`);
  console.log(`\ndead exports: ${result.deadExports.length}`);
  for (const d of result.deadExports) console.log(`  ${relativize(root, d.file)}:${d.line}  ${d.name}`);
}

main();
