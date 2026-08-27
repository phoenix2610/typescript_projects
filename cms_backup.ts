#!/usr/bin/env -S node
/**
 * Export content and assets from a headless CMS on a schedule, with a restorable manifest.
 *
 *   node cms_backup.ts export --api https://cms.example.com/api --token $TOKEN --out ./backups
 *   node cms_backup.ts --demo
 *
 * A "backup" that's just a directory of JSON files isn't restorable unless
 * someone remembers the exact shape the CMS API expects them fed back in. This
 * writes one file per content type plus a manifest recording the export
 * timestamp, item counts, and a content hash per type — so a later restore (or
 * just a human checking "did last night's backup actually capture the new
 * blog post") can verify the backup is complete without re-hitting the API.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

interface ContentItem {
  id: string;
  type: string;
  fields: Record<string, unknown>;
  updatedAt: string;
}

interface Asset {
  id: string;
  filename: string;
  url: string;
  sizeBytes: number;
}

interface ContentTypeExport {
  type: string;
  itemCount: number;
  contentHash: string;
  exportedTo: string;
}

interface BackupManifest {
  exportedAt: string;
  cmsApi: string;
  contentTypes: ContentTypeExport[];
  assetCount: number;
  assetManifestPath: string;
  totalItems: number;
}

function hashContent(items: ContentItem[]): string {
  const hash = crypto.createHash("sha256");
  // sort by id first so the hash is stable regardless of API pagination/ordering
  for (const item of [...items].sort((a, b) => a.id.localeCompare(b.id))) {
    hash.update(item.id);
    hash.update(JSON.stringify(item.fields));
  }
  return hash.digest("hex").slice(0, 16);
}

interface CmsClient {
  listContentTypes(): Promise<string[]>;
  listItems(type: string): Promise<ContentItem[]>;
  listAssets(): Promise<Asset[]>;
}

class RealCmsClient implements CmsClient {
  private apiBase: string;
  private token: string;

  constructor(apiBase: string, token: string) {
    this.apiBase = apiBase;
    this.token = token;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await fetch(`${this.apiBase}${path}`, { headers: { Authorization: `Bearer ${this.token}` } });
    if (!response.ok) throw new Error(`CMS API error at ${path}: ${response.status}`);
    return (await response.json()) as T;
  }

  async listContentTypes(): Promise<string[]> {
    return this.fetchJson<string[]>("/content-types");
  }
  async listItems(type: string): Promise<ContentItem[]> {
    return this.fetchJson<ContentItem[]>(`/content-types/${type}/items`);
  }
  async listAssets(): Promise<Asset[]> {
    return this.fetchJson<Asset[]>("/assets");
  }
}

async function performBackup(client: CmsClient, outDir: string, apiLabel: string, now: Date): Promise<BackupManifest> {
  fs.mkdirSync(outDir, { recursive: true });

  const contentTypes = await client.listContentTypes();
  const typeExports: ContentTypeExport[] = [];
  let totalItems = 0;

  for (const type of contentTypes) {
    const items = await client.listItems(type);
    const fileName = `${type}.json`;
    const filePath = path.join(outDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(items, null, 2));
    typeExports.push({ type, itemCount: items.length, contentHash: hashContent(items), exportedTo: fileName });
    totalItems += items.length;
  }

  const assets = await client.listAssets();
  const assetManifestPath = "assets.json";
  fs.writeFileSync(path.join(outDir, assetManifestPath), JSON.stringify(assets, null, 2));

  const manifest: BackupManifest = {
    exportedAt: now.toISOString(),
    cmsApi: apiLabel,
    contentTypes: typeExports,
    assetCount: assets.length,
    assetManifestPath,
    totalItems,
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

interface VerifyResult {
  valid: boolean;
  problems: string[];
}

/** Verify a backup directory against its own manifest: every file the manifest
 *  claims to exist actually does, has the right item count, and the content
 *  hash still matches — catches a backup that was silently truncated or
 *  corrupted after the fact, not just "did the export script run." */
function verifyBackup(outDir: string): VerifyResult {
  const problems: string[] = [];
  const manifestPath = path.join(outDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return { valid: false, problems: ["manifest.json is missing"] };

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BackupManifest;
  for (const typeExport of manifest.contentTypes) {
    const filePath = path.join(outDir, typeExport.exportedTo);
    if (!fs.existsSync(filePath)) {
      problems.push(`${typeExport.exportedTo} referenced in manifest but missing on disk`);
      continue;
    }
    const items = JSON.parse(fs.readFileSync(filePath, "utf8")) as ContentItem[];
    if (items.length !== typeExport.itemCount) {
      problems.push(`${typeExport.type}: manifest says ${typeExport.itemCount} items, file has ${items.length}`);
    }
    const actualHash = hashContent(items);
    if (actualHash !== typeExport.contentHash) {
      problems.push(`${typeExport.type}: content hash mismatch (file was modified after export)`);
    }
  }
  if (!fs.existsSync(path.join(outDir, manifest.assetManifestPath))) {
    problems.push(`${manifest.assetManifestPath} referenced in manifest but missing on disk`);
  }

  return { valid: problems.length === 0, problems };
}

// ------------------------------------------------------------ demo

class FakeCmsClient implements CmsClient {
  private data: Record<string, ContentItem[]>;
  private assets: Asset[];

  constructor(data: Record<string, ContentItem[]>, assets: Asset[]) {
    this.data = data;
    this.assets = assets;
  }
  async listContentTypes(): Promise<string[]> {
    return Object.keys(this.data);
  }
  async listItems(type: string): Promise<ContentItem[]> {
    return this.data[type] ?? [];
  }
  async listAssets(): Promise<Asset[]> {
    return this.assets;
  }
}

async function demo(): Promise<void> {
  const now = new Date("2026-08-27T02:00:00Z");
  const outDir = "/tmp/cms-backup-demo";
  fs.rmSync(outDir, { recursive: true, force: true });

  const fakeData: Record<string, ContentItem[]> = {
    blogPost: [
      { id: "post-1", type: "blogPost", fields: { title: "Launch week recap", body: "..." }, updatedAt: "2026-08-20T10:00:00Z" },
      { id: "post-2", type: "blogPost", fields: { title: "How we scaled to 1M users", body: "..." }, updatedAt: "2026-08-25T14:00:00Z" },
    ],
    author: [{ id: "auth-1", type: "author", fields: { name: "Ana Rivera", bio: "..." }, updatedAt: "2026-01-10T00:00:00Z" }],
    landingPage: [],
  };
  const fakeAssets: Asset[] = [
    { id: "asset-1", filename: "hero.jpg", url: "https://cms.example.com/assets/hero.jpg", sizeBytes: 240_000 },
    { id: "asset-2", filename: "og-image.png", url: "https://cms.example.com/assets/og-image.png", sizeBytes: 85_000 },
  ];

  console.log("1. running a backup against a fake CMS with 3 content types + 2 assets\n");
  const client = new FakeCmsClient(fakeData, fakeAssets);
  const manifest = await performBackup(client, outDir, "https://cms.example.com/api (demo)", now);

  console.log(`exported to ${outDir}:\n`);
  for (const t of manifest.contentTypes) {
    console.log(`  ${t.exportedTo.padEnd(18)} ${t.itemCount} items  hash=${t.contentHash}`);
  }
  console.log(`  ${manifest.assetManifestPath.padEnd(18)} ${manifest.assetCount} assets`);
  console.log(`\n  manifest.json records ${manifest.totalItems} total items across ${manifest.contentTypes.length} content types`);

  console.log("\n\n2. verifying the backup right after export — should be clean\n");
  const verify1 = verifyBackup(outDir);
  console.log(`  valid: ${verify1.valid}`);

  console.log("\n\n3. simulating corruption: someone truncates blogPost.json after the fact\n");
  const blogPostPath = path.join(outDir, "blogPost.json");
  const originalItems = JSON.parse(fs.readFileSync(blogPostPath, "utf8")) as ContentItem[];
  fs.writeFileSync(blogPostPath, JSON.stringify(originalItems.slice(0, 1))); // drop one item

  const verify2 = verifyBackup(outDir);
  console.log(`  valid: ${verify2.valid}`);
  for (const p of verify2.problems) console.log(`    problem: ${p}`);

  console.log("\n\n4. simulating a missing file: someone deletes author.json\n");
  fs.rmSync(path.join(outDir, "author.json"));
  const verify3 = verifyBackup(outDir);
  console.log(`  valid: ${verify3.valid}`);
  for (const p of verify3.problems) console.log(`    problem: ${p}`);

  console.log(`\n\nnote: verification doesn't just check "does the file exist" — it re-reads each`);
  console.log(`file's actual item count and content hash against what the manifest recorded at`);
  console.log(`export time, which is what catches a backup that was silently truncated or edited`);
  console.log(`after the fact, not just one that never ran. landingPage.json exported with 0`);
  console.log(`items (an empty content type) and that's correctly NOT flagged as a problem —`);
  console.log(`an empty export is valid if the CMS genuinely has no landing pages yet.`);

  fs.rmSync(outDir, { recursive: true, force: true });
}

// ------------------------------------------------------------ CLI

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--demo") || args.length === 0) {
    await demo();
    return;
  }

  if (args[0] === "verify") {
    const dir = args[1];
    if (!dir) {
      console.error("usage: cms_backup.ts verify <backup-dir>");
      process.exitCode = 1;
      return;
    }
    const result = verifyBackup(dir);
    console.log(`valid: ${result.valid}`);
    for (const p of result.problems) console.log(`  problem: ${p}`);
    process.exitCode = result.valid ? 0 : 1;
    return;
  }

  if (args[0] !== "export") {
    console.log("usage: cms_backup.ts export --api URL --token TOKEN --out DIR | verify <backup-dir>");
    return;
  }
  const get = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  const api = get("--api");
  const token = get("--token");
  const out = get("--out") ?? "./cms-backup";
  if (!api || !token) {
    console.error("--api and --token are required");
    process.exitCode = 1;
    return;
  }

  try {
    const client = new RealCmsClient(api, token);
    const manifest = await performBackup(client, out, api, new Date());
    console.log(`exported ${manifest.totalItems} items across ${manifest.contentTypes.length} content types to ${out}`);
  } catch (err) {
    console.error(`export failed: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

main();
