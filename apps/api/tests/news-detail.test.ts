import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, before, describe, it } from "node:test";
import { createApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";

function seedCleanedDb(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE cleaned_records (
      source_record_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, cleaned_at TEXT NOT NULL,
      provider TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL, item_count INTEGER NOT NULL,
      source_agent TEXT NOT NULL DEFAULT '');
    CREATE TABLE cleaned_items (
      id TEXT PRIMARY KEY, source_record_id TEXT NOT NULL, idx INTEGER NOT NULL, title TEXT NOT NULL,
      summary TEXT NOT NULL, detail TEXT, category TEXT NOT NULL, tags TEXT NOT NULL,
      event_date TEXT, sources TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO cleaned_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("rec-1", "hash-1", "2026-10-22T12:00:00.000Z", "openai-compatible", "openai/gpt-4o-mini", "clean-v2", 1, "muse");
  db.prepare("INSERT INTO cleaned_records VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run("rec-2", "hash-2", "2026-10-23T12:00:00.000Z", "openai-compatible", "openai/gpt-4o-mini", "clean-v2", 1, "muse");
  const insert = db.prepare("INSERT INTO cleaned_items VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  insert.run("item-old", "rec-1", 0, "旧新闻", "旧摘要", null, "Web3 DeFi",
    JSON.stringify([]), "2026-10-21", JSON.stringify([{ name: "S", url: "https://example.com/s" }]));
  insert.run("item-new", "rec-2", 0, "新新闻", "新摘要", "新细节", "AI Agent",
    JSON.stringify([]), null, JSON.stringify([]));
  db.close();
}

describe("news-detail endpoints", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let newsDetailDir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "news-detail-api-"));
    const cleanedDbFile = join(dir, "cleaned.sqlite");
    seedCleanedDb(cleanedDbFile);
    newsDetailDir = join(dir, "news-detail");
    const config: AppConfig = {
      port: 0,
      basePath: "/data-pipeline",
      dataDir: dir,
      storage: "sqlite",
      authRequired: false,
      maxContentBytes: 1_048_576,
      maxPromptBytes: 65_536,
      rateLimitPerMin: 60,
      cleanedDbFile,
      newsSiteUrl: "https://agent101.uk/news",
      newsDetailDir,
      newsDetailDbFile: join(dir, "news-detail.sqlite"),
    };
    const { app } = createApp(config);
    server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/data-pipeline`;
  });

  after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists pending items oldest first, capped at 10, with the original url", async () => {
    const capped = (await (await fetch(`${base}/api/v1/news-detail/pending?limit=99`)).json()) as {
      items: { id: string; original_url: string; detail_status: string; detail_path: string | null }[];
      limit: number;
    };
    assert.equal(capped.limit, 10, "limit is capped at 10 even when the caller asks for more");
    assert.deepEqual(capped.items.map((i) => i.id), ["item-old", "item-new"]);
    assert.equal(capped.items[0].original_url, "https://agent101.uk/news/item/item-old/");
    assert.equal(capped.items[0].detail_status, "pending");
    assert.equal(capped.items[0].detail_path, null);

    const one = (await (await fetch(`${base}/api/v1/news-detail/pending?limit=1`)).json()) as {
      items: { id: string }[];
      limit: number;
    };
    assert.equal(one.limit, 1);
    assert.deepEqual(one.items.map((i) => i.id), ["item-old"]);
  });

  it("pushes one HTML file, records its relative path, and drops the item from pending", async () => {
    const html = "<!doctype html><html><body>detail</body></html>";
    const first = await fetch(`${base}/api/v1/news-detail/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: "item-old", html }),
    });
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as {
      item_id: string; detail_path: string; original_url: string; status: string;
    };
    assert.equal(firstBody.detail_path, "item-old.html");
    assert.equal(firstBody.original_url, "https://agent101.uk/news/item/item-old/");
    assert.equal(firstBody.status, "created");
    assert.equal(readFileSync(join(newsDetailDir, "item-old.html"), "utf8"), html);

    const pending = (await (await fetch(`${base}/api/v1/news-detail/pending`)).json()) as {
      items: { id: string }[];
    };
    assert.deepEqual(pending.items.map((i) => i.id), ["item-new"]);

    const got = await fetch(`${base}/api/v1/news-detail/pages/item-old`);
    assert.equal(got.status, 200);
    const gotBody = (await got.json()) as { status: string; detail_path: string };
    assert.equal(gotBody.status, "done");
    assert.equal(gotBody.detail_path, "item-old.html");

    const again = await fetch(`${base}/api/v1/news-detail/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: "item-old", html: "<!doctype html><html><body>v2</body></html>" }),
    });
    assert.equal(again.status, 200, "re-push overwrites and reports replaced");
    assert.equal(((await again.json()) as { status: string }).status, "replaced");
    assert.equal(readFileSync(join(newsDetailDir, "item-old.html"), "utf8"), "<!doctype html><html><body>v2</body></html>");
  });

  it("rejects unknown items, non-HTML bodies and escaping paths", async () => {
    const unknown = await fetch(`${base}/api/v1/news-detail/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: "nope", html: "<!doctype html><html></html>" }),
    });
    assert.equal(unknown.status, 404);

    const notHtml = await fetch(`${base}/api/v1/news-detail/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: "item-new", html: "just some text" }),
    });
    assert.equal(notHtml.status, 400);

    const escape = await fetch(`${base}/api/v1/news-detail/pages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_id: "item-new", html: "<!doctype html><html></html>", detail_path: "../evil.html" }),
    });
    assert.equal(escape.status, 400);
    assert.equal(existsSync(join(dir, "evil.html")), false);
  });

  it("lists done ids publicly for list-page link rewriting", async () => {
    const res = await fetch(`${base}/api/v1/news-detail/done`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { item_ids: string[]; count: number };
    assert.deepEqual(body.item_ids, ["item-old"], "only the pushed item is done");
    assert.equal(body.count, 1);
  });

  it("404s on a detail page that was never pushed", async () => {
    const res = await fetch(`${base}/api/v1/news-detail/pages/item-new`);
    assert.equal(res.status, 404);
  });
});

describe("news-detail endpoints without a cleaned database yet", () => {
  it("pending degrades to an empty list, not an error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "news-detail-none-"));
    const config: AppConfig = {
      port: 0,
      basePath: "/data-pipeline",
      dataDir: dir,
      storage: "sqlite",
      authRequired: false,
      maxContentBytes: 1_048_576,
      maxPromptBytes: 65_536,
      rateLimitPerMin: 60,
      cleanedDbFile: join(dir, "missing.sqlite"),
      newsSiteUrl: "https://agent101.uk/news",
      newsDetailDir: join(dir, "news-detail"),
      newsDetailDbFile: join(dir, "news-detail.sqlite"),
    };
    const { app, driver } = createApp(config);
    const server = app.listen(0);
    await new Promise<void>((r) => server.once("listening", r));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/data-pipeline`;
    const res = await fetch(`${base}/api/v1/news-detail/pending`);
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { items: unknown[] }).items, []);
    server.close();
    driver.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
