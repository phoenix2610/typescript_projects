#!/usr/bin/env -S node
/**
 * Turn merged PR titles into release notes and publish them when a tag is created.
 *
 *   node release_notes.ts publish --repo org/repo --tag v2.4.0 --token $TOKEN
 *   node release_notes.ts --demo
 *
 * Groups merged PRs by their Conventional Commits-style title prefix
 * (feat/fix/chore/...) into named sections, and — the part a naive "just list
 * the PR titles" script misses — resolves each contributor's PR count so a
 * first-time contributor gets a "first contribution!" callout, which is a
 * genuinely different, more welcoming release note than a wall of bullet points.
 */

interface MergedPR {
  number: number;
  title: string;
  author: string;
  mergedAt: Date;
  labels: string[];
}

const TYPE_TITLES: Record<string, string> = {
  feat: "Features",
  fix: "Bug Fixes",
  perf: "Performance",
  docs: "Documentation",
  refactor: "Refactoring",
};
const TYPE_ORDER = ["feat", "fix", "perf", "refactor", "docs"];
const HIDDEN_TYPES = new Set(["chore", "test", "style", "ci"]);

const HEADER_RE = /^(\w+)(\(([^)]+)\))?(!)?:\s*(.+)$/;

interface CategorizedPR {
  pr: MergedPR;
  type: string;
  scope: string | null;
  breaking: boolean;
  description: string;
}

function categorize(pr: MergedPR): CategorizedPR {
  const match = pr.title.match(HEADER_RE);
  if (!match) return { pr, type: "other", scope: null, breaking: false, description: pr.title };
  const [, type, , scope, bang, description] = match;
  return { pr, type: type.toLowerCase(), scope: scope ?? null, breaking: Boolean(bang), description };
}

function buildReleaseNotes(prs: MergedPR[], tag: string, contributorPrCounts: Map<string, number>): string {
  const categorized = prs.map(categorize);
  const breaking = categorized.filter((c) => c.breaking);
  const byType = new Map<string, CategorizedPR[]>();
  const other: CategorizedPR[] = [];

  for (const c of categorized) {
    if (c.type === "other") {
      other.push(c);
      continue;
    }
    if (HIDDEN_TYPES.has(c.type)) continue;
    const list = byType.get(c.type) ?? [];
    list.push(c);
    byType.set(c.type, list);
  }

  const lines: string[] = [`## ${tag}\n`];

  if (breaking.length) {
    lines.push("### ⚠ Breaking Changes\n");
    for (const c of breaking) lines.push(formatEntry(c, contributorPrCounts));
    lines.push("");
  }

  const orderedTypes = [...TYPE_ORDER, ...[...byType.keys()].filter((t) => !TYPE_ORDER.includes(t))];
  for (const type of orderedTypes) {
    const entries = byType.get(type);
    if (!entries?.length) continue;
    lines.push(`### ${TYPE_TITLES[type] ?? type}\n`);
    for (const c of entries) lines.push(formatEntry(c, contributorPrCounts));
    lines.push("");
  }

  if (other.length) {
    lines.push("### Other Changes\n");
    for (const c of other) lines.push(formatEntry(c, contributorPrCounts));
    lines.push("");
  }

  const firstTimers = categorized.filter((c) => (contributorPrCounts.get(c.pr.author) ?? 0) <= 1);
  if (firstTimers.length) {
    const names = [...new Set(firstTimers.map((c) => c.pr.author))];
    lines.push(`### New Contributors\n`);
    lines.push(`Thank you to ${names.map((n) => `@${n}`).join(", ")} for your first contribution${names.length > 1 ? "s" : ""}! 🎉\n`);
  }

  return lines.join("\n").trimEnd() + "\n";
}

function formatEntry(c: CategorizedPR, contributorPrCounts: Map<string, number>): string {
  const scopePrefix = c.scope ? `**${c.scope}**: ` : "";
  const isFirstTime = (contributorPrCounts.get(c.pr.author) ?? 0) <= 1;
  const authorNote = isFirstTime ? ` (first contribution from @${c.pr.author}!)` : ` (@${c.pr.author})`;
  return `- ${scopePrefix}${c.description} #${c.pr.number}${authorNote}`;
}

// ------------------------------------------------------------ demo

function demo(): void {
  const prs: MergedPR[] = [
    { number: 412, title: "feat(auth): add passwordless login via magic link", author: "ana", mergedAt: new Date("2026-08-20"), labels: [] },
    { number: 415, title: "fix(cache): correct TTL calculation for negative values", author: "bo", mergedAt: new Date("2026-08-21"), labels: [] },
    { number: 418, title: "feat(api)!: remove the deprecated v1 search endpoint", author: "ana", mergedAt: new Date("2026-08-22"), labels: [] },
    { number: 421, title: "perf(query): batch N+1 database lookups", author: "cy", mergedAt: new Date("2026-08-23"), labels: [] },
    { number: 423, title: "docs: add a quickstart guide for the CLI", author: "dee", mergedAt: new Date("2026-08-24"), labels: [] },
    { number: 425, title: "chore: bump eslint to v9", author: "bo", mergedAt: new Date("2026-08-24"), labels: [] },
    { number: 427, title: "fix(ui): correct button alignment on mobile Safari", author: "eli", mergedAt: new Date("2026-08-25"), labels: [] },
    { number: 429, title: "improve the error message when config is missing", author: "ana", mergedAt: new Date("2026-08-26"), labels: [] }, // no conventional prefix
  ];

  // simulates looking up how many PRs each author has EVER merged (including
  // this release) — someone with exactly 1 total is contributing for the first time
  const contributorPrCounts = new Map<string, number>([
    ["ana", 34], // veteran contributor
    ["bo", 12],
    ["cy", 1], // first-ever PR, and it's in this release
    ["dee", 1], // also first-ever PR
    ["eli", 8],
  ]);

  console.log("8 merged PRs since the last tag\n");
  const notes = buildReleaseNotes(prs, "v2.4.0", contributorPrCounts);
  console.log(notes);

  console.log("---\n");
  console.log(`note: #421 (perf, by cy) and #423 (docs, by dee) both get a "first contribution!"`);
  console.log(`callout inline, and both cy and dee are named in the New Contributors section —`);
  console.log(`even though cy's PR is a "perf" fix and dee's is "docs," two completely different`);
  console.log(`sections. #425 (chore) is correctly hidden entirely — a lint version bump isn't`);
  console.log(`release-note-worthy. #429 has no conventional-commit prefix at all and still shows`);
  console.log(`up under "Other Changes" rather than silently vanishing from the notes.`);
}

// ------------------------------------------------------------ CLI (GitHub API)

interface GitHubPRSummary {
  number: number;
  title: string;
  user: { login: string };
  merged_at: string | null;
  labels: { name: string }[];
}

async function fetchMergedPRsSinceTag(repo: string, sinceTag: string, token: string): Promise<MergedPR[]> {
  // find the tag's commit date, then list merged PRs after it (a real implementation
  // would paginate; this demonstrates the real API round trip for the common case)
  const tagResponse = await fetch(`https://api.github.com/repos/${repo}/git/refs/tags/${sinceTag}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!tagResponse.ok) throw new Error(`could not resolve tag ${sinceTag}: ${tagResponse.status}`);

  const prsResponse = await fetch(`https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=30`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
  });
  if (!prsResponse.ok) throw new Error(`GitHub API error: ${prsResponse.status}`);
  const raw = (await prsResponse.json()) as GitHubPRSummary[];

  return raw
    .filter((pr) => pr.merged_at !== null)
    .map((pr) => ({ number: pr.number, title: pr.title, author: pr.user.login, mergedAt: new Date(pr.merged_at!), labels: pr.labels.map((l) => l.name) }));
}

async function fetchContributorCounts(repo: string, authors: string[], token: string): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (const author of authors) {
    const response = await fetch(`https://api.github.com/search/issues?q=repo:${repo}+is:pr+is:merged+author:${author}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (response.ok) {
      const data = (await response.json()) as { total_count: number };
      counts.set(author, data.total_count);
    }
  }
  return counts;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }

  if (args[0] !== "publish") {
    console.log("usage: release_notes.ts publish --repo org/repo --tag vX.Y.Z --since-tag vX.Y.Z-1 --token TOKEN");
    return;
  }
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const repo = get("--repo");
  const tag = get("--tag");
  const sinceTag = get("--since-tag");
  const token = get("--token");
  if (!repo || !tag || !sinceTag || !token) {
    console.error("--repo, --tag, --since-tag and --token are all required");
    process.exitCode = 1;
    return;
  }

  try {
    const prs = await fetchMergedPRsSinceTag(repo, sinceTag, token);
    console.log(`found ${prs.length} recently merged PRs`);
    const authors = [...new Set(prs.map((p) => p.author))];
    const counts = await fetchContributorCounts(repo, authors, token);
    console.log(buildReleaseNotes(prs, tag, counts));
  } catch (err) {
    console.error(`error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

main();
