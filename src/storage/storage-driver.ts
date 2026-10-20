import type { StoredRecord, StoredToken } from "../domain/types.js";

/**
 * The single storage interface (design doc §4). The ingest service depends
 * only on this interface; the SQLite and file implementations must behave
 * identically and pass the same contract tests.
 */
export interface StorageDriver {
  insertRecord(rec: StoredRecord): void;
  /** Replace mutable fields of an existing record (keeps id and created_at). */
  updateRecord(rec: StoredRecord): void;
  findRecordByExternalId(identity: string, externalId: string): StoredRecord | null;
  findRecordByHash(identity: string, contentHash: string): StoredRecord | null;
  getRecord(identity: string, id: string): StoredRecord | null;
  listRecords(
    identity: string,
    filter: { source_agent?: string; tag?: string; limit: number; offset: number },
  ): { items: StoredRecord[]; total: number };
  deleteRecord(identity: string, id: string): boolean;

  createToken(tok: StoredToken): void;
  findTokenByHash(keyHash: string): StoredToken | null;
  revokeToken(id: string): boolean;
  close(): void;
}
