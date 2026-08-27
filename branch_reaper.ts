#!/usr/bin/env -S node
/**
 * Find branches merged or untouched for months, and archive them safely.
 *
 *   node branch_reaper.ts --stale-days 90
 *   node branch_reaper.ts --demo
 *
 * "Archive," not "delete" — a branch reaper that deletes outright is one typo
 * away from losing someone's unmerged work. This tags a stale branch with a
 * timestamped archive ref (refs/archive/<name>-<date>) before removing the
 * original, so the commits stay reachable and `git branch -a` stays clean,
 * without a delete being an irreversible action. Branches merged into main are
 * treated differently from branches that are just old and unmerged — the
 * latter get flagged for review, never auto-archived, since "nobody touched
 * it in 90 days" and "this work was abandoned" are not the same claim.
 */

import { execFileSync } from "node:child_process";

interface BranchInfo {
  name: string;
  lastCommitDate: Date;
  lastAuthor: string;
  isMerged: boolean;
  aheadOfMain: number;
  behindOfMain: number;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function listBranches(repoDir: string, mainBranch: string): BranchInfo[] {
  const format = ["%(refname:short)", "%(committerdate:iso-strict)", "%(authorname)"].join("%09");
  const raw = git(["for-each-ref", "refs/heads", `--format=${format}`], repoDir);
  const mergedSet = new Set(
    git(["branch", "--merged", mainBranch, "--format=%(refname:short)"], repoDir)
      .split("\n")
      .filter(Boolean),
  );

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, dateStr, author] = line.split("\t");
      let ahead = 0;
      let behind = 0;
      try {
        const counts = git(["rev-list", "--left-right", "--count", `${mainBranch}...${name}`], repoDir);
        const [behindStr, aheadStr] = counts.split(/\s+/);
        behind = Number(behindStr);
        ahead = Number(aheadStr);
      } catch {
        // unrelated histories or other edge cases — leave at 0/0
      }
      return {
        name,
        lastCommitDate: new Date(dateStr),
        lastAuthor: author,
        isMerged: mergedSet.has(name),
        aheadOfMain: ahead,
        behindOfMain: behind,
      };
    });
}

type Disposition = "auto-archive" | "review-suggested" | "keep";

interface BranchDecision {
  branch: BranchInfo;
  disposition: Disposition;
  reason: string;
  daysSinceCommit: number;
}

function classifyBranch(branch: BranchInfo, mainBranch: string, staleDays: number, now: Date): BranchDecision | null {
  if (branch.name === mainBranch || branch.name === "main" || branch.name === "master") return null;

  const daysSinceCommit = (now.getTime() - branch.lastCommitDate.getTime()) / 86_400_000;
  if (daysSinceCommit < staleDays) return null; // not stale at all — skip entirely

  if (branch.isMerged) {
    return {
      branch,
      disposition: "auto-archive",
      reason: `merged into ${mainBranch}, ${Math.round(daysSinceCommit)}d since last commit — safe to archive`,
      daysSinceCommit,
    };
  }

  if (branch.aheadOfMain === 0) {
    // not merged by git's reckoning, but has no unique commits either (e.g. an
    // empty branch, or one whose commits landed via squash-merge) — same as merged
    return {
      branch,
      disposition: "auto-archive",
      reason: `no unique commits ahead of ${mainBranch} (likely squash-merged), ${Math.round(daysSinceCommit)}d old — safe to archive`,
      daysSinceCommit,
    };
  }

  return {
    branch,
    disposition: "review-suggested",
    reason: `${branch.aheadOfMain} unpushed/unmerged commit(s), ${Math.round(daysSinceCommit)}d untouched by ${branch.lastAuthor} — needs a human decision, not auto-archived`,
    daysSinceCommit,
  };
}

function archiveBranch(repoDir: string, branch: BranchInfo, now: Date): string {
  const stamp = now.toISOString().slice(0, 10);
  const archiveRef = `refs/archive/${branch.name}-${stamp}`;
  git(["update-ref", archiveRef, `refs/heads/${branch.name}`], repoDir);
  git(["branch", "-D", branch.name], repoDir);
  return archiveRef;
}

// ------------------------------------------------------------ demo

function daysAgo(now: Date, days: number): Date {
  return new Date(now.getTime() - days * 86_400_000);
}

function demo(): void {
  const now = new Date("2026-08-27T12:00:00Z");
  const mainBranch = "main";

  const branches: BranchInfo[] = [
    { name: "main", lastCommitDate: daysAgo(now, 0), lastAuthor: "ana", isMerged: true, aheadOfMain: 0, behindOfMain: 0 },
    { name: "feature/checkout-v2", lastCommitDate: daysAgo(now, 120), lastAuthor: "bo", isMerged: true, aheadOfMain: 0, behindOfMain: 40 },
    { name: "fix/typo-readme", lastCommitDate: daysAgo(now, 95), lastAuthor: "cy", isMerged: false, aheadOfMain: 0, behindOfMain: 12 }, // squash-merged, 0 unique commits
    { name: "experiment/new-cache", lastCommitDate: daysAgo(now, 150), lastAuthor: "dee", isMerged: false, aheadOfMain: 7, behindOfMain: 30 }, // real unmerged work
    { name: "wip/refactor-auth", lastCommitDate: daysAgo(now, 20), lastAuthor: "eli", isMerged: false, aheadOfMain: 3, behindOfMain: 5 }, // recent, not stale
    { name: "hotfix/payment-bug", lastCommitDate: daysAgo(now, 200), lastAuthor: "fen", isMerged: true, aheadOfMain: 0, behindOfMain: 80 },
  ];

  console.log(`checking ${branches.length} branches against main, stale threshold 90 days\n`);

  const decisions = branches
    .map((b) => classifyBranch(b, mainBranch, 90, now))
    .filter((d): d is BranchDecision => d !== null);

  for (const d of decisions) {
    console.log(`  ${d.disposition.padEnd(17)} ${d.branch.name}`);
    console.log(`    ${d.reason}`);
  }

  const skipped = branches.length - 1 - decisions.length; // -1 for main itself
  console.log(`\n${decisions.length} branches flagged, ${skipped} skipped (main, or under the staleness threshold)`);

  const autoArchive = decisions.filter((d) => d.disposition === "auto-archive");
  const needsReview = decisions.filter((d) => d.disposition === "review-suggested");
  console.log(`\n  ${autoArchive.length} safe to auto-archive: ${autoArchive.map((d) => d.branch.name).join(", ")}`);
  console.log(`  ${needsReview.length} needs human review: ${needsReview.map((d) => d.branch.name).join(", ")}`);

  console.log(`\n\nnote: fix/typo-readme is NOT flagged as "merged" by git's own bookkeeping`);
  console.log(`(isMerged: false) — it was squash-merged, so its individual commits never appear`);
  console.log(`in main's history. But it has zero commits AHEAD of main, meaning nothing on that`);
  console.log(`branch is missing from main either way, so it's still classified auto-archive.`);
  console.log(`experiment/new-cache has real unmerged work (7 commits ahead) that git can't tell`);
  console.log(`apart from "abandoned" — it goes to review-suggested, never auto-archived, because`);
  console.log(`deleting someone's actual unmerged work by accident is the one mistake this tool`);
  console.log(`is built specifically not to make. wip/refactor-auth is only 20 days old and never`);
  console.log(`even enters the stale pool.`);
}

// ------------------------------------------------------------ CLI

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }

  const staleDaysIdx = args.indexOf("--stale-days");
  const staleDays = staleDaysIdx >= 0 ? Number(args[staleDaysIdx + 1]) : 90;
  const dryRun = !args.includes("--apply");
  const repoDir = process.cwd();

  try {
    git(["rev-parse", "--git-dir"], repoDir);
  } catch {
    console.error("not a git repository — try --demo");
    process.exitCode = 1;
    return;
  }

  const mainBranch = ["main", "master"].find((name) => {
    try {
      git(["rev-parse", "--verify", "--quiet", name], repoDir);
      return true;
    } catch {
      return false;
    }
  });
  if (!mainBranch) {
    console.error("could not find a main/master branch");
    process.exitCode = 1;
    return;
  }

  const branches = listBranches(repoDir, mainBranch);
  const now = new Date();
  const decisions = branches
    .map((b) => classifyBranch(b, mainBranch, staleDays, now))
    .filter((d): d is BranchDecision => d !== null);

  console.log(`${decisions.length} stale branches found (threshold ${staleDays} days)\n`);
  for (const d of decisions) {
    console.log(`  ${d.disposition.padEnd(17)} ${d.branch.name}  —  ${d.reason}`);
  }

  const toArchive = decisions.filter((d) => d.disposition === "auto-archive");
  if (toArchive.length === 0) {
    console.log("\nnothing to auto-archive");
    return;
  }

  if (dryRun) {
    console.log(`\n${toArchive.length} branch(es) would be archived (pass --apply to actually do it)`);
    return;
  }

  for (const d of toArchive) {
    const ref = archiveBranch(repoDir, d.branch, now);
    console.log(`  archived ${d.branch.name} -> ${ref}`);
  }
}

main();
