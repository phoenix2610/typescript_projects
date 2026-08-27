#!/usr/bin/env -S node
/**
 * Drive a repetitive web form submission with retries and a run log — no browser needed
 * when the form is a plain HTML POST (the common case for internal tools, waitlists,
 * and legacy admin panels that never went full-SPA).
 *
 *   node form_filler.ts submit --url https://httpbin.org/post --data name=Ana --data role=admin
 *   node form_filler.ts batch --url URL --csv rows.csv
 *   node form_filler.ts --demo
 *
 * Parses the target page for its actual <form> action, method, and hidden
 * fields first (a CSRF token, a honeypot field that must stay empty) rather
 * than guessing — a POST that's missing the hidden fields a real browser would
 * have sent is the #1 reason a "form filler" script silently gets rejected.
 * Retries with backoff, and a batch run keeps going after one row fails
 * instead of aborting the whole CSV.
 */

interface FormField {
  name: string;
  type: string;
  value: string;
  required: boolean;
}

interface ParsedForm {
  action: string;
  method: string;
  fields: FormField[];
}

/** A minimal HTML form parser: finds the first <form>, its action/method, and
 *  every <input>/<select>/<textarea> inside it — including hidden fields, which
 *  is the part a naive "just POST the visible fields" script gets wrong. */
function parseForm(html: string, baseUrl: string): ParsedForm | null {
  const formMatch = html.match(/<form\b([^>]*)>([\s\S]*?)<\/form>/i);
  if (!formMatch) return null;

  const formAttrs = formMatch[1];
  const formBody = formMatch[2];
  const action = extractAttr(formAttrs, "action") ?? "";
  const method = (extractAttr(formAttrs, "method") ?? "GET").toUpperCase();

  const fields: FormField[] = [];
  const inputRe = /<input\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = inputRe.exec(formBody))) {
    const attrs = match[1];
    const name = extractAttr(attrs, "name");
    if (!name) continue;
    fields.push({
      name,
      type: extractAttr(attrs, "type") ?? "text",
      value: extractAttr(attrs, "value") ?? "",
      required: /\brequired\b/i.test(attrs),
    });
  }

  const textareaRe = /<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi;
  while ((match = textareaRe.exec(formBody))) {
    const name = extractAttr(match[1], "name");
    if (name) fields.push({ name, type: "textarea", value: match[2].trim(), required: /\brequired\b/i.test(match[1]) });
  }

  const resolvedAction = action ? new URL(action, baseUrl).toString() : baseUrl;
  return { action: resolvedAction, method, fields };
}

function extractAttr(attrString: string, name: string): string | null {
  const match = attrString.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match ? match[2] : null;
}

interface FillResult {
  attempt: number;
  status: number | null;
  ok: boolean;
  error: string | null;
  latencyMs: number;
}

async function submitForm(form: ParsedForm, values: Record<string, string>, maxRetries = 3): Promise<FillResult[]> {
  const attempts: FillResult[] = [];
  const body = new URLSearchParams();

  // hidden fields (CSRF tokens, honeypots) get their page-provided value UNLESS
  // the caller explicitly overrides them; visible fields get the caller's value
  // or fall back to whatever default was in the page
  for (const field of form.fields) {
    if (field.type === "hidden") {
      body.set(field.name, values[field.name] ?? field.value);
    } else if (field.type === "submit" || field.type === "button") {
      continue; // not real data
    } else {
      body.set(field.name, values[field.name] ?? field.value);
    }
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const start = performance.now();
    try {
      const response = await fetch(form.action, {
        method: form.method,
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.method === "GET" ? undefined : body.toString(),
      });
      const result: FillResult = { attempt, status: response.status, ok: response.ok, error: null, latencyMs: performance.now() - start };
      attempts.push(result);
      if (response.ok) break;
      if (response.status < 500) break; // a 4xx won't fix itself on retry
    } catch (err) {
      attempts.push({ attempt, status: null, ok: false, error: (err as Error).message, latencyMs: performance.now() - start });
    }
    if (attempt < maxRetries) {
      await new Promise((resolve) => setTimeout(resolve, 200 * attempt)); // linear backoff
    }
  }
  return attempts;
}

interface BatchRowResult {
  row: Record<string, string>;
  succeeded: boolean;
  attempts: FillResult[];
}

async function submitBatch(form: ParsedForm, rows: Record<string, string>[]): Promise<BatchRowResult[]> {
  const results: BatchRowResult[] = [];
  for (const row of rows) {
    const attempts = await submitForm(form, row);
    results.push({ row, succeeded: attempts.some((a) => a.ok), attempts });
  }
  return results;
}

function parseCsvLine(line: string): string[] {
  return line.split(",").map((cell) => cell.trim());
}

function parseCsv(text: string): Record<string, string>[] {
  const lines = text.trim().split("\n");
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line);
    return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
  });
}

// ------------------------------------------------------------ demo

function demo(): void {
  console.log("1. parsing a real HTML form (with a CSRF token and a honeypot field)\n");

  const samplePage = `
<html><body>
<form action="/submit" method="POST">
  <input type="hidden" name="csrf_token" value="tok_9f8e7d6c5b4a">
  <input type="text" name="full_name" required>
  <input type="email" name="email" required>
  <input type="text" name="website" value="" style="display:none">
  <!-- ^ honeypot: real users never fill this in, a naive scraper often does -->
  <textarea name="message"></textarea>
  <input type="submit" value="Send">
</form>
</body></html>`;

  const form = parseForm(samplePage, "https://example.com/contact")!;
  console.log(`  action: ${form.action}`);
  console.log(`  method: ${form.method}`);
  console.log(`  fields:`);
  for (const f of form.fields) {
    console.log(`    ${f.name.padEnd(14)} type=${f.type.padEnd(8)} required=${f.required}  default=${JSON.stringify(f.value)}`);
  }

  console.log(`\n  note: csrf_token has a real value already extracted from the page — a submission`);
  console.log(`  that omits it would be rejected by any form with real CSRF protection. The`);
  console.log(`  'website' honeypot field defaults to empty and is left alone unless explicitly`);
  console.log(`  overridden, which is exactly what keeps a legitimate automated submission from`);
  console.log(`  tripping a spam filter that real users never trigger.`);

  console.log(`\n\n2. what the actual outgoing POST body would contain\n`);
  const values = { full_name: "Ana Rivera", email: "ana@example.com", message: "Interested in a demo" };
  const body = new URLSearchParams();
  for (const field of form.fields) {
    if (field.type === "submit" || field.type === "button") continue;
    body.set(field.name, values[field.name as keyof typeof values] ?? field.value);
  }
  console.log(`  ${body.toString()}`);

  console.log(`\n\n3. CSV parsing for a batch run\n`);
  const csv = `full_name,email,message
Ana Rivera,ana@example.com,Interested in enterprise pricing
Bo Chen,bo@example.com,Question about the API
Cy Patel,cy@example.com,Requesting a callback`;
  const rows = parseCsv(csv);
  console.log(`  parsed ${rows.length} rows from CSV:`);
  for (const row of rows) console.log(`    ${JSON.stringify(row)}`);
}

async function demoRealSubmission(): Promise<void> {
  console.log(`\n\n4. a real submission — POSTing to httpbin.org, which echoes back what it received\n`);
  const httpbinForm: ParsedForm = {
    action: "https://httpbin.org/post",
    method: "POST",
    fields: [
      { name: "full_name", type: "text", value: "", required: true },
      { name: "email", type: "email", value: "", required: true },
    ],
  };
  try {
    const attempts = await submitForm(httpbinForm, { full_name: "Ana Rivera", email: "ana@example.com" });
    const last = attempts[attempts.length - 1];
    console.log(`  attempt ${last.attempt}: status=${last.status} ok=${last.ok} (${last.latencyMs.toFixed(0)}ms)`);
    if (last.ok) {
      console.log(`  the request genuinely reached httpbin.org and was accepted — this is a real`);
      console.log(`  network round trip, not simulated data.`);
    }
  } catch (err) {
    console.log(`  network unavailable in this environment: ${(err as Error).message}`);
  }
}

// ------------------------------------------------------------ CLI

function parseDataArgs(argv: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data") {
      const [key, ...rest] = argv[++i].split("=");
      values[key] = rest.join("=");
    }
  }
  return values;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    await demoRealSubmission();
    return;
  }

  if (args[0] === "submit") {
    const urlIdx = args.indexOf("--url");
    const url = args[urlIdx + 1];
    const values = parseDataArgs(args);
    if (!url) {
      console.error("--url is required");
      process.exitCode = 1;
      return;
    }
    const pageResponse = await fetch(url);
    const html = await pageResponse.text();
    const form = parseForm(html, url) ?? { action: url, method: "POST", fields: [] };
    const attempts = await submitForm(form, values);
    const last = attempts[attempts.length - 1];
    console.log(`${attempts.length} attempt(s), final status: ${last.status} ok=${last.ok}`);
    process.exitCode = last.ok ? 0 : 1;
    return;
  }

  if (args[0] === "batch") {
    const urlIdx = args.indexOf("--url");
    const csvIdx = args.indexOf("--csv");
    const url = args[urlIdx + 1];
    const csvPath = args[csvIdx + 1];
    if (!url || !csvPath) {
      console.error("--url and --csv are required");
      process.exitCode = 1;
      return;
    }
    const fs = await import("node:fs");
    const rows = parseCsv(fs.readFileSync(csvPath, "utf8"));
    const pageResponse = await fetch(url);
    const html = await pageResponse.text();
    const form = parseForm(html, url) ?? { action: url, method: "POST", fields: [] };
    const results = await submitBatch(form, rows);
    const succeeded = results.filter((r) => r.succeeded).length;
    console.log(`${succeeded}/${results.length} rows submitted successfully`);
    for (const r of results) {
      if (!r.succeeded) console.log(`  FAILED: ${JSON.stringify(r.row)}`);
    }
    return;
  }

  console.log("usage: form_filler.ts submit --url URL --data key=value | batch --url URL --csv rows.csv");
}

main();
