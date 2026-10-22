import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredRecord, StoredToken } from "../domain/types.js";
import type { StorageDriver } from "./storage-driver.js";

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
      this.readAllRecords().find((r) => r.token_id === identity && r.external_id === externalId) ??
      null
    );
  }

  findRecordByHash(identity: string, contentHash: string): StoredRecord | null {
    const matches = this.readAllRecords()
      .filter((r) => r.token_id === identity && r.content_hash === contentHash)
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return matches[0] ?? null;
  }

  getRecord(identity: string, id: string): StoredRecord | null {
    const path = join(this.recordsDir, `${id}.json`);
    if (!existsSync(path)) return null;
    const rec = JSON.parse(readFileSync(path, "utf8")) as StoredRecord;
    return rec.token_id === identity ? rec : null;
  }

  listRecords(
    identity: string,
    filter: { source_agent?: string; tag?: string; limit: number; offset: number },
  ): { items: StoredRecord[]; total: number } {
    let items = this.readAllRecords().filter((r) => r.token_id === identity);
    if (filter.source_agent) items = items.filter((r) => r.source_agent === filter.source_agent);
    if (filter.tag) items = items.filter((r) => r.tags.includes(filter.tag as string));
    items.sort((a, b) => b.created_at.localeCompare(a.created_at));
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
