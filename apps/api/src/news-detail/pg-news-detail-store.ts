import { createPgPool, type PgPoolLike } from "../pg/pool.js";
import { resolvePgConfig } from "../pg/verify.js";
import { toIso } from "../cleaned/cleaned-reader.js";
import type { NewsDetailPage, NewsDetailStoreLike } from "./news-detail-store.js";

/**
 * PostgreSQL implementation of NewsDetailStoreLike over schema
 * news_detail.*. Mirrors the SQLite NewsDetailStore:
 * - save() pre-SELECTs then upserts with the same column list: on
 *   conflict it updates detail_path/status/original_url/updated_at
 *   but NEVER overwrites created_at (first-write time is kept).
 * - TIMESTAMPTZ columns read back as ISO strings via toIso; writes
 *   accept ISO strings.
 * - listDone orders by updated_at ASC, like the SQLite version.
 * The constructor only builds a lazy pool; no query runs until first
 * use. With no pool argument it resolves PG env via resolvePgConfig()
 * and throws on missing/invalid config (fail fast at startup).
 */
export class PgNewsDetailStore implements NewsDetailStoreLike {
  private readonly pool: PgPoolLike;

  constructor(pool?: PgPoolLike) {
    if (pool) {
      this.pool = pool;
      return;
    }
    const resolved = resolvePgConfig();
    if ("error" in resolved) throw new Error(resolved.error);
    this.pool = createPgPool(resolved.config);
  }

  async get(itemId: string): Promise<NewsDetailPage | null> {
    const { rows } = await this.pool.query(
      "SELECT * FROM news_detail.detail_pages WHERE item_id = $1",
      [itemId],
    );
    return rows.length === 0 ? null : rowToPage(rows[0]);
  }

  async save(page: NewsDetailPage): Promise<"created" | "replaced"> {
    const { rows } = await this.pool.query(
      "SELECT item_id FROM news_detail.detail_pages WHERE item_id = $1",
      [page.item_id],
    );
    await this.pool.query(
      `INSERT INTO news_detail.detail_pages (item_id, detail_path, status, original_url, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (item_id) DO UPDATE SET
         detail_path = EXCLUDED.detail_path,
         status = EXCLUDED.status,
         original_url = EXCLUDED.original_url,
         updated_at = EXCLUDED.updated_at`,
      [page.item_id, page.detail_path, page.status, page.original_url, page.created_at, page.updated_at],
    );
    return rows.length > 0 ? "replaced" : "created";
  }

  async listDone(): Promise<{ item_id: string; detail_path: string }[]> {
    const { rows } = await this.pool.query(
      "SELECT item_id, detail_path FROM news_detail.detail_pages WHERE status = 'done' ORDER BY updated_at ASC",
    );
    return rows.map((r) => ({ item_id: String(r.item_id), detail_path: String(r.detail_path) }));
  }

  async countDone(): Promise<number> {
    const { rows } = await this.pool.query(
      "SELECT COUNT(*) AS n FROM news_detail.detail_pages WHERE status = 'done'",
    );
    return Number(rows[0]?.n ?? 0);
  }
}

function rowToPage(r: Record<string, unknown>): NewsDetailPage {
  return {
    item_id: String(r.item_id),
    detail_path: String(r.detail_path),
    status: r.status as "pending" | "done",
    original_url: String(r.original_url),
    created_at: toIso(r.created_at as string | Date),
    updated_at: toIso(r.updated_at as string | Date),
  };
}
