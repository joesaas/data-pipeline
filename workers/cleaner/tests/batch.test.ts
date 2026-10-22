import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawRecord } from "@data-pipeline/shared";
import { runBatch } from "../src/batch.js";
import { MockProvider } from "../src/providers.js";
import { CleanerStore } from "../src/store.js";

function record(id: string, hash: string, content: string): RawRecord {
  return {
    id, external_id: null, title: "科技简报标题", prompt: "p", content,
    content_format: "markdown", content_hash: hash, source_agent: "test",
    skill_version: null, tags: [], metadata: {}, created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z",
  };
}
const BRIEF = `## A. AI Agent\n\n### 1. 框架发布 2.0\n${"发布说明内容足够长用于通过质量门检查。".repeat(3)}`;

describe("runBatch", () => {
  it("cleans new records, then skips them on the second run", async () => {
    const store = new CleanerStore(":memory:");
    const deps = {
      client: { fetchAll: async () => [record("r1", "h1", BRIEF)] },
      provider: new MockProvider(),
      store,
      systemPrompt: "x",
      limit: 100,
      maxPerRun: 20,
      log: () => {},
    };
    const first = await runBatch(deps);
    assert.equal(first.cleaned, 1);
    assert.ok(first.items >= 1);
    const second = await runBatch(deps);
    assert.equal(second.skipped, 1);
    assert.equal(second.cleaned, 0);
    store.close();
  });
  it("rejects records that fail the quality gate", async () => {
    const store = new CleanerStore(":memory:");
    const stats = await runBatch({
      client: { fetchAll: async () => [record("r2", "h2", "太短")] },
      provider: new MockProvider(),
      store,
      systemPrompt: "x",
      limit: 100,
      maxPerRun: 20,
      log: () => {},
    });
    assert.equal(stats.rejected, 1);
    store.close();
  });
});
