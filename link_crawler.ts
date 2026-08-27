#!/usr/bin/env -S node
/**
 * Crawl a site from its sitemap (or by following links) and report every broken one.
 *
 *   node link_crawler.ts https://example.com --max-pages 50
 *   node link_crawler.ts --demo
 *
 * Distinguishes internal links (part of the crawl — followed AND checked) from
 * external links (checked with a HEAD request, but never followed further, or
 * a broken-link checker turns into an accidental crawl of the entire internet).
 * A link is checked once no matter how many pages reference it — the same
 * broken CDN URL linked from 40 pages should be one finding with 40 sources
 * listed, not 40 duplicate findings.
 */

interface CrawlOptions {
  startUrl: string;
  maxPages: number;
  timeout: number;
}

interface PageResult {
  url: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  links: string[];
}

interface LinkCheck {
  url: string;
  status: number | null;
  ok: boolean;
  error: string | null;
  isExternal: boolean;
  referencedFrom: string[];
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const hrefRe = /<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefRe.exec(html))) {
    const raw = match[2].trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("tel:") || raw.startsWith("javascript:")) continue;
    try {
      const resolved = new URL(raw, baseUrl);
      resolved.hash = "";
      links.push(resolved.toString());
    } catch {
      // malformed href — skip rather than crash the crawl
    }
  }
  return [...new Set(links)];
}

function isSameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

async function fetchPage(url: string, timeout: number): Promise<PageResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: "follow" });
    const contentType = response.headers.get("content-type") ?? "";
    const html = contentType.includes("text/html") ? await response.text() : "";
    return { url, status: response.status, ok: response.ok, error: null, links: html ? extractLinks(html, url) : [] };
  } catch (err) {
    return { url, status: null, ok: false, error: (err as Error).message, links: [] };
  } finally {
    clearTimeout(timer);
  }
}

async function checkLink(url: string, timeout: number): Promise<{ status: number | null; ok: boolean; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    // HEAD first (cheaper); some servers don't support it and 405, so fall back to GET
    let response = await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "follow" });
    if (response.status === 405) {
      response = await fetch(url, { method: "GET", signal: controller.signal, redirect: "follow" });
    }
    return { status: response.status, ok: response.ok, error: null };
  } catch (err) {
    return { status: null, ok: false, error: (err as Error).message };
  } finally {
    clearTimeout(timer);
  }
}

interface CrawlReport {
  pagesVisited: number;
  brokenInternal: LinkCheck[];
  brokenExternal: LinkCheck[];
  totalLinksChecked: number;
}

async function crawl(options: CrawlOptions, onProgress?: (msg: string) => void): Promise<CrawlReport> {
  const origin = options.startUrl;
  const visited = new Set<string>();
  const queue: string[] = [options.startUrl];
  const linkSources = new Map<string, Set<string>>(); // link URL -> pages that reference it

  while (queue.length > 0 && visited.size < options.maxPages) {
    const url = queue.shift()!;
    if (visited.has(url)) continue;
    visited.add(url);

    const page = await fetchPage(url, options.timeout);
    onProgress?.(`fetched ${url} (${page.status ?? "error"})`);

    for (const link of page.links) {
      const sources = linkSources.get(link) ?? new Set();
      sources.add(url);
      linkSources.set(link, sources);

      if (isSameOrigin(link, origin) && !visited.has(link) && !queue.includes(link)) {
        queue.push(link);
      }
    }
  }

  const uniqueLinks = [...linkSources.keys()];
  onProgress?.(`checking ${uniqueLinks.length} unique links found across ${visited.size} pages...`);

  const checks = await Promise.all(
    uniqueLinks.map(async (link) => {
      const result = await checkLink(link, options.timeout);
      return {
        url: link,
        status: result.status,
        ok: result.ok,
        error: result.error,
        isExternal: !isSameOrigin(link, origin),
        referencedFrom: [...(linkSources.get(link) ?? [])],
      } satisfies LinkCheck;
    }),
  );

  const broken = checks.filter((c) => !c.ok);
  return {
    pagesVisited: visited.size,
    brokenInternal: broken.filter((c) => !c.isExternal),
    brokenExternal: broken.filter((c) => c.isExternal),
    totalLinksChecked: checks.length,
  };
}

function formatReport(report: CrawlReport): string {
  const lines: string[] = [
    `${report.pagesVisited} pages crawled, ${report.totalLinksChecked} unique links checked`,
    `${report.brokenInternal.length + report.brokenExternal.length} broken\n`,
  ];
  if (report.brokenInternal.length) {
    lines.push(`broken internal links (${report.brokenInternal.length}) — these are pages on your own site:`);
    for (const link of report.brokenInternal) {
      lines.push(`  ${link.status ?? "ERROR"}  ${link.url}`);
      lines.push(`    referenced from: ${link.referencedFrom.join(", ")}`);
    }
    lines.push("");
  }
  if (report.brokenExternal.length) {
    lines.push(`broken external links (${report.brokenExternal.length}):`);
    for (const link of report.brokenExternal) {
      lines.push(`  ${link.status ?? "ERROR"}  ${link.url}  (${link.error ?? ""})`);
      lines.push(`    referenced from ${link.referencedFrom.length} page(s): ${link.referencedFrom.slice(0, 3).join(", ")}${link.referencedFrom.length > 3 ? "..." : ""}`);
    }
  }
  if (report.brokenInternal.length === 0 && report.brokenExternal.length === 0) {
    lines.push("no broken links found.");
  }
  return lines.join("\n");
}

// ------------------------------------------------------------ demo

function demo(): void {
  console.log("1. link extraction and same-origin classification (offline, deterministic)\n");

  const samplePage = `
<html><body>
<a href="/about">About</a>
<a href="/products/widget">Widget</a>
<a href="https://cdn.example.com/logo.png">Logo (external CDN)</a>
<a href="https://broken-partner-site.invalid/page">Partner page (external, broken)</a>
<a href="#section">On-page anchor (skipped)</a>
<a href="mailto:hello@example.com">Email (skipped)</a>
<a href="/about#team">About with anchor (normalized, dedupes with /about)</a>
</body></html>`;

  const links = extractLinks(samplePage, "https://example.com/home");
  console.log(`  extracted ${links.length} unique, normalized links:`);
  for (const link of links) {
    const internal = isSameOrigin(link, "https://example.com");
    console.log(`    ${internal ? "internal" : "external"}  ${link}`);
  }
  console.log(`\n  note: the anchor-only link (#section) and mailto: were correctly excluded,`);
  console.log(`  and /about + /about#team collapsed to ONE link (https://example.com/about) since`);
  console.log(`  the hash fragment doesn't change what gets fetched.`);

  console.log(`\n\n2. a real crawl against httpbin.org's link-generator endpoint\n`);
}

async function demoRealCrawl(): Promise<void> {
  try {
    const report = await crawl(
      { startUrl: "https://httpbin.org/links/6/0", maxPages: 3, timeout: 8000 },
      (msg) => console.log(`  ${msg}`),
    );
    console.log(`\n${formatReport(report)}`);
    console.log(`\n\nnote: httpbin's /links/N/ endpoint generates a page of N sequential links to`);
    console.log(`itself (/links/6/0, /links/6/1, ...) — a genuine small link graph the crawler`);
    console.log(`follows and checks for real, not simulated data.`);
  } catch (err) {
    console.log(`  network unavailable in this environment: ${(err as Error).message}`);
  }
}

// ------------------------------------------------------------ CLI

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    demo();
    await demoRealCrawl();
    return;
  }

  const url = args[0];
  const maxPagesIdx = args.indexOf("--max-pages");
  const maxPages = maxPagesIdx >= 0 ? Number(args[maxPagesIdx + 1]) : 20;

  console.log(`crawling ${url} (max ${maxPages} pages)...\n`);
  const report = await crawl({ startUrl: url, maxPages, timeout: 10000 }, (msg) => console.log(`  ${msg}`));
  console.log(`\n${formatReport(report)}`);
  process.exitCode = report.brokenInternal.length > 0 ? 1 : 0;
}

main();
