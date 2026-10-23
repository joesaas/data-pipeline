import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { exportSite } from "../src/export.js";
import { esc } from "../src/render.js";

function seedDb(file: string): void {
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
    .run("rec-1", "h1", "2026-10-22T12:00:00.000Z", "openai-compatible", "openai/gpt-4o-mini", "clean-v2", 1, "muse");
  db.prepare("INSERT INTO cleaned_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("item-1", "rec-1", 0, "标题 <script>alert(1)</script>", "摘要 & 说明", null, "Web3 DeFi",
      JSON.stringify(["Solana"]), "2026-10-21", JSON.stringify([{ name: "Solana", url: "https://solana.com" }]));
  db.close();
}

describe("esc", () => {
  it("escapes HTML-significant characters", () => {
    assert.equal(esc(`<a href="x">&'</a>`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;");
  });
});

describe("exportSite", () => {
  const dir = mkdtempSync(join(tmpdir(), "exporter-"));
  const dbFile = join(dir, "cleaned.sqlite");
  const outDir = join(dir, "web-dist");
  seedDb(dbFile);
  after(() => rmSync(dir, { recursive: true, force: true }));

  it("renders index, detail pages, items.json and styles into a release", () => {
    const result = exportSite({ dbFile, outDir, now: new Date("2026-10-22T15:00:00Z") });
    assert.equal(result.items, 1);
    const index = readFileSync(join(result.releaseDir, "index.html"), "utf8");
    assert.ok(index.includes("全部资讯"));
    assert.ok(index.includes("标题 &lt;script&gt;"), "titles must be HTML-escaped");
    assert.ok(!index.includes("<script>alert(1)</script>"), "no raw injection");
    assert.ok(index.includes('href="item/item-1/"'));
    assert.ok(index.includes("权重"), "weight badge rendered");
    assert.ok(index.includes("data-gran-group"), "date granularity switch rendered");
    assert.ok(index.includes("muse"), "source_agent rendered");
    assert.ok(!index.includes("重要性"), "importance is gone");
    const detail = readFileSync(join(result.releaseDir, "item/item-1/index.html"), "utf8");
    assert.ok(detail.includes("openai/gpt-4o-mini"));
    assert.ok(detail.includes("/data-pipeline/api/v1/records/rec-1"));
    const json = JSON.parse(readFileSync(join(result.releaseDir, "items.json"), "utf8")) as { items: unknown[] };
    assert.equal(json.items.length, 1);
    assert.ok(existsSync(join(result.releaseDir, "styles.css")));
    assert.ok(readlinkSync(join(outDir, "current")).includes("releases"));
  });

  it("flips current on re-export and prunes old releases", () => {
    const first = readlinkSync(join(outDir, "current"));
    exportSite({ dbFile, outDir, now: new Date("2026-10-22T16:00:00Z") });
    const second = readlinkSync(join(outDir, "current"));
    assert.notEqual(first, second);
    exportSite({ dbFile, outDir, now: new Date("2026-10-22T17:00:00Z") });
    exportSite({ dbFile, outDir, now: new Date("2026-10-22T18:00:00Z") });
    assert.ok(readdirSync(join(outDir, "releases")).length <= 3);
  });

  it("exports an empty site when the database does not exist yet", () => {
    const result = exportSite({ dbFile: join(dir, "missing.sqlite"), outDir: join(dir, "empty-dist") });
    assert.equal(result.items, 0);
    assert.ok(readFileSync(join(result.releaseDir, "index.html"), "utf8").includes("这里还没有资讯"));
  });
});

describe("exportSite: category merge + zh display", () => {
  it("folds DeFi Protocol into Web3 DeFi and prefers zh titles", () => {
    const dir = mkdtempSync(join(tmpdir(), "exporter-zh-"));
    const dbFile = join(dir, "cleaned.sqlite");
    const db = new DatabaseSync(dbFile);
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
      .run("rec-1", "h1", "2026-10-23T01:00:00.000Z", "openai-compatible", "openai/gpt-4o-mini", "clean-v4", 2, "muse");
    const insert = db.prepare("INSERT INTO cleaned_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insert.run("x1", "rec-1", 0, "Aave proposes V3.8 upgrade", "Lending pool guard", null, "DeFi Protocol",
      "[]", "2026-10-21", "[]", JSON.stringify({ title: "Aave 提出 V3.8 升级", summary: "借贷池增加重入防护" }));
    insert.run("x2", "rec-1", 1, "Solana Alpenglow goes live", "New consensus", null, "Web3 DeFi",
      "[]", "2026-10-22", "[]", null);
    db.close();
    const result = exportSite({ dbFile, outDir: join(dir, "web-dist"), now: new Date("2026-10-23T02:00:00Z") });
    const data = JSON.parse(readFileSync(join(result.releaseDir, "items.json"), "utf8")) as {
      items: { category: string; title_zh: string | null }[];
      categories: { name: string; count: number }[];
    };
    assert.deepEqual(data.categories, [{ name: "Web3 DeFi", count: 2 }]);
    const index = readFileSync(join(result.releaseDir, "index.html"), "utf8");
    assert.ok(index.includes("Aave 提出 V3.8 升级"), "zh title is the primary title");
    assert.ok(index.includes("Aave proposes V3.8 upgrade"), "original title kept as secondary line");
    assert.ok(!index.includes("DeFi Protocol"), "merged category name is gone");
    rmSync(dir, { recursive: true, force: true });
  });
});
