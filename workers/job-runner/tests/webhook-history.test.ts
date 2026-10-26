import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { appendTriggerHistory, TRIGGER_HISTORY_LIMIT } from "../src/webhook-history.js";

const BASE = {
  webhook_id: 1,
  webhook_name: "grok-bot",
  kind: "scheduled" as const,
  triggered_at: "2026-10-26T01:00:00.000Z",
  http_status: 200,
  ok: true,
  body_kind: "payload(single)",
  error: null,
  duration_ms: 120,
};

function readRows(path: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM webhook_trigger_history ORDER BY id ASC")
      .all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

describe("webhook-history", () => {
  it("append creates the table, stores the row, and returns true", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-trigger-history-"));
    try {
      const path = join(dir, "data.db");
      new DatabaseSync(path).close();
      assert.equal(appendTriggerHistory(path, BASE), true);
      const rows = readRows(path);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].webhook_id, 1);
      assert.equal(rows[0].webhook_name, "grok-bot");
      assert.equal(rows[0].kind, "scheduled");
      assert.equal(rows[0].http_status, 200);
      assert.equal(rows[0].ok, 1);
      assert.equal(rows[0].body_kind, "payload(single)");
      assert.equal(rows[0].error, null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("append prunes to the latest 1000 rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-trigger-history-prune-"));
    try {
      const path = join(dir, "data.db");
      new DatabaseSync(path).close();
      for (let i = 0; i < TRIGGER_HISTORY_LIMIT + 5; i++) {
        assert.equal(
          appendTriggerHistory(path, { ...BASE, triggered_at: `2026-10-26T${String(i % 24).padStart(2, "0")}:00:00.000Z` }),
          true,
        );
      }
      const rows = readRows(path);
      assert.equal(rows.length, TRIGGER_HISTORY_LIMIT);
      // The first five (oldest ids) were pruned, the newest remain.
      assert.equal(rows[0].id, 6);
      assert.equal(rows[rows.length - 1].id, TRIGGER_HISTORY_LIMIT + 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("append never throws: missing file returns false", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-trigger-history-missing-"));
    try {
      assert.equal(appendTriggerHistory(join(dir, "nope.db"), BASE), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
