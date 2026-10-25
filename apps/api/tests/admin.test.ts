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

  it("deletes only revoked tokens; records are untouched", async () => {
    const created = await req(ctx, "POST", "/data-pipeline/api/v1/admin/tokens", ctx.adminKey, {
      name: "trash",
    });
    const id = created.body.id as string;
    // Still active: 409, and the row stays.
    assert.equal(
      (await req(ctx, "DELETE", `/data-pipeline/api/v1/admin/tokens/${id}`, ctx.adminKey)).status,
      409,
    );
    const stillThere = await req(ctx, "GET", "/data-pipeline/api/v1/admin/tokens", ctx.adminKey);
    assert.ok((stillThere.body.items as Record<string, unknown>[]).some((t) => t.id === id));
    // Auth gates: anonymous 401, valid non-admin 403.
    assert.equal((await req(ctx, "DELETE", `/data-pipeline/api/v1/admin/tokens/${id}`)).status, 401);
    assert.equal(
      (await req(ctx, "DELETE", `/data-pipeline/api/v1/admin/tokens/${id}`, ctx.userKey)).status,
      403,
    );
    // Revoke, then delete: gone from the list, second delete 404.
    await req(ctx, "POST", `/data-pipeline/api/v1/admin/tokens/${id}/revoke`, ctx.adminKey);
    const deleted = await req(ctx, "DELETE", `/data-pipeline/api/v1/admin/tokens/${id}`, ctx.adminKey);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.ok, true);
    const gone = await req(ctx, "GET", "/data-pipeline/api/v1/admin/tokens", ctx.adminKey);
    assert.ok(!(gone.body.items as Record<string, unknown>[]).some((t) => t.id === id));
    assert.equal(
      (await req(ctx, "DELETE", `/data-pipeline/api/v1/admin/tokens/${id}`, ctx.adminKey)).status,
      404,
    );
    assert.equal(
      (await req(ctx, "DELETE", "/data-pipeline/api/v1/admin/tokens/nope", ctx.adminKey)).status,
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

  it("webhooks: validation rejects bad url, bad token, bad active flag; plain-text payload accepted", async () => {
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
    // Plain text payloads are accepted now (no JSON requirement): a bare
    // prompt saves as-is and is sent as text/plain by the trigger.
    const textSaved = await req(ctx, "POST", W, ctx.adminKey, {
      ...base,
      name: "text-one",
      payload: "do the thing",
    });
    assert.equal(textSaved.status, 201);
    assert.equal(textSaved.body.payload, "do the thing");
    const arraySaved = await req(ctx, "POST", W, ctx.adminKey, {
      ...base,
      name: "text-two",
      payload: "[1,2]",
    });
    assert.equal(arraySaved.status, 201);
    assert.equal(arraySaved.body.payload, "[1,2]");
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

  it("pull tasks: create/list/get/update/active, many may be active", async () => {
    const P = "/data-pipeline/api/v1/admin/pull-tasks";
    // Validation: prompt and cron are required, cron must parse, target must match.
    assert.equal(
      (await req(ctx, "POST", P, ctx.adminKey, { name: "t1", prompt: "do it" })).status,
      400,
    );
    assert.equal(
      (
        await req(ctx, "POST", P, ctx.adminKey, {
          name: "t1",
          prompt: "do it",
          cron: "0 9 * *",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req(ctx, "POST", P, ctx.adminKey, {
          name: "t1",
          prompt: "do it",
          cron: "0 9 * * *",
          target: "Bad Target!",
        })
      ).status,
      400,
    );
    const a = await req(ctx, "POST", P, ctx.adminKey, {
      name: "every-minute",
      prompt: "do it every minute",
      cron: "* * * * *",
    });
    assert.equal(a.status, 201);
    assert.equal(a.body.is_active, false);
    assert.equal(a.body.target, "muse");
    assert.equal(a.body.last_run_at, null);
    const idA = a.body.id as number;
    const b = await req(ctx, "POST", P, ctx.adminKey, {
      name: "also-every-minute",
      prompt: "do it too",
      cron: "* * * * *",
      target: "grok",
    });
    assert.equal(b.status, 201);
    assert.equal(b.body.target, "grok");
    const idB = b.body.id as number;
    assert.equal(
      (
        await req(ctx, "POST", P, ctx.adminKey, {
          name: "every-minute",
          prompt: "dup",
          cron: "* * * * *",
        })
      ).status,
      409,
    );
    // Activate both: unlike webhooks, both stay active.
    assert.equal(
      (await req(ctx, "POST", `${P}/${idA}/active`, ctx.adminKey, { active: true })).body.is_active,
      true,
    );
    assert.equal(
      (await req(ctx, "POST", `${P}/${idB}/active`, ctx.adminKey, { active: true })).body.is_active,
      true,
    );
    assert.equal((await req(ctx, "GET", `${P}/${idA}`, ctx.adminKey)).body.is_active, true);
    // Update prompt + cron + target; name is immutable (not in the update body).
    const upd = await req(ctx, "PUT", `${P}/${idB}`, ctx.adminKey, {
      prompt: "do it better",
      cron: "0 9 * * *",
      target: "muse",
    });
    assert.equal(upd.status, 200);
    assert.equal(upd.body.prompt, "do it better");
    assert.equal(upd.body.cron, "0 9 * * *");
    assert.equal(upd.body.target, "muse");
    assert.equal((await req(ctx, "PUT", `${P}/${idB}`, ctx.adminKey, { cron: "nope" })).status, 400);
    // Auth and unknown ids.
    assert.equal((await req(ctx, "GET", P)).status, 401);
    assert.equal((await req(ctx, "GET", P, ctx.userKey)).status, 403);
    assert.equal((await req(ctx, "GET", `${P}/999999`, ctx.adminKey)).status, 404);
    assert.equal((await req(ctx, "GET", `${P}/abc`, ctx.adminKey)).status, 400);
    assert.equal((await req(ctx, "DELETE", `${P}/${idA}`, ctx.adminKey)).status, 200);
    assert.equal((await req(ctx, "DELETE", `${P}/${idB}`, ctx.adminKey)).status, 200);
  });

  it("pending queue: run-now blocks on waiting, claim/complete/fail/reset transitions", async () => {
    const P = "/data-pipeline/api/v1/admin/pull-tasks";
    const created = await req(ctx, "POST", P, ctx.adminKey, {
      name: "queue-task",
      prompt: "queue prompt",
      cron: "0 9 * * *",
    });
    assert.equal(created.status, 201);
    const taskId = created.body.id as number;
    // Public detector: no waiting rows yet, and it needs no key.
    const pub0 = await req(ctx, "GET", "/data-pipeline/api/v1/pull-tasks/pending?target=muse");
    assert.equal(pub0.status, 200);
    assert.equal(pub0.body.waiting, 0);
    // Run now inserts a manual waiting row.
    const run1 = await req(ctx, "POST", `${P}/${taskId}/run-now`, ctx.adminKey, {});
    assert.equal(run1.status, 201);
    assert.equal(run1.body.status, "waiting");
    assert.equal(run1.body.kind, "manual");
    assert.equal(run1.body.prompt, "queue prompt");
    const pendingId = run1.body.id as number;
    // Second run-now while one waits is a 409.
    assert.equal((await req(ctx, "POST", `${P}/${taskId}/run-now`, ctx.adminKey, {})).status, 409);
    // Public detector now sees it, without the prompt.
    const pub1 = await req(ctx, "GET", "/data-pipeline/api/v1/pull-tasks/pending?target=muse");
    assert.equal(pub1.body.waiting, 1);
    const pubItems = pub1.body.items as unknown as Record<string, unknown>[];
    assert.equal(pubItems[0].id, pendingId);
    assert.equal("prompt" in pubItems[0], false);
    // Claim: waiting -> running; a second claim is a 409.
    const claimed = await req(ctx, "POST", `${P}/pending/${pendingId}/claim`, ctx.adminKey, {});
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.status, "running");
    assert.equal(claimed.body.prompt, "queue prompt");
    assert.equal((await req(ctx, "POST", `${P}/pending/${pendingId}/claim`, ctx.adminKey, {})).status, 409);
    // Complete requires external_id and only works from running.
    assert.equal(
      (await req(ctx, "POST", `${P}/pending/${pendingId}/complete`, ctx.adminKey, {})).status,
      400,
    );
    const done = await req(ctx, "POST", `${P}/pending/${pendingId}/complete`, ctx.adminKey, {
      external_id: "pull-1-manual",
      record_id: "rec-1",
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, "done");
    assert.equal(done.body.result_external_id, "pull-1-manual");
    assert.equal(done.body.result_record_id, "rec-1");
    // After done, run-now works again (no waiting row left).
    assert.equal((await req(ctx, "POST", `${P}/${taskId}/run-now`, ctx.adminKey, {})).status, 201);
    const pending2 = (await req(ctx, "GET", `${P}/pending?status=waiting`, ctx.adminKey)).body as unknown as Record<string, unknown>[];
    assert.equal(pending2.length, 1);
    const pendingId2 = pending2[0].id as number;
    // Fail from running: a failed row stays failed (no auto-retry) —
    // neither claim nor reset applies to it; a fresh run-now re-queues.
    await req(ctx, "POST", `${P}/pending/${pendingId2}/claim`, ctx.adminKey, {});
    const failed = await req(ctx, "POST", `${P}/pending/${pendingId2}/fail`, ctx.adminKey, {
      error: "boom",
    });
    assert.equal(failed.body.status, "failed");
    assert.equal(failed.body.error, "boom");
    assert.equal(
      (await req(ctx, "POST", `${P}/pending/${pendingId2}/claim`, ctx.adminKey, {})).status,
      409,
    );
    assert.equal(
      (await req(ctx, "POST", `${P}/pending/${pendingId2}/reset`, ctx.adminKey, {})).status,
      409,
    );
    // Stale-running recovery: claim a fresh row, then reset it to waiting.
    assert.equal((await req(ctx, "POST", `${P}/${taskId}/run-now`, ctx.adminKey, {})).status, 201);
    const waiting3 = (await req(ctx, "GET", `${P}/pending?status=waiting`, ctx.adminKey)).body as unknown as Record<string, unknown>[];
    assert.equal(waiting3.length, 1);
    const pendingId3 = waiting3[0].id as number;
    await req(ctx, "POST", `${P}/pending/${pendingId3}/claim`, ctx.adminKey, {});
    const reset = await req(ctx, "POST", `${P}/pending/${pendingId3}/reset`, ctx.adminKey, {});
    assert.equal(reset.body.status, "waiting");
    // Deleting the task cancels its waiting rows.
    const del = await req(ctx, "DELETE", `${P}/${taskId}`, ctx.adminKey);
    assert.equal(del.body.cancelled_waiting, 1);
    const pub2 = await req(ctx, "GET", "/data-pipeline/api/v1/pull-tasks/pending?target=muse");
    assert.equal(pub2.body.waiting, 0);
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
