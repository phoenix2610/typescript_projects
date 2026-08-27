#!/usr/bin/env -S node
/**
 * Step through failing snapshots one at a time and accept or reject each interactively.
 *
 *   node snapreview.ts __snapshots__/app.snap.new
 *   node snapreview.ts --demo
 *
 * A snapshot test failure dumps every mismatch into one wall of text — this
 * reformats that into one reviewable diff per snapshot, with a running tally, so
 * "47 snapshots failed" becomes 47 individual yes/no decisions instead of one
 * intimidating blob. Accepting a snapshot updates the stored file at exactly that
 * key, leaving every other snapshot in the file untouched — a full `--update-snapshots`
 * run does not have that property, and will happily bless a regression you never looked at.
 */

import * as fs from "node:fs";

interface Snapshot {
  key: string;
  content: string;
}

interface SnapshotFile {
  path: string;
  snapshots: Map<string, string>;
}

function parseSnapshotFile(source: string): Map<string, string> {
  // format: `exports["Suite > case 1"] = `\ncontent\n`;\n\n` repeated
  const map = new Map<string, string>();
  const re = /exports\[(["'])((?:(?!\1).)*)\1\]\s*=\s*`([\s\S]*?)`;/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    map.set(match[2], match[3]);
  }
  return map;
}

function serializeSnapshotFile(snapshots: Map<string, string>): string {
  const parts: string[] = ["// Jest Snapshot v1, https://goo.gl/fbAQLP\n"];
  for (const [key, content] of [...snapshots.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    parts.push(`exports[${JSON.stringify(key)}] = \`${content}\`;\n`);
  }
  return parts.join("\n");
}

type LineOp = { op: "same" | "add" | "remove"; text: string };

/** Line-based LCS diff — simple O(n*m) dynamic programming, fine at snapshot sizes. */
function diffLines(oldText: string, newText: string): LineOp[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: LineOp[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ op: "same", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ op: "remove", text: a[i] });
      i++;
    } else {
      ops.push({ op: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) ops.push({ op: "remove", text: a[i++] });
  while (j < b.length) ops.push({ op: "add", text: b[j++] });
  return ops;
}

function renderDiff(ops: LineOp[], context = 2): string {
  const out: string[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i].op !== "same") {
      const start = Math.max(0, i - context);
      if (out.length && start > 0 && ops[start - 1]?.op === "same") out.push("  ...");
      for (let k = start; k < i; k++) if (ops[k].op === "same") out.push(`    ${ops[k].text}`);
      while (i < ops.length && ops[i].op !== "same") {
        out.push(`${ops[i].op === "add" ? "  + " : "  - "}${ops[i].text}`);
        i++;
      }
      let after = 0;
      while (i < ops.length && ops[i].op === "same" && after < context) {
        out.push(`    ${ops[i].text}`);
        i++;
        after++;
      }
    } else {
      i++;
    }
  }
  return out.join("\n") || "  (no textual difference)";
}

interface ReviewDecision {
  key: string;
  decision: "accept" | "reject" | "skip";
}

function reviewSnapshots(
  stored: Map<string, string>,
  received: Map<string, string>,
  decide: (key: string, oldContent: string | undefined, newContent: string) => "accept" | "reject" | "skip",
): { updated: Map<string, string>; decisions: ReviewDecision[] } {
  const updated = new Map(stored);
  const decisions: ReviewDecision[] = [];

  for (const [key, newContent] of received) {
    const oldContent = stored.get(key);
    if (oldContent === newContent) continue; // identical: nothing to review
    const decision = decide(key, oldContent, newContent);
    decisions.push({ key, decision });
    if (decision === "accept") updated.set(key, newContent);
  }

  return { updated, decisions };
}

// ------------------------------------------------------------ demo

const STORED_SNAPSHOTS = new Map<string, string>([
  ["Button > renders default", "<button class=\"btn\">Click me</button>"],
  ["Button > renders disabled", "<button class=\"btn\" disabled>Click me</button>"],
  ["Card > renders with title", "<div class=\"card\">\n  <h2>Title</h2>\n  <p>Body text</p>\n</div>"],
  ["Header > renders logo", "<header>\n  <img src=\"/logo.svg\" alt=\"Logo\">\n</header>"],
]);

const RECEIVED_SNAPSHOTS = new Map<string, string>([
  ["Button > renders default", "<button class=\"btn\">Click me</button>"], // unchanged
  ["Button > renders disabled", "<button class=\"btn btn-disabled\" disabled>Click me</button>"], // intentional class rename
  ["Card > renders with title", "<div class=\"card\">\n  <h2>Title</h2>\n  <p>Body text</p>\n  <footer>New</footer>\n</div>"], // new feature
  ["Header > renders logo", "<header>\n  <img src=\"/logo.png\" alt=\"Logo\">\n</header>"], // accidental regression — wrong extension
]);

function demo(): void {
  console.log(`${STORED_SNAPSHOTS.size} stored snapshots, ${RECEIVED_SNAPSHOTS.size} received from this test run\n`);

  const changed = [...RECEIVED_SNAPSHOTS.entries()].filter(([key, content]) => STORED_SNAPSHOTS.get(key) !== content);
  console.log(`${changed.length} snapshots differ and need review:\n`);

  // scripted "reviewer": accept intentional-looking changes, reject a regression, skip one
  const scriptedDecisions: Record<string, "accept" | "reject" | "skip"> = {
    "Button > renders disabled": "accept", // deliberate class rename
    "Card > renders with title": "accept", // deliberate new feature
    "Header > renders logo": "reject", // looks like an accidental asset swap, not intended
  };

  let index = 0;
  const { updated, decisions } = reviewSnapshots(STORED_SNAPSHOTS, RECEIVED_SNAPSHOTS, (key, oldContent, newContent) => {
    index++;
    console.log(`[${index}/${changed.length}] ${key}`);
    const diff = diffLines(oldContent ?? "", newContent);
    console.log(renderDiff(diff));
    const decision = scriptedDecisions[key] ?? "skip";
    console.log(`  -> ${decision}\n`);
    return decision;
  });

  console.log("summary:");
  const accepted = decisions.filter((d) => d.decision === "accept").length;
  const rejected = decisions.filter((d) => d.decision === "reject").length;
  console.log(`  ${accepted} accepted (snapshot file updated)`);
  console.log(`  ${rejected} rejected (code needs fixing, or the test needs a closer look)`);
  console.log(`  ${STORED_SNAPSHOTS.size - decisions.length} snapshots untouched (no change from this run)`);

  console.log("\nupdated snapshot file (only the accepted keys changed):\n");
  const serialized = serializeSnapshotFile(updated);
  console.log(serialized.split("\n").slice(0, 12).join("\n") + "\n  ...");

  console.log("\nkey property: rejecting the Header snapshot means it is NOT written back —");
  console.log("a bulk --update-snapshots run would have silently accepted this regression too.");
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  const receivedPath = args[0];
  const storedPath = receivedPath.replace(/\.new$/, "");
  const stored = fs.existsSync(storedPath) ? parseSnapshotFile(fs.readFileSync(storedPath, "utf8")) : new Map<string, string>();
  const received = parseSnapshotFile(fs.readFileSync(receivedPath, "utf8"));

  const changed = [...received.entries()].filter(([key, content]) => stored.get(key) !== content);
  console.log(`${changed.length} snapshots differ`);
  for (const [key, content] of changed) {
    console.log(`\n${key}`);
    console.log(renderDiff(diffLines(stored.get(key) ?? "", content)));
  }
  console.log("\n(interactive accept/reject requires a TTY prompt loop — this prints the diffs; wire up readline for real use)");
}

main();
