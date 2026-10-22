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
/* Cleaning output schema v1 (decided 2026-10-22, implemented in       */
/* workers/cleaner). One raw record (e.g. a whole news brief) is       */
/* cleaned into one CleanedRecord holding many CleanedItems.           */
/* ------------------------------------------------------------------ */

export interface CleanedSource {
  name: string;
  url: string;
}

export type Importance = "high" | "medium" | "low";

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
  importance: Importance;
}

export interface CleanedRecord {
  schema_version: 1;
  source_record_id: string;
  /** content_hash of the raw record at cleaning time (idempotency key) */
  content_hash: string;
  cleaned_at: string;
  provider: string;
  model: string;
  prompt_version: string;
  items: CleanedItem[];
}
