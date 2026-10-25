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
 * A webhook configuration (e.g. the cursor-trigger automation endpoint).
 * The token is stored in plaintext by necessity — it must be sent as a
 * Bearer token on every trigger — so it is never returned to clients:
 * listings and status reports carry the metadata view only.
 * `payload` is the user-authored JSON body template for the trigger
 * request (it usually contains the `prompt`); null means "no template —
 * use the built-in body shape".
 */
export interface StoredWebhookConfig {
  name: string;
  url: string;
  token: string;
  payload: string | null;
  /** True when this is the webhook the scheduled trigger fires. At most one row is active. */
  is_active: boolean;
  updated_at: string;
}

/** Public view of a webhook configuration: everything except the token. */
export interface WebhookConfigMeta {
  name: string;
  url: string;
  payload: string | null;
  is_active: boolean;
  /** Whether a token is stored (the value itself is never exposed). */
  hasToken: boolean;
  updated_at: string;
}

/**
 * One saved webhook payload template in the console's payload list. The
 * content is a user-authored JSON object (it usually contains the
 * `prompt`); at most one row is active, and the scheduled trigger sends
 * the active one. Content is not a secret, so list/detail endpoints
 * return it in full.
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
 * Identity an admin token resolves to. Records are siloed per identity;
 * drivers treat this identity as unscoped for reads (find / get / list /
 * delete). An admin identity is a reader, not a bucket: nothing is ever
 * pushed under it in normal operation.
 */
export const ADMIN_IDENTITY = "__admin__";

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
