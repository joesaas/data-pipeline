import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredRecord, StoredToken } from "../domain/types.js";
import { ADMIN_IDENTITY } from "../domain/types.js";
import type { StorageDriver } from "./storage-driver.js";

/** Identity scoping: admin sees every record; anyone else only their own. */
function inScope(identity: string, rec: StoredRecord): boolean {
  return identity === ADMIN_IDENTITY || rec.token_id === identity;
}

/**
 * File implementation of StorageDriver: one JSON file per record under
 * <dir>/records/, tokens in <dir>/tokens.json. Single-process assumption:
 * reads/writes are synchronous read-modify-write, no cross-process locking
 * (the trade-off documented in design doc §4.2).
 */
export class FileDriver implements StorageDriver {
  private recordsDir: string;
  private tokensPath: string;

  constructor(dir: string) {
    this.recordsDir = join(dir, "records");
    this.tokensPath = join(dir, "tokens.json");
    mkdirSync(this.recordsDir, { recursive: true });
    if (!existsSync(this.tokensPath)) writeFileSync(this.tokensPath, "[]");
  }

  private readAllRecords(): StoredRecord[] {
    return readdirSync(this.recordsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.recordsDir, f), "utf8")) as StoredRecord);
  }

  private readTokens(): StoredToken[] {
    return JSON.parse(readFileSync(this.tokensPath, "utf8")) as StoredToken[];
  }

  private writeTokens(tokens: StoredToken[]): void {
    writeFileSync(this.tokensPath, JSON.stringify(tokens, null, 1));
  }

  insertRecord(rec: StoredRecord): void {
    writeFileSync(join(this.recordsDir, `${rec.id}.json`), JSON.stringify(rec, null, 1));
  }

  updateRecord(rec: StoredRecord): void {
    this.insertRecord(rec);
  }

  findRecordByExternalId(identity: string, externalId: string): StoredRecord | null {
    return (
      this.readAllRecords().find((r) => inScope(identity, r) && r.external_id === externalId) ??
      null
    );
  }

  findRecordByHash(identity: string, contentHash: string): StoredRecord | null {
    const matches = this.readAllRecords()
      .filter((r) => inScope(identity, r) && r.content_hash === contentHash)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return matches[0] ?? null;
  }

  getRecord(identity: string, id: string): StoredRecord | null {
    const path = join(this.recordsDir, `${id}.json`);
    if (!existsSync(path)) return null;
    const rec = JSON.parse(readFileSync(path, "utf8")) as StoredRecord;
    return inScope(identity, rec) ? rec : null;
  }

  listRecords(
    identity: string,
    filter: {
      source_agent?: string;
      tag?: string;
      limit: number;
      offset: number;
      updated_after?: string;
      after_id?: string;
      order?: "created_desc" | "updated_asc";
    },
  ): { items: StoredRecord[]; total: number } {
    let items = this.readAllRecords().filter((r) => inScope(identity, r));
    if (filter.source_agent) items = items.filter((r) => r.source_agent === filter.source_agent);
    if (filter.tag) items = items.filter((r) => r.tags.includes(filter.tag as string));
    if (filter.order === "updated_asc") {
      if (filter.updated_after) {
        const after = filter.updated_after;
        const afterId = filter.after_id ?? "";
        items = items.filter(
          (r) => r.updated_at > after || (r.updated_at === after && r.id > afterId),
        );
      }
      items.sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.id.localeCompare(b.id));
    } else {
      items.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    return { items: items.slice(filter.offset, filter.offset + filter.limit), total: items.length };
  }

  deleteRecord(identity: string, id: string): boolean {
    if (!this.getRecord(identity, id)) return false;
    rmSync(join(this.recordsDir, `${id}.json`));
    return true;
  }

  createToken(tok: StoredToken): void {
    const tokens = this.readTokens();
    tokens.push(tok);
    this.writeTokens(tokens);
  }

  findTokenByHash(keyHash: string): StoredToken | null {
    return this.readTokens().find((t) => t.key_hash === keyHash) ?? null;
  }

  revokeToken(id: string): boolean {
    const tokens = this.readTokens();
    const tok = tokens.find((t) => t.id === id && t.revoked_at === null);
    if (!tok) return false;
    tok.revoked_at = new Date().toISOString();
    this.writeTokens(tokens);
    return true;
  }

  close(): void {
    // Nothing to release; files are written synchronously.
  }
}
