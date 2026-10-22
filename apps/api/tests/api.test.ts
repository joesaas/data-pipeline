import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

function baseConfig(dir: string, over: Partial<AppConfig> = {}): AppConfig {
  return {
    port: 0,
    basePath: "/data-pipeline",
    dataDir: dir,
    storage: "sqlite",
    authRequired: false,
    maxContentBytes: 1_048_576,
    maxPromptBytes: 65_536,
    rateLimitPerMin: 60,
    cleanedDbFile: join(dir, "no-cleaned.sqlite"),
    ...over,
  };
}

async function start(config: AppConfig): Promise<{ base: string; server: Server; close: () => void }> {
  const { app, driver } = createApp(config);
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
  };
}

async function post(base: string, path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe("api: auth off (default)", () => {
  let dir: string;
  let ctx: Awaited<ReturnType<typeof start>>;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "dp-api-"));
    ctx = await start(baseConfig(dir));
  });
  after(() => {
    ctx.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("root path returns service info and the endpoint index", async () => {
    const res = await fetch(`${ctx.base}/`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { name: string; endpoints: Record<string, string> };
    assert.equal(body.name, "data-pipeline");
    assert.equal(body.endpoints.push, "POST /data-pipeline/api/v1/records");
  });

  it("the whole API also answers under the project base path", async () => {
    const info = await fetch(`${ctx.base}/data-pipeline/`);
    assert.equal(info.status, 200);
    const pushed = await post(ctx.base, "/data-pipeline/api/v1/records", {
      prompt: "p",
      content: "via prefixed path",
      external_id: "prefixed-1",
    });
    assert.equal(pushed.status, 201);
    const health = await fetch(`${ctx.base}/data-pipeline/api/v1/health`);
    assert.equal(health.status, 200);
  });

  it("health is open", async () => {
    const res = await fetch(`${ctx.base}/api/v1/health`);
    assert.equal(res.status, 200);
  });

  it("push without any key works; dedupe and replace follow the design", async () => {
    const a = await post(ctx.base, "/api/v1/records", { prompt: "p", content: "# Title\nbody", external_id: "e1" });
    assert.equal(a.status, 201);
    assert.equal(a.body.status, "created");

    const b = await post(ctx.base, "/api/v1/records", { prompt: "p", content: "# Title\nbody", external_id: "e1" });
    assert.equal(b.body.status, "deduped");
    assert.equal(b.body.id, a.body.id);

    const c = await post(ctx.base, "/api/v1/records", { prompt: "p", content: "changed", external_id: "e1" });
    assert.equal(c.body.status, "replaced");
    assert.equal(c.body.id, a.body.id);

    const got = await fetch(`${ctx.base}/api/v1/records/${a.body.id}`);
    const rec = (await got.json()) as { content: string; title: string };
    assert.equal(rec.content, "changed");

    const del = await fetch(`${ctx.base}/api/v1/records/${a.body.id}`, { method: "DELETE" });
    assert.equal(del.status, 204);
    const gone = await fetch(`${ctx.base}/api/v1/records/${a.body.id}`);
    assert.equal(gone.status, 404);
  });

  it("validation errors name the field", async () => {
    const bad = await post(ctx.base, "/api/v1/records", { content: "x" });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.field, "prompt");
  });
});

describe("api: auth on", () => {
  let dir: string;
  let ctx: Awaited<ReturnType<typeof start>>;
  let key: string;
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "dp-api-auth-"));
    const probe = createApp(baseConfig(dir, { authRequired: true }));
    key = probe.auth.createToken("tester").plainKey;
    probe.driver.close();
    ctx = await start(baseConfig(dir, { authRequired: true }));
  });
  after(() => {
    ctx.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects missing and wrong keys, accepts the issued key", async () => {
    const noKey = await post(ctx.base, "/api/v1/records", { prompt: "p", content: "c" });
    assert.equal(noKey.status, 401);
    const wrong = await post(ctx.base, "/api/v1/records", { prompt: "p", content: "c" }, { "x-api-key": "nope" });
    assert.equal(wrong.status, 401);
    const ok = await post(ctx.base, "/api/v1/records", { prompt: "p", content: "c" }, { "x-api-key": key });
    assert.equal(ok.status, 201);
  });
});
