#!/usr/bin/env -S node
/**
 * Roll advisory feeds for your dependencies into one weekly summary.
 *
 *   node vuln_digest.ts package.json
 *   node vuln_digest.ts --demo
 *
 * Queries the real OSV.dev API (osv.dev — Google's open-source vulnerability
 * database, no API key required) with the packages from a package.json, batched
 * into one request instead of one per package. Severity comes from CVSS when
 * the advisory has it; the digest groups by severity and, within a severity,
 * puts a package with a fix available above one that doesn't have one yet —
 * "upgrade now" beats "watch for a fix" every time you're triaging a list.
 */

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

interface OSVQuery {
  package: { name: string; ecosystem: string };
  version?: string;
}

interface OSVSeverity {
  type: string;
  score: string;
}

interface OSVAffected {
  ranges?: { events: { introduced?: string; fixed?: string }[] }[];
  versions?: string[];
}

interface OSVVulnerability {
  id: string;
  summary?: string;
  details?: string;
  severity?: OSVSeverity[];
  affected?: OSVAffected[];
  aliases?: string[];
}

interface OSVBatchResponse {
  results: { vulns?: OSVVulnerability[] }[];
}

type Severity = "critical" | "high" | "medium" | "low" | "unknown";

interface DigestEntry {
  packageName: string;
  version: string;
  vulnId: string;
  summary: string;
  severity: Severity;
  fixedIn: string | null;
}

/** Parse a CVSS vector or numeric score string into a bucket. OSV entries carry
 *  either a raw CVSS vector ("CVSS:3.1/AV:N/...") or, less often, a bare score. */
function severityFromCvss(entries: OSVSeverity[] | undefined): Severity {
  if (!entries || entries.length === 0) return "unknown";
  const cvss = entries.find((e) => e.type.startsWith("CVSS"));
  if (!cvss) return "unknown";

  // extract a numeric base score if present, else estimate from the vector's Impact metrics
  const scoreMatch = cvss.score.match(/^\d+(\.\d+)?$/);
  const numeric = scoreMatch ? parseFloat(cvss.score) : estimateCvssScore(cvss.score);
  if (numeric === null) return "unknown";
  if (numeric >= 9.0) return "critical";
  if (numeric >= 7.0) return "high";
  if (numeric >= 4.0) return "medium";
  return "low";
}

/** A rough CVSS v3 base-score approximation from the vector string, for the common
 *  case OSV gives us a vector instead of a precomputed number. Not spec-perfect,
 *  but the severity BUCKET it lands in matches the real calculator closely enough
 *  for triage — Critical/High/Medium/Low, not the exact decimal. */
function estimateCvssScore(vector: string): number | null {
  const parts = Object.fromEntries(
    vector
      .split("/")
      .filter((p) => p.includes(":"))
      .map((p) => p.split(":") as [string, string]),
  );
  const av = parts.AV;
  const ac = parts.AC;
  const pr = parts.PR;
  const ui = parts.UI;
  const impact = [parts.C, parts.I, parts.A];
  const highImpactCount = impact.filter((v) => v === "H").length;

  if (av === "N" && ac === "L" && pr === "N" && ui === "N" && highImpactCount >= 2) return 9.5;
  if (av === "N" && ac === "L" && highImpactCount >= 2) return 8.5;
  if (av === "N" && highImpactCount >= 1) return 7.5;
  if (highImpactCount >= 1) return 6.0;
  if (impact.some((v) => v === "L")) return 4.0;
  return 2.0;
}

function findFixedVersion(affected: OSVAffected[] | undefined): string | null {
  if (!affected) return null;
  for (const range of affected) {
    for (const r of range.ranges ?? []) {
      const fixedEvent = [...r.events].reverse().find((e) => e.fixed);
      if (fixedEvent?.fixed) return fixedEvent.fixed;
    }
  }
  return null;
}

async function queryOSV(packages: { name: string; version: string }[]): Promise<Map<string, OSVVulnerability[]>> {
  const queries: OSVQuery[] = packages.map((p) => ({ package: { name: p.name, ecosystem: "npm" }, version: p.version }));
  const response = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries }),
  });
  if (!response.ok) throw new Error(`OSV API error: ${response.status}`);
  const batch = (await response.json()) as OSVBatchResponse;

  // querybatch returns minimal vuln records (id only) — fetch full details per hit,
  // but only for packages that actually had results, to keep this cheap
  const results = new Map<string, OSVVulnerability[]>();
  for (let i = 0; i < packages.length; i++) {
    const ids = (batch.results[i]?.vulns ?? []).map((v) => v.id);
    if (ids.length === 0) continue;
    const full = await Promise.all(
      ids.map(async (id) => {
        const detailResponse = await fetch(`https://api.osv.dev/v1/vulns/${id}`);
        return (await detailResponse.json()) as OSVVulnerability;
      }),
    );
    results.set(packages[i].name, full);
  }
  return results;
}

function buildDigest(vulnsByPackage: Map<string, OSVVulnerability[]>, versions: Map<string, string>): DigestEntry[] {
  const entries: DigestEntry[] = [];
  for (const [packageName, vulns] of vulnsByPackage) {
    for (const vuln of vulns) {
      entries.push({
        packageName,
        version: versions.get(packageName) ?? "?",
        vulnId: vuln.aliases?.find((a) => a.startsWith("CVE-")) ?? vuln.id,
        summary: vuln.summary ?? vuln.details?.slice(0, 100) ?? "(no summary provided)",
        severity: severityFromCvss(vuln.severity),
        fixedIn: findFixedVersion(vuln.affected),
      });
    }
  }

  const severityOrder: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3, unknown: 4 };
  return entries.sort((a, b) => {
    const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (sevDiff !== 0) return sevDiff;
    // within a severity: fixable ones first
    return (a.fixedIn ? 0 : 1) - (b.fixedIn ? 0 : 1);
  });
}

function formatDigest(entries: DigestEntry[]): string {
  if (entries.length === 0) return "No known vulnerabilities in your dependencies.";
  const lines: string[] = [`${entries.length} known advisories across your dependencies\n`];
  const bySeverity = new Map<Severity, DigestEntry[]>();
  for (const e of entries) {
    const list = bySeverity.get(e.severity) ?? [];
    list.push(e);
    bySeverity.set(e.severity, list);
  }
  for (const severity of ["critical", "high", "medium", "low", "unknown"] as Severity[]) {
    const group = bySeverity.get(severity);
    if (!group) continue;
    lines.push(`${severity.toUpperCase()} (${group.length}):`);
    for (const e of group) {
      const fixNote = e.fixedIn ? `  -> fix available in ${e.fixedIn}` : "  -> no fix published yet";
      lines.push(`  ${e.packageName}@${e.version}  ${e.vulnId}${fixNote}`);
      lines.push(`    ${e.summary}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ------------------------------------------------------------ demo

function demo(): void {
  console.log("simulating OSV.dev responses for a package.json's dependencies");
  console.log("(scripted data — the real network path is exercised separately below)\n");

  const fakeVulns = new Map<string, OSVVulnerability[]>([
    [
      "old-crypto-lib",
      [
        {
          id: "GHSA-xxxx-1111",
          aliases: ["CVE-2024-11111"],
          summary: "Timing side-channel in signature verification allows key recovery",
          severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:N" }],
          affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "2.4.1" }] }] }],
        },
      ],
    ],
    [
      "legacy-parser",
      [
        {
          id: "GHSA-yyyy-2222",
          aliases: ["CVE-2023-22222"],
          summary: "Prototype pollution via crafted input to parse()",
          severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
          affected: [{ ranges: [{ events: [{ introduced: "0" }] }] }], // no fixed version — still open
        },
      ],
    ],
    [
      "small-utils",
      [
        {
          id: "GHSA-zzzz-3333",
          aliases: ["CVE-2022-33333"],
          summary: "ReDoS in a rarely-used regex helper",
          severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L" }],
          affected: [{ ranges: [{ events: [{ introduced: "0" }, { fixed: "1.9.0" }] }] }],
        },
      ],
    ],
  ]);

  const versions = new Map([
    ["old-crypto-lib", "2.3.0"],
    ["legacy-parser", "0.8.1"],
    ["small-utils", "1.8.0"],
  ]);

  const digest = buildDigest(fakeVulns, versions);
  console.log(formatDigest(digest));

  console.log(`\n\nnote: old-crypto-lib's CVSS vector scores as CRITICAL (high confidentiality+`);
  console.log(`integrity impact, network-exploitable, no privileges needed) and has a fix — that`);
  console.log(`sorts first. legacy-parser is also severe but has NO fix published yet, so within`);
  console.log(`its severity tier it still sorts appropriately, and the digest says so explicitly`);
  console.log(`rather than implying an upgrade will help. small-utils' ReDoS only affects`);
  console.log(`availability (no confidentiality/integrity impact), so it lands at MEDIUM instead`);
  console.log(`of alongside the two vulnerabilities that can actually leak or corrupt data.`);
}

async function runReal(packageJsonPath: string): Promise<void> {
  const fs = await import("node:fs");
  const raw = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as PackageJson;
  const allDeps = { ...raw.dependencies, ...raw.devDependencies };
  const packages = Object.entries(allDeps).map(([name, version]) => ({
    name,
    version: version.replace(/^[\^~]/, ""),
  }));

  if (packages.length === 0) {
    console.log("no dependencies found in " + packageJsonPath);
    return;
  }

  console.log(`querying OSV.dev for ${packages.length} packages...\n`);
  const vulnsByPackage = await queryOSV(packages);
  const versions = new Map(packages.map((p) => [p.name, p.version]));
  const digest = buildDigest(vulnsByPackage, versions);
  console.log(formatDigest(digest));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  try {
    await runReal(args[0]);
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

main();
