import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
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
    newsSiteUrl: "https://agent101.uk/news",
    newsDetailDir: join(dir, "news-detail"),
    newsDetailDbFile: join(dir, "news-detail.sqlite"),
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

const CHAT = "/data-pipeline/api/v1/admin/chat/messages";

describe("console chat routes", () => {
  let dir: string;
  let ctx: Ctx;

  before(async () => {
    dir = join(tmpdir(), `dp-chat-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    ctx = await start(baseConfig(dir));
  });

  after(() => {
    ctx.close();
  });

  it("rejects anonymous callers with 401 and non-admin keys with 403", async () => {
    assert.equal((await req(ctx, "GET", CHAT)).status, 401);
    assert.equal((await req(ctx, "GET", CHAT, ctx.userKey)).status, 403);
  });

  it("creates a human row as pending and validates content", async () => {
    assert.equal(
      (await req(ctx, "POST", CHAT, ctx.adminKey, { content: "  " })).status,
      400,
    );
    const r = await req(ctx, "POST", CHAT, ctx.adminKey, { content: "你好" });
    assert.equal(r.status, 201);
    assert.equal(r.body.source, "human");
    assert.equal(r.body.status, "pending");
    assert.equal(r.body.in_reply_to, null);
  });

  it("runs the full claim -> complete loop and lists in order", async () => {
    const first = await req(ctx, "POST", CHAT, ctx.adminKey, { content: "第一条" });
    const second = await req(ctx, "POST", CHAT, ctx.adminKey, { content: "第二条" });
    const firstId = first.body.id as number;
    const secondId = second.body.id as number;

    const pending = await req(ctx, "GET", `${CHAT}/pending`, ctx.adminKey);
    assert.equal(pending.status, 200);
    const pendingItems = pending.body.items as { id: number }[];
    const pendingIds = pendingItems.map((m) => m.id);
    assert.deepEqual(pendingIds, [...pendingIds].sort((a, b) => a - b));
    assert.ok(pendingIds.indexOf(firstId) !== -1);
    assert.ok(pendingIds.indexOf(firstId) < pendingIds.indexOf(secondId));

    const claim = await req(ctx, "POST", `${CHAT}/${firstId}/claim`, ctx.adminKey);
    assert.equal(claim.status, 200);
    assert.equal(claim.body.status, "processing");
    assert.equal((await req(ctx, "POST", `${CHAT}/${firstId}/claim`, ctx.adminKey)).status, 409);

    const done = await req(ctx, "POST", `${CHAT}/${firstId}/complete`, ctx.adminKey, {
      content: "这是回复",
    });
    assert.equal(done.status, 200);
    const human = done.body.human as Record<string, unknown>;
    const muse = done.body.muse as Record<string, unknown>;
    assert.equal(human.status, "done");
    assert.equal(muse.source, "muse");
    assert.equal(muse.status, "done");
    assert.equal(muse.in_reply_to, firstId);
    assert.equal((await req(ctx, "POST", `${CHAT}/${firstId}/complete`, ctx.adminKey, { content: "x" })).status, 409);

    const list = await req(ctx, "GET", CHAT, ctx.adminKey);
    const items = list.body.items as { id: number; source: string; status: string }[];
    const ids = items.map((m) => m.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
    const museRow = items.find((m) => m.source === "muse");
    assert.ok(museRow);
    assert.equal(museRow.status, "done");
  });

  it("fails a processing row; reset only revives processing rows", async () => {
    const created = await req(ctx, "POST", CHAT, ctx.adminKey, { content: "会失败的" });
    const id = created.body.id as number;
    assert.equal((await req(ctx, "POST", `${CHAT}/${id}/fail`, ctx.adminKey, { error: "x" })).status, 409);
    const claimed = await req(ctx, "POST", `${CHAT}/${id}/claim`, ctx.adminKey);
    assert.equal(claimed.status, 200);
    const failed = await req(ctx, "POST", `${CHAT}/${id}/fail`, ctx.adminKey, { error: "boom" });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.status, "failed");
    assert.equal(failed.body.error, "boom");
    // A failed row is terminal: reset refuses it.
    assert.equal((await req(ctx, "POST", `${CHAT}/${id}/reset`, ctx.adminKey)).status, 409);
    // A stuck processing row resets back to pending.
    const stuck = await req(ctx, "POST", CHAT, ctx.adminKey, { content: "卡住的" });
    const stuckId = stuck.body.id as number;
    await req(ctx, "POST", `${CHAT}/${stuckId}/claim`, ctx.adminKey);
    const reset = await req(ctx, "POST", `${CHAT}/${stuckId}/reset`, ctx.adminKey);
    assert.equal(reset.status, 200);
    assert.equal(reset.body.status, "pending");
    const pending = await req(ctx, "GET", `${CHAT}/pending`, ctx.adminKey);
    assert.ok((pending.body.items as { id: number }[]).some((m) => m.id === stuckId));
  });

  it("returns 404 for unknown ids", async () => {
    assert.equal((await req(ctx, "POST", `${CHAT}/999999/claim`, ctx.adminKey)).status, 404);
  });
});
