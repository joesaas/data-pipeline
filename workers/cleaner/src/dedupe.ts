import type { CleanedItem } from "@data-pipeline/shared";

/**
 * Cross-record dedupe, applied at save time: the same news pushed twice
 * (two runs, two agents, different external_ids) cleans into near-identical
 * items under different records, and record-level idempotency cannot see
 * them. An item is a duplicate when, against items already stored from
 * OTHER records within the window (or earlier items of the same batch):
 *   - its normalized title matches (needs >= 6 chars, so short ambiguous
 *     titles never collide), or
 *   - it shares any normalized source URL.
 * Deterministic on purpose: no LLM judgment, no extra calls.
 */

export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .trim();
}

export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const key of [...u.searchParams.keys()]) {
      if (key.toLowerCase().startsWith("utm_")) u.searchParams.delete(key);
    }
    u.hostname = u.hostname.toLowerCase();
    const s = u.toString();
    return s.endsWith("/") && u.pathname === "/" ? s.slice(0, -1) : s.replace(/\/$/, "");
  } catch {
    return raw.trim().toLowerCase();
  }
}

export interface ExistingKey {
  title: string;
  sourceUrls: string[];
}

export interface DedupeOutcome {
  kept: CleanedItem[];
  dropped: { item: CleanedItem; reason: string }[];
}

const MIN_TITLE_KEY_LEN = 6;

export function dedupeItems(newItems: CleanedItem[], existing: ExistingKey[]): DedupeOutcome {
  const titleKeys = new Map<string, string>(); // normalized -> original title (for the log)
  const urlKeys = new Set<string>();
  const register = (title: string, urls: string[]): void => {
    const nt = normalizeTitle(title);
    if (nt.length >= MIN_TITLE_KEY_LEN && !titleKeys.has(nt)) titleKeys.set(nt, title);
    for (const u of urls) urlKeys.add(normalizeUrl(u));
  };
  for (const e of existing) register(e.title, e.sourceUrls);

  const kept: CleanedItem[] = [];
  const dropped: { item: CleanedItem; reason: string }[] = [];
  for (const item of newItems) {
    const nt = normalizeTitle(item.title);
    const urls = item.sources.map((s) => s.url);
    let reason: string | null = null;
    if (nt.length >= MIN_TITLE_KEY_LEN && titleKeys.has(nt)) {
      reason = `title matches "${titleKeys.get(nt)}"`;
    } else {
      const hit = urls.map(normalizeUrl).find((u) => urlKeys.has(u));
      if (hit) reason = `source url already stored: ${hit}`;
    }
    if (reason) {
      dropped.push({ item, reason });
    } else {
      kept.push(item);
      register(item.title, urls);
    }
  }
  return { kept, dropped };
}
