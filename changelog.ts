#!/usr/bin/env -S node
/**
 * Turn conventional commits into grouped release notes since the last tag.
 *
 *   node changelog.ts                    # uses real git log in this repo
 *   node changelog.ts --demo             # synthetic commit history, no git needed
 *
 * Commits are grouped by their Conventional Commits type (feat, fix, ...), each
 * group titled and ordered by how much a reader cares (breaking changes and
 * features before chores), and within a group sorted so the most recent commit is
 * first. A commit that does not follow the convention still shows up, under
 * "Other changes" — silently dropping it would make the changelog lie about what
 * shipped.
 */

import { execSync } from "node:child_process";

interface Commit {
  hash: string;
  subject: string;
  body: string;
  author: string;
  date: string;
}

interface Categorized {
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
  commit: Commit;
}

const TYPE_TITLES: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  refactor: "Refactoring",
  docs: "Documentation",
  build: "Build System",
  ci: "Continuous Integration",
  revert: "Reverts",
};
const TYPE_ORDER = ["feat", "fix", "perf", "refactor", "revert", "docs", "build", "ci"];
const HIDDEN_TYPES = new Set(["chore", "style", "test"]); // noise in release notes, kept out unless --all

const HEADER_RE = /^(\w+)(\(([^)]+)\))?(!)?: (.+)$/;

function categorize(commit: Commit): Categorized {
  const match = commit.subject.match(HEADER_RE);
  const breakingFooter = /BREAKING CHANGE:/.test(commit.body);
  if (!match) {
    return { type: "other", scope: null, breaking: breakingFooter, description: commit.subject, commit };
  }
  const [, type, , scope, bang] = match;
  return {
    type: type.toLowerCase(),
    scope: scope ?? null,
    breaking: Boolean(bang) || breakingFooter,
    description: match[5],
    commit,
  };
}

function formatEntry(entry: Categorized, shortHashes: boolean): string {
  const scope = entry.scope ? `**${entry.scope}**: ` : "";
  const hash = shortHashes ? ` (${entry.commit.hash.slice(0, 7)})` : "";
  return `- ${scope}${entry.description}${hash}`;
}

function buildChangelog(commits: Commit[], options: { includeChores?: boolean; shortHashes?: boolean } = {}): string {
  const categorized = commits.map(categorize);
  const breaking = categorized.filter((c) => c.breaking);
  const byType = new Map<string, Categorized[]>();
  const other: Categorized[] = [];

  for (const entry of categorized) {
    if (entry.type === "other") {
      other.push(entry);
      continue;
    }
    if (HIDDEN_TYPES.has(entry.type) && !options.includeChores) continue;
    const list = byType.get(entry.type) ?? [];
    list.push(entry);
    byType.set(entry.type, list);
  }

  const lines: string[] = [];

  if (breaking.length) {
    lines.push("### ⚠ BREAKING CHANGES");
    lines.push("");
    for (const entry of breaking) lines.push(formatEntry(entry, options.shortHashes ?? false));
    lines.push("");
  }

  const orderedTypes = [...TYPE_ORDER, ...[...byType.keys()].filter((t) => !TYPE_ORDER.includes(t))];
  for (const type of orderedTypes) {
    const entries = byType.get(type);
    if (!entries || entries.length === 0) continue;
    lines.push(`### ${TYPE_TITLES[type] ?? type[0].toUpperCase() + type.slice(1)}`);
    lines.push("");
    for (const entry of entries) lines.push(formatEntry(entry, options.shortHashes ?? false));
    lines.push("");
  }

  if (other.length) {
    lines.push("### Other Changes");
    lines.push("");
    for (const entry of other) lines.push(formatEntry(entry, options.shortHashes ?? false));
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

function commitsSinceLastTag(): Commit[] {
  const lastTag = execSync("git describe --tags --abbrev=0 2>/dev/null || true", { encoding: "utf8" }).trim();
  const range = lastTag ? `${lastTag}..HEAD` : "HEAD";
  const sep = "\x1f";
  const format = `%H${sep}%s${sep}%b${sep}%an${sep}%ad`;
  const raw = execSync(`git log ${range} --date=short --pretty=format:"${format}" --no-merges`, { encoding: "utf8" });
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, body, author, date] = line.split(sep);
      return { hash, subject, body: body ?? "", author, date };
    });
}

// ------------------------------------------------------------ demo

function demoCommits(): Commit[] {
  const raw: [string, string, string][] = [
    ["a1b2c3d", "feat(auth): add refresh token rotation", ""],
    ["b2c3d4e", "fix(cache): evict stale entries on write", "The TTL check only ran on read."],
    ["c3d4e5f", "feat(api)!: remove the deprecated v1 endpoints", "BREAKING CHANGE: /v1/* routes now return 410 Gone."],
    ["d4e5f6a", "perf(query): batch N+1 lookups into one round trip", ""],
    ["e5f6a7b", "fix(ui): correct off-by-one in pagination", ""],
    ["f6a7b8c", "docs: link the RFC for the retry policy", ""],
    ["a7b8c9d", "chore: bump dependencies", ""],
    ["b8c9d0e", "refactor(auth): extract token validation into its own module", ""],
    ["c9d0e1f", "feat(auth): support hardware security keys", ""],
    ["d0e1f2a", "fix(auth)!: require MFA for admin accounts", "BREAKING CHANGE: existing admin sessions are invalidated on upgrade."],
    ["e1f2a3b", "style: reformat with the new prettier config", ""],
    ["f2a3b4c", "tweak the thing that was broken", ""], // not conventional — still must appear
    ["a3b4c5d", "test: add coverage for the retry backoff", ""],
    ["b4c5d6e", "build(deps): pin node to 22.x in CI", ""],
  ];
  return raw.map(([hash, subject, body], i) => ({
    hash: hash.padEnd(40, "0"),
    subject,
    body,
    author: i % 3 === 0 ? "ana" : i % 3 === 1 ? "bo" : "cy",
    date: `2026-08-${String(20 + (i % 6)).padStart(2, "0")}`,
  }));
}

function demo(): void {
  const commits = demoCommits();
  console.log(`${commits.length} commits since v2.3.0\n`);

  console.log("# Changelog for v2.4.0\n");
  console.log(buildChangelog(commits, { shortHashes: true }));

  console.log("---\n");
  console.log("with --all (chores/style/tests included):\n");
  console.log(buildChangelog(commits, { includeChores: true, shortHashes: true }));

  const categorized = commits.map(categorize);
  const unconventional = categorized.filter((c) => c.type === "other");
  console.log(`note: ${unconventional.length} commit did not follow Conventional Commits and still appears under "Other Changes":`);
  for (const entry of unconventional) console.log(`  "${entry.commit.subject}"`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo")) {
    demo();
    return;
  }
  try {
    const commits = commitsSinceLastTag();
    if (commits.length === 0) {
      console.log("no commits since the last tag (or not a git repo) — try --demo");
      return;
    }
    console.log(buildChangelog(commits, { includeChores: args.includes("--all"), shortHashes: true }));
  } catch {
    console.log("not a git repository — try --demo");
  }
}

main();
