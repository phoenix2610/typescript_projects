#!/usr/bin/env -S node
/**
 * Prompt for options and render a template tree with variable substitution.
 *
 *   node scaffold.ts new my-service --template node-cli
 *   node scaffold.ts --demo
 *
 * Templates are plain files with `{{variable}}` placeholders in both their
 * content and their path — a file literally named `{{name}}.config.ts` becomes
 * `payments.config.ts` once the name variable is bound. Conditional files (a
 * `.github/workflows/ci.yml` that should only appear when `withCI` is true) are
 * expressed with a `{{#if flag}}...{{/if}}` guard around the whole file's path
 * segment, not a separate config format to learn.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface TemplateFile {
  path: string; // may contain {{var}} placeholders, and an optional {{#if flag}}segment{{/if}}
  content: string;
}

interface Template {
  name: string;
  description: string;
  variables: { name: string; prompt: string; default?: string; type: "string" | "boolean" }[];
  files: TemplateFile[];
}

function substitute(text: string, vars: Record<string, string | boolean>): string {
  let out = text.replace(/\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, flag, inner) => (vars[flag] ? inner : ""));
  out = out.replace(/\{\{(\w+)\}\}/g, (_, key) => String(vars[key] ?? ""));
  return out;
}

interface RenderedFile {
  path: string;
  content: string;
  skipped: boolean;
}

function renderTemplate(template: Template, vars: Record<string, string | boolean>): RenderedFile[] {
  const rendered: RenderedFile[] = [];
  for (const file of template.files) {
    const path = substitute(file.path, vars);
    if (path.trim() === "") {
      rendered.push({ path: file.path, content: "", skipped: true });
      continue;
    }
    rendered.push({ path, content: substitute(file.content, vars), skipped: false });
  }
  return rendered;
}

/** Fill in any variable the caller did not pass, from the template's declared default. */
function applyDefaults(template: Template, provided: Record<string, string | boolean>): Record<string, string | boolean> {
  const merged: Record<string, string | boolean> = { ...provided };
  for (const v of template.variables) {
    if (v.name in merged || v.default === undefined) continue;
    merged[v.name] = v.type === "boolean" ? v.default === "true" : v.default;
  }
  return merged;
}

function validateVars(template: Template, provided: Record<string, string | boolean>): string[] {
  const errors: string[] = [];
  for (const v of template.variables) {
    if (v.type === "string" && v.default === undefined && !provided[v.name]) {
      errors.push(`missing required variable: ${v.name} (${v.prompt})`);
    }
    if (v.name === "name" && typeof provided.name === "string") {
      if (!/^[a-z][a-z0-9-]*$/.test(provided.name)) {
        errors.push(`"name" must be lowercase, alphanumeric and hyphens only (kebab-case) — got ${JSON.stringify(provided.name)}`);
      }
    }
  }
  return errors;
}

// ------------------------------------------------------------ built-in template

const NODE_CLI_TEMPLATE: Template = {
  name: "node-cli",
  description: "A minimal Node CLI tool with a package.json, entry point and optional CI",
  variables: [
    { name: "name", prompt: "package name (kebab-case)", type: "string" },
    { name: "author", prompt: "author name", default: "", type: "string" },
    { name: "withCI", prompt: "add a GitHub Actions workflow?", default: "false", type: "boolean" },
    { name: "withTests", prompt: "add a test file?", default: "true", type: "boolean" },
  ],
  files: [
    {
      path: "package.json",
      content: `{
  "name": "{{name}}",
  "version": "0.1.0",
  "description": "",
  "author": "{{author}}",
  "type": "module",
  "bin": { "{{name}}": "./bin/{{name}}.js" },
  "scripts": {
    "start": "node bin/{{name}}.js"{{#if withTests}},
    "test": "node --test"{{/if}}
  }
}
`,
    },
    {
      path: "bin/{{name}}.js",
      content: `#!/usr/bin/env node
console.log("{{name}} is running");
`,
    },
    {
      path: "README.md",
      content: `# {{name}}

## Usage

\`\`\`
npm install
npm start
\`\`\`
`,
    },
    {
      path: "{{#if withTests}}test/{{name}}.test.js{{/if}}",
      content: `import { test } from "node:test";
import assert from "node:assert";

test("{{name}} runs", () => {
  assert.ok(true);
});
`,
    },
    {
      path: "{{#if withCI}}.github/workflows/ci.yml{{/if}}",
      content: `name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm install
      - run: npm test
`,
    },
  ],
};

// ------------------------------------------------------------ demo

function printTree(files: RenderedFile[]): void {
  const kept = files.filter((f) => !f.skipped);
  const sorted = [...kept].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sorted) {
    const size = file.content.length;
    console.log(`  ${file.path}  (${size}B)`);
  }
}

function demo(): void {
  console.log(`template: ${NODE_CLI_TEMPLATE.name} — ${NODE_CLI_TEMPLATE.description}\n`);
  console.log("variables:");
  for (const v of NODE_CLI_TEMPLATE.variables) {
    console.log(`  ${v.name.padEnd(10)} ${v.type.padEnd(8)} ${v.prompt}${v.default !== undefined ? `  (default: ${v.default})` : ""}`);
  }

  console.log("\n--- scaffold 1: full-featured project ---\n");
  const answers1 = { name: "payments-cli", author: "Ana", withCI: true, withTests: true };
  const errors1 = validateVars(NODE_CLI_TEMPLATE, answers1);
  if (errors1.length) {
    console.log("validation errors:", errors1);
  } else {
    const files1 = renderTemplate(NODE_CLI_TEMPLATE, answers1);
    printTree(files1);
    console.log("\ngenerated package.json:\n");
    console.log(files1.find((f) => f.path === "package.json")!.content);
  }

  console.log("--- scaffold 2: minimal, no CI, no tests ---\n");
  const answers2 = { name: "quick-tool", author: "", withCI: false, withTests: false };
  const files2 = renderTemplate(NODE_CLI_TEMPLATE, answers2);
  printTree(files2);
  console.log(`\n  (${NODE_CLI_TEMPLATE.files.length} template files -> ${files2.filter((f) => !f.skipped).length} written: the CI workflow and test file were skipped by the {{#if}} guard)`);

  console.log("\n--- scaffold 3: an invalid name is caught before anything is written ---\n");
  const badAnswers = { name: "Not Valid! Name", author: "Cy", withCI: false, withTests: true };
  const errors3 = validateVars(NODE_CLI_TEMPLATE, badAnswers);
  console.log(`validation errors (${errors3.length}):`);
  for (const err of errors3) console.log(`  - ${err}`);

  console.log("\n--- scaffold 4: a required variable with no default is missing ---\n");
  const missingAnswers = { author: "Bo" };
  const errors4 = validateVars(NODE_CLI_TEMPLATE, missingAnswers);
  for (const err of errors4) console.log(`  - ${err}`);
}

function parseKeyValueArgs(argv: string[]): Record<string, string | boolean> {
  const vars: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--") && arg !== "--template") {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        vars[key] = next === "true" ? true : next === "false" ? false : next;
        i++;
      } else {
        vars[key] = true;
      }
    }
  }
  return vars;
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  const command = args[0];
  if (command !== "new") {
    console.log("usage: scaffold.ts new <target-dir> [--name value] [--withCI] ...");
    return;
  }
  const targetDir = args[1];
  const provided = parseKeyValueArgs(args.slice(2));
  provided.name = provided.name ?? path.basename(targetDir);
  const vars = applyDefaults(NODE_CLI_TEMPLATE, provided);

  const errors = validateVars(NODE_CLI_TEMPLATE, vars);
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(1);
  }

  const files = renderTemplate(NODE_CLI_TEMPLATE, vars);
  for (const file of files) {
    if (file.skipped) continue;
    const full = path.join(targetDir, file.path);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, file.content);
    console.log(`  created ${file.path}`);
  }
  console.log(`\n${files.filter((f) => !f.skipped).length} files written to ${targetDir}`);
}

main();
