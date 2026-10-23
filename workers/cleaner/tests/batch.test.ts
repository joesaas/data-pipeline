import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RawRecord } from "@data-pipeline/shared";
import { runBatch } from "../src/batch.js";
import type { RecordCursor } from "../src/client.js";
import { MockProvider } from "../src/providers.js";
import { LlmRateLimiter } from "../src/ratelimit.js";
import { CleanerStore } from "../src/store.js";

/** In-memory client honoring the (updated_at, id) keyset contract. */
function stubClient(all: RawRecord[]) {
  return {
    fetchSince: async (cursor: RecordCursor | null): Promise<RawRecord[]> =>
      all
        .filter(
          (r) =>
            !cursor ||
            r.updated_at > cursor.updated_at ||
            (r.updated_at === cursor.updated_at && r.id > cursor.id),
        )
        .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id)),
  };
}

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
      client: stubClient([record("r1", "h1", BRIEF)]),
      provider: new MockProvider(),
      store,
      systemPrompt: "x",
      translatePrompt: "t",
      limit: 100,
      maxPerRun: 20,
      log: () => {},
    };
    const first = await runBatch(deps);
    assert.equal(first.cleaned, 1);
    assert.ok(first.items >= 1);
    const second = await runBatch(deps);
    assert.equal(second.fetched, 0); // cursor moved past r1: nothing is re-fetched
    assert.equal(second.cleaned, 0);
    store.close();
  });
  it("rejects records that fail the quality gate", async () => {
    const store = new CleanerStore(":memory:");
    const stats = await runBatch({
      client: stubClient([record("r2", "h2", "太短")]),
      provider: new MockProvider(),
      store,
      systemPrompt: "x",
      translatePrompt: "t",
      limit: 100,
      maxPerRun: 20,
      log: () => {},
    });
    assert.equal(stats.rejected, 1);
    store.close();
  });
});

describe("runBatch cursor + budget discipline", () => {
  const twoRecords = () => [
    { ...record("a1", "h1", BRIEF), updated_at: "2026-10-22T00:00:01Z" },
    { ...record("a2", "h2", BRIEF), updated_at: "2026-10-22T00:00:02Z" },
  ];

  it("rate limit defers remaining records without failing them", async () => {
    const store = new CleanerStore(":memory:");
    const provider = {
      name: "openai-compatible",
      model: "fake",
      clean: async (rec: RawRecord) => new MockProvider().clean(rec),
      translate: async () => new Map(),
    };
    const limiter = new LlmRateLimiter(store, { perHour: 1, perDay: 500 });
    const stats = await runBatch({
      client: stubClient(twoRecords()),
      provider,
      store,
      systemPrompt: "x",
      translatePrompt: "t",
      limit: 100,
      maxPerRun: 20,
      rateLimiter: limiter,
      log: () => {},
    });
    assert.equal(stats.cleaned, 1);
    assert.equal(stats.deferred, 1);
    assert.equal(stats.failed, 0);
    assert.equal(store.getCursor()?.id, "a1"); // cursor stopped before the deferred record
    store.close();
  });

  it("a failing record stops the batch and keeps the cursor before it", async () => {
    const store = new CleanerStore(":memory:");
    const provider = {
      name: "openai-compatible",
      model: "fake",
      clean: async () => {
        throw new Error("provider down");
      },
      translate: async () => new Map(),
    };
    const stats = await runBatch({
      client: stubClient(twoRecords()),
      provider,
      store,
      systemPrompt: "x",
      translatePrompt: "t",
      limit: 100,
      maxPerRun: 20,
      log: () => {},
    });
    assert.equal(stats.failed, 1);
    assert.equal(stats.deferred, 1);
    assert.equal(store.getCursor(), null);
    assert.equal(store.getAttempts("a1"), 1);
    store.close();
  });
});

describe("runBatch translation phase", () => {
  const EN_BRIEF = `## A. DeFi Protocol\n\n### 1. Protocol launches v2 on mainnet\n${"The protocol shipped a major upgrade with new vaults and lower fees for all users. ".repeat(2)}`;

  function enDeps(store: CleanerStore, translateCalls: { n: number; sizes: number[] }) {
    return {
      client: stubClient([record("e1", "eh1", EN_BRIEF), { ...record("e2", "eh2", EN_BRIEF), updated_at: "2026-10-22T00:00:01Z" }]),
      provider: {
        name: "openai-compatible",
        model: "fake",
        clean: async (rec: RawRecord) => new MockProvider().clean(rec),
        translate: async (entries: { id: string; title: string; summary: string }[]) => {
          translateCalls.n += 1;
          translateCalls.sizes.push(entries.length);
          return new Map(entries.map((e) => [e.id, { title: `译:${e.title}`, summary: `译:${e.summary}` }]));
        },
      },
      store,
      systemPrompt: "x",
      translatePrompt: "t",
      limit: 100,
      maxPerRun: 20,
      log: () => {},
    };
  }

  it("translates a whole round in ONE provider call, then never again", async () => {
    const store = new CleanerStore(":memory:");
    const calls = { n: 0, sizes: [] as number[] };
    const stats = await runBatch(enDeps(store, calls));
    assert.equal(stats.cleaned, 2);
    assert.equal(calls.n, 1); // one batched call for the entire round
    assert.ok(stats.translated >= 2);
    assert.equal(store.listUntranslated(10).length, 0);
    const second = await runBatch(enDeps(store, calls));
    assert.equal(calls.n, 1); // nothing pending -> no further call
    assert.equal(second.translated, 0);
    store.close();
  });

  it("mock provider never translates", async () => {
    const store = new CleanerStore(":memory:");
    const stats = await runBatch({
      client: stubClient([record("m1", "mh1", EN_BRIEF)]),
      provider: new MockProvider(),
      store,
      systemPrompt: "x",
      translatePrompt: "t",
      limit: 100,
      maxPerRun: 20,
      log: () => {},
    });
    assert.equal(stats.translated, 0);
    assert.equal(store.listUntranslated(10).length, 1); // left pending, not marked
    store.close();
  });
});
