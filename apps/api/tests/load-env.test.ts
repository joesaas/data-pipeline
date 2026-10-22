import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { loadDefaultEnv } from "../src/load-env.js";

describe("loadDefaultEnv", () => {
  const dir = mkdtempSync(join(tmpdir(), "loadenv-"));
  const file = join(dir, ".env");
  writeFileSync(file, "DP_LOADENV_SET=set-by-file\nDP_LOADENV_KEEP=file-value\n");
  process.env.DP_LOADENV_KEEP = "env-value";
  after(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.DP_LOADENV_SET;
    delete process.env.DP_LOADENV_KEEP;
  });

  it("loads values that are not set yet", () => {
    const loaded = loadDefaultEnv([file]);
    assert.equal(loaded, file);
    assert.equal(process.env.DP_LOADENV_SET, "set-by-file");
  });
  it("never overwrites real environment variables", () => {
    loadDefaultEnv([file]);
    assert.equal(process.env.DP_LOADENV_KEEP, "env-value");
  });
  it("returns null when no candidate exists", () => {
    assert.equal(loadDefaultEnv([join(dir, "nope.env")]), null);
  });
});
