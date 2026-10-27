import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

export interface CleanedSourceView {
  name: string;
  url: string;
}

import {
  canonicalCategory,
  categoryAliasesFor,
  computeWeight,
  eventParts,
  parseTranslationZh,
  weightTier,
} from "@data-pipeline/shared";

export interface CleanedItemView {
  id: string;
  source_record_id: string;
  idx: number;
  title: string;
  summary: string;
  detail: string | null;
  category: string;
  tags: string[];
  event_date: string | null;
  event_year: number | null;
  event_month: number | null;
  event_day: number | null;
  sources: CleanedSourceView[];
  /** Chinese translation of title/summary (null until the cleaner translates it) */
  title_zh: string | null;
  summary_zh: string | null;
  source_agent: string;
  /** time-decay weight from cleaned_at (publish time), computed at read */
  weight: number;
  weight_tier: number;
  cleaned_at: string;
  provider: string;
  model: string;
}

export interface CleanedStats {
  records: number;
  items: number;
  last_cleaned_at: string | null;
  categories: { name: string; count: number }[];
  providers: { provider: string; model: string; records: number }[];
}

interface ItemRow {
  id: string;
  source_record_id: string;
  idx: number;
  title: string;
  summary: string;
  detail: string | null;
  category: string;
  tags: string;
  event_date: string | null;
  sources: string;
  translation_zh: string | null;
  source_agent: string;
  cleaned_at: string;
  provider: string;
  model: string;
}

function parseJsonArray<T>(text: string): T[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

function toView(row: ItemRow): CleanedItemView {
  const parts = eventParts(row.event_date);
  const weight = computeWeight(row.cleaned_at);
  const zh = parseTranslationZh(row.translation_zh);
  const { translation_zh: _raw, ...rest } = row;
  return {
    ...rest,
    category: canonicalCategory(row.category),
    title_zh: zh?.title || null,
    summary_zh: zh?.summary || null,
    event_year: parts?.event_year ?? null,
    event_month: parts?.event_month ?? null,
    event_day: parts?.event_day ?? null,
    weight,
    weight_tier: weightTier(weight),
    tags: parseJsonArray<string>(row.tags),
    sources: parseJsonArray<CleanedSourceView>(row.sources),
  };
}

// source_agent exists only after the cleaner's v2 migration ran; older
// databases (cleaner not yet restarted) read as "" instead of erroring.
function selectSql(db: DatabaseSync): string {
  const cols = db.prepare("PRAGMA table_info(cleaned_records)").all() as { name: string }[];
  const agentExpr = cols.some((c) => c.name === "source_agent") ? "r.source_agent" : "''";
  // translation_zh exists only after the cleaner's v3 migration ran.
  const itemCols = db.prepare("PRAGMA table_info(cleaned_items)").all() as { name: string }[];
  const zhExpr = itemCols.some((c) => c.name === "translation_zh") ? "i.translation_zh" : "NULL";
  return `
  SELECT i.id, i.source_record_id, i.idx, i.title, i.summary, i.detail,
         i.category, i.tags, i.event_date, i.sources,
         ${zhExpr} AS translation_zh,
         ${agentExpr} AS source_agent,
         r.cleaned_at, r.provider, r.model
  FROM cleaned_items i
  JOIN cleaned_records r ON r.source_record_id = i.source_record_id`;
}

/**
 * Read-only access to the cleaner's SQLite output (workers/cleaner/data).
 * The API never writes there; the cleaner owns that file. When the file does
 * not exist yet (cleaner never ran), every method degrades to empty results
 * instead of failing. A fresh connection per call keeps this correct when
 * the cleaner replaces the file.
 */
export class CleanedReader {
  constructor(private readonly dbFile: string) {}

  private open(): DatabaseSync | null {
    if (!existsSync(this.dbFile)) return null;
    try {
      return new DatabaseSync(this.dbFile, { readOnly: true });
    } catch {
      return null;
    }
  }

  listItems(filter: {
    category?: string;
    q?: string;
    limit: number;
    offset: number;
    /** Default "cleaned_desc" (existing behaviour). "cleaned_asc" is
     *  used by the news-detail pending queue so the oldest
     *  ungenerated items are picked up first. */
    order?: "cleaned_desc" | "cleaned_asc";
  }): { items: CleanedItemView[]; total: number } {
    const db = this.open();
    if (!db) return { items: [], total: 0 };
    try {
      const where: string[] = [];
      const params: unknown[] = [];
      if (filter.category) {
        // Stored spellings may predate an alias (e.g. "DeFi Protocol"):
        // match every spelling that folds into the requested category.
        const names = categoryAliasesFor(canonicalCategory(filter.category));
        where.push(`i.category COLLATE NOCASE IN (${names.map(() => "?").join(", ")})`);
        params.push(...names);
      }
      if (filter.q) {
        where.push("(i.title LIKE ? OR i.summary LIKE ?)");
        params.push(`%${filter.q}%`, `%${filter.q}%`);
      }
      const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
      const totalRow = db
        .prepare(`SELECT COUNT(*) AS n FROM cleaned_items i ${whereSql}`)
        .get(...params) as { n: number };
      const direction = filter.order === "cleaned_asc" ? "ASC" : "DESC";
      const rows = db
        .prepare(
          `${selectSql(db)} ${whereSql}
           ORDER BY r.cleaned_at ${direction}, i.idx ASC
           LIMIT ? OFFSET ?`,
        )
        .all(...params, filter.limit, filter.offset) as ItemRow[];
      return { items: rows.map(toView), total: Number(totalRow.n) };
    } finally {
      db.close();
    }
  }

  getItem(id: string): CleanedItemView | null {
    const db = this.open();
    if (!db) return null;
    try {
      const row = db.prepare(`${selectSql(db)} WHERE i.id = ?`).get(id) as ItemRow | undefined;
      return row ? toView(row) : null;
    } finally {
      db.close();
    }
  }

  stats(): CleanedStats {
    const empty: CleanedStats = { records: 0, items: 0, last_cleaned_at: null, categories: [], providers: [] };
    const db = this.open();
    if (!db) return empty;
    try {
      const records = db.prepare("SELECT COUNT(*) AS n FROM cleaned_records").get() as { n: number };
      const items = db.prepare("SELECT COUNT(*) AS n FROM cleaned_items").get() as { n: number };
      const last = db.prepare("SELECT MAX(cleaned_at) AS m FROM cleaned_records").get() as { m: string | null };
      const rawCategories = db
        .prepare("SELECT category AS name, COUNT(*) AS count FROM cleaned_items GROUP BY category ORDER BY count DESC")
        .all() as { name: string; count: number }[];
      const categories = rawCategories.reduce<{ name: string; count: number }[]>((acc, c) => {
        const name = canonicalCategory(c.name);
        const found = acc.find((x) => x.name === name);
        if (found) found.count += Number(c.count);
        else acc.push({ name, count: Number(c.count) });
        return acc;
      }, []).sort((a, b) => b.count - a.count);
      const providers = db
        .prepare("SELECT provider, model, COUNT(*) AS records FROM cleaned_records GROUP BY provider, model")
        .all() as { provider: string; model: string; records: number }[];
      return {
        records: Number(records.n),
        items: Number(items.n),
        last_cleaned_at: last.m,
        categories,
        providers: providers.map((p) => ({ ...p, records: Number(p.records) })),
      };
    } finally {
      db.close();
    }
  }
}
