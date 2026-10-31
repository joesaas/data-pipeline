import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AppConfig } from "../src/config.js";
import { PgCleanedReader } from "../src/cleaned/pg-cleaned-reader.js";
import { PgNewsDetailStore } from "../src/news-detail/pg-news-detail-store.js";
import { NewsDetailService } from "../src/news-detail/news-detail-service.js";
import type { PgPoolLike } from "../src/pg/pool.js";

/**
 * PG news-detail tests with stub pools: no live database, no network,
 * no credentials. Pins the ILIKE ANY category SQL, ISO conversion,
 * JSONB normalization, save created/replaced, and the pending-queue
 * join (reader + store) through the real NewsDetailService.
 */

interface Call {
  text: string;
  params: unknown[];
}

type Responder = (text: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number | null };

function stubPool(respond: Responder): PgPoolLike & { calls: Call[]; ended: boolean } {
  const calls: Call[] = [];
  let ended = false;
  return {
    calls,
    get ended() {
      return ended;
    },
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return respond(text, params);
    },
    connect: async () => {
      throw new Error("stub pool has no client (use pool.query)");
    },
    end: async () => {
      ended = true;
    },
  };
}

function itemRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "item-1",
    source_record_id: "rec-1",
    idx: 0,
    title: "t",
    summary: "s",
    detail: null,
    category: "AI Agent",
    tags: ["a"],
    event_date: null,
    sources: [{ name: "S", url: "https://example.com/s" }],
    translation_zh: null,
    source_agent: "muse",
    cleaned_at: new Date("2026-10-22T12:00:00.000Z"),
    provider: "openai-compatible",
    model: "openai/gpt-4o-mini",
    ...over,
  };
}

const serviceConfig = {
  newsSiteUrl: "https://agent101.uk/news",
  newsDetailDir: "/tmp/nd-test",
  maxContentBytes: 1_048_576,
} as unknown as AppConfig;

describe("pg news-detail (stub pools)", () => {
  it("reader filters categories with ILIKE ANY over the alias list", async () => {
    const pool = stubPool((text) => {
      if (text.includes("COUNT(*)")) return { rows: [{ n: "1" }], rowCount: 1 };
      return { rows: [itemRow()], rowCount: 1 };
    });
    const reader = new PgCleanedReader(pool);
    const { items, total } = await reader.listItems({ category: "AI Agent", limit: 10, offset: 0 });
    assert.equal(total, 1);
    assert.equal(items.length, 1);
    const list = pool.calls.find((c) => c.text.includes("FROM cleaner.cleaned_items"));
    assert.ok(list);
    assert.match(list.text, /i\.category ILIKE ANY\(\$\d+\)/);
    assert.ok(Array.isArray(list.params[0]));
    assert.ok((list.params[0] as unknown[]).includes("AI Agent"));
    // TIMESTAMPTZ Date normalized to ISO; JSONB native values pass through.
    assert.equal(items[0].cleaned_at, "2026-10-22T12:00:00.000Z");
    assert.deepEqual(items[0].tags, ["a"]);
    assert.deepEqual(items[0].sources, [{ name: "S", url: "https://example.com/s" }]);
  });

  it("reader searches text with ILIKE and returns null for a missing item", async () => {
    const pool = stubPool((text) => {
      if (text.includes("COUNT(*)")) return { rows: [{ n: "0" }], rowCount: 1 };
      if (text.includes("WHERE i.id = $1")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
    const reader = new PgCleanedReader(pool);
    await reader.listItems({ q: "Alpenglow", limit: 10, offset: 0 });
    const list = pool.calls.find((c) => c.text.includes("FROM cleaner.cleaned_items"));
    assert.ok(list);
    assert.match(list.text, /i\.title ILIKE \$\d+ OR i\.summary ILIKE \$\d+/);
    assert.equal(list.params[0], "%Alpenglow%");
    assert.equal(await reader.getItem("nope"), null);
  });

  it("reader propagates connection errors instead of degrading to empty", async () => {
    const pool = stubPool(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const reader = new PgCleanedReader(pool);
    await assert.rejects(reader.listItems({ limit: 10, offset: 0 }), /ECONNREFUSED/);
    await assert.rejects(reader.getItem("x"), /ECONNREFUSED/);
  });

  it("store save reports created then replaced, keeping first created_at", async () => {
    let calls = 0;
    const pool = stubPool(() => {
      calls += 1;
      // First save: pre-SELECT empty -> created. Second: hit -> replaced.
      if (calls === 1) return { rows: [], rowCount: 0 };
      return { rows: [{ item_id: "item-1" }], rowCount: 1 };
    });
    const store = new PgNewsDetailStore(pool);
    const page = {
      item_id: "item-1", detail_path: "item-1.html", status: "done" as const,
      original_url: "https://agent101.uk/news/item/item-1/",
      created_at: "2026-10-22T00:00:00.000Z", updated_at: "2026-10-22T01:00:00.000Z",
    };
    assert.equal(await store.save(page), "created");
    assert.equal(await store.save(page), "replaced");
    const upsert = pool.calls.find((c) => c.text.includes("INSERT INTO news_detail.detail_pages"));
    assert.ok(upsert);
    assert.match(upsert.text, /ON CONFLICT \(item_id\) DO UPDATE/);
    assert.ok(!upsert.text.includes("created_at = EXCLUDED.created_at"));
  });

  it("store reads TIMESTAMPTZ back as ISO strings", async () => {
    const pool = stubPool(() => ({
      rows: [{
        item_id: "item-1", detail_path: "item-1.html", status: "done",
        original_url: "https://agent101.uk/news/item/item-1/",
        created_at: new Date("2026-10-22T00:00:00.000Z"),
        updated_at: new Date("2026-10-22T01:00:00.000Z"),
      }],
      rowCount: 1,
    }));
    const store = new PgNewsDetailStore(pool);
    const page = await store.get("item-1");
    assert.equal(page?.created_at, "2026-10-22T00:00:00.000Z");
    assert.equal(page?.updated_at, "2026-10-22T01:00:00.000Z");
  });

  it("service listPending joins the PG reader with the PG store, oldest first", async () => {
    const readerPool = stubPool((text) => {
      if (text.includes("COUNT(*)")) return { rows: [{ n: "2" }], rowCount: 1 };
      return {
        rows: [
          itemRow({ id: "item-old", cleaned_at: new Date("2026-10-22T12:00:00.000Z") }),
          itemRow({ id: "item-new", cleaned_at: new Date("2026-10-23T12:00:00.000Z") }),
        ],
        rowCount: 2,
      };
    });
    const storePool = stubPool(() => ({
      rows: [{ item_id: "item-old", detail_path: "item-old.html" }],
      rowCount: 1,
    }));
    const service = new NewsDetailService(
      new PgCleanedReader(readerPool),
      new PgNewsDetailStore(storePool),
      serviceConfig,
    );
    const { items, limit } = await service.listPending(10);
    assert.equal(limit, 10);
    assert.deepEqual(items.map((i) => i.id), ["item-new"]);
    assert.equal(items[0].detail_status, "pending");
    assert.equal(items[0].original_url, "https://agent101.uk/news/item/item-new/");
  });
});
