import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { IngestService } from "../src/ingest/ingest-service.js";
import { ADMIN_IDENTITY } from "../src/domain/types.js";
import { FileDriver } from "../src/storage/file-driver.js";
import { PgDriver } from "../src/storage/pg-driver.js";
import { SqliteDriver } from "../src/storage/sqlite-driver.js";
import type { StorageDriver } from "../src/storage/storage-driver.js";

/**
 * The same contract runs against both storage implementations: identical
 * behavior is what makes them interchangeable (design doc §4, LSP).
 */
function contract(name: string, make: (dir: string) => StorageDriver) {
  describe(`storage contract: ${name}`, () => {
    let dir: string;
    let driver: StorageDriver;
    let ingest: IngestService;

    before(() => {
      dir = mkdtempSync(join(tmpdir(), "dp-contract-"));
      driver = make(dir);
      ingest = new IngestService(driver, { maxContentBytes: 1_048_576, maxPromptBytes: 65_536 });
    });
    after(async () => {
      await driver.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("creates, then dedupes identical content under an external_id", async () => {
      const a = await ingest.push("anonymous", { prompt: "p1", content: "hello", external_id: "e1" });
      assert.equal(a.status, "created");
      const b = await ingest.push("anonymous", { prompt: "p1", content: "hello", external_id: "e1" });
      assert.equal(b.status, "deduped");
      assert.equal(b.id, a.id);
    });

    it("replaces changed content under the same external_id, keeping id and created_at", async () => {
      const a = await ingest.push("anonymous", { prompt: "p2", content: "v1", external_id: "e2" });
      const b = await ingest.push("anonymous", { prompt: "p2", content: "v2", external_id: "e2" });
      assert.equal(b.status, "replaced");
      assert.equal(b.id, a.id);
      assert.equal(b.created_at, a.created_at);
      assert.equal((await driver.getRecord("anonymous", a.id))?.content, "v2");
    });

    it("dedupes by content hash when no external_id is given", async () => {
      const a = await ingest.push("anonymous", { prompt: "p3", content: "same body" });
      const b = await ingest.push("anonymous", { prompt: "p3 again", content: "same body" });
      assert.equal(b.status, "deduped");
      assert.equal(b.id, a.id);
    });

    it("keeps identities isolated", async () => {
      const a = await ingest.push("token-a", { prompt: "p", content: "secret", external_id: "x" });
      assert.equal(await driver.getRecord("token-b", a.id), null);
      assert.equal((await driver.listRecords("token-b", { limit: 10, offset: 0 })).total, 0);
    });

    it("lets the admin identity read across identities, without merging buckets", async () => {
      const a = await ingest.push("token-a", { prompt: "p", content: "admin-visible", external_id: "adm1" });
      assert.equal((await driver.getRecord(ADMIN_IDENTITY, a.id))?.content, "admin-visible");
      assert.equal((await driver.findRecordByExternalId(ADMIN_IDENTITY, "adm1"))?.id, a.id);
      assert.ok((await driver.listRecords(ADMIN_IDENTITY, { limit: 100, offset: 0 })).total >= 1);
      // Isolation still holds for non-admin identities.
      assert.equal(await driver.getRecord("token-b", a.id), null);
    });

    it("lists with filters and deletes", async () => {
      await ingest.push("anonymous", { prompt: "p", content: "tagged", tags: ["news"], source_agent: "muse" });
      const byTag = await driver.listRecords("anonymous", { tag: "news", limit: 10, offset: 0 });
      assert.equal(byTag.total, 1);
      const id = byTag.items[0].id;
      assert.equal(await driver.deleteRecord("anonymous", id), true);
      assert.equal(await driver.getRecord("anonymous", id), null);
      assert.equal(await driver.deleteRecord("anonymous", id), false);
    });

    it("lists ascending by (updated_at, id) with a keyset cursor", async () => {
      for (const c of ["k1 body", "k2 body", "k3 body"]) {
        await ingest.push("anonymous", { prompt: "pk", content: c, external_id: `k-${c}`, tags: ["keyset"] });
      }
      const page1 = await driver.listRecords("anonymous", { tag: "keyset", limit: 2, offset: 0, order: "updated_asc" });
      assert.equal(page1.items.length, 2);
      const sorted = [...page1.items].sort(
        (a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id),
      );
      assert.deepEqual(page1.items.map((r) => r.id), sorted.map((r) => r.id));
      const last = page1.items[page1.items.length - 1];
      const page2 = await driver.listRecords("anonymous", {
        tag: "keyset",
        limit: 10,
        offset: 0,
        order: "updated_asc",
        updated_after: last.updated_at,
        after_id: last.id,
      });
      assert.equal(page2.items.length, 1);
      assert.notEqual(page2.items[0].id, last.id);
    });

    it("stores tokens and finds them by hash", async () => {
      await driver.createToken({ id: "t1", name: "n", key_hash: "h1", created_at: new Date().toISOString(), revoked_at: null });
      assert.equal((await driver.findTokenByHash("h1"))?.id, "t1");
      assert.equal(await driver.revokeToken("t1"), true);
      assert.notEqual((await driver.findTokenByHash("h1"))?.revoked_at, null);
      assert.equal(await driver.deleteToken("t1"), true);
      assert.equal(await driver.findTokenByHash("h1"), null);
      assert.ok(!(await driver.listTokens()).some((t) => t.id === "t1"));
      assert.equal(await driver.deleteToken("t1"), false);
    });

    it("stores site nonces, sessions and favorites", async () => {
      await driver.saveSiteNonce({ address: "0xabc", nonce: "n1", message: "m1", expires_at: "2030-01-01T00:00:00.000Z" });
      assert.equal((await driver.getSiteNonce("0xabc"))?.nonce, "n1");
      await driver.saveSiteNonce({ address: "0xabc", nonce: "n2", message: "m2", expires_at: "2030-01-01T00:00:00.000Z" });
      assert.equal((await driver.getSiteNonce("0xabc"))?.nonce, "n2");
      await driver.deleteSiteNonce("0xabc");
      assert.equal(await driver.getSiteNonce("0xabc"), null);

      await driver.saveSiteSession({ token_hash: "h1", address: "0xabc", created_at: "2026-01-01T00:00:00.000Z", expires_at: "2030-01-01T00:00:00.000Z" });
      assert.equal((await driver.findSiteSessionByHash("h1"))?.address, "0xabc");
      await driver.deleteSiteSession("h1");
      assert.equal(await driver.findSiteSessionByHash("h1"), null);

      await driver.saveSiteFavorite({ address: "0xabc", item_id: "i1", created_at: "2026-01-01T00:00:00.000Z" });
      await driver.saveSiteFavorite({ address: "0xabc", item_id: "i1", created_at: "2026-01-02T00:00:00.000Z" });
      assert.deepEqual((await driver.listSiteFavorites("0xabc")).map((f) => f.item_id), ["i1"]);
      assert.deepEqual(await driver.listSiteFavorites("0xdef"), []);
      assert.equal(await driver.deleteSiteFavorite("0xabc", "i1"), true);
      assert.equal(await driver.deleteSiteFavorite("0xabc", "i1"), false);
    });

    it("lists tokens oldest first", async () => {
      await driver.createToken({ id: "t-old", name: "old", key_hash: "ho", created_at: "2026-01-01T00:00:00.000Z", revoked_at: null });
      await driver.createToken({ id: "t-new", name: "new", key_hash: "hn", created_at: "2026-01-02T00:00:00.000Z", revoked_at: null });
      const names = (await driver.listTokens()).map((t) => t.name);
      assert.ok(names.indexOf("old") < names.indexOf("new"));
    });

    it("rejects invalid payloads with field info", async () => {
      await assert.rejects(ingest.push("anonymous", { content: "x" }), /prompt is required/);
      await assert.rejects(ingest.push("anonymous", { prompt: "x", content: "" }), /content is required/);
    });

    it("webhooks: save assigns ids and upserts, get returns the token, list hides it, delete removes", async () => {
      const created = await driver.saveWebhook({
        id: 0,
        name: "hook-a",
        url: "https://hooks.example/hook",
        token: "tok-1",
        payload: null,
        cron: null,
        is_active: false,
        created_at: "2026-10-25T00:00:00.000Z",
        updated_at: "2026-10-25T00:00:00.000Z",
      });
      assert.ok(created.id > 0);
      assert.equal((await driver.getWebhook(created.id))?.token, "tok-1");
      assert.equal((await driver.getWebhook(created.id))?.payload, null);
      assert.equal((await driver.getWebhook(created.id))?.cron, null);
      assert.equal((await driver.getWebhook(created.id))?.is_active, false);
      await driver.saveWebhook({
        ...created,
        url: "https://hooks.example/hook2",
        token: "tok-2",
        payload: JSON.stringify({ prompt: "do it" }),
        cron: "0 9 * * 1-5",
        is_active: true,
        updated_at: "2026-10-25T01:00:00.000Z",
      });
      const row = await driver.getWebhook(created.id);
      assert.equal(row?.url, "https://hooks.example/hook2");
      assert.equal(row?.token, "tok-2");
      assert.equal(row?.payload, JSON.stringify({ prompt: "do it" }));
      assert.equal(row?.cron, "0 9 * * 1-5");
      assert.equal(row?.is_active, true);
      assert.equal(row?.created_at, "2026-10-25T00:00:00.000Z");
      const listed = await driver.listWebhooks();
      assert.equal(listed.length, 1);
      assert.equal(listed[0].id, created.id);
      assert.equal(listed[0].name, "hook-a");
      assert.equal(listed[0].url, "https://hooks.example/hook2");
      assert.equal(listed[0].payload, JSON.stringify({ prompt: "do it" }));
      assert.equal(listed[0].cron, "0 9 * * 1-5");
      assert.equal(listed[0].is_active, true);
      assert.equal(listed[0].hasToken, true);
      assert.equal("token" in listed[0], false);
      assert.equal(await driver.deleteWebhook(created.id), true);
      assert.equal(await driver.deleteWebhook(created.id), false);
      assert.equal(await driver.getWebhook(created.id), null);
    });

    it("trigger history: append assigns ids, list newest first, filter by webhook, limit", async () => {
      const ok = await driver.appendTriggerHistory({
        webhook_id: 1,
        webhook_name: "grok-bot",
        kind: "scheduled",
        triggered_at: "2026-10-25T01:00:00.000Z",
        http_status: 200,
        ok: true,
        body_kind: "payload(single)",
        body: JSON.stringify({ prompt: "do it" }),
        body_truncated: false,
        error: null,
        duration_ms: 120,
      });
      assert.ok(ok.id > 0);
      const failed = await driver.appendTriggerHistory({
        webhook_id: 2,
        webhook_name: "other-bot",
        kind: "test",
        triggered_at: "2026-10-25T02:00:00.000Z",
        http_status: null,
        ok: false,
        body_kind: "ping",
        body: JSON.stringify({ source: "data-pipeline/cursor-trigger" }),
        body_truncated: false,
        error: "fetch failed",
        duration_ms: 5000,
      });
      const all = await driver.listTriggerHistory({ limit: 50 });
      assert.equal(all.total, 2);
      assert.equal(all.items.length, 2);
      assert.equal(all.items[0].id, failed.id);
      assert.equal(all.items[0].ok, false);
      assert.equal(all.items[0].http_status, null);
      assert.equal(all.items[0].body, JSON.stringify({ source: "data-pipeline/cursor-trigger" }));
      assert.equal(all.items[0].body_truncated, false);
      assert.equal(all.items[1].id, ok.id);
      assert.equal(all.items[1].body, JSON.stringify({ prompt: "do it" }));
      const scoped = await driver.listTriggerHistory({ webhook_id: 1, limit: 50 });
      assert.equal(scoped.total, 1);
      assert.equal(scoped.items[0].webhook_name, "grok-bot");
      const limited = await driver.listTriggerHistory({ limit: 1 });
      assert.equal(limited.total, 2);
      assert.equal(limited.items.length, 1);
    });

    it("pull tasks: save assigns ids and upserts, list, delete removes", async () => {
      const created = await driver.savePullTask({
        id: 0,
        name: "pull-a",
        prompt: "do it",
        cron: "0 9 * * *",
        target: "muse",
        is_active: false,
        last_run_at: null,
        created_at: "2026-10-25T00:00:00.000Z",
        updated_at: "2026-10-25T00:00:00.000Z",
      });
      assert.ok(created.id > 0);
      assert.equal((await driver.getPullTask(created.id))?.prompt, "do it");
      assert.equal((await driver.getPullTask(created.id))?.last_run_at, null);
      await driver.savePullTask({
        ...created,
        is_active: true,
        last_run_at: "2026-10-25T01:00:00.000Z",
        updated_at: "2026-10-25T01:00:00.000Z",
      });
      const row = await driver.getPullTask(created.id);
      assert.equal(row?.is_active, true);
      assert.equal(row?.last_run_at, "2026-10-25T01:00:00.000Z");
      assert.equal((await driver.listPullTasks()).length, 1);
      assert.equal(await driver.deletePullTask(created.id), true);
      assert.equal(await driver.deletePullTask(created.id), false);
      assert.equal(await driver.getPullTask(created.id), null);
    });

    it("pending tasks: save assigns ids, one row per (task, due_at), status transitions", async () => {
      const base = {
        pull_task_id: 7,
        pull_task_name: "t7",
        target: "muse",
        prompt: "do it",
        due_at: "2026-10-25T01:00:00.000Z",
        kind: "scheduled" as const,
        status: "waiting" as const,
        result_external_id: null,
        result_record_id: null,
        error: null,
        created_at: "2026-10-25T01:00:00.000Z",
        updated_at: "2026-10-25T01:00:00.000Z",
      };
      const created = await driver.savePendingTask({ ...base, id: 0 });
      assert.ok(created.id > 0);
      await assert.rejects(driver.savePendingTask({ ...base, id: 0 }), /UNIQUE|duplicate/);
      assert.equal((await driver.getPendingTask(created.id))?.status, "waiting");
      await driver.savePendingTask({ ...created, status: "running", updated_at: "2026-10-25T01:01:00.000Z" });
      assert.equal((await driver.getPendingTask(created.id))?.status, "running");
      assert.equal((await driver.listPendingTasks({ target: "muse", status: "running" })).length, 1);
      assert.equal((await driver.listPendingTasks({ target: "grok" })).length, 0);
      assert.equal(await driver.deleteWaitingPendingTasks(7), 0);
      await driver.savePendingTask({ ...created, status: "waiting", updated_at: "2026-10-25T01:02:00.000Z" });
      assert.equal(await driver.deleteWaitingPendingTasks(7), 1);
      assert.equal(await driver.getPendingTask(created.id), null);
      assert.equal(await driver.deletePendingTask(created.id), false);
    });

    it("webhook payloads: save upserts, list newest-updated first, delete removes", async () => {
      assert.deepEqual(await driver.listWebhookPayloads(), []);
      await driver.saveWebhookPayload({
        id: "p1",
        name: "news",
        content: JSON.stringify({ prompt: "news brief" }),
        is_active: false,
        created_at: "2026-10-25T00:00:00.000Z",
        updated_at: "2026-10-25T00:00:00.000Z",
      });
      await driver.saveWebhookPayload({
        id: "p2",
        name: "other",
        content: JSON.stringify({ prompt: "other" }),
        is_active: true,
        created_at: "2026-10-25T01:00:00.000Z",
        updated_at: "2026-10-25T01:00:00.000Z",
      });
      const listed = await driver.listWebhookPayloads();
      assert.equal(listed.length, 2);
      assert.equal(listed[0].id, "p2");
      assert.equal(listed[0].is_active, true);
      assert.equal((await driver.getWebhookPayload("p1"))?.content, JSON.stringify({ prompt: "news brief" }));
      await driver.saveWebhookPayload({
        id: "p1",
        name: "news renamed",
        content: JSON.stringify({ prompt: "news v2" }),
        is_active: true,
        created_at: "2026-10-25T00:00:00.000Z",
        updated_at: "2026-10-25T02:00:00.000Z",
      });
      assert.equal((await driver.getWebhookPayload("p1"))?.name, "news renamed");
      assert.equal((await driver.listWebhookPayloads())[0].id, "p1");
      assert.equal(await driver.deleteWebhookPayload("p2"), true);
      assert.equal(await driver.deleteWebhookPayload("p2"), false);
      assert.equal(await driver.getWebhookPayload("p2"), null);
    });
  });
}

contract("sqlite", (dir) => new SqliteDriver(join(dir, "test.db")));
contract("file", (dir) => new FileDriver(join(dir, "files")));

// Real-PG contract, opt-in only (never in the default run): with
// PG_CONTRACT_TEST=1 the same contract runs against PgDriver, using
// PG_HOST/PG_PORT/PG_DATABASE/PG_USER/PG_REGION from the environment.
// Point it at a SCRATCH database carrying the migration DDL — never at
// the migration target, because the contract writes and deletes rows.
// See docs/pg-driver.md for the exact command. This round does not run
// it (no live PG is touched by this change).
if (process.env.PG_CONTRACT_TEST === "1") {
  contract("pg", () => new PgDriver());
}

// SQLite-only: opening a database that still has the old webhook_configs
// table migrates its rows into webhooks (id-keyed, payload kept), marks
// the legacy cursor-trigger row scheduled, leaves other rows unscheduled,
// and drops the old table. A database whose old table predates the payload
// column migrates with payload null.
describe("sqlite webhook migration", () => {
  it("migrates legacy rows into webhooks and drops the old table", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "dp-migration-"));
    try {
      const path = join(dir, "old.db");
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE webhook_configs (name TEXT PRIMARY KEY, url TEXT NOT NULL, token TEXT NOT NULL, payload TEXT, updated_at TEXT NOT NULL);",
      );
      db.prepare("INSERT INTO webhook_configs VALUES (?, ?, ?, ?, ?)").run(
        "cursor-trigger",
        "https://old.example/hook",
        "old-token",
        JSON.stringify({ prompt: "old template" }),
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
      const driver = new SqliteDriver(path);
      try {
        const rows = await driver.listWebhooks();
        assert.equal(rows.length, 2);
        const legacy = rows.find((w) => w.name === "cursor-trigger");
        assert.ok(legacy);
        assert.equal(legacy.is_active, true);
        assert.equal(legacy.payload, JSON.stringify({ prompt: "old template" }));
        assert.equal(legacy.hasToken, true);
        assert.equal("token" in legacy, false);
        assert.equal(rows.find((w) => w.name === "other")?.is_active, false);
        // Full row round-trips by id, and the old table is gone.
        const full = await driver.getWebhook(legacy.id);
        assert.equal(full?.url, "https://old.example/hook");
        assert.equal(full?.token, "old-token");
        const check = new DatabaseSync(path, { readOnly: true });
        try {
          const tables = check
            .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'webhook_configs'")
            .all();
          assert.equal(tables.length, 0);
        } finally {
          check.close();
        }
      } finally {
        await driver.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates an old table without payload/is_active columns", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const dir = mkdtempSync(join(tmpdir(), "dp-migration-nopayload-"));
    try {
      const path = join(dir, "old.db");
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE webhook_configs (name TEXT PRIMARY KEY, url TEXT NOT NULL, token TEXT NOT NULL, updated_at TEXT NOT NULL);",
      );
      db.prepare("INSERT INTO webhook_configs VALUES (?, ?, ?, ?)").run(
        "cursor-trigger",
        "https://ancient.example/hook",
        "ancient-token",
        "2026-10-25T00:00:00.000Z",
      );
      db.close();
      const driver = new SqliteDriver(path);
      try {
        const rows = await driver.listWebhooks();
        assert.equal(rows.length, 1);
        assert.equal(rows[0].name, "cursor-trigger");
        assert.equal(rows[0].is_active, true);
        assert.equal(rows[0].payload, null);
      } finally {
        await driver.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// File-only: a directory that still has webhook-configs.json migrates its
// rows into webhooks.json (id-keyed) and removes the old file.
describe("file webhook migration", () => {
  it("migrates legacy rows and drops the old file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-file-migration-"));
    try {
      writeFileSync(
        join(dir, "webhook-configs.json"),
        JSON.stringify([
          {
            name: "cursor-trigger",
            url: "https://old.example/hook",
            token: "old-token",
            payload: JSON.stringify({ prompt: "old template" }),
            is_active: true,
            updated_at: "2026-10-25T00:00:00.000Z",
          },
          {
            name: "other",
            url: "https://other.example/hook",
            token: "other-token",
            updated_at: "2026-10-25T00:00:00.000Z",
          },
        ]),
      );
      const driver = new FileDriver(dir);
      try {
        const rows = await driver.listWebhooks();
        assert.equal(rows.length, 2);
        const legacy = rows.find((w) => w.name === "cursor-trigger");
        assert.ok(legacy);
        assert.ok(legacy.id > 0);
        assert.equal(legacy.is_active, true);
        assert.equal(legacy.payload, JSON.stringify({ prompt: "old template" }));
        assert.equal((await driver.getWebhook(legacy.id))?.token, "old-token");
        assert.equal(rows.find((w) => w.name === "other")?.is_active, false);
        assert.equal(existsSync(join(dir, "webhook-configs.json")), false);
        assert.equal(existsSync(join(dir, "webhooks.json")), true);
      } finally {
        await driver.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
