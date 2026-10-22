import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

/** Build a cleaner-output SQLite with the same schema workers/cleaner writes. */
function seedCleanedDb(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE cleaned_records (
      source_record_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, cleaned_at TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, item_count INTEGER NOT NULL);
    CREATE TABLE cleaned_items (
      id TEXT PRIMARY KEY, source_record_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL,
      summary TEXT NOT NULL, detail TEXT, category TEXT NOT NULL, tags TEXT NOT NULL,
      event_date TEXT, sources TEXT NOT NULL, importance TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO cleaned_records VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("rec-1", "hash-1", "2026-10-22T12:00:00.000Z", "openai-compatible", "openai/gpt-4o-mini", "clean-v1", 2);
  const insert = db.prepare("INSERT INTO cleaned_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("item-1", "rec-1", 0, "Solana 升级 Alpenglow", "主网切换新共识", null, "Web3 DeFi",
    JSON.stringify(["Solana"]), "2026-10-21", JSON.stringify([{ name: "Solana", url: "https://solana.com" }]), "high");
  insert.run("item-2", "rec-1", 1, "某框架发布 2.0", "发布新版本", "细节若干", "AI Agent",
    JSON.stringify([]), null, JSON.stringify([]), "medium");
  db.close();
}

describe("cleaned endpoints", () => {
  let dir: string;
  let server: Server;
  let base: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cleaned-api-"));
    const cleanedDbFile = join(dir, "cleaned.sqlite");
    seedCleanedDb(cleanedDbFile);
    const config: AppConfig = {
      port: 0,
      basePath: "/data-pipeline",
      dataDir: dir,
      storage: "sqlite",
      authRequired: false,
      maxContentBytes: 1_048_576,
      maxPromptBytes: 65_536,
      rateLimitPerMin: 60,
      cleanedDbFile,
    };
    const { app } = createApp(config);
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/data-pipeline`;
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists cleaned items with parsed tags and sources", async () => {
    const res = await fetch(`${base}/api/v1/cleaned/items`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { items: { title: string; tags: string[]; sources: { url: string }[] }[]; total: number };
    assert.equal(body.total, 2);
    const first = body.items.find((i) => i.title.includes("Solana"))!;
    assert.deepEqual(first.tags, ["Solana"]);
    assert.equal(first.sources[0].url, "https://solana.com");
  });

  it("filters by category and q", async () => {
    const byCat = (await (await fetch(`${base}/api/v1/cleaned/items?category=AI%20Agent`)).json()) as { total: number };
    assert.equal(byCat.total, 1);
    const byQ = (await (await fetch(`${base}/api/v1/cleaned/items?q=Alpenglow`)).json()) as { total: number };
    assert.equal(byQ.total, 1);
  });

  it("gets one item and 404s on unknown ids", async () => {
    const ok = await fetch(`${base}/api/v1/cleaned/items/item-2`);
    assert.equal(ok.status, 200);
    const missing = await fetch(`${base}/api/v1/cleaned/items/nope`);
    assert.equal(missing.status, 404);
  });

  it("reports stats", async () => {
    const stats = (await (await fetch(`${base}/api/v1/cleaned/stats`)).json()) as {
      records: number;
      items: number;
      categories: { name: string; count: number }[];
      providers: { provider: string; records: number }[];
    };
    assert.equal(stats.records, 1);
    assert.equal(stats.items, 2);
    assert.equal(stats.categories.length, 2);
    assert.equal(stats.providers[0].provider, "openai-compatible");
  });
});

describe("cleaned endpoints without a cleaned database yet", () => {
  it("degrade to empty results, not errors", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cleaned-none-"));
    const config: AppConfig = {
      port: 0,
      basePath: "/data-pipeline",
      dataDir: dir,
      storage: "sqlite",
      authRequired: false,
      maxContentBytes: 1_048_576,
      maxPromptBytes: 65_536,
      rateLimitPerMin: 60,
      cleanedDbFile: join(dir, "missing.sqlite"),
    };
    const { app, driver } = createApp(config);
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/data-pipeline`;
    const res = await fetch(`${base}/api/v1/cleaned/items`);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { total: number }).total, 0);
    server.close();
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
