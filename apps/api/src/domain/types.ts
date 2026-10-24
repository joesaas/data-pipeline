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
