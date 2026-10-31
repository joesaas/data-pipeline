import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, describe, it } from "node:test";
import { exportSite } from "../src/export.js";
import type { PgPoolLike } from "../src/pg-pool.js";
import { resolveExporterStorageDriver } from "../src/storage.js";

/**
 * Stub pool answering the exporter's three PG queries: the item JOIN,
 * COUNT(*) and MAX(cleaned_at). Rows carry PG-native shapes: JSONB
 * tags/sources as arrays, TIMESTAMPTZ cleaned_at as Dates.
 */
class StubPool implements PgPoolLike {
  constructor(
    private readonly itemRows: Record<string, unknown>[],
    private readonly records: number,
    private readonly last: Date | null,
  ) {}
  async query(text: string): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    if (text.includes("COUNT(*)")) return { rows: [{ n: this.records }], rowCount: 1 };
    if (text.includes("MAX(cleaned_at)")) return { rows: [{ m: this.last }], rowCount: 1 };
    return { rows: this.itemRows, rowCount: this.itemRows.length };
  }
  async connect(): Promise<never> {
    throw new Error("connect() is unused by the export read");
  }
  async end(): Promise<void> {}
}

function seedSqlite(file: string): void {
  const db = new DatabaseSync(file);
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
  const rec = db.prepare("INSERT INTO cleaned_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  rec.run("rec-1", "h1", "2026-10-23T01:00:00.000Z", "openai-compatible", "openai/gpt-4o-mini", "clean-v4", 2, "muse");
  rec.run("rec-2", "h2", "2026-10-22T12:00:00.000Z", "openai-compatible", "openai/gpt-4o-mini", "clean-v4", 1, "");
  const item = db.prepare("INSERT INTO cleaned_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  item.run("x1", "rec-1", 0, "Aave proposes V3.8 upgrade", "Lending pool guard", null, "DeFi Protocol",
    JSON.stringify(["DeFi"]), "2026-10-21", JSON.stringify([{ name: "Aave", url: "https://aave.com" }]),
    JSON.stringify({ title: "Aave 提出 V3.8 升级", summary: "借贷池增加重入防护" }));
  item.run("x2", "rec-1", 1, "Solana Alpenglow goes live", "New consensus", null, "Web3 DeFi",
    "[]", "2026-10-22", "[]", null);
  item.run("x3", "rec-2", 0, "U title", "U summary", null, "未分类",
    JSON.stringify(["X"]), "2026-10-21", "[]", "");
  db.close();
}

/** The same rows as seedSqlite, in PG-native shapes and PG order
 * (cleaned_at DESC, idx ASC): rec-1's items first, then rec-2's. */
function pgRows(): Record<string, unknown>[] {
  const base = {
    provider: "openai-compatible",
    model: "openai/gpt-4o-mini",
  };
  return [
    { id: "x1", source_record_id: "rec-1", idx: 0, title: "Aave proposes V3.8 upgrade", summary: "Lending pool guard",
      detail: null, category: "DeFi Protocol", tags: ["DeFi"], event_date: "2026-10-21",
      sources: [{ name: "Aave", url: "https://aave.com" }],
      translation_zh: JSON.stringify({ title: "Aave 提出 V3.8 升级", summary: "借贷池增加重入防护" }),
      source_agent: "muse", cleaned_at: new Date("2026-10-23T01:00:00.000Z"), ...base },
    { id: "x2", source_record_id: "rec-1", idx: 1, title: "Solana Alpenglow goes live", summary: "New consensus",
      detail: null, category: "Web3 DeFi", tags: [], event_date: "2026-10-22", sources: [],
      translation_zh: null, source_agent: "muse", cleaned_at: new Date("2026-10-23T01:00:00.000Z"), ...base },
    { id: "x3", source_record_id: "rec-2", idx: 0, title: "U title", summary: "U summary",
      detail: null, category: "未分类", tags: ["X"], event_date: "2026-10-21", sources: [],
      translation_zh: "", source_agent: "", cleaned_at: new Date("2026-10-22T12:00:00.000Z"), ...base },
  ];
}

describe("exportSite: PG parity with SQLite", () => {
  it("renders byte-identical output for the same rows from PG and SQLite", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exporter-pg-parity-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const dbFile = join(dir, "cleaned.sqlite");
    seedSqlite(dbFile);
    const now = new Date("2026-10-23T02:00:00Z");
    const sqlite = await exportSite({ dbFile, outDir: join(dir, "dist-sqlite"), now });
    const pg = await exportSite({
      pgPool: new StubPool(pgRows(), 2, new Date("2026-10-23T01:00:00.000Z")),
      outDir: join(dir, "dist-pg"),
      now,
    });
    assert.equal(pg.items, 3);
    assert.equal(sqlite.items, 3);
    // Same rows, same `now` -> every output file must match exactly,
    // including key order in items.json and the merged categories.
    for (const rel of ["index.html", "items.json", "sitemap.xml", "styles.css",
      "item/x1/index.html", "item/x2/index.html", "item/x3/index.html"]) {
      assert.equal(
        readFileSync(join(pg.releaseDir, rel), "utf8"),
        readFileSync(join(sqlite.releaseDir, rel), "utf8"),
        `${rel} must be identical across backends`,
      );
    }
    const json = JSON.parse(readFileSync(join(pg.releaseDir, "items.json"), "utf8")) as {
      items: { category: string; title_zh: string | null }[];
      categories: { name: string; count: number }[];
      records: number;
      lastCleanedAt: string | null;
    };
    assert.deepEqual(json.categories, [{ name: "Web3 DeFi", count: 2 }, { name: "Other", count: 1 }]);
    assert.equal(json.records, 2);
    assert.equal(json.lastCleanedAt, "2026-10-23T01:00:00.000Z");
    assert.equal(json.items[0].title_zh, "Aave 提出 V3.8 升级");
    assert.equal(json.items[1].title_zh, null);
    assert.equal(json.items[2].title_zh, null, "'' translation_zh renders like NULL (no zh title)");
  });

  it("exports an empty site from PG when the tables hold no rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exporter-pg-empty-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const result = await exportSite({
      pgPool: new StubPool([], 0, null),
      outDir: join(dir, "web-dist"),
      now: new Date("2026-10-23T02:00:00Z"),
    });
    assert.equal(result.items, 0);
    assert.ok(readFileSync(join(result.releaseDir, "index.html"), "utf8").includes("这里还没有资讯"));
  });

  it("fails without writing anything when the PG read fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exporter-pg-fail-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const failing: PgPoolLike = {
      query: async () => {
        throw new Error("connection refused");
      },
      connect: async () => {
        throw new Error("unused");
      },
      end: async () => {},
    };
    const outDir = join(dir, "web-dist");
    await assert.rejects(exportSite({ pgPool: failing, outDir }), /connection refused/);
    assert.ok(!existsSync(join(outDir, "current")), "current must not be created on a failed export");
    assert.ok(!existsSync(join(outDir, "releases")), "no release directory may be created before a successful read");
  });

  it("rejects a call that passes both or neither source", async () => {
    const dir = mkdtempSync(join(tmpdir(), "exporter-pg-args-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const pool = new StubPool([], 0, null);
    await assert.rejects(
      exportSite({ dbFile: join(dir, "x.sqlite"), pgPool: pool, outDir: join(dir, "web-dist") }),
      /exactly one of dbFile or pgPool/,
    );
    await assert.rejects(
      exportSite({ outDir: join(dir, "web-dist") }),
      /pass dbFile \(SQLite\) or pgPool \(PG\)/,
    );
  });
});

describe("resolveExporterStorageDriver", () => {
  it("defaults to sqlite, accepts pg, and fails fast on unknown values", () => {
    assert.equal(resolveExporterStorageDriver({}), "sqlite");
    assert.equal(resolveExporterStorageDriver({ EXPORTER_STORAGE_DRIVER: "" }), "sqlite");
    assert.equal(resolveExporterStorageDriver({ EXPORTER_STORAGE_DRIVER: "sqlite" }), "sqlite");
    assert.equal(resolveExporterStorageDriver({ EXPORTER_STORAGE_DRIVER: " pg " }), "pg");
    assert.throws(() => resolveExporterStorageDriver({ EXPORTER_STORAGE_DRIVER: "postgres" }), /unknown EXPORTER_STORAGE_DRIVER/);
  });
});
