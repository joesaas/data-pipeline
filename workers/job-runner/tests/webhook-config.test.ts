import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { apiDbPath, loadActivePayloadFromDb, loadActiveWebhookFromDb, loadWebhookByIdFromDb } from "../src/webhook-config.js";

const WEBHOOKS_DDL =
  "CREATE TABLE webhooks (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, url TEXT NOT NULL, token TEXT NOT NULL, payload TEXT, is_active INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);";

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

  it("loadActiveWebhookFromDb: active row only, null on missing file/table/row/values", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-webhook-db-"));
    try {
      assert.equal(loadActiveWebhookFromDb(join(dir, "nope.db")), null);
      const noTable = join(dir, "empty.db");
      new DatabaseSync(noTable).close();
      assert.equal(loadActiveWebhookFromDb(noTable), null);
      const path = join(dir, "data.db");
      const db = new DatabaseSync(path);
      db.exec(WEBHOOKS_DDL);
      assert.equal(loadActiveWebhookFromDb(path), null);
      db.prepare(
        "INSERT INTO webhooks (name, url, token, payload, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "idle",
        "https://idle.example/hook",
        "idle-token",
        null,
        0,
        "2026-10-25T00:00:00.000Z",
        "2026-10-25T00:00:00.000Z",
      );
      // Inactive rows never count as scheduled.
      assert.equal(loadActiveWebhookFromDb(path), null);
      db.prepare(
        "INSERT INTO webhooks (name, url, token, payload, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "grok",
        "https://grok.example/hook",
        "grok-token",
        JSON.stringify({ prompt: "grok template" }),
        1,
        "2026-10-25T01:00:00.000Z",
        "2026-10-25T01:00:00.000Z",
      );
      assert.deepEqual(loadActiveWebhookFromDb(path), {
        id: 2,
        name: "grok",
        url: "https://grok.example/hook",
        token: "grok-token",
        payload: JSON.stringify({ prompt: "grok template" }),
        cron: null,
      });
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadWebhookByIdFromDb: one row by id, null otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-webhook-byid-"));
    try {
      const path = join(dir, "data.db");
      const db = new DatabaseSync(path);
      db.exec(WEBHOOKS_DDL);
      const res = db
        .prepare(
          "INSERT INTO webhooks (name, url, token, payload, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "solo",
          "https://solo.example/hook",
          "solo-token",
          null,
          0,
          "2026-10-25T00:00:00.000Z",
          "2026-10-25T00:00:00.000Z",
        );
      const id = Number(res.lastInsertRowid);
      db.close();
      assert.deepEqual(loadWebhookByIdFromDb(path, id), {
        id,
        name: "solo",
        url: "https://solo.example/hook",
        token: "solo-token",
        payload: null,
        cron: null,
      });
      assert.equal(loadWebhookByIdFromDb(path, id + 100), null);
      assert.equal(loadWebhookByIdFromDb(join(dir, "missing.db"), id), null);
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

  it("loadActiveWebhookFromDb: a read-only open sees rows written by another connection", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-webhook-wal-"));
    try {
      const path = join(dir, "data.db");
      const writer = new DatabaseSync(path);
      writer.exec("PRAGMA journal_mode = WAL;");
      writer.exec(WEBHOOKS_DDL);
      writer
        .prepare(
          "INSERT INTO webhooks (name, url, token, payload, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run(
          "wal",
          "https://wal.example/hook",
          "wal-token",
          null,
          1,
          "2026-10-25T00:00:00.000Z",
          "2026-10-25T00:00:00.000Z",
        );
      // Writer stays open (like the running API) while the reader opens.
      assert.deepEqual(loadActiveWebhookFromDb(path), {
        id: 1,
        name: "wal",
        url: "https://wal.example/hook",
        token: "wal-token",
        payload: null,
        cron: null,
      });
      writer.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
