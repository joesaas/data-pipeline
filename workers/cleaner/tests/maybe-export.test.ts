import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { maybeExport } from "../src/maybe-export.js";
import type { PgPoolLike } from "../src/pg-pool.js";

function stubPool(): PgPoolLike {
  return {
    query: async () => ({ rows: [], rowCount: 0 }),
    connect: async () => {
      throw new Error("unused");
    },
    end: async () => {},
  };
}

describe("maybeExport", () => {
  it("PG mode (null storeFilePath) exports from the pool, never from a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maybe-export-pg-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    const pool = stubPool();
    let poolUsed = false;
    const seen: unknown[] = [];
    await maybeExport(
      { cleaned: 2, translated: 0 },
      {
        storeFilePath: null,
        getPgPool: () => {
          poolUsed = true;
          return pool;
        },
        outDir: join(dir, "web-dist"),
        runExport: (async (opts: { pgPool?: unknown; dbFile?: string }) => {
          seen.push(opts);
          return { items: 3, detailPages: 1, releaseDir: join(dir, "r"), currentLink: join(dir, "c") };
        }) as never,
        log: () => {},
        logError: () => {},
      },
    );
    assert.equal(poolUsed, true);
    assert.equal(seen.length, 1);
    const opts = seen[0] as { pgPool?: unknown; dbFile?: string };
    assert.equal(opts.pgPool, pool);
    assert.equal(opts.dbFile, undefined);
  });

  it("SQLite mode exports from the store file and never touches the pool", async () => {
    const dir = mkdtempSync(join(tmpdir(), "maybe-export-sqlite-"));
    after(() => rmSync(dir, { recursive: true, force: true }));
    let poolUsed = false;
    const seen: unknown[] = [];
    await maybeExport(
      { cleaned: 0, translated: 1 },
      {
        storeFilePath: join(dir, "cleaned.sqlite"),
        getPgPool: () => {
          poolUsed = true;
          return stubPool();
        },
        outDir: join(dir, "web-dist"),
        runExport: (async (opts: { pgPool?: unknown; dbFile?: string }) => {
          seen.push(opts);
          return { items: 1, detailPages: 0, releaseDir: join(dir, "r"), currentLink: join(dir, "c") };
        }) as never,
        log: () => {},
        logError: () => {},
      },
    );
    assert.equal(poolUsed, false);
    assert.equal(seen.length, 1);
    const opts = seen[0] as { pgPool?: unknown; dbFile?: string };
    assert.equal(opts.dbFile, join(dir, "cleaned.sqlite"));
    assert.equal(opts.pgPool, undefined);
  });

  it("skips when nothing was cleaned or translated, or when WEB_EXPORT_ON_CLEAN=false", async () => {
    let calls = 0;
    const runExport = (async () => {
      calls += 1;
      return { items: 0, detailPages: 0, releaseDir: "r", currentLink: "c" };
    }) as never;
    const base = {
      storeFilePath: null as string | null,
      getPgPool: stubPool,
      outDir: "out",
      runExport,
      log: () => {},
      logError: () => {},
    };
    await maybeExport({ cleaned: 0, translated: 0 }, base);
    await maybeExport({ cleaned: 1, translated: 0 }, { ...base, webExportOnClean: "false" });
    assert.equal(calls, 0);
  });

  it("logs export failures instead of throwing (batch outcome unchanged)", async () => {
    const errors: unknown[][] = [];
    await maybeExport(
      { cleaned: 1, translated: 0 },
      {
        storeFilePath: null,
        getPgPool: stubPool,
        outDir: "out",
        runExport: (async () => {
          throw new Error("pg read failed");
        }) as never,
        log: () => {},
        logError: (...args: unknown[]) => {
          errors.push(args);
        },
      },
    );
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /export failed \(ignored\): pg read failed/);
  });

  it("logs a getPgPool failure instead of throwing", async () => {
    const errors: unknown[][] = [];
    await maybeExport(
      { cleaned: 1, translated: 0 },
      {
        storeFilePath: null,
        getPgPool: () => {
          throw new Error("bad pg config");
        },
        outDir: "out",
        runExport: (async () => {
          throw new Error("must not be reached");
        }) as never,
        log: () => {},
        logError: (...args: unknown[]) => {
          errors.push(args);
        },
      },
    );
    assert.equal(errors.length, 1);
    assert.match(String(errors[0][0]), /bad pg config/);
  });
});
