import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PgCleanerStore } from "../src/pg-store.js";
import type { PgPoolLike } from "../src/pg-pool.js";

/**
 * PG cleaner store tests with a stub pool: no live database, no
 * network, no credentials. Pins the translation_zh three-state
 * passthrough, the JSONB normalization, the save() transaction shape
 * and id formula, and the listUntranslated SQL/order.
 */

interface Call {
  text: string;
  params: unknown[];
}

type Responder = (text: string, params: unknown[]) => { rows: Record<string, unknown>[]; rowCount: number | null };

function stubPool(respond: Responder, clientRespond?: Responder): PgPoolLike & { calls: Call[]; clientCalls: Call[]; released: boolean; ended: boolean } {
  const calls: Call[] = [];
  const clientCalls: Call[] = [];
  let released = false;
  let ended = false;
  const client = {
    query: async (text: string, params: unknown[] = []) => {
      clientCalls.push({ text, params });
      return (clientRespond ?? respond)(text, params);
    },
    release: () => {
      released = true;
    },
  };
  return {
    calls,
    clientCalls,
    get released() {
      return released;
    },
    get ended() {
      return ended;
    },
    query: async (text: string, params: unknown[] = []) => {
      calls.push({ text, params });
      return respond(text, params);
    },
    connect: async () => client,
    end: async () => {
      ended = true;
    },
  };
}

const record = {
  id: "r1", external_id: null, title: "t", prompt: "p", content: "正文",
  content_format: "markdown" as const, content_hash: "h1", source_agent: "test",
  skill_version: null, tags: [], metadata: {}, created_at: "2026-10-22T00:00:00Z", updated_at: "2026-10-22T00:00:00Z",
};
const meta = { provider: "mock", model: "m", promptVersion: "clean-v1", cleanedAt: "2026-10-22T00:00:00Z" };
const item = { title: "一", summary: "s", category: "AI Agent", tags: ["a"], event_date: null, sources: [{ name: "x", url: "https://x.example/" }] };

describe("pg cleaner store (stub pool)", () => {
  it("keeps translation_zh three states apart: NULL, '' and JSON text", async () => {
    // listUntranslated selects only NULL rows — the SQL is the proof.
    const pool = stubPool(() => ({ rows: [], rowCount: 0 }));
    const store = new PgCleanerStore(pool);
    try {
      await store.listUntranslated(10);
      const sel = pool.calls.find((c) => c.text.includes("FROM cleaner.cleaned_items"));
      assert.ok(sel);
      assert.match(sel.text, /translation_zh IS NULL/);
      assert.match(sel.text, /ORDER BY r\.cleaned_at DESC, i\.idx ASC/);

      await store.markNoTranslation("i1");
      const mark = pool.calls.find((c) => c.text.includes("translation_zh = ''"));
      assert.ok(mark);
      assert.deepEqual(mark.params, ["i1"]);

      await store.setTranslation("i2", { title: "中", summary: "摘" });
      const set = pool.calls.find((c) => c.text.includes("SET translation_zh = $1"));
      assert.ok(set);
      assert.deepEqual(set.params, [JSON.stringify({ title: "中", summary: "摘" }), "i2"]);
    } finally {
      await store.close();
    }
  });

  it("save() runs one transaction and uses the identical sha256 id formula", async () => {
    const pool = stubPool(
      () => ({ rows: [], rowCount: 0 }),
      () => ({ rows: [], rowCount: 0 }),
    );
    const store = new PgCleanerStore(pool);
    try {
      await store.save(record, meta, [item]);
      const seq = pool.clientCalls.map((c) => c.text);
      assert.equal(seq[0], "BEGIN");
      assert.equal(seq[seq.length - 1], "COMMIT");
      assert.ok(seq.some((t) => t.includes("INSERT INTO cleaner.cleaned_records")));
      assert.ok(seq.some((t) => t.includes("DELETE FROM cleaner.cleaned_items")));
      const insert = pool.clientCalls.find((c) => c.text.includes("INSERT INTO cleaner.cleaned_items"));
      assert.ok(insert);
      const { createHash } = await import("node:crypto");
      const expected = createHash("sha256").update("r1:0:一").digest("hex");
      assert.equal(insert.params[0], expected);
      assert.equal(insert.params[6], "AI Agent");
      assert.equal(insert.params[7], JSON.stringify(["a"]));
      assert.equal(insert.params[9], JSON.stringify([{ name: "x", url: "https://x.example/" }]));
      assert.equal(pool.released, true);
    } finally {
      await store.close();
    }
  });

  it("save() rolls back and releases on failure", async () => {
    const pool = stubPool(
      () => ({ rows: [], rowCount: 0 }),
      (text) => {
        if (text.includes("INSERT INTO cleaner.cleaned_records")) throw new Error("boom");
        return { rows: [], rowCount: 0 };
      },
    );
    const store = new PgCleanerStore(pool);
    try {
      await assert.rejects(store.save(record, meta, [item]), /boom/);
      assert.ok(pool.clientCalls.some((c) => c.text === "ROLLBACK"));
      assert.ok(!pool.clientCalls.some((c) => c.text === "COMMIT"));
      assert.equal(pool.released, true);
    } finally {
      await store.close();
    }
  });

  it("normalizes JSONB sources and keeps BIGINT llm counts numeric", async () => {
    const pool = stubPool((text) => {
      if (text.includes("FROM cleaner.cleaned_items")) {
        return { rows: [{ title: "一", sources: [{ name: "x", url: "https://x.example/" }] }], rowCount: 1 };
      }
      if (text.includes("FROM cleaner.llm_calls")) return { rows: [{ n: "3" }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const store = new PgCleanerStore(pool);
    try {
      const keys = await store.recentItemKeys(7, "r0");
      assert.deepEqual(keys, [{ title: "一", sourceUrls: ["https://x.example/"] }]);
      assert.equal(await store.countLlmCalls(0), 3);
    } finally {
      await store.close();
    }
  });

  it("constructor fails fast on missing PG configuration", async () => {
    const saved = process.env.PG_HOST;
    process.env.PG_HOST = "";
    try {
      assert.throws(() => new PgCleanerStore(), /pg driver configuration/);
    } finally {
      if (saved === undefined) delete process.env.PG_HOST;
      else process.env.PG_HOST = saved;
    }
  });
});
