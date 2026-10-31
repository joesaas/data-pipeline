import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PgPoolLike } from "../src/pg-pool.js";
import {
  loadActivePullTasksPg,
  loadExistingDueKeysPg,
  insertPendingTaskPg,
} from "../src/pull-task-scheduler.js";
import { appendTriggerHistoryPg, TRIGGER_HISTORY_LIMIT } from "../src/webhook-history.js";
import {
  loadActivePayloadFromDbPg,
  loadActiveWebhookFromDbPg,
  loadWebhookByIdFromDbPg,
} from "../src/webhook-config.js";
import {
  assertJobRunnerPgConfig,
  endJobRunnerPgPool,
  resolveJobRunnerStorageDriver,
} from "../src/storage.js";

/**
 * Stub-level PG tests for the job-runner PG mapping. No test here
 * touches a real database: every PG function takes a stub pool, and
 * the dispatcher PG path is deliberately NOT exercised (it would
 * build a real pool and attempt a connection). What these prove:
 *   - the driver switch semantics (default sqlite, pg, fail fast),
 *   - PG row mapping (BIGINT-as-string -> Number, TIMESTAMPTZ Date
 *     -> ISO due keys, BOOLEAN as real booleans, null fallbacks),
 *   - the exact SQL shapes (schema-qualified tables, $ placeholders,
 *     kind/status literals, prune LIMIT parameter),
 *   - the never-throws contract (a failing pool yields null/false).
 */

class StubPool implements PgPoolLike {
  calls: { text: string; params?: unknown[] }[] = [];
  rows: Record<string, unknown>[][] = [];
  fail = false;
  ended = false;

  async query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    this.calls.push({ text, params });
    if (this.fail) throw new Error("stub pool failure");
    const rows = this.rows.shift() ?? [];
    return { rows, rowCount: rows.length };
  }

  async connect(): Promise<{ query: PgPoolLike["query"]; release(): void }> {
    return { query: (t: string, p?: unknown[]) => this.query(t, p), release: () => {} };
  }

  async end(): Promise<void> {
    this.ended = true;
  }
}

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key] as string;
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key] as string;
    }
  }
}

describe("job-runner storage switch", () => {
  it("defaults to sqlite; sqlite/pg pass; unknown throws; whitespace trimmed", () => {
    withEnv({ JOB_RUNNER_STORAGE_DRIVER: undefined }, () => {
      assert.equal(resolveJobRunnerStorageDriver(), "sqlite");
    });
    withEnv({ JOB_RUNNER_STORAGE_DRIVER: "" }, () => {
      assert.equal(resolveJobRunnerStorageDriver(), "sqlite");
    });
    withEnv({ JOB_RUNNER_STORAGE_DRIVER: "sqlite" }, () => {
      assert.equal(resolveJobRunnerStorageDriver(), "sqlite");
    });
    withEnv({ JOB_RUNNER_STORAGE_DRIVER: "  pg  " }, () => {
      assert.equal(resolveJobRunnerStorageDriver(), "pg");
    });
    withEnv({ JOB_RUNNER_STORAGE_DRIVER: "postgres" }, () => {
      assert.throws(() => resolveJobRunnerStorageDriver(), /unknown JOB_RUNNER_STORAGE_DRIVER/);
    });
  });

  it("assertJobRunnerPgConfig passes on defaults, throws on an empty PG var", () => {
    withEnv(
      { PG_HOST: undefined, PG_PORT: undefined, PG_DATABASE: undefined, PG_USER: undefined, PG_REGION: undefined },
      () => {
        assertJobRunnerPgConfig();
      },
    );
    withEnv({ PG_HOST: "" }, () => {
      assert.throws(() => assertJobRunnerPgConfig(), /pg driver configuration is incomplete/);
    });
  });

  it("endJobRunnerPgPool is a no-op when no pool was created", async () => {
    await endJobRunnerPgPool();
  });
});

describe("scheduler PG mapping", () => {
  it("maps BIGINT-as-string ids, boolean is_active, null target -> muse", async () => {
    const pool = new StubPool();
    pool.rows.push([
      { id: "42", name: "t", prompt: "p", cron: "* * * * *", target: null, is_active: true },
      { id: 7, name: "u", prompt: "q", cron: "0 * * * *", target: "muse", is_active: false },
    ]);
    const tasks = await loadActivePullTasksPg(pool);
    assert.deepEqual(tasks, [
      { id: 42, name: "t", prompt: "p", cron: "* * * * *", target: "muse", is_active: true },
      { id: 7, name: "u", prompt: "q", cron: "0 * * * *", target: "muse", is_active: false },
    ]);
    assert.match(pool.calls[0].text, /FROM app\.pull_tasks WHERE is_active/);
  });

  it("renders TIMESTAMPTZ Dates back to ISO due keys (string due_at passes through)", async () => {
    const pool = new StubPool();
    pool.rows.push([
      { pull_task_id: "1", due_at: new Date("2026-10-31T00:00:00.000Z") },
      { pull_task_id: 2, due_at: "2026-10-31T01:00:00.000Z" },
    ]);
    const keys = await loadExistingDueKeysPg(pool);
    assert.deepEqual(
      [...(keys ?? [])].sort(),
      ["1|2026-10-31T00:00:00.000Z", "2|2026-10-31T01:00:00.000Z"],
    );
  });

  it("inserts with $ placeholders, kind/status literals, ISO timestamps; failure -> false", async () => {
    const pool = new StubPool();
    const ok = await insertPendingTaskPg(pool, {
      pull_task_id: 1,
      pull_task_name: "t",
      target: "muse",
      prompt: "p",
      due_at: "2026-10-31T00:00:00.000Z",
    });
    assert.equal(ok, true);
    assert.match(pool.calls[0].text, /INSERT INTO app\.pending_tasks/);
    assert.match(pool.calls[0].text, /'scheduled', 'waiting'/);
    assert.deepEqual(pool.calls[0].params?.slice(0, 5), [1, "t", "muse", "p", "2026-10-31T00:00:00.000Z"]);
    const failing = new StubPool();
    failing.fail = true;
    assert.equal(
      await insertPendingTaskPg(failing, {
        pull_task_id: 1,
        pull_task_name: "t",
        target: "muse",
        prompt: "p",
        due_at: "2026-10-31T00:00:00.000Z",
      }),
      false,
    );
  });

  it("PG failure returns null, never throws", async () => {
    const pool = new StubPool();
    pool.fail = true;
    assert.equal(await loadActivePullTasksPg(pool), null);
    assert.equal(await loadExistingDueKeysPg(pool), null);
  });
});

describe("webhook-history PG mapping", () => {
  it("inserts booleans (not 1/0) then prunes with LIMIT 1000; failure -> false", async () => {
    const pool = new StubPool();
    const ok = await appendTriggerHistoryPg(pool, {
      webhook_id: 1,
      webhook_name: "grok-bot",
      kind: "scheduled",
      triggered_at: "2026-10-26T01:00:00.000Z",
      http_status: 200,
      ok: true,
      body_kind: "payload(single)",
      body: JSON.stringify({ prompt: "do it" }),
      body_truncated: false,
      error: null,
      duration_ms: 120,
    });
    assert.equal(ok, true);
    assert.equal(pool.calls.length, 2);
    assert.match(pool.calls[0].text, /INSERT INTO app\.webhook_trigger_history/);
    assert.deepEqual(pool.calls[0].params?.slice(5, 9), [true, "payload(single)", JSON.stringify({ prompt: "do it" }), false]);
    assert.match(pool.calls[1].text, /DELETE FROM app\.webhook_trigger_history/);
    assert.deepEqual(pool.calls[1].params, [TRIGGER_HISTORY_LIMIT]);
    const failing = new StubPool();
    failing.fail = true;
    assert.equal(
      await appendTriggerHistoryPg(failing, {
        webhook_id: 1,
        webhook_name: "g",
        kind: "scheduled",
        triggered_at: "2026-10-26T01:00:00.000Z",
        http_status: null,
        ok: false,
        body_kind: "ping",
        body: null,
        body_truncated: false,
        error: "boom",
        duration_ms: null,
      }),
      false,
    );
  });
});

describe("webhook-config PG mapping", () => {
  it("maps string ids to numbers, null cron/payload; empty url/token -> null; no rows -> null", async () => {
    const pool = new StubPool();
    pool.rows.push([
      { id: "7", name: "grok", url: "https://grok.example/hook", token: "tok", payload: null, cron: null },
    ]);
    assert.deepEqual(await loadActiveWebhookFromDbPg(pool), {
      id: 7,
      name: "grok",
      url: "https://grok.example/hook",
      token: "tok",
      payload: null,
      cron: null,
    });
    assert.match(pool.calls[0].text, /FROM app\.webhooks WHERE is_active/);

    const emptyUrl = new StubPool();
    emptyUrl.rows.push([{ id: 1, name: "x", url: "", token: "tok", payload: null, cron: null }]);
    assert.equal(await loadActiveWebhookFromDbPg(emptyUrl), null);

    const noRows = new StubPool();
    noRows.rows.push([]);
    assert.equal(await loadActiveWebhookFromDbPg(noRows), null);
  });

  it("by-id binds the id as $1; PG failure -> null", async () => {
    const pool = new StubPool();
    pool.rows.push([{ id: 3, name: "n", url: "https://h.example/", token: "t", payload: "p", cron: "0 * * * *" }]);
    assert.deepEqual(await loadWebhookByIdFromDbPg(pool, 3), {
      id: 3,
      name: "n",
      url: "https://h.example/",
      token: "t",
      payload: "p",
      cron: "0 * * * *",
    });
    assert.deepEqual(pool.calls[0].params, [3]);
    const failing = new StubPool();
    failing.fail = true;
    assert.equal(await loadWebhookByIdFromDbPg(failing, 3), null);
    assert.equal(await loadActiveWebhookFromDbPg(failing), null);
    assert.equal(await loadActivePayloadFromDbPg(failing), null);
  });

  it("payload: content passes through untrimmed, whitespace-only -> null", async () => {
    const pool = new StubPool();
    pool.rows.push([{ content: "  hello  " }]);
    assert.equal(await loadActivePayloadFromDbPg(pool), "  hello  ");
    const blank = new StubPool();
    blank.rows.push([{ content: "   " }]);
    assert.equal(await loadActivePayloadFromDbPg(blank), null);
    const none = new StubPool();
    none.rows.push([]);
    assert.equal(await loadActivePayloadFromDbPg(none), null);
  });
});
