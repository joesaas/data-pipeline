import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  StoredRecord,
  StoredToken,
  StoredWebhookConfig,
  WebhookConfigMeta,
  WebhookPayload,
} from "../domain/types.js";
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
  private webhookConfigsPath: string;
  private webhookPayloadsPath: string;

  constructor(dir: string) {
    this.recordsDir = join(dir, "records");
    this.tokensPath = join(dir, "tokens.json");
    this.webhookConfigsPath = join(dir, "webhook-configs.json");
    this.webhookPayloadsPath = join(dir, "webhook-payloads.json");
    mkdirSync(this.recordsDir, { recursive: true });
    if (!existsSync(this.tokensPath)) writeFileSync(this.tokensPath, "[]");
    if (!existsSync(this.webhookConfigsPath)) writeFileSync(this.webhookConfigsPath, "[]");
    if (!existsSync(this.webhookPayloadsPath)) writeFileSync(this.webhookPayloadsPath, "[]");
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

  listTokens(): StoredToken[] {
    return this.readTokens().sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
    );
  }

  revokeToken(id: string): boolean {
    const tokens = this.readTokens();
    const tok = tokens.find((t) => t.id === id && t.revoked_at === null);
    if (!tok) return false;
    tok.revoked_at = new Date().toISOString();
    this.writeTokens(tokens);
    return true;
  }

  private readWebhookConfigs(): StoredWebhookConfig[] {
    return JSON.parse(readFileSync(this.webhookConfigsPath, "utf8")) as StoredWebhookConfig[];
  }

  private writeWebhookConfigs(cfgs: StoredWebhookConfig[]): void {
    writeFileSync(this.webhookConfigsPath, JSON.stringify(cfgs, null, 1));
  }

  getWebhookConfig(name: string): StoredWebhookConfig | null {
    const found = this.readWebhookConfigs().find((c) => c.name === name);
    if (!found) return null;
    // Rows written before the payload column existed lack the field at
    // runtime even though the type requires it. Rows written before the
    // webhook list existed lack is_active too — the old single row was
    // the scheduled webhook, so it normalizes to active (mirroring the
    // SQLite migration, which marks the cursor-trigger row active).
    const row = found as StoredWebhookConfig & { payload?: string | null; is_active?: boolean };
    return {
      ...row,
      payload: row.payload ?? null,
      is_active: row.is_active ?? row.name === "cursor-trigger",
    };
  }

  listWebhookConfigs(): WebhookConfigMeta[] {
    return this.readWebhookConfigs()
      .map((c) => {
        const row = c as StoredWebhookConfig & { payload?: string | null; is_active?: boolean };
        return {
          name: row.name,
          url: row.url,
          payload: (row.payload ?? null) as string | null,
          is_active: row.is_active ?? row.name === "cursor-trigger",
          hasToken: (row.token ?? "").trim() !== "",
          updated_at: row.updated_at,
        };
      })
      .sort((a, b) => a.updated_at.localeCompare(b.updated_at) || a.name.localeCompare(b.name));
  }

  saveWebhookConfig(cfg: StoredWebhookConfig): void {
    const cfgs = this.readWebhookConfigs();
    const i = cfgs.findIndex((c) => c.name === cfg.name);
    if (i >= 0) cfgs[i] = cfg;
    else cfgs.push(cfg);
    this.writeWebhookConfigs(cfgs);
  }

  deleteWebhookConfig(name: string): boolean {
    const cfgs = this.readWebhookConfigs();
    const kept = cfgs.filter((c) => c.name !== name);
    if (kept.length === cfgs.length) return false;
    this.writeWebhookConfigs(kept);
    return true;
  }

  private readWebhookPayloads(): WebhookPayload[] {
    return JSON.parse(readFileSync(this.webhookPayloadsPath, "utf8")) as WebhookPayload[];
  }

  private writeWebhookPayloads(items: WebhookPayload[]): void {
    writeFileSync(this.webhookPayloadsPath, JSON.stringify(items, null, 1));
  }

  listWebhookPayloads(): WebhookPayload[] {
    return this.readWebhookPayloads().sort(
      (a, b) => b.updated_at.localeCompare(a.updated_at) || a.id.localeCompare(b.id),
    );
  }

  getWebhookPayload(id: string): WebhookPayload | null {
    return this.readWebhookPayloads().find((p) => p.id === id) ?? null;
  }

  saveWebhookPayload(p: WebhookPayload): void {
    const items = this.readWebhookPayloads();
    const i = items.findIndex((x) => x.id === p.id);
    if (i >= 0) items[i] = p;
    else items.push(p);
    this.writeWebhookPayloads(items);
  }

  deleteWebhookPayload(id: string): boolean {
    const items = this.readWebhookPayloads();
    const kept = items.filter((p) => p.id !== id);
    if (kept.length === items.length) return false;
    this.writeWebhookPayloads(kept);
    return true;
  }

  close(): void {
    // Nothing to release; files are written synchronously.
  }
}
