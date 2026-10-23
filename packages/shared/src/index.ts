/**
 * Shared contracts for data-pipeline (wire format, not storage internals).
 *
 * RawRecord mirrors what GET /api/v1/records returns. Its source of truth is
 * apps/api/src/domain/types.ts (StoredRecord); if the API shape changes,
 * update both in the same commit.
 */

export type ContentFormat = "markdown" | "text" | "html" | "json";

export interface RawRecord {
  id: string;
  external_id: string | null;
  title: string | null;
  prompt: string;
  content: string;
  content_format: ContentFormat;
  content_hash: string;
  source_agent: string;
  skill_version: string | null;
  tags: string[];
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface RecordsPage {
  items: RawRecord[];
  total: number;
  limit: number;
  offset: number;
}

/* ------------------------------------------------------------------ */
/* Cleaning output schema v2 (2026-10-23; v1 was 2026-10-22). One raw  */
/* record (e.g. a whole news brief) is cleaned into one CleanedRecord  */
/* holding many CleanedItems. v2 changes vs v1:                        */
/*   - importance removed (it collapsed to "medium" in practice);     */
/*     ranking is now a time-decay weight computed from publish time.  */
/*   - source_agent recorded per record (pipeline provenance, set      */
/*     from the raw record — never by the LLM).                        */
/* ------------------------------------------------------------------ */

export interface CleanedSource {
  name: string;
  url: string;
}

export interface CleanedItem {
  title: string;
  /** 1-3 sentence summary of what happened */
  summary: string;
  /** optional longer detail (mechanism / what changed) */
  detail?: string;
  /** topic bucket, e.g. "Web3 DeFi" / "AI Agent"; "未分类" when unclear */
  category: string;
  tags: string[];
  /** ISO date (yyyy-mm-dd) of the event itself, null when not stated */
  event_date: string | null;
  sources: CleanedSource[];
}

export interface CleanedRecord {
  schema_version: 2;
  source_record_id: string;
  /** content_hash of the raw record at cleaning time (idempotency key) */
  content_hash: string;
  /** source_agent of the raw record (which agent pushed it) */
  source_agent: string;
  cleaned_at: string;
  provider: string;
  model: string;
  prompt_version: string;
  items: CleanedItem[];
}

/** Split an ISO event date into its calendar parts (null when unknown). */
export function eventParts(
  eventDate: string | null,
): { event_year: number; event_month: number; event_day: number } | null {
  if (!eventDate) return null;
  const m = eventDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { event_year: Number(m[1]), event_month: Number(m[2]), event_day: Number(m[3]) };
}

/**
 * Time-decay weight of an item, 0-100, from its publish time (cleaned_at):
 * starts at 100 and halves every WEIGHT_HALF_LIFE_HOURS. Replaces the old
 * importance field — fresher items weigh more, mechanically.
 */
export const WEIGHT_HALF_LIFE_HOURS = 48;

export function computeWeight(publishedAtIso: string, nowMs: number = Date.now()): number {
  const t = Date.parse(publishedAtIso);
  if (Number.isNaN(t)) return 0;
  const ageHours = Math.max(0, (nowMs - t) / 3_600_000);
  return Math.round(100 * Math.pow(0.5, ageHours / WEIGHT_HALF_LIFE_HOURS));
}

/** UI shows the weight in three tiers. */
export type WeightTier = 1 | 2 | 3;

export function weightTier(weight: number): WeightTier {
  return weight >= 50 ? 1 : weight >= 20 ? 2 : 3;
}
