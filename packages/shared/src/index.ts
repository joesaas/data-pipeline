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

/* ------------------------------------------------------------------ */
/* Canonical categories. The cleaning prompt asks for canonical names */
/* verbatim, but models drift ("DeFi Protocol" vs "Web3 DeFi"), and a  */
/* drifted name splits one sidebar category into two. This table is   */
/* the single source of truth: the cleaner folds aliases at write     */
/* time, readers fold again at read time (so rows stored before an    */
/* alias existed merge instantly, without a re-clean).                 */
/* ------------------------------------------------------------------ */

const CATEGORY_ALIASES: Record<string, string> = {
  github: "GitHub 热点项目",
  "github 热点": "GitHub 热点项目",
  "github热点": "GitHub 热点项目",
  "github 热门项目": "GitHub 热点项目",
  "github热门项目": "GitHub 热点项目",
  "github trending": "GitHub 热点项目",
  "开源项目": "GitHub 热点项目",
  "热门开源项目": "GitHub 热点项目",
  "defi protocol": "Web3 DeFi",
  "defi 协议": "Web3 DeFi",
  "defi协议": "Web3 DeFi",
  "web3 defi protocol": "Web3 DeFi",
  security: "安全",
  "网络安全": "安全",
  "信息安全": "安全",
  "安全动态": "安全",
  "安全资讯": "安全",
  "安全事件": "安全",
  "智能合约安全": "安全",
};

export function canonicalCategory(raw: string): string {
  const c = raw.trim();
  if (!c) return "未分类";
  return CATEGORY_ALIASES[c.toLowerCase()] ?? c;
}

/** Every stored spelling that folds into `canonical` (for SQL IN filters). */
export function categoryAliasesFor(canonical: string): string[] {
  const names = new Set<string>([canonical]);
  for (const [alias, target] of Object.entries(CATEGORY_ALIASES)) {
    if (target === canonical) names.add(alias);
  }
  return [...names];
}

/** Chinese translation of an item's display fields, produced by one
 *  batched LLM call per cleaning round (never per item). Stored on the
 *  item row as JSON text in cleaned_items.translation_zh. */
export interface TranslationZh {
  title: string;
  summary: string;
}

export function parseTranslationZh(text: string | null | undefined): TranslationZh | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as { title?: unknown; summary?: unknown };
    const title = typeof v.title === "string" ? v.title.trim() : "";
    const summary = typeof v.summary === "string" ? v.summary.trim() : "";
    return title || summary ? { title, summary } : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* Webhook cron schedules (2026-10-25, per-webhook cron, plan A).     */
/* One schedule lives on one webhook row; empty means "no cron — use   */
/* the legacy interval gate". This is the single parser for both the   */
/* API (which validates what the console saves) and the job-runner    */
/* (which decides whether a tick fires), so the two can never drift.  */
/*                                                                    */
/* Format: exactly 5 fields, "minute hour day-of-month month          */
/* day-of-week", numbers only (no month/weekday names). Each field    */
/* accepts "*", star-slash-step, "a-b", "a-b/step", "n/step" and     */
/* comma lists. Day-of-week 0 and 7 both mean Sunday.                */
/*                                                                    */
/* Timezone is load-bearing and fixed: cron times are Asia/Shanghai   */
/* (UTC+8, no DST). The server's own timezone is deliberately NOT     */
/* used — an EC2 box on UTC would otherwise fire "0 9 * * *" at      */
/* 17:00 Beijing time, an 8-hour surprise. The console says so too.   */
/* Missed minutes are skipped, never caught up: a tick fires only     */
/* when the current Shanghai minute itself matches the expression.    */
/* ------------------------------------------------------------------ */

export const CRON_TIMEZONE = "Asia/Shanghai";

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  dayOfWeek: Set<number>;
  /** False when the field was "*" (unrestricted) — needed for the dom/dow OR rule. */
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
  raw: string;
}

const CRON_RANGES: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

function parseCronField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    if (!part) return null;
    const [base, stepRaw] = part.split("/");
    if (stepRaw !== undefined) {
      if (!/^\d+$/.test(stepRaw)) return null;
      const step = Number(stepRaw);
      if (step <= 0) return null;
      let lo: number;
      let hi: number;
      if (base === "*") {
        lo = min;
        hi = max;
      } else if (/^\d+$/.test(base)) {
        lo = Number(base);
        hi = max;
      } else {
        const m = /^(\d+)-(\d+)$/.exec(base);
        if (!m) return null;
        lo = Number(m[1]);
        hi = Number(m[2]);
      }
      if (lo < min || hi > max || lo > hi) return null;
      for (let v = lo; v <= hi; v += step) out.add(v);
      continue;
    }
    if (base === "*") {
      for (let v = min; v <= max; v++) out.add(v);
      continue;
    }
    const m = /^(\d+)-(\d+)$/.exec(base);
    if (m) {
      const lo = Number(m[1]);
      const hi = Number(m[2]);
      if (lo < min || hi > max || lo > hi) return null;
      for (let v = lo; v <= hi; v++) out.add(v);
      continue;
    }
    if (!/^\d+$/.test(base)) return null;
    const v = Number(base);
    if (v < min || v > max) return null;
    out.add(v);
  }
  return out.size ? out : null;
}

/** Parse a 5-field cron expression; null when malformed. Empty input is not valid here — callers treat empty as "no cron". */
export function parseCron(expr: string): ParsedCron | null {
  const raw = expr.trim();
  if (!raw) return null;
  const fields = raw.split(/\s+/);
  if (fields.length !== 5) return null;
  const sets: Set<number>[] = [];
  for (let i = 0; i < 5; i++) {
    const [min, max] = CRON_RANGES[i];
    const s = parseCronField(fields[i], min, max);
    if (!s) return null;
    sets.push(s);
  }
  const dow = new Set<number>();
  for (const v of sets[4]) dow.add(v === 7 ? 0 : v);
  return {
    minute: sets[0],
    hour: sets[1],
    dayOfMonth: sets[2],
    month: sets[3],
    dayOfWeek: dow,
    dayOfMonthRestricted: fields[2] !== "*",
    dayOfWeekRestricted: fields[4] !== "*",
    raw,
  };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

interface CronParts {
  minute: number;
  hour: number;
  day: number;
  month: number;
  weekday: number;
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Calendar parts of a Date in the cron timezone (Asia/Shanghai). */
export function cronParts(date: Date): CronParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: CRON_TIMEZONE,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
    weekday: "short",
  }).formatToParts(date);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  return {
    minute: Number(get("minute")),
    hour: Number(get("hour")),
    day: Number(get("day")),
    month: Number(get("month")),
    weekday: WEEKDAY_NAMES.indexOf(get("weekday")),
  };
}

/** "2026-10-25 09:00" in Shanghai time — the minute key used to suppress duplicate fires within one minute. */
export function cronMinuteKey(date: Date): string {
  const p = cronParts(date);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${p.month}/${p.day} ${pad(p.hour)}:${pad(p.minute)}`;
}

/** True when the expression matches this instant (Shanghai time). Standard dom/dow rule: when both are restricted, either matching fires. */
export function matchesCron(cron: ParsedCron, date: Date): boolean {
  const p = cronParts(date);
  if (!cron.minute.has(p.minute) || !cron.hour.has(p.hour) || !cron.month.has(p.month)) {
    return false;
  }
  const dom = cron.dayOfMonth.has(p.day);
  const dow = cron.dayOfWeek.has(p.weekday);
  if (!cron.dayOfMonthRestricted && !cron.dayOfWeekRestricted) return true;
  if (cron.dayOfMonthRestricted && !cron.dayOfWeekRestricted) return dom;
  if (!cron.dayOfMonthRestricted && cron.dayOfWeekRestricted) return dow;
  return dom || dow;
}

/**
 * True when a cron-scheduled tick should fire now: the current Shanghai
 * minute matches, and the last successful fire was not in this same
 * minute (the 1-minute tick must not double-fire one cron minute).
 * A null/unparseable last fire means "fire if the minute matches".
 */
export function isCronDue(cron: ParsedCron, now: Date, lastTriggeredAt: string | null): boolean {
  if (!matchesCron(cron, now)) return false;
  if (!lastTriggeredAt) return true;
  const last = new Date(lastTriggeredAt);
  if (Number.isNaN(last.getTime())) return true;
  return cronMinuteKey(last) !== cronMinuteKey(now);
}
