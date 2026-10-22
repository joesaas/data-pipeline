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
      provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, item_count INTEGER NOT NULL);
    CREATE TABLE cleaned_items (
      id TEXT PRIMARY KEY, source_record_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL,
      summary TEXT NOT NULL, detail TEXT, category TEXT NOT NULL, tags TEXT NOT NULL,
      event_date TEXT, sources TEXT NOT NULL, importance TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO cleaned_records VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run("rec-1", "h1", "2026-10-22T12:00:00.000Z", "openai-compatible", "openai/gpt-4o-mini", "clean-v1", 1);
  db.prepare("INSERT INTO cleaned_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("item-1", "rec-1", 0, "标题 <script>alert(1)</script>", "摘要 & 说明", null, "Web3 DeFi",
      JSON.stringify(["Solana"]), "2026-10-21", JSON.stringify([{ name: "Solana", url: "https://solana.com" }]), "high");
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
