/**
 * Cursor automation trigger: config resolution, request building and the
 * single webhook call. Pure / injectable so tests never touch the network
 * or a real token.
 *
 * Secrets rule (same as the cleaner's LLM key): the webhook URL and the
 * Bearer token are read from the environment (server root .env) only.
 * They are never hard-coded, never logged, and never included in errors.
 */

export interface TriggerConfig {
  url: string;
  token: string;
  intervalMinutes: number;
}

/** Defaults mirror the cleaner: hourly, minimum 1 minute. */
export function resolveConfig(env: NodeJS.ProcessEnv): TriggerConfig {
  const url = env.CURSOR_WEBHOOK_URL?.trim() ?? "";
  const token = env.CURSOR_AUTOMATION_TOKEN?.trim() ?? "";
  const missing: string[] = [];
  if (!url) missing.push("CURSOR_WEBHOOK_URL");
  if (!token) missing.push("CURSOR_AUTOMATION_TOKEN");
  if (missing.length > 0) {
    // Name the variables only — never their (absent) values.
    throw new Error(`missing required env: ${missing.join(", ")} (set them in the repo root .env on the server)`);
  }
  const intervalMinutes = Math.max(1, Number(env.CURSOR_TRIGGER_INTERVAL_MINUTES ?? 60) || 60);
  // Shape checks: a bad value (e.g. a pasted placeholder with brackets,
  // spaces or non-ASCII text) must fail here with a readable message, not
  // later as a cryptic ByteString error from fetch. Messages name the
  // variable and the problem class only — never the value.
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("bad protocol");
  } catch {
    throw new Error("CURSOR_WEBHOOK_URL is not a valid http(s) URL — check the value in the repo root .env");
  }
  if (!/^[\x21-\x7E]+$/.test(token)) {
    throw new Error(
      "CURSOR_AUTOMATION_TOKEN is not a plain ASCII token (it contains spaces, brackets or non-ASCII characters) — the .env value must be the raw crsr_ token only, with no placeholder text",
    );
  }
  return { url, token, intervalMinutes };
}

export interface TriggerRequest {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
}

/** The automation's own instructions live in Cursor; the body is context. */
export function buildRequest(config: TriggerConfig, now: Date): TriggerRequest {
  return {
    url: config.url,
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      source: "data-pipeline/cursor-trigger",
      triggered_at: now.toISOString(),
    }),
  };
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
