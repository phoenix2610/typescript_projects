#!/usr/bin/env -S node
/**
 * Render Markdown in the terminal: headings, lists, tables, and syntax-highlighted code.
 *
 *   node mdrender.ts README.md
 *   node mdrender.ts --demo
 *
 * A block-level parser first: split the source into paragraphs, headings, lists,
 * code fences and tables by scanning line by line, then render each block with
 * inline formatting (bold, italic, code, links) applied within it. Code fences get
 * a minimal tokenizer per language — just enough to colour keywords, strings and
 * comments differently, which is most of what makes a code block readable.
 */

import * as fs from "node:fs";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
  bgGray: "\x1b[100m",
};

function paint(text: string, ...codes: string[]): string {
  return codes.join("") + text + ANSI.reset;
}

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" }
  | { kind: "table"; header: string[]; rows: string[][] };

function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i++;
      continue;
    }

    if (/^```/.test(line)) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      blocks.push({ kind: "code", lang, lines: codeLines });
      continue;
    }

    const headingMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      blocks.push({ kind: "heading", level: headingMatch[1].length, text: headingMatch[2] });
      i++;
      continue;
    }

    if (/^([-*_])\1{2,}\s*$/.test(line.trim())) {
      blocks.push({ kind: "hr" });
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoteLines: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", lines: quoteLines });
      continue;
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*([-*+]|\d+\.)\s+/, ""));
        i++;
      }
      blocks.push({ kind: "list", ordered, items });
      continue;
    }

    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = line
        .split("|")
        .slice(1, -1)
        .map((c) => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) {
        rows.push(
          lines[i]
            .split("|")
            .slice(1, -1)
            .map((c) => c.trim()),
        );
        i++;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const paraLines: string[] = [line];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|\s*([-*+]|\d+\.)\s|>\s?|\|.*\|)/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "paragraph", text: paraLines.join(" ") });
  }

  return blocks;
}

// Placeholder tokens stand in for already-rendered (ANSI-wrapped) fragments while
// later regex passes run over the rest of the text. They must never collide with
// anything a later pass might match: not real content, not the digits inside an
// ANSI code like "\x1b[36m", and not each other. Encoding the index in letters
// (base26, zero digits) inside visible bracket delimiters rules out every one of
// those — a generic \d+ matcher has nothing to catch, and the brackets are ordinary
// printable characters, not control codes that a pipeline might mangle.
function encodeToken(n: number): string {
  let x = n + 1;
  let out = "";
  while (x > 0) {
    x--;
    out = String.fromCharCode(97 + (x % 26)) + out;
    x = Math.floor(x / 26);
  }
  return out;
}
function makeTokenizer(tag: string): { hide: (rendered: string) => string; restore: (text: string) => string } {
  const store: string[] = [];
  const open = `⟦${tag}`;
  const close = `⟧`;
  const restoreRe = new RegExp(`${open}([a-z]+)${close}`, "g");
  return {
    hide: (rendered: string): string => {
      store.push(rendered);
      return `${open}${encodeToken(store.length - 1)}${close}`;
    },
    restore: (text: string): string =>
      text.replace(restoreRe, (_, letters: string) => {
        let n = 0;
        for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 96);
        return store[n - 1];
      }),
  };
}

/** Inline formatting: bold, italic, code spans, links. Order matters — code spans must resolve first
 *  so `**not bold**` inside backticks does not get parsed as emphasis. */
function renderInline(text: string): string {
  const codeSpans = makeTokenizer("C");
  let out = text.replace(/`([^`]+)`/g, (_, code) => codeSpans.hide(paint(` ${code} `, ANSI.bgGray, ANSI.yellow)));

  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, url) => paint(label, ANSI.underline, ANSI.blue) + paint(` (${url})`, ANSI.gray));
  out = out.replace(/\*\*([^*]+)\*\*/g, (_, bold) => paint(bold, ANSI.bold));
  out = out.replace(/__([^_]+)__/g, (_, bold) => paint(bold, ANSI.bold));
  out = out.replace(/\*([^*]+)\*/g, (_, italic) => paint(italic, ANSI.italic));
  out = out.replace(/(?<![a-zA-Z0-9])_([^_]+)_(?![a-zA-Z0-9])/g, (_, italic) => paint(italic, ANSI.italic));

  return codeSpans.restore(out);
}

const KEYWORDS: Record<string, RegExp> = {
  javascript: /\b(const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|typeof|instanceof|try|catch|throw)\b/g,
  typescript: /\b(const|let|var|function|return|if|else|for|while|class|new|import|export|from|async|await|typeof|instanceof|try|catch|throw|interface|type|enum|extends|implements|public|private)\b/g,
  python: /\b(def|return|if|elif|else|for|while|class|import|from|as|try|except|with|lambda|yield|None|True|False|and|or|not|in|is)\b/g,
  bash: /\b(if|then|else|fi|for|do|done|while|function|echo|export|local|return)\b/g,
};

function highlightCode(line: string, lang: string): string {
  let result = line;
  const strings = makeTokenizer("S");
  result = result.replace(/(".*?"|'.*?')/g, (m) => strings.hide(paint(m, ANSI.green)));

  const comments = makeTokenizer("X");
  const commentPattern = lang === "python" || lang === "bash" ? /#.*/ : /\/\/.*/;
  result = result.replace(commentPattern, (m) => comments.hide(paint(m, ANSI.gray)));

  const keywordRe = KEYWORDS[lang];
  if (keywordRe) result = result.replace(keywordRe, (m) => paint(m, ANSI.magenta));
  result = result.replace(/\b\d+(\.\d+)?\b/g, (m) => paint(m, ANSI.cyan));

  result = strings.restore(result);
  result = comments.restore(result);
  return result;
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  const visibleLength = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (visibleLength(candidate) > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function renderBlocks(blocks: Block[], width = 76): string {
  const out: string[] = [];
  const headingStyle: Record<number, string[]> = {
    1: [ANSI.bold, ANSI.underline, ANSI.cyan],
    2: [ANSI.bold, ANSI.cyan],
    3: [ANSI.bold],
  };

  for (const block of blocks) {
    if (block.kind === "heading") {
      const style = headingStyle[block.level] ?? [ANSI.bold, ANSI.dim];
      const prefix = "#".repeat(block.level) + " ";
      out.push(paint(prefix + block.text, ...style));
      out.push("");
    } else if (block.kind === "paragraph") {
      out.push(...wrapText(renderInline(block.text), width));
      out.push("");
    } else if (block.kind === "code") {
      const lang = block.lang || "text";
      out.push(paint(`  ${lang}`, ANSI.dim));
      for (const line of block.lines) {
        out.push("  " + paint("│ ", ANSI.dim) + highlightCode(line, lang));
      }
      out.push("");
    } else if (block.kind === "list") {
      block.items.forEach((item, idx) => {
        const marker = block.ordered ? `${idx + 1}.` : "•";
        out.push(`  ${paint(marker, ANSI.yellow)} ${renderInline(item)}`);
      });
      out.push("");
    } else if (block.kind === "quote") {
      for (const line of block.lines) out.push(paint("  ┃ ", ANSI.gray) + paint(renderInline(line), ANSI.italic, ANSI.gray));
      out.push("");
    } else if (block.kind === "hr") {
      out.push(paint("─".repeat(width), ANSI.dim));
      out.push("");
    } else if (block.kind === "table") {
      const widths = block.header.map((h, c) => Math.max(h.length, ...block.rows.map((r) => (r[c] ?? "").length)));
      const renderRow = (cells: string[], style: string[]): string =>
        "  " + cells.map((c, idx) => paint((c ?? "").padEnd(widths[idx]), ...style)).join("  " + paint("│", ANSI.dim) + "  ");
      out.push(renderRow(block.header, [ANSI.bold]));
      out.push("  " + paint(widths.map((w) => "─".repeat(w)).join("──┼──"), ANSI.dim));
      for (const row of block.rows) out.push(renderRow(row, []));
      out.push("");
    }
  }
  return out.join("\n");
}

// ------------------------------------------------------------ demo

const SAMPLE = `# Deploy Pipeline

A short readme to show off **bold**, *italic*, \`inline code\`, and [a link](https://example.com).

## Steps

1. Run \`npm test\`
2. Build the *production* bundle
3. Push to the registry

- checks out the branch
- runs lint and tests
- publishes on green

> Note: this only runs on \`main\`. Feature branches skip the publish step.

\`\`\`typescript
interface Job {
  id: string;
  retries: number;
}

async function run(job: Job): Promise<void> {
  // three attempts before giving up
  for (let i = 0; i < job.retries; i++) {
    if (await attempt(job)) return;
  }
  throw new Error("job failed");
}
\`\`\`

| Stage | Duration | Status |
|-------|----------|--------|
| build | 42s | ok |
| test | 118s | ok |
| deploy | 9s | pending |

---

That's the whole pipeline.
`;

function demo(): void {
  const blocks = parseBlocks(SAMPLE);
  console.log(renderBlocks(blocks));
  console.log(paint(`\n${blocks.length} blocks parsed: `, ANSI.dim) + blocks.map((b) => b.kind).join(", "));

  console.log(paint("\nround-trip check on the tokenizer itself:", ANSI.dim));
  const tricky = "code has 12345 digits and **stars** inside `a**b**c123` spans";
  const rendered = renderInline(tricky);
  const stripped = rendered.replace(/\x1b\[[0-9;]*m/g, "");
  console.log(`  input:  ${tricky}`);
  console.log(`  output: ${stripped}`);
  console.log(`  no leftover token brackets: ${!rendered.includes("⟦")}`);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    return;
  }
  const source = fs.readFileSync(args[0], "utf8");
  const columns = process.stdout.columns ? Math.min(process.stdout.columns - 4, 100) : 76;
  console.log(renderBlocks(parseBlocks(source), columns));
}

main();
