#!/usr/bin/env -S node
/**
 * Topologically ordered tasks with caching and parallel workspace execution.
 *
 *   node monotask.ts build
 *   node monotask.ts --demo
 *
 * A monorepo task runner's whole job is respecting the dependency graph: if
 * `api` depends on `shared`, building `api` before `shared` finishes is either
 * wrong or lucky. Tasks run in topological order, independent packages within
 * the same "layer" run in parallel, and a task is skipped entirely if a content
 * hash of its inputs matches the last successful run — the same idea as a
 * Makefile's mtime check, but keyed on what actually changed, not when.
 */

import * as crypto from "node:crypto";

interface PackageDef {
  name: string;
  dependsOn: string[];
  files: Record<string, string>; // filename -> content, stands in for a real workspace on disk
}

interface TaskResult {
  package: string;
  status: "ran" | "cached" | "failed";
  durationMs: number;
  output: string;
}

function hashOwnFiles(files: Record<string, string>): string {
  const hash = crypto.createHash("sha256");
  for (const name of Object.keys(files).sort()) {
    hash.update(name);
    hash.update(files[name]);
  }
  return hash.digest("hex").slice(0, 12);
}

/** The cache key must fold in every dependency's effective hash, not just this
 *  package's own files. Otherwise a change to `logger` never invalidates `api`
 *  or `web`, which import it — a stale cache hit that ships an old build. */
function effectiveHash(ownFilesHash: string, dependencyHashes: string[]): string {
  const hash = crypto.createHash("sha256");
  hash.update(ownFilesHash);
  for (const dep of [...dependencyHashes].sort()) hash.update(dep);
  return hash.digest("hex").slice(0, 12);
}

/** Kahn's algorithm, but grouped into layers — everything in one layer has no
 *  dependency on anything else in that same layer, so the layer can run in parallel. */
function topologicalLayers(packages: PackageDef[]): string[][] {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();

  for (const pkg of packages) {
    inDegree.set(pkg.name, pkg.dependsOn.length);
    for (const dep of pkg.dependsOn) {
      if (!byName.has(dep)) throw new Error(`${pkg.name} depends on unknown package "${dep}"`);
      const list = dependents.get(dep) ?? [];
      list.push(pkg.name);
      dependents.set(dep, list);
    }
  }

  const layers: string[][] = [];
  let current = packages.filter((p) => inDegree.get(p.name) === 0).map((p) => p.name);
  const seen = new Set<string>();

  while (current.length > 0) {
    layers.push(current);
    for (const name of current) seen.add(name);
    const next: string[] = [];
    for (const name of current) {
      for (const dependent of dependents.get(name) ?? []) {
        const remaining = (inDegree.get(dependent) ?? 0) - 1;
        inDegree.set(dependent, remaining);
        if (remaining === 0) next.push(dependent);
      }
    }
    current = next;
  }

  if (seen.size < packages.length) {
    const cyclic = packages.filter((p) => !seen.has(p.name)).map((p) => p.name);
    throw new Error(`circular dependency involving: ${cyclic.join(", ")}`);
  }

  return layers;
}

interface RunOptions {
  cache: Map<string, string>; // package name -> last successful input hash
  taskRunner: (pkg: PackageDef) => Promise<{ ok: boolean; output: string }>;
  concurrency?: number;
}

async function runInLayers(packages: PackageDef[], options: RunOptions): Promise<TaskResult[]> {
  const layers = topologicalLayers(packages);
  const byName = new Map(packages.map((p) => [p.name, p]));
  const results: TaskResult[] = [];
  // effective hash of every package processed so far this run — dependencies are
  // always in an earlier layer, so this is always populated before it's needed
  const thisRunHashes = new Map<string, string>();

  for (const layer of layers) {
    const layerResults = await Promise.all(
      layer.map(async (name): Promise<TaskResult> => {
        const pkg = byName.get(name)!;
        const depHashes = pkg.dependsOn.map((dep) => thisRunHashes.get(dep)!);
        const inputHash = effectiveHash(hashOwnFiles(pkg.files), depHashes);
        thisRunHashes.set(name, inputHash);
        const start = performance.now();

        if (options.cache.get(name) === inputHash) {
          return { package: name, status: "cached", durationMs: performance.now() - start, output: "(unchanged since last successful run)" };
        }

        const { ok, output } = await options.taskRunner(pkg);
        const durationMs = performance.now() - start;
        if (ok) options.cache.set(name, inputHash);
        return { package: name, status: ok ? "ran" : "failed", durationMs, output };
      }),
    );
    results.push(...layerResults);
    if (layerResults.some((r) => r.status === "failed")) break; // don't build downstream of a failure
  }

  return results;
}

// ------------------------------------------------------------ demo

const PACKAGES: PackageDef[] = [
  { name: "shared", dependsOn: [], files: { "index.ts": "export const VERSION = 1;" } },
  { name: "logger", dependsOn: ["shared"], files: { "index.ts": "import { VERSION } from 'shared';" } },
  { name: "api", dependsOn: ["shared", "logger"], files: { "index.ts": "import { VERSION } from 'shared';\nimport 'logger';" } },
  { name: "web", dependsOn: ["shared", "logger"], files: { "index.ts": "import { VERSION } from 'shared';\nimport 'logger';" } },
  { name: "e2e", dependsOn: ["api", "web"], files: { "spec.ts": "test('smoke', () => {});" } },
];

async function fakeBuild(pkg: PackageDef): Promise<{ ok: boolean; output: string }> {
  await new Promise((resolve) => setTimeout(resolve, 30 + Math.random() * 40));
  if (pkg.name === "web" && pkg.files["index.ts"].includes("BROKEN")) {
    return { ok: false, output: "type error: Cannot find module 'shared'" };
  }
  return { ok: true, output: `built ${Object.keys(pkg.files).length} file(s)` };
}

function printResults(results: TaskResult[], layers: string[][]): void {
  let layerIndex = 0;
  let consumed = 0;
  for (const result of results) {
    if (consumed === 0) console.log(`  layer ${layerIndex + 1}: [${layers[layerIndex].join(", ")}]  (run in parallel)`);
    const icon = result.status === "cached" ? "cached " : result.status === "failed" ? "FAILED " : "built  ";
    console.log(`    ${icon} ${result.package.padEnd(8)} ${result.durationMs.toFixed(0)}ms  ${result.output}`);
    consumed++;
    if (consumed === layers[layerIndex].length) {
      consumed = 0;
      layerIndex++;
    }
  }
}

async function demo(): Promise<void> {
  console.log("dependency graph:");
  for (const pkg of PACKAGES) console.log(`  ${pkg.name.padEnd(8)} depends on: ${pkg.dependsOn.join(", ") || "(none)"}`);

  const layers = topologicalLayers(PACKAGES);
  console.log(`\n${layers.length} layers, respecting the dependency order:`);
  layers.forEach((layer, i) => console.log(`  layer ${i + 1}: ${layer.join(", ")}`));

  console.log("\n--- run 1: everything is new, nothing cached ---\n");
  const cache = new Map<string, string>();
  const start1 = performance.now();
  const results1 = await runInLayers(PACKAGES, { cache, taskRunner: fakeBuild });
  printResults(results1, layers);
  console.log(`\n  total wall time: ${(performance.now() - start1).toFixed(0)}ms for ${PACKAGES.length} packages`);
  console.log(`  (layers ran sequentially, but packages WITHIN a layer ran in parallel — that's`);
  console.log(`  why this is faster than ${PACKAGES.length} sequential builds would be)`);

  console.log("\n--- run 2: nothing changed, everything should be cached ---\n");
  const start2 = performance.now();
  const results2 = await runInLayers(PACKAGES, { cache, taskRunner: fakeBuild });
  printResults(results2, layers);
  console.log(`\n  total wall time: ${(performance.now() - start2).toFixed(0)}ms  (all cache hits, no builds ran)`);

  console.log("\n--- run 3: only 'logger' changed — see what rebuilds ---\n");
  const changedPackages = PACKAGES.map((p) => (p.name === "logger" ? { ...p, files: { "index.ts": p.files["index.ts"] + "\n// touched" } } : p));
  const results3 = await runInLayers(changedPackages, { cache, taskRunner: fakeBuild });
  printResults(results3, layers);
  const rebuilt = results3.filter((r) => r.status === "ran").map((r) => r.package);
  console.log(`\n  rebuilt: [${rebuilt.join(", ")}]`);
  console.log(`  NOT rebuilt: [${results3.filter((r) => r.status === "cached").map((r) => r.package).join(", ")}]`);
  console.log(`  note: 'shared' stayed cached (its own files did not change), but api/web/e2e all`);
  console.log(`  rebuilt even though none of THEIR files changed — each one's cache key folds in`);
  console.log(`  its dependencies' hashes, so a change cascades to everything downstream of it.`);

  console.log("\n--- run 4: 'web' fails to build — 'e2e' must not run afterward ---\n");
  const brokenPackages = changedPackages.map((p) => (p.name === "web" ? { ...p, files: { "index.ts": "BROKEN" } } : p));
  const cache4 = new Map<string, string>();
  const results4 = await runInLayers(brokenPackages, { cache: cache4, taskRunner: fakeBuild });
  printResults(results4, layers);
  const ranE2E = results4.some((r) => r.package === "e2e");
  console.log(`\n  did e2e run despite web failing: ${ranE2E} (correctly stopped before the last layer)`);

  console.log("\n--- a circular dependency is caught before anything runs ---\n");
  try {
    topologicalLayers([
      { name: "a", dependsOn: ["b"], files: {} },
      { name: "b", dependsOn: ["a"], files: {} },
    ]);
  } catch (err) {
    console.log(`  ${(err as Error).message}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    void demo();
    return;
  }
  console.log("this build uses a fixed demo workspace graph — run with --demo to see it execute");
}

main();
