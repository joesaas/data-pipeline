import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPgPool, type PgPoolLike } from "../src/pg/pool.js";
import { PgDriver } from "../src/storage/pg-driver.js";

/**
 * PG driver tests with a stub pool: no live database, no network, no
 * credentials. The stub answers each query from canned rows and records
 * every statement, so the tests pin the SQL shape (tag filter, txn
 * boundaries) as well as the row mapping (ISO times, JSONB, booleans,
 * BIGINT-as-string).
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

const T0 = "2026-10-25T00:00:00.000Z";
const T1 = "2026-10-25T01:00:00.000Z";

function recordRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "r1",
    token_id: "tok",
    external_id: "e1",
    title: "t",
    prompt: "p",
    content: "c",
    content_format: "markdown",
    content_hash: "h",
    source_agent: "muse",
    skill_version: null,
    tags: ["news"],
    metadata: { k: 1 },
    created_at: new Date(T0),
    updated_at: new Date(T1),
    ...over,
  };
}

describe("pg driver (stub pool)", () => {
  it("returns TIMESTAMPTZ columns as ISO strings, the same shape SQLite TEXT gave", async () => {
    const pool = stubPool(() => ({ rows: [recordRow()], rowCount: 1 }));
    const driver = new PgDriver(pool);
    try {
      const rec = await driver.getRecord("tok", "r1");
      assert.equal(rec?.created_at, T0);
      assert.equal(rec?.updated_at, T1);
      // Writes accept ISO strings (passed through as timestamptz params).
      const pool2 = stubPool(() => ({ rows: [], rowCount: 1 }));
      const driver2 = new PgDriver(pool2);
      try {
        await driver2.insertRecord({
          id: "r2",
          token_id: "tok",
          external_id: null,
          title: null,
          prompt: "p",
          content: "c",
          content_format: "text",
          content_hash: "h2",
          source_agent: "other",
          skill_version: null,
          tags: [],
          metadata: {},
          created_at: T0,
          updated_at: T0,
        });
        const insert = pool2.calls.find((c) => c.text.includes("INSERT INTO app.records"));
        assert.ok(insert);
        assert.equal(insert.params[12], T0);
        assert.equal(insert.params[13], T0);
      } finally {
        await driver2.close();
      }
    } finally {
      await driver.close();
    }
  });

  it("serializes tags/metadata as JSON strings for JSONB, not Postgres array literals", async () => {
    // Regression: passing a JS array raw makes node-postgres emit {"news"},
    // which jsonb rejects with 22P02 (real-PG contract, 2026-10-31).
    const pool = stubPool(() => ({ rows: [], rowCount: 1 }));
    const driver = new PgDriver(pool);
    try {
      await driver.insertRecord({
        id: "r3",
        token_id: "tok",
        external_id: null,
        title: null,
        prompt: "p",
        content: "c",
        content_format: "text",
        content_hash: "h3",
        source_agent: "other",
        skill_version: null,
        tags: ["news"],
        metadata: { k: 1 },
        created_at: T0,
        updated_at: T0,
      });
      const insert = pool.calls.find((c) => c.text.includes("INSERT INTO app.records"));
      assert.ok(insert);
      assert.equal(insert.params[10], '["news"]');
      assert.equal(insert.params[11], '{"k":1}');
      await driver.updateRecord({
        id: "r3",
        token_id: "tok",
        external_id: null,
        title: null,
        prompt: "p",
        content: "c",
        content_format: "text",
        content_hash: "h3",
        source_agent: "other",
        skill_version: null,
        tags: ["a", "b"],
        metadata: {},
        created_at: T0,
        updated_at: T0,
      });
      const update = pool.calls.find((c) => c.text.includes("UPDATE app.records"));
      assert.ok(update);
      assert.equal(update.params[7], '["a","b"]');
      assert.equal(update.params[8], "{}");
    } finally {
      await driver.close();
    }
  });

  it("normalizes JSONB: native arrays/objects pass through, JSON strings are parsed", async () => {
    const native = stubPool(() => ({ rows: [recordRow()], rowCount: 1 }));
    const d1 = new PgDriver(native);
    try {
      const rec = await d1.getRecord("tok", "r1");
      assert.deepEqual(rec?.tags, ["news"]);
      assert.deepEqual(rec?.metadata, { k: 1 });
    } finally {
      await d1.close();
    }
    const textual = stubPool(() => ({
      rows: [recordRow({ tags: '["a","b"]', metadata: '{"x":2}' })],
      rowCount: 1,
    }));
    const d2 = new PgDriver(textual);
    try {
      const rec = await d2.getRecord("tok", "r1");
      assert.deepEqual(rec?.tags, ["a", "b"]);
      assert.deepEqual(rec?.metadata, { x: 2 });
    } finally {
      await d2.close();
    }
  });

  it("filters tags with the JSONB ? operator and keeps param order", async () => {
    const pool = stubPool((text) => {
      if (text.includes("COUNT(*)")) return { rows: [{ n: "1" }], rowCount: 1 };
      return { rows: [recordRow()], rowCount: 1 };
    });
    const driver = new PgDriver(pool);
    try {
      const { items, total } = await driver.listRecords("tok", { tag: "news", limit: 10, offset: 0 });
      assert.equal(items.length, 1);
      assert.equal(total, 1);
      const list = pool.calls.find((c) => c.text.includes("SELECT * FROM app.records"));
      assert.ok(list);
      assert.match(list.text, /tags \? \$\d/);
      assert.deepEqual(list.params.slice(0, 2), ["tok", "news"]);
    } finally {
      await driver.close();
    }
  });

  it("maps BIGINT ids and COUNT(*) arriving as strings to numbers", async () => {
    const pool = stubPool((text) => {
      if (text.includes("COUNT(*)")) return { rows: [{ n: "7" }], rowCount: 1 };
      if (text.includes("RETURNING id")) return { rows: [{ id: "42" }], rowCount: 1 };
      if (text.includes("FROM app.webhooks WHERE id")) {
        return {
          rows: [{
            id: "42", name: "h", url: "https://x.example/", token: "t", payload: null,
            cron: null, is_active: true, created_at: new Date(T0), updated_at: new Date(T0),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    });
    const driver = new PgDriver(pool);
    try {
      const saved = await driver.saveWebhook({
        id: 0, name: "h", url: "https://x.example/", token: "t", payload: null, cron: null,
        is_active: true, created_at: T0, updated_at: T0,
      });
      assert.equal(saved.id, 42);
      assert.equal(typeof saved.id, "number");
      const { total } = await driver.listRecords("tok", { limit: 10, offset: 0 });
      assert.equal(total, 7);
      assert.equal(typeof total, "number");
    } finally {
      await driver.close();
    }
  });

  it("maps BOOLEAN columns to real booleans (and tolerates 1/0 from stubs)", async () => {
    const pool = stubPool(() => ({
      rows: [{
        id: 1, name: "h", url: "https://x.example/", token: "t", payload: null, cron: null,
        is_active: 1, created_at: new Date(T0), updated_at: new Date(T0),
      }],
      rowCount: 1,
    }));
    const driver = new PgDriver(pool);
    try {
      const row = await driver.getWebhook(1);
      assert.equal(row?.is_active, true);
    } finally {
      await driver.close();
    }
  });

  it("completeChatMessage commits human-done + muse row in one transaction and releases the client", async () => {
    const pool = stubPool(
      () => ({ rows: [], rowCount: 0 }),
      (text) => {
        if (text.startsWith("UPDATE app.chat_messages")) return { rows: [], rowCount: 1 };
        if (text.startsWith("INSERT INTO app.chat_messages")) return { rows: [{ id: 9 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    );
    // Reads after commit go through the pool (not the txn client).
    const origQuery = pool.query;
    pool.query = async (text: string, params: unknown[] = []) => {
      if (text.includes("FROM app.chat_messages WHERE id")) {
        const id = params[0] as number;
        return {
          rows: [{
            id, source: id === 9 ? "muse" : "human", content: id === 9 ? "reply" : "q",
            status: "done", in_reply_to: id === 9 ? 5 : null, error: null,
            created_at: new Date(T0), updated_at: new Date(T1),
          }],
          rowCount: 1,
        };
      }
      return origQuery(text, params);
    };
    const driver = new PgDriver(pool);
    try {
      const done = await driver.completeChatMessage(5, "reply");
      assert.ok(done);
      assert.equal(done.human.id, 5);
      assert.equal(done.human.status, "done");
      assert.equal(done.muse.id, 9);
      assert.equal(done.muse.in_reply_to, 5);
      const seq = pool.clientCalls.map((c) => c.text);
      assert.deepEqual(seq, ["BEGIN", "UPDATE app.chat_messages SET status = 'done', error = NULL, updated_at = $1 WHERE id = $2 AND status = 'processing'", "INSERT INTO app.chat_messages (source, content, status, in_reply_to, error, created_at, updated_at) VALUES ('muse', $1, 'done', $2, NULL, $3, $3) RETURNING id", "COMMIT"]);
      assert.equal(pool.released, true);
    } finally {
      await driver.close();
    }
  });

  it("completeChatMessage returns null without inserting when the row is not processing", async () => {
    const pool = stubPool(
      () => ({ rows: [], rowCount: 0 }),
      (text) => {
        if (text.startsWith("UPDATE app.chat_messages")) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      },
    );
    const driver = new PgDriver(pool);
    try {
      assert.equal(await driver.completeChatMessage(5, "reply"), null);
      assert.ok(!pool.clientCalls.some((c) => c.text.startsWith("INSERT INTO app.chat_messages")));
      assert.ok(pool.clientCalls.some((c) => c.text === "COMMIT"));
      assert.equal(pool.released, true);
    } finally {
      await driver.close();
    }
  });

  it("completeChatMessage rolls back, rethrows, and still releases the client on INSERT failure", async () => {
    const pool = stubPool(
      () => ({ rows: [], rowCount: 0 }),
      (text) => {
        if (text.startsWith("UPDATE app.chat_messages")) return { rows: [], rowCount: 1 };
        if (text.startsWith("INSERT INTO app.chat_messages")) throw new Error("boom");
        return { rows: [], rowCount: 0 };
      },
    );
    const driver = new PgDriver(pool);
    try {
      await assert.rejects(driver.completeChatMessage(5, "reply"), /boom/);
      assert.ok(pool.clientCalls.some((c) => c.text === "ROLLBACK"));
      assert.ok(!pool.clientCalls.some((c) => c.text === "COMMIT"));
      assert.equal(pool.released, true);
    } finally {
      await driver.close();
    }
  });

  it("propagates unique violations instead of swallowing them (callers map them to conflicts)", async () => {
    const pool = stubPool(() => {
      throw new Error('duplicate key value violates unique constraint "pending_tasks_pull_task_id_due_at_key"');
    });
    const driver = new PgDriver(pool);
    try {
      await assert.rejects(
        driver.savePendingTask({
          id: 0, pull_task_id: 7, pull_task_name: "t7", target: "muse", prompt: "do it",
          due_at: T0, kind: "scheduled", status: "waiting", result_external_id: null,
          result_record_id: null, error: null, created_at: T0, updated_at: T0,
        }),
        /duplicate key value violates unique constraint/,
      );
    } finally {
      await driver.close();
    }
  });

  it("pool auth is a per-connection token callback, never a stored token value", async () => {
    const pool = createPgPool({
      host: "database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com",
      port: 5432,
      database: "data_pipeline",
      user: "data_pipeline_app",
      region: "ap-southeast-1",
    });
    try {
      const options = pool.options as unknown as Record<string, unknown>;
      // A function means every new connection asks rds-signer for a
      // fresh token; a string here would be a stale, leaked credential.
      assert.equal(typeof options.password, "function");
      assert.ok(!Object.values(options).some((v) => typeof v === "string" && v.includes("AKIA")));
    } finally {
      await pool.end();
    }
  });

  it("constructor fails fast on missing PG configuration", async () => {
    const saved = process.env.PG_HOST;
    process.env.PG_HOST = "";
    try {
      assert.throws(() => new PgDriver(), /pg driver configuration/);
    } finally {
      if (saved === undefined) delete process.env.PG_HOST;
      else process.env.PG_HOST = saved;
    }
  });
});
