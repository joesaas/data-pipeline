import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { Wallet } from "ethers";
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

async function start(config: AppConfig) {
  const { app, driver } = createApp(config);
  const server: Server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => {
      server.close();
      driver.close();
    },
  };
}

type Ctx = Awaited<ReturnType<typeof start>>;

async function req(
  ctx: Ctx,
  method: string,
  path: string,
  session?: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${ctx.base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(session ? { authorization: `Bearer ${session}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function login(
  ctx: Ctx,
  wallet: { address: string; signMessage(message: string): Promise<string> },
): Promise<string> {
  const address = wallet.address.toLowerCase();
  const nonce = await req(ctx, "POST", "/data-pipeline/api/v1/site-auth/nonce", undefined, { address });
  assert.equal(nonce.status, 200);
  const signature = await wallet.signMessage(nonce.body.message as string);
  const verified = await req(ctx, "POST", "/data-pipeline/api/v1/site-auth/verify", undefined, {
    address,
    signature,
  });
  assert.equal(verified.status, 200);
  assert.equal(verified.body.address, address);
  return verified.body.session_token as string;
}

describe("site wallet login + favorites", () => {
  let ctx: Ctx;

  before(async () => {
    const dir = join(tmpdir(), `dp-site-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    ctx = await start(baseConfig(dir));
  });

  after(() => ctx.close());

  it("nonce -> signature -> session; favorites are per-address and need a session", async () => {
    const wallet = Wallet.createRandom();
    const address = wallet.address.toLowerCase();

    // Favorites without a session: 401.
    assert.equal((await req(ctx, "GET", "/data-pipeline/api/v1/site-favorites")).status, 401);
    assert.equal(
      (await req(ctx, "POST", "/data-pipeline/api/v1/site-favorites", undefined, { item_id: "x" }))
        .status,
      401,
    );

    // Bad address: 400, not a nonce.
    assert.equal(
      (
        await req(ctx, "POST", "/data-pipeline/api/v1/site-auth/nonce", undefined, {
          address: "not-an-address",
        })
      ).status,
      400,
    );

    const session = await login(ctx, wallet);
    const me = await req(ctx, "GET", "/data-pipeline/api/v1/site-auth/me", session);
    assert.equal(me.status, 200);
    assert.equal(me.body.address, address);

    // Add, list, ids, delete, then 404 on a second delete.
    assert.equal(
      (await req(ctx, "POST", "/data-pipeline/api/v1/site-favorites", session, { item_id: "item-1" }))
        .status,
      201,
    );
    // Idempotent re-add: still one row.
    await req(ctx, "POST", "/data-pipeline/api/v1/site-favorites", session, { item_id: "item-1" });
    const list = await req(ctx, "GET", "/data-pipeline/api/v1/site-favorites", session);
    assert.equal((list.body.items as unknown[]).length, 1);
    const ids = await req(ctx, "GET", "/data-pipeline/api/v1/site-favorites/ids", session);
    assert.deepEqual(ids.body.ids, ["item-1"]);
    assert.equal(
      (await req(ctx, "DELETE", "/data-pipeline/api/v1/site-favorites/item-1", session)).status,
      200,
    );
    assert.equal(
      (await req(ctx, "DELETE", "/data-pipeline/api/v1/site-favorites/item-1", session)).status,
      404,
    );

    // Another wallet sees an empty list: favorites never leak across addresses.
    const other = await login(ctx, Wallet.createRandom());
    const otherList = await req(ctx, "GET", "/data-pipeline/api/v1/site-favorites", other);
    assert.deepEqual(otherList.body.items, []);

    // Logout invalidates the session.
    assert.equal((await req(ctx, "POST", "/data-pipeline/api/v1/site-auth/logout", session)).status, 200);
    assert.equal((await req(ctx, "GET", "/data-pipeline/api/v1/site-auth/me", session)).status, 401);
  });

  it("a nonce is single-use and a signature for another address fails", async () => {
    const wallet = Wallet.createRandom();
    const address = wallet.address.toLowerCase();
    const nonce = await req(ctx, "POST", "/data-pipeline/api/v1/site-auth/nonce", undefined, { address });
    const signature = await wallet.signMessage(nonce.body.message as string);
    // Wrong address for this signature: 401.
    assert.equal(
      (
        await req(ctx, "POST", "/data-pipeline/api/v1/site-auth/verify", undefined, {
          address: Wallet.createRandom().address.toLowerCase(),
          signature,
        })
      ).status,
      401,
    );
    // Correct verify consumes the nonce; replaying it fails.
    assert.equal(
      (
        await req(ctx, "POST", "/data-pipeline/api/v1/site-auth/verify", undefined, {
          address,
          signature,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await req(ctx, "POST", "/data-pipeline/api/v1/site-auth/verify", undefined, {
          address,
          signature,
        })
      ).status,
      401,
    );
  });
});
