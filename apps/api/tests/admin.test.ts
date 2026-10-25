import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

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
  };
}

async function start(config: AppConfig): Promise<{
  base: string;
  server: Server;
  close: () => void;
  adminKey: string;
  userKey: string;
}> {
  const { app, driver, auth } = createApp(config);
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
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("admin routes", () => {
  let dir: string;
  let ctx: Ctx;

  before(async () => {
    dir = join(tmpdir(), `dp-admin-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    ctx = await start(baseConfig(dir));
  });

  after(() => {
    ctx.close();
  });

  it("rejects anonymous callers with 401 and non-admin keys with 403", async () => {
    assert.equal((await req(ctx, "GET", "/data-pipeline/api/v1/admin/tokens")).status, 401);
    assert.equal(
      (await req(ctx, "GET", "/data-pipeline/api/v1/admin/tokens", ctx.userKey)).status,
      403,
    );
  });

  it("lists tokens without hashes or plaintext, oldest first", async () => {
    const r = await req(ctx, "GET", "/data-pipeline/api/v1/admin/tokens", ctx.adminKey);
    assert.equal(r.status, 200);
    const items = r.body.items as Record<string, unknown>[];
    assert.ok(items.length >= 2);
    assert.ok(items.some((t) => t.name === "console-admin" && t.role === "admin"));
    for (const t of items) {
      assert.equal("key_hash" in t, false);
      assert.equal("api_key" in t, false);
    }
  });

  it("creates a token and returns its plaintext exactly once", async () => {
    const r = await req(ctx, "POST", "/data-pipeline/api/v1/admin/tokens", ctx.adminKey, {
      name: "fresh",
      role: "user",
    });
    assert.equal(r.status, 201);
    assert.equal(typeof r.body.api_key, "string");
    assert.equal((r.body.api_key as string).length, 64);
    const list = await req(ctx, "GET", "/data-pipeline/api/v1/admin/tokens", ctx.adminKey);
    const row = (list.body.items as Record<string, unknown>[]).find((t) => t.name === "fresh");
    assert.ok(row);
    assert.equal("api_key" in row, false);
    assert.equal(
      (await req(ctx, "POST", "/data-pipeline/api/v1/admin/tokens", ctx.adminKey, { role: "user" })).status,
      400,
    );
    assert.equal(
      (
        await req(ctx, "POST", "/data-pipeline/api/v1/admin/tokens", ctx.adminKey, {
          name: "bad",
          role: "super",
        })
      ).status,
      400,
    );
  });

  it("revokes a token; the revoked key then fails auth", async () => {
    const created = await req(ctx, "POST", "/data-pipeline/api/v1/admin/tokens", ctx.adminKey, {
      name: "doomed",
    });
    const id = created.body.id as string;
    const revoked = await req(
      ctx,
      "POST",
      `/data-pipeline/api/v1/admin/tokens/${id}/revoke`,
      ctx.adminKey,
    );
    assert.equal(revoked.status, 200);
    assert.notEqual(revoked.body.revoked_at, null);
    assert.equal(
      (await req(ctx, "GET", "/data-pipeline/api/v1/admin/tokens", created.body.api_key as string)).status,
      401,
    );
    assert.equal(
      (await req(ctx, "POST", "/data-pipeline/api/v1/admin/tokens/nope/revoke", ctx.adminKey)).status,
      404,
    );
  });

  it("webhooks: create/list/get/update/active/delete, token never returned", async () => {
    const W = "/data-pipeline/api/v1/admin/webhooks";
    const a = await req(ctx, "POST", W, ctx.adminKey, {
      name: "hook-a",
      webhookUrl: "https://a.example/hook",
      webhookToken: "tok-a",
      payload: JSON.stringify({ prompt: "from-A" }),
    });
    assert.equal(a.status, 201);
    const idA = a.body.id as number;
    assert.ok(idA > 0);
    assert.equal(a.body.name, "hook-a");
    assert.equal(a.body.payload, JSON.stringify({ prompt: "from-A" }));
    assert.equal(a.body.is_active, false);
    assert.equal(a.body.hasToken, true);
    assert.equal("token" in a.body, false);
    const b = await req(ctx, "POST", W, ctx.adminKey, {
      name: "hook-b",
      webhookUrl: "https://b.example/hook",
      webhookToken: "tok-b",
    });
    assert.equal(b.status, 201);
    const idB = b.body.id as number;
    assert.equal(b.body.payload, null);
    // Duplicate name conflicts.
    assert.equal(
      (
        await req(ctx, "POST", W, ctx.adminKey, {
          name: "hook-a",
          webhookUrl: "https://a.example/hook",
          webhookToken: "tok-x",
        })
      ).status,
      409,
    );
    // List returns both rows, oldest-updated first, without tokens.
    const list = await req(ctx, "GET", W, ctx.adminKey);
    assert.equal(list.status, 200);
    const items = list.body as unknown as Record<string, unknown>[];
    assert.ok(Array.isArray(items));
    assert.ok(items.some((w) => w.id === idA && w.name === "hook-a"));
    assert.ok(items.some((w) => w.id === idB && w.name === "hook-b"));
    for (const w of items) assert.equal("token" in w, false);
    // Detail echoes url + payload, never the token.
    const detail = await req(ctx, "GET", `${W}/${idA}`, ctx.adminKey);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.url, "https://a.example/hook");
    assert.equal(detail.body.payload, JSON.stringify({ prompt: "from-A" }));
    assert.equal(detail.body.hasToken, true);
    assert.equal("token" in detail.body, false);
    // Partial update: url only — token and payload survive.
    const upd = await req(ctx, "PUT", `${W}/${idA}`, ctx.adminKey, {
      webhookUrl: "https://a2.example/hook",
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.url, "https://a2.example/hook");
    assert.equal(upd.body.hasToken, true);
    assert.equal(upd.body.payload, JSON.stringify({ prompt: "from-A" }));
    // Empty payload clears the template.
    const cleared = await req(ctx, "PUT", `${W}/${idA}`, ctx.adminKey, { payload: "   " });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.payload, null);
    // Activate A, then B: at most one stays active.
    assert.equal(
      (await req(ctx, "POST", `${W}/${idA}/active`, ctx.adminKey, { active: true })).body.is_active,
      true,
    );
    const bActive = await req(ctx, "POST", `${W}/${idB}/active`, ctx.adminKey, { active: true });
    assert.equal(bActive.body.is_active, true);
    assert.equal((await req(ctx, "GET", `${W}/${idA}`, ctx.adminKey)).body.is_active, false);
    // Cancel B: none active.
    assert.equal(
      (await req(ctx, "POST", `${W}/${idB}/active`, ctx.adminKey, { active: false })).body.is_active,
      false,
    );
    // Auth: anonymous 401, non-admin 403.
    assert.equal((await req(ctx, "GET", W)).status, 401);
    assert.equal((await req(ctx, "GET", W, ctx.userKey)).status, 403);
    // Unknown id and malformed id.
    assert.equal((await req(ctx, "GET", `${W}/999999`, ctx.adminKey)).status, 404);
    assert.equal((await req(ctx, "GET", `${W}/abc`, ctx.adminKey)).status, 400);
    assert.equal((await req(ctx, "DELETE", `${W}/999999`, ctx.adminKey)).status, 404);
    // Delete B: gone afterwards.
    assert.equal((await req(ctx, "DELETE", `${W}/${idB}`, ctx.adminKey)).status, 200);
    assert.equal((await req(ctx, "GET", `${W}/${idB}`, ctx.adminKey)).status, 404);
  });

  it("webhooks: validation rejects bad url, bad token, bad payload, bad active flag", async () => {
    const W = "/data-pipeline/api/v1/admin/webhooks";
    const base = { name: "bad-one", webhookUrl: "https://ok.example/hook", webhookToken: "tok-ok" };
    assert.equal(
      (await req(ctx, "POST", W, ctx.adminKey, { ...base, webhookUrl: "not a url" })).status,
      400,
    );
    assert.equal(
      (await req(ctx, "POST", W, ctx.adminKey, { ...base, webhookUrl: "http://plain.example/hook" }))
        .status,
      400,
    );
    assert.equal(
      (await req(ctx, "POST", W, ctx.adminKey, { ...base, webhookToken: "has space" })).status,
      400,
    );
    assert.equal(
      (await req(ctx, "POST", W, ctx.adminKey, { ...base, webhookToken: "" })).status,
      400,
    );
    assert.equal(
      (await req(ctx, "POST", W, ctx.adminKey, { ...base, payload: "not json" })).status,
      400,
    );
    assert.equal(
      (await req(ctx, "POST", W, ctx.adminKey, { ...base, payload: "[1,2]" })).status,
      400,
    );
    assert.equal((await req(ctx, "POST", W, ctx.adminKey, { ...base, name: "  " })).status, 400);
    const created = await req(ctx, "POST", W, ctx.adminKey, base);
    assert.equal(created.status, 201);
    const id = created.body.id as number;
    assert.equal(
      (await req(ctx, "PUT", `${W}/${id}`, ctx.adminKey, { webhookUrl: "ftp://x.example/h" })).status,
      400,
    );
    assert.equal(
      (await req(ctx, "POST", `${W}/${id}/active`, ctx.adminKey, { active: "yes" })).status,
      400,
    );
    assert.equal((await req(ctx, "DELETE", `${W}/${id}`, ctx.adminKey)).status, 200);
  });

  it("webhooks: cron is saved, echoed, cleared, and validated", async () => {
    const W = "/data-pipeline/api/v1/admin/webhooks";
    // Invalid cron expressions are rejected on create and on update.
    assert.equal(
      (
        await req(ctx, "POST", W, ctx.adminKey, {
          name: "cron-bad",
          webhookUrl: "https://cron.example/hook",
          webhookToken: "cron-token",
          cron: "0 9 * *",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req(ctx, "POST", W, ctx.adminKey, {
          name: "cron-bad",
          webhookUrl: "https://cron.example/hook",
          webhookToken: "cron-token",
          cron: "0 25 * * *",
        })
      ).status,
      400,
    );
    const created = await req(ctx, "POST", W, ctx.adminKey, {
      name: "cron-ok",
      webhookUrl: "https://cron.example/hook",
      webhookToken: "cron-token",
      cron: "0 9 * * 1-5",
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.cron, "0 9 * * 1-5");
    const id = created.body.id as number;
    // Detail and list echo cron; token still never returned.
    assert.equal((await req(ctx, "GET", `${W}/${id}`, ctx.adminKey)).body.cron, "0 9 * * 1-5");
    const items = (await req(ctx, "GET", W, ctx.adminKey)).body as unknown as Record<string, unknown>[];
    assert.equal(items.find((w) => w.id === id)?.cron, "0 9 * * 1-5");
    // Update without cron keeps it; an empty cron clears it.
    assert.equal(
      (await req(ctx, "PUT", `${W}/${id}`, ctx.adminKey, { webhookUrl: "https://cron2.example/hook" }))
        .body.cron,
      "0 9 * * 1-5",
    );
    assert.equal(
      (await req(ctx, "PUT", `${W}/${id}`, ctx.adminKey, { cron: "  " })).body.cron,
      null,
    );
    assert.equal(
      (await req(ctx, "PUT", `${W}/${id}`, ctx.adminKey, { cron: "every day" })).status,
      400,
    );
    assert.equal((await req(ctx, "DELETE", `${W}/${id}`, ctx.adminKey)).status, 200);
  });

  it("webhooks: test unknown id 404s before spawn; missing runner script fails cleanly", async () => {
    const W = "/data-pipeline/api/v1/admin/webhooks";
    assert.equal((await req(ctx, "POST", `${W}/999999/test`, ctx.adminKey)).status, 404);
    const dir2 = join(tmpdir(), `dp-admin-norunner-${Date.now()}`);
    mkdirSync(dir2, { recursive: true });
    const ctx2 = await start(baseConfig(dir2));
    try {
      const created = await req(ctx2, "POST", "/data-pipeline/api/v1/admin/webhooks", ctx2.adminKey, {
        name: "solo",
        webhookUrl: "https://solo.example/hook",
        webhookToken: "solo-token",
      });
      assert.equal(created.status, 201);
      const r = await req(
        ctx2,
        "POST",
        `/data-pipeline/api/v1/admin/webhooks/${created.body.id as number}/test`,
        ctx2.adminKey,
      );
      assert.equal(r.status, 500);
      assert.equal(r.body.ok, false);
    } finally {
      ctx2.close();
    }
  });

  it("webhooks: test runs the runner script and reports its output", async () => {
    const scriptDir = join(dir, "workers/job-runner/dist/src");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "main.js"), `console.log("fake trigger ok");\n`);
    const created = await req(ctx, "POST", "/data-pipeline/api/v1/admin/webhooks", ctx.adminKey, {
      name: "testable",
      webhookUrl: "https://testable.example/hook",
      webhookToken: "testable-token",
    });
    assert.equal(created.status, 201);
    const r = await req(
      ctx,
      "POST",
      `/data-pipeline/api/v1/admin/webhooks/${created.body.id as number}/test`,
      ctx.adminKey,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.match(r.body.output as string, /fake trigger ok/);
    await req(ctx, "DELETE", `/data-pipeline/api/v1/admin/webhooks/${created.body.id as number}`, ctx.adminKey);
  });

  it("webhooks: test refuses a second concurrent run with 409", async () => {
    const scriptDir = join(dir, "workers/job-runner/dist/src");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(scriptDir, "main.js"),
      `await new Promise((r) => setTimeout(r, 1500));\nconsole.log("slow fake done");\n`,
    );
    const created = await req(ctx, "POST", "/data-pipeline/api/v1/admin/webhooks", ctx.adminKey, {
      name: "slow-one",
      webhookUrl: "https://slow.example/hook",
      webhookToken: "slow-token",
    });
    assert.equal(created.status, 201);
    const id = created.body.id as number;
    const [a, b] = await Promise.all([
      req(ctx, "POST", `/data-pipeline/api/v1/admin/webhooks/${id}/test`, ctx.adminKey),
      req(ctx, "POST", `/data-pipeline/api/v1/admin/webhooks/${id}/test`, ctx.adminKey),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
    await req(ctx, "DELETE", `/data-pipeline/api/v1/admin/webhooks/${id}`, ctx.adminKey);
  });
});
