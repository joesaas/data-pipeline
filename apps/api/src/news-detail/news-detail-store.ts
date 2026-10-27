import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * One row per cleaned item that has ever had a rich detail page pushed.
 * Status is deliberately small: "pending" means a row exists but no file
 * has been saved yet (reserved for a future claim step; the current
 * push flow only ever writes "done"), "done" means the file in
 * detail_path was written by the push endpoint.
 *
 * The table lives in its own SQLite file (config.newsDetailDbFile),
 * not in the cleaner's database (the API never writes there) and not
 * in the records database (so the StorageDriver contract is untouched).
 * Each method opens a fresh connection, like CleanedReader, so a
 * replaced database file is picked up on the next call.
 */
export interface NewsDetailPage {
  item_id: string;
  detail_path: string;
  status: "pending" | "done";
  original_url: string;
  created_at: string;
  updated_at: string;
}

export class NewsDetailStore {
  constructor(private readonly dbFile: string) {}

  private open(): DatabaseSync {
    if (this.dbFile !== ":memory:") {
      mkdirSync(dirname(this.dbFile), { recursive: true });
    }
    const db = new DatabaseSync(this.dbFile);
    db.exec(`
      CREATE TABLE IF NOT EXISTS detail_pages (
        item_id TEXT PRIMARY KEY,
        detail_path TEXT NOT NULL,
        status TEXT NOT NULL,
        original_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    return db;
  }

  get(itemId: string): NewsDetailPage | null {
    const db = this.open();
    try {
      const row = db
        .prepare("SELECT * FROM detail_pages WHERE item_id = ?")
        .get(itemId) as NewsDetailPage | undefined;
      return row ?? null;
    } finally {
      db.close();
    }
  }

  /** Upsert by item_id. Returns "created" on first insert, "replaced" on overwrite. */
  save(page: NewsDetailPage): "created" | "replaced" {
    const db = this.open();
    try {
      const existing = db
        .prepare("SELECT item_id FROM detail_pages WHERE item_id = ?")
        .get(page.item_id) as { item_id: string } | undefined;
      db.prepare(
        `INSERT INTO detail_pages (item_id, detail_path, status, original_url, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           detail_path = excluded.detail_path,
           status = excluded.status,
           original_url = excluded.original_url,
           updated_at = excluded.updated_at`,
      ).run(
        page.item_id,
        page.detail_path,
        page.status,
        page.original_url,
        page.created_at,
        page.updated_at,
      );
      return existing ? "replaced" : "created";
    } finally {
      db.close();
    }
  }

  /** All done rows (item_id + detail_path only): the public list
   *  the news-site list page uses to rewrite card links at load time,
   *  without needing an API key or a re-export. */
  listDone(): { item_id: string; detail_path: string }[] {
    if (!existsSync(this.dbFile) && this.dbFile !== ":memory:") return [];
    const db = this.open();
    try {
      return db
        .prepare("SELECT item_id, detail_path FROM detail_pages WHERE status = 'done' ORDER BY updated_at ASC")
        .all() as { item_id: string; detail_path: string }[];
    } finally {
      db.close();
    }
  }

  countDone(): number {
    if (!existsSync(this.dbFile) && this.dbFile !== ":memory:") return 0;
    const db = this.open();
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM detail_pages WHERE status = 'done'")
        .get() as { n: number };
      return Number(row.n);
    } finally {
      db.close();
    }
  }
}
