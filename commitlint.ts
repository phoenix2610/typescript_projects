#!/usr/bin/env -S node
/**
 * Enforce Conventional Commits as a git hook: a fixable error, not a rejection you have to guess at.
 *
 *   node commitlint.ts .git/COMMIT_EDITMSG
 *   node commitlint.ts --demo
 *   git config core.hooksPath .githooks   # then drop this at .githooks/commit-msg
 *
 * The header is parsed against the spec exactly: type(scope)!: subject. Every
 * failure names the rule and, where possible, the fix — "subject must not end
 * with a period" beats "invalid commit message" every time. Body/footer checks
 * (line length, blank line separation, breaking-change footer format) run only
 * when those parts exist, so a one-line commit isn't punished for missing a body.
 */

import * as fs from "node:fs";

interface LintIssue {
  rule: string;
  message: string;
  severity: "error" | "warning";
  line?: number;
}

const TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];

const HEADER_RE = /^(\w+)(\(([^)]*)\))?(!)?: (.+)$/;

function lint(message: string): LintIssue[] {
  const issues: LintIssue[] = [];
  const rawLines = message.replace(/\r\n/g, "\n").split("\n");
  // strip trailing comment lines the way git leaves them in COMMIT_EDITMSG
  const lines = rawLines.filter((l) => !l.startsWith("#"));
  while (lines.length && lines.at(-1) === "") lines.pop();

  if (lines.length === 0 || lines[0].trim() === "") {
    issues.push({ rule: "header-empty", message: "commit message has no header line", severity: "error", line: 1 });
    return issues;
  }

  const header = lines[0];

  if (header.length > 72) {
    issues.push({
      rule: "header-max-length",
      message: `header is ${header.length} characters (max 72) — shorten the subject`,
      severity: "error",
      line: 1,
    });
  }

  const match = header.match(HEADER_RE);
  if (!match) {
    issues.push({
      rule: "header-format",
      message: `header does not match "type(scope): subject" — got ${JSON.stringify(header)}`,
      severity: "error",
      line: 1,
    });
  } else {
    const [, type, , scope, breaking, subject] = match;

    if (!TYPES.includes(type)) {
      issues.push({
        rule: "type-enum",
        message: `type ${JSON.stringify(type)} is not one of: ${TYPES.join(", ")}`,
        severity: "error",
        line: 1,
      });
    }
    if (type !== type.toLowerCase()) {
      issues.push({ rule: "type-case", message: `type should be lowercase — use "${type.toLowerCase()}"`, severity: "error", line: 1 });
    }
    if (scope !== undefined && scope.trim() === "") {
      issues.push({ rule: "scope-empty", message: "scope parentheses are empty — remove them or name a scope", severity: "error", line: 1 });
    }
    if (subject.endsWith(".")) {
      issues.push({ rule: "subject-full-stop", message: "subject must not end with a period — drop the trailing \".\"", severity: "error", line: 1 });
    }
    if (subject[0] !== subject[0].toLowerCase() && /[A-Z]/.test(subject[0])) {
      issues.push({
        rule: "subject-case",
        message: `subject starts with a capital — use "${subject[0].toLowerCase()}${subject.slice(1)}"`,
        severity: "warning",
        line: 1,
      });
    }
    if (/^(added|fixed|updated|removed|changed)\b/i.test(subject)) {
      issues.push({
        rule: "subject-imperative",
        message: `subject should use the imperative mood ("add", not "${subject.split(" ")[0]}") — describes what the commit does, not what you did`,
        severity: "warning",
        line: 1,
      });
    }
    if (subject.trim().length === 0) {
      issues.push({ rule: "subject-empty", message: "subject is empty", severity: "error", line: 1 });
    }
    if (breaking && !/BREAKING CHANGE:/.test(lines.slice(1).join("\n"))) {
      issues.push({
        rule: "breaking-footer-missing",
        message: '"!" marks a breaking change but no "BREAKING CHANGE:" footer was found',
        severity: "warning",
      });
    }
  }

  if (lines.length > 1) {
    if (lines[1].trim() !== "") {
      issues.push({ rule: "body-leading-blank", message: "the body must be separated from the header by one blank line", severity: "error", line: 2 });
    }
    for (let i = 2; i < lines.length; i++) {
      if (lines[i].length > 100 && !/https?:\/\/\S+/.test(lines[i])) {
        issues.push({
          rule: "body-max-line-length",
          message: `body line ${i + 1} is ${lines[i].length} characters (max 100) — wrap it`,
          severity: "warning",
          line: i + 1,
        });
      }
    }
  }

  const footerLines = lines.slice(2).filter((l) => l.trim() !== "");
  for (const line of footerLines) {
    if (/^BREAKING CHANGE:/.test(line) && line === "BREAKING CHANGE:") {
      issues.push({ rule: "breaking-footer-empty", message: "BREAKING CHANGE: footer has no description", severity: "error" });
    }
  }

  return issues;
}

function formatReport(message: string, issues: LintIssue[]): string {
  const header = message.split("\n")[0];
  if (issues.length === 0) return `ok: ${JSON.stringify(header)}`;
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  const lines: string[] = [`${errors.length ? "REJECTED" : "warnings"}: ${JSON.stringify(header)}`];
  for (const issue of issues) {
    const marker = issue.severity === "error" ? "error  " : "warning";
    lines.push(`  ${marker}  [${issue.rule}]  ${issue.message}`);
  }
  if (warnings.length && errors.length === 0) lines.push(`  (${warnings.length} warning(s), commit allowed)`);
  return lines.join("\n");
}

// ------------------------------------------------------------ demo

function demo(): void {
  const cases: { label: string; message: string }[] = [
    { label: "a perfect conventional commit", message: "feat(auth): add refresh token rotation" },
    { label: "with a body, correctly separated", message: "fix(cache): evict stale entries on write\n\nThe TTL check only ran on read, so a write after expiry\nwould silently resurrect a dead entry." },
    { label: "missing the blank line before the body", message: "fix: correct off-by-one in pagination\nThis was causing the last page to be dropped." },
    { label: "not conventional at all", message: "fixed the bug in the thing" },
    { label: "unknown type", message: "improvement: speed up the build" },
    { label: "subject ends with a period", message: "chore: bump dependencies." },
    { label: "subject capitalized (warning, not error)", message: "docs: Update the README with setup instructions" },
    { label: "past-tense subject (warning)", message: "feat: added dark mode toggle" },
    { label: "breaking change, no footer", message: "feat(api)!: remove the deprecated v1 endpoints" },
    { label: "breaking change with a proper footer", message: "feat(api)!: remove the deprecated v1 endpoints\n\nBREAKING CHANGE: /v1/* routes now return 410 Gone." },
    { label: "empty scope parens", message: "fix(): typo in error message" },
    { label: "header way too long", message: "feat: this is an extremely long subject line that goes on and on and really should have been split into a body instead of one giant header" },
    { label: "a long URL in the body is exempt from wrapping", message: "docs: link the RFC\n\nSee https://www.rfc-editor.org/rfc/rfc9110.html#section-really-quite-long-fragment-identifier-here for details." },
  ];

  let rejected = 0;
  let clean = 0;
  for (const { label, message } of cases) {
    console.log(`\n${label}`);
    console.log(`  $ ${JSON.stringify(message.split("\n")[0])}`);
    const issues = lint(message);
    const report = formatReport(message, issues);
    for (const line of report.split("\n")) console.log("  " + line);
    if (issues.some((i) => i.severity === "error")) rejected++;
    else if (issues.length === 0) clean++;
  }

  console.log(`\n${cases.length} messages checked: ${clean} clean, ${rejected} would be rejected by the hook`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  const path = args[0];
  const message = fs.readFileSync(path, "utf8");
  const issues = lint(message);
  console.log(formatReport(message, issues));
  process.exit(issues.some((i) => i.severity === "error") ? 1 : 0);
}

main();
