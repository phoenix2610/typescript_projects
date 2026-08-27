#!/usr/bin/env -S node
/**
 * Group, sort and rewrite import blocks, using regex tokenizing rather than a real AST
 * (good enough for the common case, and dependency-free).
 *
 *   node importsort.ts src/App.tsx --write
 *   node importsort.ts --demo
 *
 * Imports are grouped into three tiers — Node builtins, external packages, then
 * relative imports — each tier sorted alphabetically, blank line between tiers.
 * Named specifiers within one import are also sorted, and duplicate imports from
 * the same module are merged into one statement rather than flagged as an error.
 * A tool that only complains is annoying; one that fixes it is useful.
 */

import * as fs from "node:fs";

const NODE_BUILTINS = new Set([
  "assert", "buffer", "child_process", "cluster", "crypto", "dns", "events",
  "fs", "http", "https", "net", "os", "path", "process", "querystring",
  "readline", "stream", "string_decoder", "timers", "tls", "url", "util",
  "v8", "vm", "zlib", "perf_hooks", "worker_threads",
]);

interface ImportStatement {
  raw: string;
  source: string;
  defaultName: string | null;
  namespaceName: string | null;
  named: string[];
  isTypeOnly: boolean;
  startLine: number;
  endLine: number;
}

function classify(source: string): "builtin" | "external" | "relative" {
  // strip both the "node:" prefix and any subpath ("fs/promises" -> "fs") before
  // checking the builtin set, or every node:*/... submodule falls through to "external"
  const bare = source.replace(/^node:/, "").split("/")[0];
  if (source.startsWith("node:") || NODE_BUILTINS.has(bare)) return "builtin";
  if (source.startsWith(".") || source.startsWith("/")) return "relative";
  return "external";
}

function parseImports(source: string): { statements: ImportStatement[]; blockEnd: number; blockStart: number } {
  const lines = source.split("\n");
  const statements: ImportStatement[] = [];
  let blockStart = -1;
  let blockEnd = -1;
  let i = 0;

  // skip a leading shebang or file-level comment banner before looking for imports
  while (i < lines.length && (lines[i].startsWith("#!") || lines[i].trim() === "" || lines[i].trim().startsWith("//") || lines[i].trim().startsWith("/*") || lines[i].trim().startsWith("*"))) {
    if (lines[i].trim() === "") break;
    i++;
  }
  while (i < lines.length && lines[i].trim() === "") i++;

  while (i < lines.length) {
    const line = lines[i];
    if (!/^import\s/.test(line.trim())) {
      if (blockStart >= 0) break; // first non-import line after imports have started ends the block
      i++;
      continue;
    }
    if (blockStart < 0) blockStart = i;

    let text = line;
    let end = i;
    while (!/;?\s*$/.test(text) || !text.includes("from")) {
      end++;
      if (end >= lines.length) break;
      text += " " + lines[end].trim();
    }
    // greedily also consume continuation lines until we see a semicolon or a quote-terminated "from '...'"
    while (!/from\s*["'][^"']+["'];?$/.test(text.trim()) && end + 1 < lines.length) {
      end++;
      text += " " + lines[end].trim();
    }

    const isTypeOnly = /^import\s+type\s/.test(text);
    const fromMatch = text.match(/from\s*["']([^"']+)["']/);
    const source_ = fromMatch ? fromMatch[1] : "";
    const clause = text.replace(/^import\s+(type\s+)?/, "").replace(/\s*from\s*["'][^"']+["'];?\s*$/, "");

    let defaultName: string | null = null;
    let namespaceName: string | null = null;
    const named: string[] = [];

    const namespaceMatch = clause.match(/\*\s+as\s+(\w+)/);
    if (namespaceMatch) namespaceName = namespaceMatch[1];

    const braceMatch = clause.match(/\{([^}]*)\}/);
    if (braceMatch) {
      for (const raw of braceMatch[1].split(",")) {
        const trimmed = raw.trim();
        if (trimmed) named.push(trimmed);
      }
    }

    const beforeBrace = clause.split("{")[0].replace(/,\s*$/, "").trim();
    const defaultCandidate = beforeBrace.replace(/\*\s+as\s+\w+/, "").trim();
    if (defaultCandidate && !defaultCandidate.includes("*")) defaultName = defaultCandidate;

    statements.push({ raw: text.trim(), source: source_, defaultName, namespaceName, named: named.sort(), isTypeOnly, startLine: i, endLine: end });
    i = end + 1;
    blockEnd = end;
  }

  return { statements, blockStart, blockEnd };
}

function mergeDuplicates(statements: ImportStatement[]): ImportStatement[] {
  const bySource = new Map<string, ImportStatement>();
  const order: string[] = [];
  for (const stmt of statements) {
    const key = `${stmt.source}::${stmt.isTypeOnly}`;
    const existing = bySource.get(key);
    if (existing) {
      existing.named = [...new Set([...existing.named, ...stmt.named])].sort();
      existing.defaultName = existing.defaultName ?? stmt.defaultName;
      existing.namespaceName = existing.namespaceName ?? stmt.namespaceName;
    } else {
      bySource.set(key, { ...stmt });
      order.push(key);
    }
  }
  return order.map((k) => bySource.get(k)!);
}

function renderImport(stmt: ImportStatement): string {
  const typePrefix = stmt.isTypeOnly ? "type " : "";
  const parts: string[] = [];
  if (stmt.defaultName) parts.push(stmt.defaultName);
  if (stmt.namespaceName) parts.push(`* as ${stmt.namespaceName}`);
  if (stmt.named.length) parts.push(`{ ${stmt.named.join(", ")} }`);
  const clause = parts.length ? `${typePrefix}${parts.join(", ")} from ` : `${typePrefix}`;
  return `import ${clause}"${stmt.source}";`;
}

function sortAndGroup(statements: ImportStatement[]): string {
  const merged = mergeDuplicates(statements);
  const groups: Record<"builtin" | "external" | "relative", ImportStatement[]> = { builtin: [], external: [], relative: [] };
  for (const stmt of merged) groups[classify(stmt.source)].push(stmt);

  const renderGroup = (list: ImportStatement[]): string[] =>
    [...list].sort((a, b) => a.source.localeCompare(b.source)).map(renderImport);

  const blocks = [renderGroup(groups.builtin), renderGroup(groups.external), renderGroup(groups.relative)].filter((b) => b.length > 0);
  return blocks.map((b) => b.join("\n")).join("\n\n");
}

function fixFile(source: string): { fixed: string; changed: boolean; before: number; after: number } {
  const { statements, blockStart, blockEnd } = parseImports(source);
  if (statements.length === 0) return { fixed: source, changed: false, before: 0, after: 0 };

  const lines = source.split("\n");
  const sorted = sortAndGroup(statements);
  const rest = lines.slice(blockEnd + 1);
  while (rest.length && rest[0].trim() === "") rest.shift();

  const newLines = [...lines.slice(0, blockStart), sorted, "", ...rest];
  const fixed = newLines.join("\n");
  const merged = mergeDuplicates(statements);
  return { fixed, changed: fixed !== source, before: statements.length, after: merged.length };
}

// ------------------------------------------------------------ demo

const SAMPLE = `import React from "react";
import { z } from "zod";
import path from "node:path";
import { formatDate } from "./utils/dates";
import fs from "fs";
import { logger } from "../logger";
import { z as zodAgain } from "zod";
import { readFile } from "node:fs/promises";
import type { Config } from "./types";
import { slugify } from "./utils/dates";
import express from "express";

const app = express();
console.log(React, z, path, formatDate, fs, logger, zodAgain, readFile, Config, slugify);
app.listen(3000);
`;

function demo(): void {
  console.log("before:\n");
  console.log(SAMPLE.split("\n").slice(0, 12).join("\n"));

  const result = fixFile(SAMPLE);
  console.log("\nafter:\n");
  const importBlockEnd = result.fixed.indexOf("\n\nconst app");
  console.log(result.fixed.slice(0, importBlockEnd));

  console.log(`\n${result.before} import statements -> ${result.after} after merging duplicates (zod was imported twice)`);
  console.log("grouped: node builtins, then external packages, then relative imports — each group alphabetised");
  console.log(`file changed: ${result.changed}`);

  console.log("\n\n--- idempotency check: running the fixer on its own output changes nothing ---");
  const second = fixFile(result.fixed);
  console.log(`second pass changed anything: ${second.changed}`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  const file = args[0];
  const write = args.includes("--write");
  const source = fs.readFileSync(file, "utf8");
  const result = fixFile(source);
  if (!result.changed) {
    console.log(`${file}: imports already sorted`);
    return;
  }
  if (write) {
    fs.writeFileSync(file, result.fixed);
    console.log(`${file}: fixed (${result.before} -> ${result.after} import statements)`);
  } else {
    console.log(result.fixed);
  }
}

main();
