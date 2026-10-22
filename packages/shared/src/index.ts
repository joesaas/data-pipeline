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

/**
 * CleanedItem is a DRAFT (v0) — the cleaning stage was agreed on 2026-10-22,
 * but the final output schema and where cleaned items are stored are still
 * open decisions. Do not treat this shape as final.
 */
export interface CleanedSource {
  name: string;
  url: string;
}

export interface CleanedItem {
  /** id of the RawRecord this item was extracted from */
  source_record_id: string;
  title: string;
  summary: string;
  detail?: string;
  category?: string;
  tags: string[];
  /** ISO date of the event itself, not of the brief that reported it */
  event_date?: string;
  sources: CleanedSource[];
  importance?: "high" | "medium" | "low";
}

export interface CleanedRecord {
  schema_version: 0;
  source_record_id: string;
  cleaned_at: string;
  provider: string;
  model: string;
  items: CleanedItem[];
}
