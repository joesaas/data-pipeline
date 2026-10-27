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
      provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, item_count INTEGER NOT NULL,
      source_agent TEXT NOT NULL DEFAULT '');
    CREATE TABLE cleaned_items (
      id TEXT PRIMARY KEY, source_record_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL,
      summary TEXT NOT NULL, detail TEXT, category TEXT NOT NULL, tags TEXT NOT NULL,
      event_date TEXT, sources TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO cleaned_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("rec-1", "hash-1", "2026-10-22T12:00:00.000Z", "openai-compatible", "openai/gpt-4o-mini", "clean-v2", 2, "muse");
  const insert = db.prepare("INSERT INTO cleaned_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("item-1", "rec-1", 0, "Solana 升级 Alpenglow", "主网切换新共识", null, "Web3 DeFi",
    JSON.stringify(["Solana"]), "2026-10-21", JSON.stringify([{ name: "Solana", url: "https://solana.com" }]));
  insert.run("item-2", "rec-1", 1, "某框架发布 2.0", "发布新版本", "细节若干", "AI Agent",
    JSON.stringify([]), null, JSON.stringify([]));
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
      newsSiteUrl: "https://agent101.uk/news",
      newsDetailDir: join(dir, "news-detail"),
      newsDetailDbFile: join(dir, "news-detail.sqlite"),
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
    const body = (await res.json()) as {
      items: {
        title: string; tags: string[]; sources: { url: string }[];
        source_agent: string; event_year: number | null; event_month: number | null; event_day: number | null;
        weight: number; weight_tier: number;
      }[];
      total: number;
    };
    assert.equal(body.total, 2);
    const first = body.items.find((i) => i.title.includes("Solana"))!;
    assert.equal(first.source_agent, "muse");
    assert.deepEqual([first.event_year, first.event_month, first.event_day], [2026, 10, 21]);
    assert.ok(first.weight >= 0 && first.weight <= 100);
    assert.ok([1, 2, 3].includes(first.weight_tier));
    assert.ok(!("importance" in first));
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
      newsSiteUrl: "https://agent101.uk/news",
      newsDetailDir: join(dir, "news-detail"),
      newsDetailDbFile: join(dir, "news-detail.sqlite"),
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

describe("cleaned endpoints: category merge + translation", () => {
  let dir: string;
  let server: Server;
  let base: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "cleaned-merge-"));
    const cleanedDbFile = join(dir, "cleaned.sqlite");
    const db = new DatabaseSync(cleanedDbFile);
    db.exec(`
      CREATE TABLE cleaned_records (
        source_record_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, cleaned_at TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, item_count INTEGER NOT NULL,
        source_agent TEXT NOT NULL DEFAULT '');
      CREATE TABLE cleaned_items (
        id TEXT PRIMARY KEY, source_record_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL,
        summary TEXT NOT NULL, detail TEXT, category TEXT NOT NULL, tags TEXT NOT NULL,
        event_date TEXT, sources TEXT NOT NULL, translation_zh TEXT);
    `);
    db.prepare("INSERT INTO cleaned_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run("rec-9", "hash-9", "2026-10-23T01:00:00.000Z", "openai-compatible", "openai/gpt-4o-mini", "clean-v4", 2, "muse");
    const insert = db.prepare("INSERT INTO cleaned_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("it-a", "rec-9", 0, "Aave proposes V3.8 upgrade", "Lending pool gets reentrancy guard", null,
      "DeFi Protocol", "[]", "2026-10-21", "[]",
      JSON.stringify({ title: "Aave 提出 V3.8 升级", summary: "借贷池增加重入防护" }));
    insert.run("it-b", "rec-9", 1, "Solana Alpenglow goes live", "New consensus on mainnet", null,
      "Web3 DeFi", "[]", "2026-10-22", "[]", null);
    db.close();
    const config: AppConfig = {
      port: 0, basePath: "/data-pipeline", dataDir: dir, storage: "sqlite", authRequired: false,
      maxContentBytes: 1_048_576, maxPromptBytes: 65_536, rateLimitPerMin: 60, cleanedDbFile,
      newsSiteUrl: "https://agent101.uk/news",
      newsDetailDir: join(dir, "news-detail"),
      newsDetailDbFile: join(dir, "news-detail.sqlite"),
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

  it("?category=Web3 DeFi also matches stored DeFi Protocol rows, reported merged", async () => {
    const body = (await (await fetch(`${base}/api/v1/cleaned/items?category=Web3%20DeFi`)).json()) as {
      total: number;
      items: { id: string; category: string; title_zh: string | null }[];
    };
    assert.equal(body.total, 2);
    assert.ok(body.items.every((i) => i.category === "Web3 DeFi"));
    const a = body.items.find((i) => i.id === "it-a")!;
    assert.equal(a.title_zh, "Aave 提出 V3.8 升级");
    const b = body.items.find((i) => i.id === "it-b")!;
    assert.equal(b.title_zh, null);
  });

  it("stats merge the two spellings into one category", async () => {
    const stats = (await (await fetch(`${base}/api/v1/cleaned/stats`)).json()) as {
      categories: { name: string; count: number }[];
    };
    assert.deepEqual(stats.categories, [{ name: "Web3 DeFi", count: 2 }]);
  });
});
