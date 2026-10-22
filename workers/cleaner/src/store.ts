import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CleanedItem, RawRecord } from "@data-pipeline/shared";

export interface CleanMeta {
  provider: string;
  model: string;
  promptVersion: string;
  cleanedAt: string;
}

/**
 * Cleaner's own SQLite store (sink decided 2026-10-22): cleaned output lives
 * next to the cleaner, not inside the API's database. Idempotency key is
 * (source_record_id, content_hash): a record is re-cleaned only when its
 * content actually changed.
 */
export class CleanerStore {
  private readonly db: DatabaseSync;

  constructor(filePath: string) {
    if (filePath !== ":memory:") {
      mkdirSync(dirname(filePath), { recursive: true });
    }
    this.db = new DatabaseSync(filePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cleaned_records (
        source_record_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        cleaned_at TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        prompt_version TEXT NOT NULL,
        item_count INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cleaned_items (
        id TEXT PRIMARY KEY,
        source_record_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        detail TEXT,
        category TEXT NOT NULL,
        tags TEXT NOT NULL,
        event_date TEXT,
        sources TEXT NOT NULL,
        importance TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_items_record ON cleaned_items(source_record_id);
    `);
  }

  static defaultPath(env: NodeJS.ProcessEnv = process.env): string {
    const dir = env.CLEANER_DATA_DIR?.trim();
    return join(dir && dir.length > 0 ? dir : join(process.cwd(), "data"), "cleaned.sqlite");
  }

  cleanedHash(sourceRecordId: string): string | null {
    const row = this.db
      .prepare("SELECT content_hash FROM cleaned_records WHERE source_record_id = ?")
      .get(sourceRecordId) as { content_hash: string } | undefined;
    return row?.content_hash ?? null;
  }

  save(record: RawRecord, meta: CleanMeta, items: CleanedItem[]): void {
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO cleaned_records (source_record_id, content_hash, cleaned_at, provider, model, prompt_version, item_count)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(source_record_id) DO UPDATE SET
             content_hash = excluded.content_hash, cleaned_at = excluded.cleaned_at,
             provider = excluded.provider, model = excluded.model,
             prompt_version = excluded.prompt_version, item_count = excluded.item_count`,
        )
        .run(record.id, record.content_hash, meta.cleanedAt, meta.provider, meta.model, meta.promptVersion, items.length);
      this.db.prepare("DELETE FROM cleaned_items WHERE source_record_id = ?").run(record.id);
      const insert = this.db.prepare(
        `INSERT INTO cleaned_items (id, source_record_id, idx, title, summary, detail, category, tags, event_date, sources, importance)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      items.forEach((item, idx) => {
        const id = createHash("sha256").update(`${record.id}:${idx}:${item.title}`).digest("hex");
        insert.run(
          id,
          record.id,
          idx,
          item.title,
          item.summary,
          item.detail ?? null,
          item.category,
          JSON.stringify(item.tags),
          item.event_date,
          JSON.stringify(item.sources),
          item.importance,
        );
      });
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  counts(): { records: number; items: number } {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM cleaned_records").get() as { n: number };
    const i = this.db.prepare("SELECT COUNT(*) AS n FROM cleaned_items").get() as { n: number };
    return { records: Number(r.n), items: Number(i.n) };
  }

  close(): void {
    this.db.close();
  }
}
