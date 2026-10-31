import { canonicalCategory, categoryAliasesFor } from "@data-pipeline/shared";
import {
  type CleanedListFilter,
  type CleanedItemView,
  type CleanedReaderLike,
  type CleanedStats,
  toCleanedItemView,
  toIso,
  type ItemRow,
} from "../cleaned/cleaned-reader.js";
import { createPgPool, type PgPoolLike } from "../pg/pool.js";
import { resolvePgConfig } from "../pg/verify.js";

/**
 * PostgreSQL implementation of CleanedReaderLike over schema cleaner.*.
 * Mirrors the SQLite CleanedReader's semantics, with the documented
 * differences:
 * - Category filter: SQLite `i.category COLLATE NOCASE IN (...)` over
 *   alias spellings becomes `i.category ILIKE ANY($n)` over the same
 *   alias array. Both are case-insensitive equality; PG ILIKE
 *   additionally folds per locale, which only widens matches for
 *   non-ASCII spellings — categories here are ASCII.
 * - Text search: SQLite `LIKE` becomes `ILIKE` (same ASCII semantics).
 * - Errors PROPAGATE: unlike the SQLite reader's missing-file
 *   degradation, a PG connection failure throws, so a DB outage can
 *   never masquerade as an empty queue.
 * - TIMESTAMPTZ Dates and native JSONB values are normalized by the
 *   shared toCleanedItemView mapper, so callers see the same view.
 * The constructor only builds a lazy pool; no query runs until first
 * use. With no pool argument it resolves PG env via resolvePgConfig()
 * and throws on missing/invalid config (fail fast at startup).
 */
export class PgCleanedReader implements CleanedReaderLike {
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

  async listItems(filter: CleanedListFilter): Promise<{ items: CleanedItemView[]; total: number }> {
    const where: string[] = [];
    const params: unknown[] = [];
    const next = () => `$${params.length + 1}`;
    if (filter.category) {
      // Same alias list as the SQLite path; ILIKE ANY is the
      // case-insensitive-equality equivalent of COLLATE NOCASE IN.
      const names = categoryAliasesFor(canonicalCategory(filter.category));
      where.push(`i.category ILIKE ANY(${next()})`);
      params.push(names);
    }
    if (filter.q) {
      where.push(`(i.title ILIKE ${next()} OR i.summary ILIKE ${next()})`);
      params.push(`%${filter.q}%`, `%${filter.q}%`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const totalRow = await this.pool.query(
      `SELECT COUNT(*) AS n FROM cleaner.cleaned_items i ${whereSql}`,
      params,
    );
    const direction = filter.order === "cleaned_asc" ? "ASC" : "DESC";
    const { rows } = await this.pool.query(
      `SELECT i.id, i.source_record_id, i.idx, i.title, i.summary, i.detail,
              i.category, i.tags, i.event_date, i.sources,
              i.translation_zh,
              r.source_agent,
              r.cleaned_at, r.provider, r.model
         FROM cleaner.cleaned_items i
         JOIN cleaner.cleaned_records r ON r.source_record_id = i.source_record_id
         ${whereSql}
         ORDER BY r.cleaned_at ${direction}, i.idx ASC
         LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, filter.limit, filter.offset],
    );
    return {
      items: rows.map((r) => toCleanedItemView(rowFromPg(r))),
      total: Number(totalRow.rows[0]?.n ?? 0),
    };
  }

  async getItem(id: string): Promise<CleanedItemView | null> {
    const { rows } = await this.pool.query(
      `SELECT i.id, i.source_record_id, i.idx, i.title, i.summary, i.detail,
              i.category, i.tags, i.event_date, i.sources,
              i.translation_zh,
              r.source_agent,
              r.cleaned_at, r.provider, r.model
         FROM cleaner.cleaned_items i
         JOIN cleaner.cleaned_records r ON r.source_record_id = i.source_record_id
         WHERE i.id = $1`,
      [id],
    );
    return rows.length === 0 ? null : toCleanedItemView(rowFromPg(rows[0]));
  }

  async stats(): Promise<CleanedStats> {
    const records = await this.pool.query("SELECT COUNT(*) AS n FROM cleaner.cleaned_records");
    const items = await this.pool.query("SELECT COUNT(*) AS n FROM cleaner.cleaned_items");
    const last = await this.pool.query("SELECT MAX(cleaned_at) AS m FROM cleaner.cleaned_records");
    const rawCategories = await this.pool.query(
      "SELECT category AS name, COUNT(*) AS count FROM cleaner.cleaned_items GROUP BY category ORDER BY count DESC",
    );
    // Same JS-side canonical folding as the SQLite path.
    const categories = (rawCategories.rows as { name: string; count: number | string }[]).reduce<{ name: string; count: number }[]>((acc, c) => {
      const name = canonicalCategory(c.name);
      const found = acc.find((x) => x.name === name);
      if (found) found.count += Number(c.count);
      else acc.push({ name, count: Number(c.count) });
      return acc;
    }, []).sort((a, b) => b.count - a.count);
    const providers = await this.pool.query(
      "SELECT provider, model, COUNT(*) AS records FROM cleaner.cleaned_records GROUP BY provider, model",
    );
    return {
      records: Number(records.rows[0]?.n ?? 0),
      items: Number(items.rows[0]?.n ?? 0),
      last_cleaned_at: last.rows[0]?.m == null ? null : toIso(last.rows[0].m as string | Date),
      categories,
      providers: (providers.rows as { provider: string; model: string; records: number | string }[]).map((p) => ({
        ...p,
        records: Number(p.records),
      })),
    };
  }
}

function rowFromPg(r: Record<string, unknown>): ItemRow {
  return {
    id: String(r.id),
    source_record_id: String(r.source_record_id),
    idx: Number(r.idx),
    title: String(r.title),
    summary: String(r.summary),
    detail: r.detail == null ? null : String(r.detail),
    category: String(r.category),
    tags: r.tags as string | string[],
    event_date: r.event_date == null ? null : String(r.event_date),
    sources: r.sources as string | CleanedItemView["sources"],
    translation_zh: r.translation_zh == null ? null : String(r.translation_zh),
    source_agent: String(r.source_agent),
    cleaned_at: r.cleaned_at as string | Date,
    provider: String(r.provider),
    model: String(r.model),
  };
}
