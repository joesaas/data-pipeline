import type { CleanedItem, Importance } from "@data-pipeline/shared";

export interface ValidationOutcome {
  items: CleanedItem[];
  dropped: number;
}

const IMPORTANCE: ReadonlySet<string> = new Set(["high", "medium", "low"]);

/** Extract the JSON object from a model response (tolerates code fences and prose around it). */
export function extractJson(text: string): unknown {
  const stripped = text.replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(stripped.slice(start, end + 1));
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
export function validateCleanedItems(raw: unknown): ValidationOutcome {
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
    const importance = IMPORTANCE.has(asString(e.importance))
      ? (asString(e.importance) as Importance)
      : "medium";
    const detail = asString(e.detail);
    items.push({
      title,
      summary,
      ...(detail ? { detail } : {}),
      category: asString(e.category) || "未分类",
      tags,
      event_date: validDate(e.event_date),
      sources,
      importance,
    });
  }
  return { items, dropped };
}
