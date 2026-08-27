#!/usr/bin/env -S node
/**
 * Query a JSON data source, render an HTML report, and send it over real SMTP.
 *
 *   node report_emailer.ts send --to ops@example.com --data metrics.json --smtp-host localhost --smtp-port 1025
 *   node report_emailer.ts --demo
 *
 * Speaks SMTP directly over a raw TCP socket (no nodemailer) — EHLO, MAIL FROM,
 * RCPT TO, DATA, the whole handshake, with a properly MIME-multipart message so
 * the HTML report renders instead of showing up as an attachment or raw markup.
 * The report itself computes week-over-week deltas and color-codes them, since
 * "revenue: $48,200" means nothing on its own — "$48,200, up 12% from last week"
 * is the sentence someone actually reads.
 */

import * as net from "node:net";
import * as crypto from "node:crypto";

interface MetricPoint {
  label: string;
  value: number;
  unit: string;
  previousValue?: number;
}

interface ReportData {
  title: string;
  periodLabel: string;
  metrics: MetricPoint[];
}

function formatDelta(current: number, previous: number | undefined): string {
  if (previous === undefined || previous === 0) return "";
  const pct = ((current - previous) / previous) * 100;
  const arrow = pct > 0 ? "&#9650;" : pct < 0 ? "&#9660;" : "&#9679;";
  const color = pct > 0 ? "#1a7f37" : pct < 0 ? "#cf222e" : "#57606a";
  return ` <span style="color:${color}">${arrow} ${Math.abs(pct).toFixed(1)}%</span>`;
}

function renderHtmlReport(data: ReportData): string {
  const rows = data.metrics
    .map((m) => {
      const delta = formatDelta(m.value, m.previousValue);
      return `<tr>
        <td style="padding:8px 16px;border-bottom:1px solid #eee;">${escapeHtml(m.label)}</td>
        <td style="padding:8px 16px;border-bottom:1px solid #eee;font-weight:600;">${m.value.toLocaleString()}${escapeHtml(m.unit)}${delta}</td>
      </tr>`;
    })
    .join("\n");

  return `<!doctype html>
<html><body style="font-family:sans-serif;max-width:520px;margin:0 auto;">
  <h2 style="margin-bottom:4px;">${escapeHtml(data.title)}</h2>
  <p style="color:#57606a;margin-top:0;">${escapeHtml(data.periodLabel)}</p>
  <table style="width:100%;border-collapse:collapse;">
    ${rows}
  </table>
</body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPlainTextFallback(data: ReportData): string {
  const lines = [data.title, data.periodLabel, ""];
  for (const m of data.metrics) {
    const deltaText = m.previousValue !== undefined && m.previousValue !== 0
      ? `  (${(((m.value - m.previousValue) / m.previousValue) * 100).toFixed(1)}% vs previous)`
      : "";
    lines.push(`${m.label}: ${m.value.toLocaleString()}${m.unit}${deltaText}`);
  }
  return lines.join("\n");
}

interface MimeMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

function buildMimeMessage(msg: MimeMessage): string {
  const boundary = `----=_Part_${crypto.randomBytes(12).toString("hex")}`;
  return [
    `From: ${msg.from}`,
    `To: ${msg.to}`,
    `Subject: ${msg.subject}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    msg.text,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    msg.html,
    ``,
    `--${boundary}--`,
    ``,
  ].join("\r\n");
}

/** A minimal SMTP client speaking the raw protocol over a TCP socket: connect,
 *  read the greeting, EHLO, MAIL FROM, RCPT TO, DATA, the message, the
 *  terminating "." line, QUIT. Enough to talk to any real SMTP server, including
 *  a local test server like `python3 -m smtpd` or MailHog/Mailpit. */
function sendViaSmtp(host: string, port: number, from: string, to: string, rawMessage: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const transcript: string[] = [];
    let step = 0;

    const steps = [
      `EHLO localhost\r\n`,
      `MAIL FROM:<${from}>\r\n`,
      `RCPT TO:<${to}>\r\n`,
      `DATA\r\n`,
      rawMessage + "\r\n.\r\n",
      `QUIT\r\n`,
    ];

    let buffer = "";
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("SMTP session timed out"));
    }, 10_000);

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split("\r\n").filter(Boolean);
      const lastLine = lines[lines.length - 1] ?? "";
      // an SMTP reply is "complete" once the last line has a space (not a dash) after the code
      if (!/^\d{3}[ -]/.test(lastLine) || /^\d{3} /.test(lastLine)) {
        transcript.push(...lines);
        buffer = "";
        if (step < steps.length) {
          socket.write(steps[step]);
          step++;
        } else {
          clearTimeout(timeout);
          socket.end();
        }
      }
    });

    socket.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    socket.on("close", () => {
      clearTimeout(timeout);
      resolve(transcript);
    });
  });
}

// ------------------------------------------------------------ demo

const SAMPLE_DATA: ReportData = {
  title: "Weekly Ops Report",
  periodLabel: "Aug 20 - Aug 27, 2026",
  metrics: [
    { label: "Revenue", value: 48200, unit: " USD", previousValue: 43000 },
    { label: "Active users", value: 12840, unit: "", previousValue: 13100 },
    { label: "Support tickets opened", value: 214, unit: "", previousValue: 190 },
    { label: "Avg response time", value: 4.2, unit: "h", previousValue: 4.2 },
    { label: "New signups", value: 890, unit: "" }, // no previous value — first time tracked
  ],
};

function demo(): void {
  console.log("1. rendering the report\n");
  const html = renderHtmlReport(SAMPLE_DATA);
  const text = renderPlainTextFallback(SAMPLE_DATA);

  console.log("plain-text fallback:\n");
  console.log(text);

  console.log("\n\nHTML (first 400 chars):\n");
  console.log(html.slice(0, 400) + "...");

  console.log(`\n\nnote: Revenue shows an up-arrow (+12.1%), Active users shows a down-arrow`);
  console.log(`(-2.0%), and Avg response time shows a flat dot (0.0% — genuinely unchanged, not`);
  console.log(`just close to zero). New signups has no previous value at all (first time this`);
  console.log(`metric was tracked) and correctly shows no delta rather than a fake "up from`);
  console.log(`nothing" or a crash from dividing by an undefined previous value.`);

  console.log("\n\n2. the MIME message that would actually be sent\n");
  const mime = buildMimeMessage({ from: "reports@example.com", to: "ops@example.com", subject: SAMPLE_DATA.title, html, text });
  console.log(mime.split("\r\n").slice(0, 12).join("\n") + "\n...");
}

async function demoRealSmtp(): Promise<void> {
  console.log("\n\n3. a real SMTP handshake — starting a throwaway local SMTP listener\n");

  // a minimal SMTP server implementing just enough of the protocol to accept a
  // real message, so the client above can be exercised against genuine TCP I/O
  const net_ = await import("node:net");
  const received: string[] = [];
  let dataMode = false;
  let dataBuffer = "";

  const server = net_.createServer((socket) => {
    socket.write("220 localhost SMTP test server\r\n");
    socket.on("data", (chunk) => {
      const line = chunk.toString();
      if (dataMode) {
        dataBuffer += line;
        if (dataBuffer.endsWith("\r\n.\r\n")) {
          dataMode = false;
          received.push(dataBuffer.slice(0, -5));
          socket.write("250 OK: message accepted\r\n");
        }
        return;
      }
      if (/^DATA/i.test(line)) {
        dataMode = true;
        dataBuffer = "";
        socket.write("354 Start mail input; end with <CRLF>.<CRLF>\r\n");
      } else if (/^QUIT/i.test(line)) {
        socket.write("221 Bye\r\n");
        socket.end();
      } else {
        socket.write("250 OK\r\n");
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  console.log(`  test SMTP server listening on 127.0.0.1:${port}\n`);

  const mime = buildMimeMessage({
    from: "reports@example.com",
    to: "ops@example.com",
    subject: SAMPLE_DATA.title,
    html: renderHtmlReport(SAMPLE_DATA),
    text: renderPlainTextFallback(SAMPLE_DATA),
  });

  const transcript = await sendViaSmtp("127.0.0.1", port, "reports@example.com", "ops@example.com", mime);
  console.log("  SMTP transcript (server replies):");
  for (const line of transcript) console.log(`    ${line}`);

  console.log(`\n  message actually received by the server: ${received.length} message(s)`);
  console.log(`  received body contains the real subject line: ${received[0]?.includes("Weekly Ops Report")}`);
  console.log(`  received body contains the rendered HTML table: ${received[0]?.includes("<table")}`);

  await new Promise<void>((resolve) => server.close(() => resolve()));
}

// ------------------------------------------------------------ CLI

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    await demoRealSmtp();
    return;
  }

  if (args[0] !== "send") {
    console.log("usage: report_emailer.ts send --to EMAIL --data FILE.json --smtp-host HOST --smtp-port PORT");
    return;
  }

  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const to = get("--to");
  const dataPath = get("--data");
  const smtpHost = get("--smtp-host") ?? "localhost";
  const smtpPort = Number(get("--smtp-port") ?? "25");
  const from = get("--from") ?? "reports@example.com";

  if (!to || !dataPath) {
    console.error("--to and --data are required");
    process.exitCode = 1;
    return;
  }

  const fs = await import("node:fs");
  const data = JSON.parse(fs.readFileSync(dataPath, "utf8")) as ReportData;
  const html = renderHtmlReport(data);
  const text = renderPlainTextFallback(data);
  const mime = buildMimeMessage({ from, to, subject: data.title, html, text });

  try {
    const transcript = await sendViaSmtp(smtpHost, smtpPort, from, to, mime);
    console.log(`sent to ${to} via ${smtpHost}:${smtpPort}`);
    console.log(transcript.join("\n"));
  } catch (err) {
    console.error(`failed to send: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

main();
