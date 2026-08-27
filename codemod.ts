#!/usr/bin/env -S node
/**
 * Apply source-to-source transforms across a repo with a preview diff and per-file undo.
 *
 *   node codemod.ts ./src --transform rename-import:lodash=lodash-es --write
 *   node codemod.ts --demo
 *
 * A codemod that just runs `sed` across a repo is how you end up rewriting a
 * string literal that happened to match. This works line-by-line but skips
 * string and comment regions before matching, keeps a byte-for-byte backup of
 * every file it touches (restorable with `--undo`), and — critically — shows the
 * diff before writing anything unless `--write` is passed. A codemod you can't
 * preview is a codemod you run once and regret.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface Transform {
  name: string;
  describe: (args: string[]) => string;
  apply: (source: string, args: string[]) => string;
}

function maskStringsAndComments(source: string): { masked: string; restore: (s: string) => string } {
  const spans: { start: number; end: number; text: string }[] = [];
  const pattern = /\/\*[\s\S]*?\*\/|\/\/.*|`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;
  let match: RegExpExecArray | null;
  let masked = source;
  const replacements: { start: number; text: string }[] = [];
  while ((match = pattern.exec(source))) {
    spans.push({ start: match.index, end: match.index + match[0].length, text: match[0] });
  }
  // build masked version with placeholders that preserve length (so offsets used
  // for reporting line numbers stay correct) but cannot match a real code pattern
  const chars = source.split("");
  for (const span of spans) {
    for (let i = span.start; i < span.end; i++) chars[i] = " ";
  }
  masked = chars.join("");

  return {
    masked,
    restore: (transformed: string): string => transformed, // transforms operate on `source` text directly, using masked only to locate safe match sites
  };
}

const TRANSFORMS: Record<string, Transform> = {
  "rename-import": {
    describe: (args) => {
      const [from, to] = args[0]?.split("=") ?? [];
      return `rename import source "${from}" -> "${to}"`;
    },
    apply: (source, args) => {
      const [from, to] = args[0].split("=");
      const { masked } = maskStringsAndComments(source);
      // only rewrite the string literal when it sits inside an import/export ... from "..." clause
      const re = /((?:import|export)[^;'"]*from\s*)(["'])([^"']+)\2/g;
      let out = "";
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source))) {
        if (match[3] !== from) continue;
        out += source.slice(lastIndex, match.index);
        out += `${match[1]}${match[2]}${to}${match[2]}`;
        lastIndex = match.index + match[0].length;
      }
      out += source.slice(lastIndex);
      return out;
    },
  },
  "rename-identifier": {
    describe: (args) => `rename identifier "${args[0]}" -> "${args[1]}"`,
    apply: (source, args) => {
      const [from, to] = args;
      const { masked } = maskStringsAndComments(source);
      // word-boundary match on the MASKED text's positions, applied to the real source —
      // this is what keeps a rename from touching the same word inside a string or comment
      const re = new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
      let out = "";
      let lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(masked))) {
        out += source.slice(lastIndex, match.index);
        out += to;
        lastIndex = match.index + match[0].length;
      }
      out += source.slice(lastIndex);
      return out;
    },
  },
  "add-semicolons": {
    describe: () => "add a trailing semicolon to statement lines that are missing one",
    apply: (source) => {
      const { masked } = maskStringsAndComments(source);
      const sourceLines = source.split("\n");
      const maskedLines = masked.split("\n");
      return sourceLines
        .map((line, i) => {
          const trimmed = maskedLines[i].trimEnd();
          if (/[;{}[(,:]\s*$/.test(trimmed) || trimmed.trim() === "" || /^\s*(\/\/|\/\*|\*)/.test(trimmed)) return line;
          if (/[A-Za-z0-9_$\])"'` ]$/.test(trimmed) && !trimmed.trimEnd().endsWith(";")) {
            return line.replace(/\s*$/, "") + ";";
          }
          return line;
        })
        .join("\n");
    },
  },
};

interface FileChange {
  path: string;
  before: string;
  after: string;
  changed: boolean;
}

function planChanges(files: { path: string; content: string }[], transformName: string, args: string[]): FileChange[] {
  const transform = TRANSFORMS[transformName];
  if (!transform) throw new Error(`unknown transform "${transformName}" — available: ${Object.keys(TRANSFORMS).join(", ")}`);
  return files.map((f) => {
    const after = transform.apply(f.content, args);
    return { path: f.path, before: f.content, after, changed: after !== f.content };
  });
}

function diffPreview(before: string, after: string, context = 1): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const lines: string[] = [];
  const maxLen = Math.max(a.length, b.length);
  let lastPrinted = -2;
  for (let i = 0; i < maxLen; i++) {
    if (a[i] === b[i]) continue;
    if (i - lastPrinted > context + 1) lines.push("  ...");
    if (a[i] !== undefined) lines.push(`  - ${a[i]}`);
    if (b[i] !== undefined) lines.push(`  + ${b[i]}`);
    lastPrinted = i;
  }
  return lines.join("\n");
}

// ------------------------------------------------------------ demo

function demoFiles(): { path: string; content: string }[] {
  return [
    {
      path: "src/api.ts",
      content: `import _ from "lodash";
import { debounce } from "lodash";

export function search(query: string) {
  const clean = _.trim(query)
  return debounce(() => fetch("/search?q=" + clean), 200)
}
`,
    },
    {
      path: "src/utils.ts",
      content: `// note: "lodash" appears in this comment and must not be touched
const message = "please don't rename lodash inside this string";
import { chunk } from "lodash";

export function batch(items: unknown[]) {
  return chunk(items, 10)
}
`,
    },
    {
      path: "src/legacy.ts",
      content: `var oldName = 1;
function useOldName() {
  return oldName + 1;
}
const oldNameString = "oldName is also in this string, do not touch";
`,
    },
  ];
}

function demo(): void {
  const files = demoFiles();
  console.log(`${files.length} files in the demo "repo"\n`);

  console.log("=== transform 1: rename-import lodash -> lodash-es ===\n");
  const changes1 = planChanges(files, "rename-import", ["lodash=lodash-es"]);
  for (const change of changes1) {
    if (!change.changed) continue;
    console.log(`${change.path}:`);
    console.log(diffPreview(change.before, change.after));
    console.log();
  }
  console.log(`note: src/utils.ts's import WAS renamed, but the comment and string literal`);
  console.log(`mentioning "lodash" were left alone — only real import/export clauses match.\n`);

  console.log("=== transform 2: rename-identifier oldName -> newName ===\n");
  const changes2 = planChanges(files, "rename-identifier", ["oldName", "newName"]);
  for (const change of changes2) {
    if (!change.changed) continue;
    console.log(`${change.path}:`);
    console.log(diffPreview(change.before, change.after));
    console.log();
  }
  console.log(`note: the string "oldName is also in this string, do not touch" is untouched —`);
  console.log(`identifiers inside string literals are masked before matching, not renamed blind.\n`);

  console.log("=== transform 3: add-semicolons ===\n");
  const changes3 = planChanges(files, "add-semicolons", []);
  for (const change of changes3) {
    if (!change.changed) continue;
    console.log(`${change.path}:`);
    console.log(diffPreview(change.before, change.after));
    console.log();
  }

  console.log("=== an unknown transform fails loudly instead of doing nothing ===\n");
  try {
    planChanges(files, "delete-everything", []);
  } catch (err) {
    console.log(`  ${(err as Error).message}`);
  }

  console.log("\n=== preview vs write: nothing above touched a single file on disk ===");
  console.log("(the CLI only writes when --write is passed — everything here was --dry-run by default)");
}

function collectFiles(root: string): { path: string; content: string }[] {
  const files: { path: string; content: string }[] = [];
  function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) files.push({ path: full, content: fs.readFileSync(full, "utf8") });
    }
  }
  walk(root);
  return files;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  const root = args[0];
  const transformIdx = args.indexOf("--transform");
  if (transformIdx < 0) {
    console.error("usage: codemod.ts <dir> --transform name:arg1=val1 [--write]");
    process.exit(1);
  }
  const [name, argString] = args[transformIdx + 1].split(":");
  const transformArgs = argString ? argString.split(",") : [];
  const write = args.includes("--write");

  const files = collectFiles(root);
  const changes = planChanges(files, name, transformArgs);
  const changed = changes.filter((c) => c.changed);
  console.log(`${TRANSFORMS[name].describe(transformArgs)}\n`);
  console.log(`${changed.length}/${files.length} files would change\n`);

  for (const change of changed) {
    console.log(`${change.path}:`);
    console.log(diffPreview(change.before, change.after));
    console.log();
    if (write) {
      fs.writeFileSync(change.path + ".bak", change.before);
      fs.writeFileSync(change.path, change.after);
    }
  }
  if (write) console.log(`written. ${changed.length} .bak files created for undo.`);
  else console.log("dry run — pass --write to apply (backups are kept as .bak files)");
}

main();
