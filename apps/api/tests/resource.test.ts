import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

function baseConfig(dir: string, resourceDir: string): AppConfig {
  return {
    port: 0,
    basePath: "/data-pipeline",
    dataDir: dir,
    storage: "sqlite",
    authRequired: false,
    maxContentBytes: 1_048_576,
    maxPromptBytes: 65_536,
    rateLimitPerMin: 60,
    cleanedDbFile: join(dir, "cleaned.sqlite"),
    newsSiteUrl: "https://agent101.uk/news",
    newsDetailDir: join(dir, "news-detail"),
    newsDetailDbFile: join(dir, "news-detail.sqlite"),
    resourceDir,
    resourceSiteUrl: "https://agent101.uk/resource",
    resourceMaxBytes: 1_048_576,
  };
}

describe("resource upload endpoints", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let resourceDir: string;
  let apiKey: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "resource-api-"));
    resourceDir = join(dir, "resource");
    const { app, auth } = createApp(baseConfig(dir, resourceDir));
    // Resource uploads require a valid key even when the global
    // AUTH_REQUIRED flag is off, so issue one for these tests.
    apiKey = auth.createToken("resource-test").plainKey;
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/data-pipeline`;
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function upload(body: Record<string, unknown>) {
    return fetch(`${base}/api/v1/resource/files`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify(body),
    });
  }

  it("uploads json under muse/test and returns the public resource url", async () => {
    const res = await upload({
      path: "muse/test",
      filename: "file.json",
      content: '{"hello":"world"}',
    });
    assert.equal(res.status, 201);
    const body = (await res.json()) as {
      status: string; path: string; url: string; size: number;
    };
    assert.equal(body.status, "created");
    assert.equal(body.path, "muse/test/file.json");
    assert.equal(body.url, "https://agent101.uk/resource/muse/test/file.json");
    assert.equal(
      readFileSync(join(resourceDir, "muse/test/file.json"), "utf8"),
      '{"hello":"world"}',
    );

    const again = await upload({
      path: "muse/test",
      filename: "file.json",
      content: '{"hello":"again"}',
    });
    assert.equal(again.status, 200, "re-upload overwrites and reports replaced");
    assert.equal(((await again.json()) as { status: string }).status, "replaced");
    assert.equal(
      readFileSync(join(resourceDir, "muse/test/file.json"), "utf8"),
      '{"hello":"again"}',
    );
  });

  it("uploads html and md as plain text", async () => {
    const html = await upload({
      path: "muse",
      filename: "page.html",
      content: "<!doctype html><html><body>hi</body></html>",
    });
    assert.equal(html.status, 201);
    assert.equal(
      readFileSync(join(resourceDir, "muse/page.html"), "utf8"),
      "<!doctype html><html><body>hi</body></html>",
    );

    const md = await upload({
      filename: "notes.md",
      content: "# Notes\nhello\n",
    });
    assert.equal(md.status, 201);
    assert.equal(((await md.json()) as { path: string }).path, "notes.md");
    assert.equal(readFileSync(join(resourceDir, "notes.md"), "utf8"), "# Notes\nhello\n");
  });

  it("uploads binary files only as base64", async () => {
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const ok = await upload({
      path: "muse",
      filename: "dot.png",
      content: pngBytes.toString("base64"),
      encoding: "base64",
    });
    assert.equal(ok.status, 201);
    assert.deepEqual(readFileSync(join(resourceDir, "muse/dot.png")), pngBytes);

    const raw = await upload({
      path: "muse",
      filename: "dot2.png",
      content: "not-base64-for-a-png",
    });
    assert.equal(raw.status, 400, "binary extensions must use base64");
  });

  it("rejects traversal, dotfiles, disallowed extensions and empty content", async () => {
    const escape = await upload({
      path: "../evil",
      filename: "file.json",
      content: "{}",
    });
    assert.equal(escape.status, 400);
    assert.equal(existsSync(join(dir, "evil/file.json")), false);

    const dotfile = await upload({
      filename: ".env",
      content: "x",
    });
    assert.equal(dotfile.status, 400);

    const script = await upload({
      filename: "run.sh",
      content: "echo hi",
    });
    assert.equal(script.status, 400, "sh is not in the allowlist");

    const empty = await upload({
      filename: "file.json",
      content: "",
    });
    assert.equal(empty.status, 400);
  });

  it("returns 401 without a key even when global auth is off", async () => {
    const res = await fetch(`${base}/api/v1/resource/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "file.json", content: "{}" }),
    });
    assert.equal(res.status, 401);
  });

  it("rejects files over the resource size limit", async () => {
    const big = await upload({
      filename: "big.json",
      content: "x".repeat(1_048_577),
    });
    assert.equal(big.status, 413);
  });
});

describe("resource upload endpoints with auth required", () => {
  it("returns 401 without a key", async () => {
    const dir = mkdtempSync(join(tmpdir(), "resource-auth-"));
    const config = { ...baseConfig(dir, join(dir, "resource")), authRequired: true };
    const { app, driver } = createApp(config);
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/data-pipeline`;
    const res = await fetch(`${base}/api/v1/resource/files`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: "file.json", content: "{}" }),
    });
    assert.equal(res.status, 401);
    server.close();
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
