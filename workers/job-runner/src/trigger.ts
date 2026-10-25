/**
 * Cursor automation trigger: config resolution, request building and the
 * single webhook call. Pure / injectable so tests never touch the network
 * or a real token.
 *
 * Secrets rule (same as the cleaner's LLM key): the webhook URL and the
 * Bearer token come only from the database webhooks table (console
 * managed). They are never hard-coded, never logged, and never included
 * in errors. There is no environment fallback.
 */

export interface TriggerConfig {
  url: string;
  token: string;
  /**
   * Instruction text for the receiving automation. NOT resolved from the
   * environment: the job fills it from the trigger state file. Undefined/
   * empty means "no prompt" — the body stays the old ping shape and the
   * receiver decides on its own.
   */
  prompt?: string;
  /**
   * User-authored JSON body template (console webhook setting, stored in
   * the database). When set, it IS the request body (after placeholder
   * substitution) and `prompt` above is ignored; when unset, the built-in
   * body shape is used.
   */
  payload?: string | null;
  /**
   * Content of the active payload-list item (read from the database on
   * every attempt). Wins over `payload` below.
   */
  activePayload?: string | null;
  /**
   * One-off template for a manual trigger of a specific list item (passed
   * by the API through the child environment). Wins over everything.
   */
  payloadOverride?: string;
}

/** A webhook endpoint read from the database (console-managed config). */
export interface DbWebhookConfig {
  url: string;
  token: string;
  payload: string | null;
}

/**
 * Resolve the webhook endpoint from the database row. A null row means
 * "no webhook is scheduled" and fails here with a readable message —
 * the caller (the job) skips the tick instead of reaching this, so this
 * is a backstop, not a normal path.
 */
export function resolveWebhookConfig(db: DbWebhookConfig | null): TriggerConfig {
  if (!db) {
    throw new Error("no active webhook configured (add one in the console and set it as scheduled)");
  }
  const url = db.url.trim();
  const token = db.token.trim();
  if (!url || !token) {
    throw new Error("no active webhook configured (add one in the console and set it as scheduled)");
  }
  // Shape checks: a bad value (e.g. a pasted placeholder with brackets,
  // spaces or non-ASCII text) must fail here with a readable message, not
  // later as a cryptic ByteString error from fetch. Messages name the
  // variable and the problem class only — never the value.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("bad protocol");
  } catch {
    throw new Error("CURSOR_WEBHOOK_URL is not a valid http(s) URL — check the value in the console webhook settings");
  }
  if (!/^[\x21-\x7E]+$/.test(token)) {
    throw new Error(
      "CURSOR_AUTOMATION_TOKEN is not a plain ASCII token (it contains spaces, brackets or non-ASCII characters) — the stored value must be the raw crsr_ token only, with no placeholder text",
    );
  }
  return { url, token, payload: db.payload ?? null };
}

/** Replace {{triggered_at}} / {{source}} inside string values (keys untouched). */
export function substitutePlaceholders(value: unknown, vars: Record<string, string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
  }
  if (Array.isArray(value)) return value.map((v) => substitutePlaceholders(v, vars));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [
        k,
        substitutePlaceholders(v, vars),
      ]),
    );
  }
  return value;
}

export interface TriggerRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/**
 * The body is either a user-authored payload template or the built-in
 * shape. Template precedence: a manual-trigger override first, then the
 * active payload-list item, then the webhook row's single template. A
 * template usually contains the `prompt` itself, so when one is used the
 * state's single prompt is ignored — the template is authoritative.
 * Placeholders {{triggered_at}} / {{source}} inside string values are
 * replaced with the run's values; anything else is sent verbatim. A
 * template that is not valid JSON, or not a JSON object, fails here with
 * a readable message (never echoing the template itself). Without a
 * template, the body is the old shape: {source, triggered_at} plus
 * `prompt` when the state has one, else just the ping.
 * The prompt is never logged (it can be long); only its presence is.
 */
export function buildRequest(config: TriggerConfig, now: Date): TriggerRequest {
  const headers = {
    Authorization: `Bearer ${config.token}`,
    "Content-Type": "application/json",
  };
  const template =
    config.payloadOverride?.trim() ||
    config.activePayload?.trim() ||
    config.payload?.trim() ||
    null;
  if (template) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(template);
    } catch {
      throw new Error("webhook payload is not valid JSON — check the value in the console webhook settings");
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("webhook payload must be a JSON object — check the value in the console webhook settings");
    }
    const body = substitutePlaceholders(parsed, {
      triggered_at: now.toISOString(),
      source: "data-pipeline/cursor-trigger",
    });
    return { url: config.url, method: "POST", headers, body: JSON.stringify(body) };
  }
  const prompt = config.prompt?.trim() ? config.prompt : undefined;
  return {
    url: config.url,
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "data-pipeline/cursor-trigger",
      triggered_at: now.toISOString(),
      ...(prompt ? { prompt } : {}),
    }),
  };
}

/** Which template (if any) buildRequest would use, for the job log line. */
export function templateKind(config: TriggerConfig): "override" | "active" | "single" | null {
  if (config.payloadOverride?.trim()) return "override";
  if (config.activePayload?.trim()) return "active";
  if (config.payload?.trim()) return "single";
  return null;
}

export interface TriggerResult {
  ok: boolean;
  status: number;
}

type FetchFn = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
}>;

/**
 * POST the webhook once. A non-2xx response is an error whose message
 * carries the status and a short response snippet — never the token.
 */
export async function triggerOnce(
  config: TriggerConfig,
  now: Date = new Date(),
  fetchFn: FetchFn = fetch as unknown as FetchFn,
): Promise<TriggerResult> {
  const req = buildRequest(config, now);
  const res = await fetchFn(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
  });
  if (!res.ok) {
    const snippet = (await res.text().catch(() => "")).slice(0, 200);
    throw new Error(`cursor webhook returned HTTP ${res.status}${snippet ? `: ${snippet}` : ""}`);
  }
  return { ok: true, status: res.status };
}
