import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { apiDbPath, loadActivePayloadFromDb, loadActiveWebhookFromDb, loadWebhookConfigByName, loadWebhookConfigFromDb } from "../src/webhook-config.js";

describe("webhook-config", () => {
  it("apiDbPath: absolute DATA_DIR wins, relative resolves against the .env dir, else cwd", () => {
    const saved = process.env.DATA_DIR;
    try {
      process.env.DATA_DIR = "/abs/data";
      assert.equal(apiDbPath("/repo/.env"), join("/abs/data", "data.db"));
      process.env.DATA_DIR = "./data";
      assert.equal(apiDbPath("/repo/.env"), join("/repo", "data", "data.db"));
      delete process.env.DATA_DIR;
      assert.equal(apiDbPath(null), join(process.cwd(), "data", "data.db"));
    } finally {
      if (saved === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = saved;
    }
  });

  it("loadWebhookConfigFromDb: reads the row, null on missing file/table/row", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-webhook-db-"));
    try {
      assert.equal(loadWebhookConfigFromDb(join(dir, "nope.db")), null);
      const noTable = join(dir, "empty.db");
      new DatabaseSync(noTable).close();
      assert.equal(loadWebhookConfigFromDb(noTable), null);
      const path = join(dir, "data.db");
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE webhook_configs (name TEXT PRIMARY KEY, url TEXT NOT NULL, token TEXT NOT NULL, payload TEXT, updated_at TEXT NOT NULL);",
      );
      assert.equal(loadWebhookConfigFromDb(path), null);
      db.prepare("INSERT INTO webhook_configs VALUES (?, ?, ?, ?, ?)").run(
        "cursor-trigger",
        "https://db.example/hook",
        "db-token",
        JSON.stringify({ prompt: "db prompt" }),
        "2026-10-25T00:00:00.000Z",
      );
      db.prepare("INSERT INTO webhook_configs VALUES (?, ?, ?, ?, ?)").run(
        "other",
        "https://other.example/hook",
        "other-token",
        null,
        "2026-10-25T00:00:00.000Z",
      );
      db.close();
      assert.deepEqual(loadWebhookConfigFromDb(path), {
        url: "https://db.example/hook",
        token: "db-token",
        payload: JSON.stringify({ prompt: "db prompt" }),
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadActivePayloadFromDb: newest-updated active row, null otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-active-payload-"));
    try {
      const path = join(dir, "data.db");
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE webhook_payloads (id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);",
      );
      assert.equal(loadActivePayloadFromDb(path), null);
      db.prepare("INSERT INTO webhook_payloads VALUES (?, ?, ?, ?, ?, ?)").run(
        "old",
        "old",
        JSON.stringify({ prompt: "old active" }),
        1,
        "2026-10-25T00:00:00.000Z",
        "2026-10-25T00:00:00.000Z",
      );
      db.prepare("INSERT INTO webhook_payloads VALUES (?, ?, ?, ?, ?, ?)").run(
        "new",
        "new",
        JSON.stringify({ prompt: "new active" }),
        1,
        "2026-10-25T01:00:00.000Z",
        "2026-10-25T01:00:00.000Z",
      );
      db.prepare("INSERT INTO webhook_payloads VALUES (?, ?, ?, ?, ?, ?)").run(
        "idle",
        "idle",
        JSON.stringify({ prompt: "inactive" }),
        0,
        "2026-10-25T02:00:00.000Z",
        "2026-10-25T02:00:00.000Z",
      );
      db.close();
      assert.equal(
        loadActivePayloadFromDb(path),
        JSON.stringify({ prompt: "new active" }),
      );
      assert.equal(loadActivePayloadFromDb(join(dir, "missing.db")), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadWebhookConfigFromDb: a read-only open sees rows written by another connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-webhook-wal-"));
    try {
      const path = join(dir, "data.db");
      const writer = new DatabaseSync(path);
      writer.exec("PRAGMA journal_mode = WAL;");
      writer.exec(
        "CREATE TABLE webhook_configs (name TEXT PRIMARY KEY, url TEXT NOT NULL, token TEXT NOT NULL, payload TEXT, updated_at TEXT NOT NULL);",
      );
      writer.prepare("INSERT INTO webhook_configs VALUES (?, ?, ?, ?, ?)").run(
        "cursor-trigger",
        "https://wal.example/hook",
        "wal-token",
        null,
        "2026-10-25T00:00:00.000Z",
      );
      // Writer stays open (like the running API) while the reader opens.
      assert.deepEqual(loadWebhookConfigFromDb(path), {
        url: "https://wal.example/hook",
        token: "wal-token",
        payload: null,
      });
      writer.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scheduled load prefers the active row over the legacy cursor-trigger row", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-webhook-active-"));
    try {
      const path = join(dir, "data.db");
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE webhook_configs (name TEXT PRIMARY KEY, url TEXT NOT NULL, token TEXT NOT NULL, payload TEXT, is_active INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);",
      );
      db.prepare("INSERT INTO webhook_configs VALUES (?, ?, ?, ?, ?, ?)").run(
        "cursor-trigger",
        "https://legacy.example/hook",
        "legacy-token",
        null,
        0,
        "2026-10-25T00:00:00.000Z",
      );
      db.prepare("INSERT INTO webhook_configs VALUES (?, ?, ?, ?, ?, ?)").run(
        "grok",
        "https://grok.example/hook",
        "grok-token",
        JSON.stringify({ prompt: "grok template" }),
        1,
        "2026-10-25T01:00:00.000Z",
      );
      db.close();
      assert.deepEqual(loadWebhookConfigFromDb(path), {
        url: "https://grok.example/hook",
        token: "grok-token",
        payload: JSON.stringify({ prompt: "grok template" }),
      });
      assert.deepEqual(loadActiveWebhookFromDb(path), {
        url: "https://grok.example/hook",
        token: "grok-token",
        payload: JSON.stringify({ prompt: "grok template" }),
      });
      assert.deepEqual(loadWebhookConfigByName(path, "cursor-trigger"), {
        url: "https://legacy.example/hook",
        token: "legacy-token",
        payload: null,
      });
      assert.equal(loadWebhookConfigByName(path, "nope"), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("scheduled load falls back to the legacy row when nothing is active", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-webhook-nactive-"));
    try {
      const path = join(dir, "data.db");
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE webhook_configs (name TEXT PRIMARY KEY, url TEXT NOT NULL, token TEXT NOT NULL, payload TEXT, is_active INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL);",
      );
      db.prepare("INSERT INTO webhook_configs VALUES (?, ?, ?, ?, ?, ?)").run(
        "cursor-trigger",
        "https://legacy.example/hook",
        "legacy-token",
        null,
        0,
        "2026-10-25T00:00:00.000Z",
      );
      db.close();
      assert.equal(loadActiveWebhookFromDb(path), null);
      assert.deepEqual(loadWebhookConfigFromDb(path), {
        url: "https://legacy.example/hook",
        token: "legacy-token",
        payload: null,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
