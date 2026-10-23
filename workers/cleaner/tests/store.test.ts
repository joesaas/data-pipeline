import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CleanedItem, RawRecord } from "@data-pipeline/shared";
import { CleanerStore } from "../src/store.js";

function record(hash: string): RawRecord {
  return {
    id: "r1", external_id: null, title: "t", prompt: "p", content: "正文",
    content_format: "markdown", content_hash: hash, source_agent: "test",
    skill_version: null, tags: [], metadata: {}, created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z",
  };
}
const item = (title: string): CleanedItem => ({
  title, summary: "s", category: "AI Agent", tags: [], event_date: null, sources: [],
});
const meta = { provider: "mock", model: "m", promptVersion: "clean-v1", cleanedAt: "2026-10-22T00:00:00Z" };

describe("CleanerStore", () => {
  it("saves and reports counts", () => {
    const store = new CleanerStore(":memory:");
    store.save(record("h1"), meta, [item("一"), item("二")]);
    assert.deepEqual(store.counts(), { records: 1, items: 2 });
    assert.equal(store.cleanedHash("r1"), "h1");
    store.close();
  });
  it("replaces items when the same record is re-cleaned", () => {
    const store = new CleanerStore(":memory:");
    store.save(record("h1"), meta, [item("一"), item("二")]);
    store.save(record("h2"), meta, [item("三")]);
    assert.deepEqual(store.counts(), { records: 1, items: 1 });
    assert.equal(store.cleanedHash("r1"), "h2");
    store.close();
  });
});

describe("CleanerStore v2 migration", () => {
  it("drops importance, adds source_agent, and keeps existing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "store-mig-"));
    const file = join(dir, "cleaned.sqlite");
    const raw = new DatabaseSync(file);
    raw.exec(`
      CREATE TABLE cleaned_records (
        source_record_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, cleaned_at TEXT NOT NULL,
        provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, item_count INTEGER NOT NULL);
      CREATE TABLE cleaned_items (
        id TEXT PRIMARY KEY, source_record_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL,
        summary TEXT NOT NULL, detail TEXT, category TEXT NOT NULL, tags TEXT NOT NULL,
        event_date TEXT, sources TEXT NOT NULL, importance TEXT NOT NULL);
    `);
    raw.prepare("INSERT INTO cleaned_records VALUES ('r1','h1','2026-10-22T00:00:00Z','mock','m','clean-v1',1)").run();
    raw.prepare("INSERT INTO cleaned_items VALUES ('i1','r1',0,'旧标题','s',NULL,'AI Agent','[]',NULL,'[]','high')").run();
    raw.close();

    const store = new CleanerStore(file);
    assert.deepEqual(store.counts(), { records: 1, items: 1 });
    store.close();

    const check = new DatabaseSync(file);
    const itemCols = (check.prepare("PRAGMA table_info(cleaned_items)").all() as { name: string }[]).map((c) => c.name);
    const recCols = (check.prepare("PRAGMA table_info(cleaned_records)").all() as { name: string }[]).map((c) => c.name);
    assert.ok(!itemCols.includes("importance"));
    assert.ok(recCols.includes("source_agent"));
    check.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
