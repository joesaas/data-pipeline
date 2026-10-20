import { createHash, randomUUID } from "node:crypto";
import type { PushPayload, PushResult, StoredRecord } from "../domain/types.js";
import { ValidationError } from "../domain/types.js";
import type { StorageDriver } from "../storage/storage-driver.js";

const FORMATS = ["markdown", "text", "html", "json"] as const;

export function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function deriveTitle(content: string): string | null {
  const firstLine = content.split("\n").map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  const cleaned = firstLine.replace(/^#+\s*/, "");
  return cleaned.slice(0, 120) || null;
}

/** Validation + dedupe/upsert semantics. Depends only on StorageDriver. */
export class IngestService {
  constructor(
    private driver: StorageDriver,
    private limits: { maxContentBytes: number; maxPromptBytes: number },
  ) {}

  private validate(payload: unknown): PushPayload {
    if (typeof payload !== "object" || payload === null) {
      throw new ValidationError("body must be a JSON object");
    }
    const p = payload as Record<string, unknown>;
    if (typeof p.prompt !== "string" || p.prompt.length === 0) {
      throw new ValidationError("prompt is required and must be a non-empty string", "prompt");
    }
    if (typeof p.content !== "string" || p.content.length === 0) {
      throw new ValidationError("content is required and must be a non-empty string", "content");
    }
    if (byteLen(p.prompt) > this.limits.maxPromptBytes) {
      throw new ValidationError(`prompt exceeds ${this.limits.maxPromptBytes} bytes`, "prompt", true);
    }
    if (byteLen(p.content) > this.limits.maxContentBytes) {
      throw new ValidationError(`content exceeds ${this.limits.maxContentBytes} bytes`, "content", true);
    }
    const format = (p.content_format as string | undefined) ?? "markdown";
    if (!FORMATS.includes(format as (typeof FORMATS)[number])) {
      throw new ValidationError(`content_format must be one of ${FORMATS.join(", ")}`, "content_format");
    }
    if (p.external_id !== undefined && (typeof p.external_id !== "string" || p.external_id.length > 128)) {
      throw new ValidationError("external_id must be a string of at most 128 chars", "external_id");
    }
    if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.some((t) => typeof t !== "string"))) {
      throw new ValidationError("tags must be an array of strings", "tags");
    }
    if (
      p.metadata !== undefined &&
      (typeof p.metadata !== "object" || p.metadata === null || Array.isArray(p.metadata))
    ) {
      throw new ValidationError("metadata must be an object", "metadata");
    }
    return p as unknown as PushPayload;
  }

  push(identity: string, rawPayload: unknown): PushResult {
    const payload = this.validate(rawPayload);
    const contentHash = hashContent(payload.content);
    const now = new Date().toISOString();

    const base: Omit<StoredRecord, "id" | "created_at" | "updated_at"> = {
      token_id: identity,
      external_id: payload.external_id ?? null,
      title: payload.title ?? deriveTitle(payload.content),
      prompt: payload.prompt,
      content: payload.content,
      content_format: payload.content_format ?? "markdown",
      content_hash: contentHash,
      source_agent: payload.source_agent ?? "other",
      skill_version: payload.skill_version ?? null,
      tags: payload.tags ?? [],
      metadata: payload.metadata ?? {},
    };

    if (payload.external_id) {
      const existing = this.driver.findRecordByExternalId(identity, payload.external_id);
      if (existing) {
        if (existing.content_hash === contentHash) {
          return { id: existing.id, status: "deduped", created_at: existing.created_at };
        }
        const updated: StoredRecord = {
          ...base,
          id: existing.id,
          created_at: existing.created_at,
          updated_at: now,
        };
        this.driver.updateRecord(updated);
        return { id: existing.id, status: "replaced", created_at: existing.created_at };
      }
    } else {
      const dup = this.driver.findRecordByHash(identity, contentHash);
      if (dup) return { id: dup.id, status: "deduped", created_at: dup.created_at };
    }

    const rec: StoredRecord = { ...base, id: randomUUID(), created_at: now, updated_at: now };
    this.driver.insertRecord(rec);
    return { id: rec.id, status: "created", created_at: now };
  }
}
