import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

/** Read the cursor-trigger webhook row straight from the test app's sqlite file. */
function readWebhookRow(dir: string): { url: string; token: string } | null {
  const db = new DatabaseSync(join(dir, "data", "data.db"), { readOnly: true });
  try {
    const row = db
      .prepare("SELECT url, token FROM webhook_configs WHERE name = ?")
      .get("cursor-trigger") as { url: string; token: string } | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}

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

  it("cursor status reports presence only, and interval writes the state file", async () => {
    const saved = process.env.CURSOR_TRIGGER_INTERVAL_MINUTES;
    process.env.CURSOR_TRIGGER_INTERVAL_MINUTES = "25";
    delete process.env.CURSOR_WEBHOOK_URL;
    delete process.env.CURSOR_AUTOMATION_TOKEN;
    try {
      const s = await req(
        ctx,
        "GET",
        "/data-pipeline/api/v1/admin/jobs/cursor-trigger",
        ctx.adminKey,
      );
      assert.equal(s.status, 200);
      assert.equal(s.body.stateFilePresent, false);
      assert.equal(s.body.effectiveIntervalMinutes, 25);
      assert.equal(s.body.webhookConfigured, false);
      const put = await req(
        ctx,
        "PUT",
        "/data-pipeline/api/v1/admin/jobs/cursor-trigger/interval",
        ctx.adminKey,
        { intervalMinutes: 30 },
      );
      assert.equal(put.status, 200);
      assert.equal(put.body.intervalMinutes, 30);
      const statePath = join(dir, "workers/job-runner/data/cursor-trigger-state.json");
      assert.equal(existsSync(statePath), true);
      assert.equal(
        (JSON.parse(readFileSync(statePath, "utf8")) as { intervalMinutes: number }).intervalMinutes,
        30,
      );
      assert.equal(
        (
          await req(
            ctx,
            "PUT",
            "/data-pipeline/api/v1/admin/jobs/cursor-trigger/interval",
            ctx.adminKey,
            { intervalMinutes: 0 },
          )
        ).status,
        400,
      );
    } finally {
      if (saved === undefined) delete process.env.CURSOR_TRIGGER_INTERVAL_MINUTES;
      else process.env.CURSOR_TRIGGER_INTERVAL_MINUTES = saved;
    }
  });

  it("manual trigger runs the runner script and reports its output", async () => {
    const scriptDir = join(dir, "workers/job-runner/dist/src");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(join(scriptDir, "main.js"), `console.log("fake trigger ok");\n`);
    const r = await req(
      ctx,
      "POST",
      "/data-pipeline/api/v1/admin/jobs/cursor-trigger/trigger",
      ctx.adminKey,
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.match(r.body.output as string, /fake trigger ok/);
  });

  it("manual trigger refuses a second concurrent run with 409", async () => {
    const scriptDir = join(dir, "workers/job-runner/dist/src");
    mkdirSync(scriptDir, { recursive: true });
    writeFileSync(
      join(scriptDir, "main.js"),
      `await new Promise((r) => setTimeout(r, 1500));\nconsole.log("slow fake done");\n`,
    );
    const [a, b] = await Promise.all([
      req(ctx, "POST", "/data-pipeline/api/v1/admin/jobs/cursor-trigger/trigger", ctx.adminKey),
      req(ctx, "POST", "/data-pipeline/api/v1/admin/jobs/cursor-trigger/trigger", ctx.adminKey),
    ]);
    const statuses = [a.status, b.status].sort();
    assert.deepEqual(statuses, [200, 409]);
  });

  it("manual trigger fails cleanly when the runner script is missing", async () => {
    const dir2 = join(tmpdir(), `dp-admin-norunner-${Date.now()}`);
    mkdirSync(dir2, { recursive: true });
    const ctx2 = await start(baseConfig(dir2));
    try {
      const r = await req(
        ctx2,
        "POST",
        "/data-pipeline/api/v1/admin/jobs/cursor-trigger/trigger",
        ctx2.adminKey,
      );
      assert.equal(r.status, 500);
      assert.equal(r.body.ok, false);
    } finally {
      ctx2.close();
    }
  });

  it("webhook save writes the database row, leaves .env untouched, never echoes values", async () => {
    const envPath = join(dir, ".env");
    writeFileSync(
      envPath,
      "# keep me\nOTHER_KEEP=hello\nCURSOR_WEBHOOK_URL=https://old.example/hook\nCURSOR_AUTOMATION_TOKEN=old-token\n",
    );
    const r = await req(
      ctx,
      "PUT",
      "/data-pipeline/api/v1/admin/jobs/cursor-trigger/webhook",
      ctx.adminKey,
      { webhookUrl: "https://hooks.example/new", webhookToken: "new-token-123" },
    );
    assert.equal(r.status, 200);
    assert.equal(r.body.webhookConfigured, true);
    assert.equal(r.body.webhookSource, "db");
    assert.equal(JSON.stringify(r.body).includes("new-token-123"), false);
    // .env is no longer the store: it must be byte-identical afterwards.
    assert.equal(
      readFileSync(envPath, "utf8"),
      "# keep me\nOTHER_KEEP=hello\nCURSOR_WEBHOOK_URL=https://old.example/hook\nCURSOR_AUTOMATION_TOKEN=old-token\n",
    );
    const row = readWebhookRow(dir);
    assert.equal(row?.url, "https://hooks.example/new");
    assert.equal(row?.token, "new-token-123");
  });

  it("webhook save is partial and validates input", async () => {
    const partial = await req(
      ctx,
      "PUT",
      "/data-pipeline/api/v1/admin/jobs/cursor-trigger/webhook",
      ctx.adminKey,
      { webhookToken: "only-token" },
    );
    assert.equal(partial.status, 200);
    // URL kept from the previous test's row; token replaced.
    const row = readWebhookRow(dir);
    assert.equal(row?.url, "https://hooks.example/new");
    assert.equal(row?.token, "only-token");
    for (const bad of [
      {},
      { webhookUrl: "not a url" },
      { webhookUrl: "http://example.com/hook" },
      { webhookToken: "has\nnewline" },
    ]) {
      assert.equal(
        (
          await req(
            ctx,
            "PUT",
            "/data-pipeline/api/v1/admin/jobs/cursor-trigger/webhook",
            ctx.adminKey,
            bad,
          )
        ).status,
        400,
      );
    }
    assert.equal(
      (
        await req(ctx, "PUT", "/data-pipeline/api/v1/admin/jobs/cursor-trigger/webhook", undefined, {
          webhookToken: "x",
        })
      ).status,
      401,
    );
  });

  it("webhook payload: full-value save, GET echoes it without the token, empty clears", async () => {
    const put = (body: unknown) =>
      req(ctx, "PUT", "/data-pipeline/api/v1/admin/jobs/cursor-trigger/webhook", ctx.adminKey, body);
    const get = () =>
      req(ctx, "GET", "/data-pipeline/api/v1/admin/jobs/cursor-trigger/webhook", ctx.adminKey);
    const saved = await put({ payload: JSON.stringify({ prompt: "hello payload" }) });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.webhookPayloadSet, true);
    const echoed = await get();
    assert.equal(echoed.status, 200);
    assert.equal(echoed.body.payload, JSON.stringify({ prompt: "hello payload" }));
    assert.equal(echoed.body.url, "https://hooks.example/new");
    assert.equal("token" in echoed.body, false);
    // A save without the payload key keeps the stored template.
    await put({ webhookToken: "tok-keep" });
    assert.equal((await get()).body.payload, JSON.stringify({ prompt: "hello payload" }));
    // Invalid templates are rejected.
    for (const bad of [{ payload: "{bad" }, { payload: '["array"]' }, { payload: 123 }]) {
      assert.equal((await put(bad)).status, 400);
    }
    // Empty payload clears the template; status flips back.
    const cleared = await put({ payload: "" });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.webhookPayloadSet, false);
    const after = await get();
    assert.equal(after.body.payload, null);
  });

  it("webhook import copies .env into the database, delete falls back to .env then nothing", async () => {
    // Clear the row from the previous tests, then import from .env.
    const cleared = await req(
      ctx,
      "DELETE",
      "/data-pipeline/api/v1/admin/jobs/cursor-trigger/webhook",
      ctx.adminKey,
    );
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.webhookSource, "env");
    assert.equal(cleared.body.webhookInEnv, true);
    writeFileSync(
      join(dir, ".env"),
      "CURSOR_WEBHOOK_URL=https://import.example/hook\nCURSOR_AUTOMATION_TOKEN=import-token\n",
    );
    const imported = await req(
      ctx,
      "POST",
      "/data-pipeline/api/v1/admin/jobs/cursor-trigger/webhook/import",
      ctx.adminKey,
    );
    assert.equal(imported.status, 200);
    assert.equal(imported.body.webhookSource, "db");
    const row = readWebhookRow(dir);
    assert.equal(row?.url, "https://import.example/hook");
    assert.equal(row?.token, "import-token");
    // Delete again: back to .env fallback, then to nothing once .env is cleared.
    const deleted = await req(
      ctx,
      "DELETE",
      "/data-pipeline/api/v1/admin/jobs/cursor-trigger/webhook",
      ctx.adminKey,
    );
    assert.equal(deleted.body.webhookSource, "env");
    assert.equal(readWebhookRow(dir), null);
    writeFileSync(join(dir, ".env"), "OTHER_KEEP=hello\n");
    const status = await req(
      ctx,
      "GET",
      "/data-pipeline/api/v1/admin/jobs/cursor-trigger",
      ctx.adminKey,
    );
    assert.equal(status.body.webhookConfigured, false);
    assert.equal(status.body.webhookSource, null);
    assert.equal(status.body.webhookInEnv, false);
  });

  it("manual trigger scrubs stale inherited CURSOR_* so the child reloads .env", async () => {
    const scriptDir = join(dir, "workers/job-runner/dist/src");
    mkdirSync(scriptDir, { recursive: true });
    const dumpPath = join(dir, "trigger-env.json");
    writeFileSync(
      join(scriptDir, "main.js"),
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(dumpPath)}, JSON.stringify({ url: process.env.CURSOR_WEBHOOK_URL ?? null, token: process.env.CURSOR_AUTOMATION_TOKEN ?? null, interval: process.env.CURSOR_TRIGGER_INTERVAL_MINUTES ?? null }));\nconsole.log("dump done");\n`,
    );
    writeFileSync(
      join(dir, ".env"),
      "CURSOR_WEBHOOK_URL=https://file.example/hook\nCURSOR_AUTOMATION_TOKEN=file-token\nCURSOR_TRIGGER_INTERVAL_MINUTES=99\n",
    );
    const saved = {
      url: process.env.CURSOR_WEBHOOK_URL,
      token: process.env.CURSOR_AUTOMATION_TOKEN,
      interval: process.env.CURSOR_TRIGGER_INTERVAL_MINUTES,
    };
    process.env.CURSOR_WEBHOOK_URL = "stale-url";
    process.env.CURSOR_AUTOMATION_TOKEN = "stale-token";
    process.env.CURSOR_TRIGGER_INTERVAL_MINUTES = "7";
    try {
      const r = await req(
        ctx,
        "POST",
        "/data-pipeline/api/v1/admin/jobs/cursor-trigger/trigger",
        ctx.adminKey,
      );
      assert.equal(r.status, 200);
      const dump = JSON.parse(readFileSync(dumpPath, "utf8")) as Record<string, unknown>;
      assert.equal(dump.url, null);
      assert.equal(dump.token, null);
      assert.equal(dump.interval, null);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        const key = `CURSOR_${k === "url" ? "WEBHOOK_URL" : k === "token" ? "AUTOMATION_TOKEN" : "TRIGGER_INTERVAL_MINUTES"}`;
        if (v === undefined) delete process.env[key];
        else process.env[key] = v;
      }
    }
  });

  it("prompt save round-trips through status, clears on empty, and survives interval saves", async () => {
    const statePath = join(dir, "workers/job-runner/data/cursor-trigger-state.json");
    const put = await req(
      ctx,
      "PUT",
      "/data-pipeline/api/v1/admin/jobs/cursor-trigger/prompt",
      ctx.adminKey,
      { prompt: "  run the news brief\n" },
    );
    assert.equal(put.status, 200);
    assert.equal(put.body.prompt, "run the news brief");
    assert.equal(
      (JSON.parse(readFileSync(statePath, "utf8")) as { prompt: string }).prompt,
      "run the news brief",
    );
    // An interval save must not wipe the prompt (read-modify-write both ways).
    const interval = await req(
      ctx,
      "PUT",
      "/data-pipeline/api/v1/admin/jobs/cursor-trigger/interval",
      ctx.adminKey,
      { intervalMinutes: 45 },
    );
    assert.equal(interval.status, 200);
    assert.equal(interval.body.prompt, "run the news brief");
    const cleared = await req(
      ctx,
      "PUT",
      "/data-pipeline/api/v1/admin/jobs/cursor-trigger/prompt",
      ctx.adminKey,
      { prompt: "   " },
    );
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.prompt, null);
    assert.equal(
      (
        await req(
          ctx,
          "PUT",
          "/data-pipeline/api/v1/admin/jobs/cursor-trigger/prompt",
          ctx.adminKey,
          { prompt: 123 },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await req(ctx, "PUT", "/data-pipeline/api/v1/admin/jobs/cursor-trigger/prompt", undefined, {
          prompt: "x",
        })
      ).status,
      401,
    );
  });

  it("restart runs pm2 restart and reports failure", async () => {
    const okBin = join(dir, "bin-ok");
    const failBin = join(dir, "bin-fail");
    mkdirSync(okBin, { recursive: true });
    mkdirSync(failBin, { recursive: true });
    writeFileSync(join(okBin, "pm2"), `#!/usr/bin/env bash\necho "pm2 restart ok $@"\n`);
    writeFileSync(join(failBin, "pm2"), `#!/usr/bin/env bash\necho "pm2 boom" >&2\nexit 1\n`);
    chmodSync(join(okBin, "pm2"), 0o755);
    chmodSync(join(failBin, "pm2"), 0o755);
    const savedPath = process.env.PATH ?? "";
    try {
      process.env.PATH = `${okBin}:${savedPath}`;
      const ok = await req(
        ctx,
        "POST",
        "/data-pipeline/api/v1/admin/jobs/cursor-trigger/restart",
        ctx.adminKey,
      );
      assert.equal(ok.status, 200);
      assert.equal(ok.body.ok, true);
      assert.match(ok.body.output as string, /pm2 restart ok restart data-job-runner/);
      process.env.PATH = `${failBin}:${savedPath}`;
      const bad = await req(
        ctx,
        "POST",
        "/data-pipeline/api/v1/admin/jobs/cursor-trigger/restart",
        ctx.adminKey,
      );
      assert.equal(bad.status, 500);
      assert.equal(bad.body.ok, false);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
