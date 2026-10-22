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
  title, summary: "s", category: "AI Agent", tags: [], event_date: null, sources: [], importance: "medium",
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
