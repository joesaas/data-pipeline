export type ContentFormat = "markdown" | "text" | "html" | "json";

export interface PushPayload {
  schema_version?: number;
  external_id?: string;
  title?: string;
  prompt: string;
  content: string;
  content_format?: ContentFormat;
  source_agent?: string;
  skill_version?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface StoredRecord {
  id: string;
  token_id: string;
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

export type TokenRole = "user" | "admin";

export interface StoredToken {
  id: string;
  name: string;
  key_hash: string;
  created_at: string;
  revoked_at: string | null;
  /** "admin" tokens resolve to ADMIN_IDENTITY and may read every
   *  identity's records (the cleaner reads all pushers' records).
   *  Optional for backward compatibility: absent means "user". */
  role?: TokenRole;
}

/**
 * One webhook endpoint in the console's webhooks table — the only webhook
 * table. The token is stored in plaintext by necessity — it must be sent
 * as a Bearer token on every trigger — so it is never returned to clients:
 * listings and detail views carry the metadata view only.
 * `payload` is the user-authored JSON body template for the trigger
 * request (it usually contains the `prompt`); null means "no template —
 * use the built-in body shape".
 * `cron` is the per-webhook schedule (plan A, 2026-10-25): a 5-field cron
 * expression evaluated in Asia/Shanghai time by the job-runner; null
 * means "no cron — fire on the legacy interval gate instead".
 */
export interface StoredWebhook {
  id: number;
  name: string;
  url: string;
  token: string;
  payload: string | null;
  cron: string | null;
  /** True when this is the webhook the scheduled trigger fires. At most one row is active. */
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/** Public view of a webhook: everything except the token. */
export interface WebhookMeta {
  id: number;
  name: string;
  url: string;
  payload: string | null;
  cron: string | null;
  is_active: boolean;
  /** Whether a token is stored (the value itself is never exposed). */
  hasToken: boolean;
  updated_at: string;
}

/**
 * One pull task (2026-10-25, pull model — the counterpart to the
 * webhook push model). An agent with no inbound webhook cannot be
 * pushed; instead the console holds tasks and the agent pulls its own.
 * Unlike webhooks, many pull tasks may be active at once — each runs
 * on its own cron, so activating one never deactivates another.
 * `cron` is required (a task without a schedule never runs) and is a
 * 5-field cron expression in Asia/Shanghai time. `target` names the
 * agent the task is for (default "muse"); a poller only ever takes
 * rows whose target is its own, so new agents can be added later
 * without changing the queue. `last_run_at` is kept for display only;
 * scheduling itself runs through the pending_tasks queue (below).
 */
export interface StoredPullTask {
  id: number;
  name: string;
  prompt: string;
  cron: string;
  /** Agent this task is for, e.g. "muse". Lowercase letters, digits, dash, underscore. */
  target: string;
  is_active: boolean;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export type PendingTaskStatus = "waiting" | "running" | "done" | "failed";

/**
 * One queued execution of a pull task (2026-10-25, queue redesign).
 * The scheduler (job-runner, 1-minute tick) inserts one row per cron
 * occurrence; a manual "run now" inserts one row with kind "manual".
 * Uniqueness rule: at most ONE row per (pull_task_id, due_at), in ANY
 * status — a row is never deleted, it only changes status, so the
 * scheduler can never insert the same occurrence twice. A manual run
 * is blocked while the task already has a waiting row (any due_at).
 * `prompt` is snapshotted at insert time: editing the task later does
 * not change an already-queued execution. The worker claims a waiting
 * row (waiting -> running) before executing, pushes the result to the
 * records API itself, then marks the row done (or failed) — there is
 * no review gate on this path, by design (2026-10-25 li decision).
 */
export interface StoredPendingTask {
  id: number;
  pull_task_id: number;
  /** Task name snapshot, for queue displays without a join. */
  pull_task_name: string;
  target: string;
  prompt: string;
  due_at: string;
  kind: "scheduled" | "manual";
  status: PendingTaskStatus;
  result_external_id: string | null;
  result_record_id: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** What the public detector endpoint returns: waiting rows only, no prompts, no results. */
export interface PendingTaskPublic {
  id: number;
  pull_task_id: number;
  due_at: string;
  kind: "scheduled" | "manual";
}

/**
 * One saved webhook payload template. The content is a user-authored JSON
 * object (it usually contains the `prompt`); at most one row is active,
 * and the scheduled trigger sends the active one. Content is not a secret.
 * The table is still read by the trigger job; the console no longer
 * manages this list.
 */
export interface WebhookPayload {
  id: string;
  name: string;
  content: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

/**
 * One recorded webhook fire (scheduled tick or console test-fire). The
 * trigger job writes a row for every actual HTTP attempt — success or
 * failure — and never for a skipped tick (no active webhook, cron not
 * due, interval gate). `webhook_name` is a snapshot: deleting or
 * renaming the webhook row never rewrites history, and history rows are
 * never deleted with the webhook. No secrets here: the token is never
 * stored in this table and the full URL is never recorded either — the
 * name snapshot is enough to identify the target. `http_status` is null
 * when the attempt never got a response (network error, timeout);
 * `error` is a short failure snippet, also secret-free by construction
 * (triggerOnce messages carry a status plus a response snippet only).
 */
export interface WebhookTriggerHistory {
  id: number;
  webhook_id: number;
  webhook_name: string;
  /** "scheduled" for a timer tick, "test" for a console 测试一次. */
  kind: "scheduled" | "test";
  triggered_at: string;
  http_status: number | null;
  ok: boolean;
  /** Body shape actually sent: payload(override|active|single), prompt, or ping. */
  body_kind: string;
  error: string | null;
  duration_ms: number | null;
}

/**
 * Identity an admin token resolves to. Records are siloed per identity;
 * drivers treat this identity as unscoped for reads (find / get / list /
 * delete). An admin identity is a reader, not a bucket: nothing is ever
 * pushed under it in normal operation.
 */
export const ADMIN_IDENTITY = "__admin__";

/**
 * News-site wallet login (separate from API tokens: those are for
 * agents, these are for human readers). A nonce is single-use and
 * short-lived; a session is a random token whose SHA-256 only is
 * stored, like API keys. Favorites are keyed by lowercase address.
 */
export interface SiteNonce {
  address: string;
  nonce: string;
  message: string;
  expires_at: string;
}

export interface SiteSession {
  token_hash: string;
  address: string;
  created_at: string;
  expires_at: string;
}

export interface SiteFavorite {
  address: string;
  item_id: string;
  created_at: string;
}

export type PushStatus = "created" | "replaced" | "deduped";

export interface PushResult {
  id: string;
  status: PushStatus;
  created_at: string;
}

export class ValidationError extends Error {
  constructor(
    message: string,
    public field?: string,
    public tooLarge = false,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}
