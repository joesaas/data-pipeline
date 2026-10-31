import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import {
  EXPECTED_TABLES,
  resolvePgConfig,
  verifyPg,
  type PgProbeClient,
  type PgVerifyResult,
} from "../src/pg/verify.js";

const ALL_TABLES = EXPECTED_TABLES.map((t) => `${t.schema}.${t.name}`);

/** Stub PG client: answers the probe's queries from canned data, never touches a real PG. */
function stubClient(opts?: {
  tables?: string[];
  probeNote?: string;
  failOn?: string;
}): PgProbeClient & { calls: string[] } {
  const calls: string[] = [];
  const tables = opts?.tables ?? ALL_TABLES;
  return {
    calls,
    query: async (text: string) => {
      calls.push(text);
      if (opts?.failOn && text.includes(opts.failOn)) throw new Error("stub failure");
      if (text.startsWith("SELECT version()")) {
        return { rows: [{ version: "PostgreSQL 17.9 on x86_64-pc-linux-gnu" }] };
      }
      if (text.startsWith("SELECT current_user")) {
        return { rows: [{ current_user: "data_pipeline_app" }] };
      }
      if (text.includes("information_schema.tables")) {
        return {
          rows: tables.map((t) => {
            const [table_schema, table_name] = t.split(".");
            return { table_schema, table_name };
          }),
        };
      }
      if (text.startsWith("SELECT note")) {
        return { rows: [{ note: opts?.probeNote ?? "probe" }] };
      }
      // BEGIN / ROLLBACK / CREATE TEMP TABLE / INSERT: no rows.
      return { rows: [] };
    },
  };
}

function stubConnect(client: PgProbeClient) {
  return async () => ({ client, close: async () => {} });
}

describe("pg verify logic (stub client, no live PG)", () => {
  it("reports ok:true when version, user, all 16 tables and the write probe pass", async () => {
    const client = stubClient();
    const result = await verifyPg({ connect: stubConnect(client) });
    assert.equal(result.ok, true);
    assert.equal(result.pg_version, "PostgreSQL 17.9 on x86_64-pc-linux-gnu");
    assert.equal(result.current_user, "data_pipeline_app");
    assert.equal(result.tables.expected.length, 16);
    assert.deepEqual(result.tables.missing, []);
    assert.equal(result.tables.found.length, 16);
    assert.equal(result.write_probe, true);
    assert.equal(result.reason, undefined);
    assert.ok(result.latency_ms >= 0);
    assert.ok(!Number.isNaN(Date.parse(result.checked_at)));
    // The write probe must run inside a rolled-back transaction.
    assert.ok(client.calls.includes("BEGIN"));
    assert.ok(client.calls.includes("ROLLBACK"));
  });

  it("reports ok:false with the missing tables listed", async () => {
    const missing = ["app.records", "cleaner.llm_calls"];
    const tables = ALL_TABLES.filter((t) => !missing.includes(t));
    const result = await verifyPg({ connect: stubConnect(stubClient({ tables })) });
    assert.equal(result.ok, false);
    assert.deepEqual(result.tables.missing, missing);
    assert.equal(result.tables.found.length, 14);
    assert.equal(result.reason, undefined);
  });

  it("reports ok:false when the write probe does not round-trip", async () => {
    const result = await verifyPg({ connect: stubConnect(stubClient({ probeNote: "other" })) });
    assert.equal(result.ok, false);
    assert.equal(result.write_probe, false);
  });

  it("reports ok:false instead of throwing when a query fails", async () => {
    const result = await verifyPg({
      connect: stubConnect(stubClient({ failOn: "information_schema" })),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "stub failure");
    assert.equal(result.pg_version, null);
  });

  it("reports ok:false instead of throwing when connecting fails", async () => {
    const result = await verifyPg({
      connect: async () => {
        throw new Error("connect refused");
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /pg connection failed/);
  });

  it("reports ok:false for missing or invalid configuration, without connecting", async () => {
    let connected = false;
    const result = await verifyPg({
      env: { PG_HOST: "" },
      connect: async () => {
        connected = true;
        throw new Error("must not connect");
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /missing PG configuration/);
    assert.equal(connected, false);
  });

  it("resolves defaults for the migration target", async () => {
    const resolved = resolvePgConfig({});
    assert.ok("config" in resolved);
    if ("config" in resolved) {
      assert.equal(resolved.config.host, "database-1.cluster-cbggog0m6isv.ap-southeast-1.rds.amazonaws.com");
      assert.equal(resolved.config.port, 5432);
      assert.equal(resolved.config.database, "data_pipeline");
      assert.equal(resolved.config.user, "data_pipeline_app");
      assert.equal(resolved.config.region, "ap-southeast-1");
    }
    const badPort = resolvePgConfig({ PG_PORT: "not-a-port" });
    assert.equal("error" in badPort, true);
  });
});

function baseConfig(dir: string): AppConfig {
  return {
    port: 0,
    basePath: "/data-pipeline",
    dataDir: join(dir, "data"),
    storage: "sqlite",
    authRequired: true,
    maxContentBytes: 1_048_576,
    maxPromptBytes: 65_536,
    rateLimitPerMin: 60,
    cleanedDbFile: join(dir, "no-cleaned.sqlite"),
    newsSiteUrl: "https://agent101.uk/news",
    newsDetailDir: join(dir, "news-detail"),
    newsDetailDbFile: join(dir, "news-detail.sqlite"),
  };
}

async function start(
  config: AppConfig,
  pgVerify: () => Promise<PgVerifyResult>,
): Promise<{
  base: string;
  server: Server;
  close: () => void;
  adminKey: string;
  userKey: string;
}> {
  const { app, driver, auth } = createApp(config, { pgVerify });
  const adminKey = auth.createToken("console-admin", "admin").plainKey;
  const userKey = auth.createToken("some-user", "user").plainKey;
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    server,
    close: () => {
      server.close();
      driver.close();
    },
    adminKey,
    userKey,
  };
}

type Ctx = Awaited<ReturnType<typeof start>>;

async function req(
  ctx: Ctx,
  method: string,
  path: string,
  key?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: { ...(key ? { "x-api-key": key } : {}) },
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

const VERIFY = "/data-pipeline/api/v1/admin/pg/verify";

describe("pg verify route", () => {
  let dir: string;
  let ctx: Ctx;

  before(async () => {
    dir = join(tmpdir(), `dp-pg-verify-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    // Injected stub: the route test must not touch a live PG or AWS.
    ctx = await start(baseConfig(dir), async () => ({
      ok: true,
      pg_version: "PostgreSQL 17.9 on x86_64-pc-linux-gnu",
      current_user: "data_pipeline_app",
      tables: { expected: ALL_TABLES, found: ALL_TABLES, missing: [] },
      write_probe: true,
      latency_ms: 3,
      checked_at: new Date().toISOString(),
    }));
  });

  after(() => {
    ctx.close();
  });

  it("rejects anonymous callers with 401 and non-admin keys with 403", async () => {
    assert.equal((await req(ctx, "GET", VERIFY)).status, 401);
    assert.equal((await req(ctx, "GET", VERIFY, ctx.userKey)).status, 403);
  });

  it("returns the probe envelope to admins", async () => {
    const r = await req(ctx, "GET", VERIFY, ctx.adminKey);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.current_user, "data_pipeline_app");
    assert.equal(r.body.write_probe, true);
    const tables = r.body.tables as { expected: string[]; found: string[]; missing: string[] };
    assert.equal(tables.expected.length, 16);
    assert.deepEqual(tables.missing, []);
  });

  it("passes a failing probe through as ok:false with 200, not a crash", async () => {
    const failing = await start(baseConfig(join(dir, "failing")), async () => ({
      ok: false,
      pg_version: null,
      current_user: null,
      tables: { expected: ALL_TABLES, found: [], missing: ALL_TABLES },
      write_probe: false,
      latency_ms: 1,
      checked_at: new Date().toISOString(),
      reason: "pg connection failed: refused",
    }));
    try {
      const r = await req(failing, "GET", VERIFY, failing.adminKey);
      assert.equal(r.status, 200);
      assert.equal(r.body.ok, false);
      assert.equal(r.body.reason, "pg connection failed: refused");
    } finally {
      failing.close();
    }
  });
});
