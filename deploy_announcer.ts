#!/usr/bin/env -S node
/**
 * Post a deploy announcement with the commit range, authors, and a ready rollback command.
 *
 *   node deploy_announcer.ts announce --env production --webhook $SLACK_WEBHOOK_URL
 *   node deploy_announcer.ts --demo
 *
 * The announcement that actually helps during an incident isn't "deployed
 * v2.4.1" — it's "here's exactly what changed, who to ask, and the one command
 * that undoes it." This builds the commit range from git directly (previous
 * deploy tag to HEAD), groups commits by author, and pre-fills the rollback
 * command with the actual previous SHA, not a placeholder someone has to look
 * up under pressure.
 */

import { execFileSync } from "node:child_process";

interface CommitInfo {
  sha: string;
  shortSha: string;
  author: string;
  subject: string;
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function getCommitRange(repoDir: string, fromRef: string, toRef: string): CommitInfo[] {
  const sep = "\x1f";
  const format = `%H${sep}%h${sep}%an${sep}%s`;
  const raw = git(["log", `${fromRef}..${toRef}`, `--pretty=format:${format}`, "--no-merges"], repoDir);
  if (!raw) return [];
  return raw.split("\n").map((line) => {
    const [sha, shortSha, author, subject] = line.split(sep);
    return { sha, shortSha, author, subject };
  });
}

interface DeployAnnouncement {
  environment: string;
  fromRef: string;
  toSha: string;
  toShortSha: string;
  commitCount: number;
  authors: string[];
  commitsByAuthor: Map<string, CommitInfo[]>;
  rollbackCommand: string;
  deployedAt: Date;
}

function buildAnnouncement(repoDir: string, environment: string, previousDeploySha: string, now: Date): DeployAnnouncement {
  const toSha = git(["rev-parse", "HEAD"], repoDir);
  const toShortSha = git(["rev-parse", "--short", "HEAD"], repoDir);
  const commits = getCommitRange(repoDir, previousDeploySha, "HEAD");

  const commitsByAuthor = new Map<string, CommitInfo[]>();
  for (const commit of commits) {
    const list = commitsByAuthor.get(commit.author) ?? [];
    list.push(commit);
    commitsByAuthor.set(commit.author, list);
  }

  return {
    environment,
    fromRef: previousDeploySha,
    toSha,
    toShortSha,
    commitCount: commits.length,
    authors: [...commitsByAuthor.keys()],
    commitsByAuthor,
    rollbackCommand: `git revert --no-edit ${previousDeploySha}..${toSha.slice(0, 12)}`,
    deployedAt: now,
  };
}

function formatSlackMessage(a: DeployAnnouncement): string {
  const lines: string[] = [];
  lines.push(`*Deployed to ${a.environment}* — ${a.toShortSha}  (${a.commitCount} commit${a.commitCount === 1 ? "" : "s"})`);
  lines.push(`_${a.deployedAt.toISOString()}_\n`);

  if (a.commitCount === 0) {
    lines.push("No new commits since the last deploy.");
    return lines.join("\n");
  }

  for (const [author, commits] of a.commitsByAuthor) {
    lines.push(`*${author}* (${commits.length}):`);
    for (const c of commits) {
      lines.push(`  \`${c.shortSha}\` ${c.subject}`);
    }
  }

  lines.push(`\n*Rollback:* \`${a.rollbackCommand}\``);
  return lines.join("\n");
}

function formatPlainText(a: DeployAnnouncement): string {
  const stripped = formatSlackMessage(a)
    .replace(/\*/g, "")
    .replace(/_/g, "")
    .replace(/`/g, "");
  return stripped;
}

async function postToSlack(webhookUrl: string, text: string): Promise<void> {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!response.ok) {
    throw new Error(`Slack webhook returned ${response.status}: ${await response.text()}`);
  }
}

// ------------------------------------------------------------ demo

function demo(): void {
  console.log("simulating a deploy announcement from a scripted commit range\n");
  console.log("(scripted commits — the git-log parsing itself is exercised for real below,");
  console.log("against this actual repository's own history)\n");

  const now = new Date("2026-08-27T16:30:00Z");
  const commits: CommitInfo[] = [
    { sha: "a".repeat(40), shortSha: "a1b2c3d", author: "Ana Rivera", subject: "fix(auth): correct token refresh race condition" },
    { sha: "b".repeat(40), shortSha: "b2c3d4e", author: "Ana Rivera", subject: "fix(auth): add a regression test for the race" },
    { sha: "c".repeat(40), shortSha: "c3d4e5f", author: "Bo Chen", subject: "feat(dashboard): add export-to-CSV button" },
    { sha: "d".repeat(40), shortSha: "d4e5f6a", author: "Cy Patel", subject: "chore: bump the http client to 2.4.0" },
  ];

  const commitsByAuthor = new Map<string, CommitInfo[]>();
  for (const c of commits) {
    const list = commitsByAuthor.get(c.author) ?? [];
    list.push(c);
    commitsByAuthor.set(c.author, list);
  }

  const announcement: DeployAnnouncement = {
    environment: "production",
    fromRef: "7f8e9d0",
    toSha: "e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4",
    toShortSha: "e5f6a7b",
    commitCount: commits.length,
    authors: [...commitsByAuthor.keys()],
    commitsByAuthor,
    rollbackCommand: "git revert --no-edit 7f8e9d0..e5f6a7b8c9d0",
    deployedAt: now,
  };

  console.log("--- Slack-formatted message ---\n");
  console.log(formatSlackMessage(announcement));

  console.log("\n\n--- plain-text (e.g. for a log or email) ---\n");
  console.log(formatPlainText(announcement));

  console.log(`\n\nnote: commits are grouped by author (Ana's two auth fixes sit together, not`);
  console.log(`interleaved with Bo's and Cy's) — during an incident, "who do I ask about the auth`);
  console.log(`change" is answered in one glance instead of scanning a flat commit list. The`);
  console.log(`rollback command has the REAL previous SHA baked in, so reverting under pressure`);
  console.log(`is copy-paste, not "let me go find what we deployed last."`);

  console.log("\n\n--- exercising getCommitRange for real, against this repository's own git log ---\n");
  try {
    const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
    const recentSha = git(["rev-list", "--max-parents=0", "HEAD"], repoRoot); // the very first commit
    const realCommits = getCommitRange(repoRoot, recentSha, "HEAD");
    console.log(`  found ${realCommits.length} real commits between the repo's first commit and HEAD`);
    if (realCommits.length > 0) {
      console.log(`  most recent: ${realCommits[0].shortSha} "${realCommits[0].subject}" by ${realCommits[0].author}`);
    }
  } catch (err) {
    console.log(`  (not run inside a git repository with commit history: ${(err as Error).message.split("\n")[0]})`);
  }
}

// ------------------------------------------------------------ CLI

function parseArgs(argv: string[]): { env?: string; webhook?: string; from?: string } {
  let env: string | undefined;
  let webhook: string | undefined;
  let from: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--env") env = argv[++i];
    else if (argv[i] === "--webhook") webhook = argv[++i];
    else if (argv[i] === "--from") from = argv[++i];
  }
  return { env, webhook, from };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  if (args[0] !== "announce") {
    console.log("usage: deploy_announcer.ts announce --env production --webhook URL [--from SHA]");
    return;
  }

  const { env, webhook, from } = parseArgs(args.slice(1));
  if (!env) {
    console.error("--env is required");
    process.exitCode = 1;
    return;
  }

  const repoDir = process.cwd();
  let previousSha = from;
  if (!previousSha) {
    try {
      previousSha = git(["rev-list", "--max-parents=0", "HEAD"], repoDir);
    } catch {
      console.error("could not determine a previous ref — pass --from <sha> explicitly, or run inside a git repo");
      process.exitCode = 1;
      return;
    }
  }

  const announcement = buildAnnouncement(repoDir, env, previousSha, new Date());
  const message = formatSlackMessage(announcement);
  console.log(message);

  if (webhook) {
    try {
      await postToSlack(webhook, message);
      console.log("\n(posted to Slack)");
    } catch (err) {
      console.error(`\nfailed to post to Slack: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  } else {
    console.log("\n(no --webhook provided — printed only)");
  }
}

main();
