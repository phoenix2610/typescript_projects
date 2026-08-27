#!/usr/bin/env -S node
/**
 * Report install size and the heaviest transitive dependencies of a package tree.
 *
 *   node pkgsize.ts ./node_modules
 *   node pkgsize.ts --demo
 *
 * Walks node_modules on disk (not the manifest — a package can be hoisted,
 * deduped, or nested several ways) and sums real bytes per package folder,
 * counting a package once even if npm nested a duplicate copy under several
 * parents. The "who pulled this in" question is answered by reading each
 * package.json's dependencies and building a reverse edge from install size
 * up through the tree that requested it.
 */

import * as fs from "node:fs";
import * as path from "node:path";

interface PackageInfo {
  name: string;
  version: string;
  selfBytes: number;
  fileCount: number;
  dependencies: string[];
  dir: string;
}

function dirSize(dir: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    if (entry.name === "node_modules") continue; // nested deps are counted as their own packages
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const sub = dirSize(full);
      bytes += sub.bytes;
      files += sub.files;
    } else if (entry.isFile()) {
      try {
        bytes += fs.statSync(full).size;
        files++;
      } catch {
        // race with a concurrent install; skip
      }
    }
  }
  return { bytes, files };
}

function findPackageDirs(nodeModulesRoot: string): string[] {
  const dirs: string[] = [];
  function walk(root: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith("@")) {
        const scopeDir = path.join(root, entry.name);
        for (const scoped of fs.readdirSync(scopeDir, { withFileTypes: true })) {
          if (scoped.isDirectory()) dirs.push(path.join(scopeDir, scoped.name));
        }
        continue;
      }
      if (entry.name === ".bin") continue;
      dirs.push(path.join(root, entry.name));
      const nested = path.join(root, entry.name, "node_modules");
      if (fs.existsSync(nested)) walk(nested);
    }
  }
  walk(nodeModulesRoot);
  return dirs;
}

function scanPackages(nodeModulesRoot: string): Map<string, PackageInfo> {
  const packages = new Map<string, PackageInfo>();
  for (const dir of findPackageDirs(nodeModulesRoot)) {
    const manifestPath = path.join(dir, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    let manifest: { name?: string; version?: string; dependencies?: Record<string, string> };
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch {
      continue;
    }
    const name = manifest.name ?? path.basename(dir);
    const key = `${name}@${manifest.version ?? "?"}`;
    if (packages.has(key)) continue; // same name+version installed twice (nested dedupe): count once
    const { bytes, files } = dirSize(dir);
    packages.set(key, {
      name,
      version: manifest.version ?? "0.0.0",
      selfBytes: bytes,
      fileCount: files,
      dependencies: Object.keys(manifest.dependencies ?? {}),
      dir,
    });
  }
  return packages;
}

function humanBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(2)}MB`;
}

/** Sum of a package plus every transitive dependency reachable from it, cycle-safe. */
function transitiveSize(packages: Map<string, PackageInfo>, byName: Map<string, PackageInfo[]>, rootKey: string): { bytes: number; count: number } {
  const seen = new Set<string>();
  let bytes = 0;
  function visit(key: string): void {
    if (seen.has(key)) return;
    seen.add(key);
    const pkg = packages.get(key);
    if (!pkg) return;
    bytes += pkg.selfBytes;
    for (const depName of pkg.dependencies) {
      const candidates = byName.get(depName);
      if (!candidates || candidates.length === 0) continue;
      // resolution ambiguity (multiple versions installed): charge the largest, the pessimistic bound
      const heaviest = candidates.reduce((a, b) => (a.selfBytes > b.selfBytes ? a : b));
      visit(`${heaviest.name}@${heaviest.version}`);
    }
  }
  visit(rootKey);
  return { bytes, count: seen.size };
}

function analyse(nodeModulesRoot: string): void {
  const packages = scanPackages(nodeModulesRoot);
  if (packages.size === 0) {
    console.log(`no packages found under ${nodeModulesRoot}`);
    return;
  }
  const byName = new Map<string, PackageInfo[]>();
  for (const pkg of packages.values()) {
    const list = byName.get(pkg.name) ?? [];
    list.push(pkg);
    byName.set(pkg.name, list);
  }

  const totalBytes = [...packages.values()].reduce((sum, p) => sum + p.selfBytes, 0);
  const totalFiles = [...packages.values()].reduce((sum, p) => sum + p.fileCount, 0);

  console.log(`${packages.size} packages, ${humanBytes(totalBytes)} total, ${totalFiles} files\n`);

  const byOwnSize = [...packages.entries()].sort((a, b) => b[1].selfBytes - a[1].selfBytes).slice(0, 10);
  console.log("heaviest packages (their own files, not what they depend on):");
  for (const [key, pkg] of byOwnSize) {
    console.log(`  ${humanBytes(pkg.selfBytes).padStart(9)}  ${key}  (${pkg.fileCount} files)`);
  }

  console.log("\nheaviest by transitive weight (self + everything they pull in):");
  const transitive = [...packages.entries()]
    .map(([key, pkg]) => ({ key, pkg, ...transitiveSize(packages, byName, key) }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 10);
  for (const t of transitive) {
    console.log(`  ${humanBytes(t.bytes).padStart(9)}  ${t.key}  (${t.count} packages pulled in)`);
  }

  const duplicated = [...byName.entries()].filter(([, versions]) => versions.length > 1);
  if (duplicated.length) {
    console.log(`\n${duplicated.length} packages installed at multiple versions (dedupe candidates):`);
    for (const [name, versions] of duplicated.slice(0, 8)) {
      const wasted = versions.slice(1).reduce((sum, v) => sum + v.selfBytes, 0);
      console.log(`  ${name}: ${versions.map((v) => v.version).join(", ")}  (~${humanBytes(wasted)} if deduped to one)`);
    }
  }
}

// ------------------------------------------------------------ demo

function buildFakeTree(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
  function write(pkgPath: string, manifest: object, files: Record<string, number>): void {
    fs.mkdirSync(pkgPath, { recursive: true });
    fs.writeFileSync(path.join(pkgPath, "package.json"), JSON.stringify(manifest, null, 2));
    for (const [name, size] of Object.entries(files)) {
      fs.writeFileSync(path.join(pkgPath, name), "x".repeat(size));
    }
  }

  write(
    path.join(root, "left-pad"),
    { name: "left-pad", version: "1.3.0", dependencies: {} },
    { "index.js": 400 },
  );
  write(
    path.join(root, "chalk"),
    { name: "chalk", version: "5.3.0", dependencies: { "ansi-styles": "^6.0.0" } },
    { "index.js": 3200, "utilities.js": 1800 },
  );
  write(
    path.join(root, "ansi-styles"),
    { name: "ansi-styles", version: "6.2.1", dependencies: {} },
    { "index.js": 5200 },
  );
  write(
    path.join(root, "big-parser"),
    { name: "big-parser", version: "2.1.0", dependencies: { chalk: "^5.0.0", "left-pad": "^1.0.0" } },
    { "parser.js": 45000, "grammar.js": 38000, "tables.js": 120000 },
  );
  write(
    path.join(root, "webpack"),
    { name: "webpack", version: "5.90.0", dependencies: { "big-parser": "^2.0.0", chalk: "^4.0.0" } },
    { "webpack.js": 890000, "compiler.js": 340000 },
  );
  // a second, older copy of chalk nested under webpack — the duplicate-version case
  write(
    path.join(root, "webpack", "node_modules", "chalk"),
    { name: "chalk", version: "4.1.2", dependencies: { "ansi-styles": "^4.0.0" } },
    { "index.js": 2900 },
  );
  write(
    path.join(root, "webpack", "node_modules", "ansi-styles"),
    { name: "ansi-styles", version: "4.3.0", dependencies: {} },
    { "index.js": 4100 },
  );
  write(
    path.join(root, "@scope", "utils"),
    { name: "@scope/utils", version: "1.0.0", dependencies: {} },
    { "index.js": 900 },
  );
}

function demo(): void {
  const root = "/tmp/pkgsize-demo/node_modules";
  buildFakeTree(root);
  console.log("(synthesised a small fake node_modules tree to analyse — no real install needed)\n");
  analyse(root);
  fs.rmSync("/tmp/pkgsize-demo", { recursive: true, force: true });
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  analyse(path.resolve(args[0]));
}

main();
