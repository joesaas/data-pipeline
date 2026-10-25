import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { IngestService } from "../src/ingest/ingest-service.js";
import { ADMIN_IDENTITY } from "../src/domain/types.js";
import { FileDriver } from "../src/storage/file-driver.js";
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
    after(() => {
      driver.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("creates, then dedupes identical content under an external_id", () => {
      const a = ingest.push("anonymous", { prompt: "p1", content: "hello", external_id: "e1" });
      assert.equal(a.status, "created");
      const b = ingest.push("anonymous", { prompt: "p1", content: "hello", external_id: "e1" });
      assert.equal(b.status, "deduped");
      assert.equal(b.id, a.id);
    });

    it("replaces changed content under the same external_id, keeping id and created_at", () => {
      const a = ingest.push("anonymous", { prompt: "p2", content: "v1", external_id: "e2" });
      const b = ingest.push("anonymous", { prompt: "p2", content: "v2", external_id: "e2" });
      assert.equal(b.status, "replaced");
      assert.equal(b.id, a.id);
      assert.equal(b.created_at, a.created_at);
      assert.equal(driver.getRecord("anonymous", a.id)?.content, "v2");
    });

    it("dedupes by content hash when no external_id is given", () => {
      const a = ingest.push("anonymous", { prompt: "p3", content: "same body" });
      const b = ingest.push("anonymous", { prompt: "p3 again", content: "same body" });
      assert.equal(b.status, "deduped");
      assert.equal(b.id, a.id);
    });

    it("keeps identities isolated", () => {
      const a = ingest.push("token-a", { prompt: "p", content: "secret", external_id: "x" });
      assert.equal(driver.getRecord("token-b", a.id), null);
      assert.equal(driver.listRecords("token-b", { limit: 10, offset: 0 }).total, 0);
    });

    it("lets the admin identity read across identities, without merging buckets", () => {
      const a = ingest.push("token-a", { prompt: "p", content: "admin-visible", external_id: "adm1" });
      assert.equal(driver.getRecord(ADMIN_IDENTITY, a.id)?.content, "admin-visible");
      assert.equal(driver.findRecordByExternalId(ADMIN_IDENTITY, "adm1")?.id, a.id);
      assert.ok(driver.listRecords(ADMIN_IDENTITY, { limit: 100, offset: 0 }).total >= 1);
      // Isolation still holds for non-admin identities.
      assert.equal(driver.getRecord("token-b", a.id), null);
    });

    it("lists with filters and deletes", () => {
      ingest.push("anonymous", { prompt: "p", content: "tagged", tags: ["news"], source_agent: "muse" });
      const byTag = driver.listRecords("anonymous", { tag: "news", limit: 10, offset: 0 });
      assert.equal(byTag.total, 1);
      const id = byTag.items[0].id;
      assert.equal(driver.deleteRecord("anonymous", id), true);
      assert.equal(driver.getRecord("anonymous", id), null);
      assert.equal(driver.deleteRecord("anonymous", id), false);
    });

    it("lists ascending by (updated_at, id) with a keyset cursor", () => {
      for (const c of ["k1 body", "k2 body", "k3 body"]) {
        ingest.push("anonymous", { prompt: "pk", content: c, external_id: `k-${c}`, tags: ["keyset"] });
      }
      const page1 = driver.listRecords("anonymous", { tag: "keyset", limit: 2, offset: 0, order: "updated_asc" });
      assert.equal(page1.items.length, 2);
      const sorted = [...page1.items].sort(
        (a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id),
      );
      assert.deepEqual(page1.items.map((r) => r.id), sorted.map((r) => r.id));
      const last = page1.items[page1.items.length - 1];
      const page2 = driver.listRecords("anonymous", {
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

    it("stores tokens and finds them by hash", () => {
      driver.createToken({ id: "t1", name: "n", key_hash: "h1", created_at: new Date().toISOString(), revoked_at: null });
      assert.equal(driver.findTokenByHash("h1")?.id, "t1");
      assert.equal(driver.revokeToken("t1"), true);
      assert.notEqual(driver.findTokenByHash("h1")?.revoked_at, null);
    });

    it("lists tokens oldest first", () => {
      driver.createToken({ id: "t-old", name: "old", key_hash: "ho", created_at: "2026-01-01T00:00:00.000Z", revoked_at: null });
      driver.createToken({ id: "t-new", name: "new", key_hash: "hn", created_at: "2026-01-02T00:00:00.000Z", revoked_at: null });
      const names = driver.listTokens().map((t) => t.name);
      assert.ok(names.indexOf("old") < names.indexOf("new"));
    });

    it("rejects invalid payloads with field info", () => {
      assert.throws(() => ingest.push("anonymous", { content: "x" }), /prompt is required/);
      assert.throws(() => ingest.push("anonymous", { prompt: "x", content: "" }), /content is required/);
    });
  });
}

contract("sqlite", (dir) => new SqliteDriver(join(dir, "test.db")));
contract("file", (dir) => new FileDriver(join(dir, "files")));
