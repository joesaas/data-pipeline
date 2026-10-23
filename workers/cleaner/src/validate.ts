import type { CleanedItem } from "@data-pipeline/shared";

export interface ValidationOutcome {
  items: CleanedItem[];
  dropped: number;
}

/** Extract the JSON object from a model response (tolerates code fences and prose around it). */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(stripped.slice(start, end + 1));
}

/**
 * Canonical category names. The prompt asks for these verbatim, but models
 * drift ("GitHub 热点" one day, "开源项目" the next) and a drifted name
 * splits one sidebar category into two. Aliases fold known variants back.
 */
const CATEGORY_ALIASES: Record<string, string> = {
  github: "GitHub 热点项目",
  "github 热点": "GitHub 热点项目",
  "github热点": "GitHub 热点项目",
  "github 热门项目": "GitHub 热点项目",
  "github热门项目": "GitHub 热点项目",
  "github trending": "GitHub 热点项目",
  "开源项目": "GitHub 热点项目",
  "热门开源项目": "GitHub 热点项目",
};

/**
 * Some sources are single-topic by construction: every item in a record
 * from them belongs to one canonical category, whatever the LLM says.
 * (A trending-repos brief's items never mention the category per item,
 * so the model leaves it empty and everything lands in 未分类.)
 */
export const SOURCE_CATEGORY: Record<string, string> = {
  "github-trending": "GitHub 热点项目",
};

export function canonicalCategory(raw: string): string {
  const c = raw.trim();
  if (!c) return "未分类";
  return CATEGORY_ALIASES[c.toLowerCase()] ?? c;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function validDate(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/** Validate and coerce raw model output into CleanedItems; invalid items are dropped, never fatal. */
export function validateCleanedItems(raw: unknown, opts?: { forceCategory?: string }): ValidationOutcome {
  const root = raw as { items?: unknown };
  if (!root || !Array.isArray(root.items)) throw new Error("model output has no items array");
  const items: CleanedItem[] = [];
  let dropped = 0;
  for (const entry of root.items) {
    const e = entry as Record<string, unknown>;
    const title = asString(e?.title);
    if (!title) {
      dropped += 1;
      continue;
    }
    const summary = asString(e.summary) || asString(e.detail) || title;
    const tags = Array.isArray(e.tags)
      ? e.tags.filter((t): t is string => typeof t === "string" && t.trim().length > 0).slice(0, 8)
      : [];
    const sources = Array.isArray(e.sources)
      ? e.sources
          .map((s) => {
            const so = s as Record<string, unknown>;
            return { name: asString(so?.name), url: asString(so?.url) };
          })
          .filter((s) => /^https?:\/\//.test(s.url))
      : [];
    const detail = asString(e.detail);
    items.push({
      title,
      summary,
      ...(detail ? { detail } : {}),
      category: opts?.forceCategory ?? canonicalCategory(asString(e.category)),
      tags,
      event_date: validDate(e.event_date),
      sources,
    });
  }
  return { items, dropped };
}
