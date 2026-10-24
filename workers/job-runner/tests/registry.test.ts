import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { JOBS, parseDurationMs, validateJobs } from "../src/registry.js";

describe("job registry", () => {
  it("the shipped registry is valid and has unique names", () => {
    assert.deepEqual(validateJobs(JOBS), []);
    assert.equal(new Set(JOBS.map((j) => j.name)).size, JOBS.length);
  });

  it("parses durations to milliseconds", () => {
    assert.equal(parseDurationMs("500ms"), 500);
    assert.equal(parseDurationMs("30m"), 1_800_000);
    assert.equal(parseDurationMs("1h"), 3_600_000);
    assert.equal(parseDurationMs("every hour"), null);
    assert.equal(parseDurationMs("0m"), null);
  });

  it("rejects bad names, duplicate names, and bad durations", () => {
    const errors = validateJobs([
      { name: "Bad_Name", interval: "30m", maxRunMs: "1m", description: "x" },
      { name: "dup", interval: "30m", maxRunMs: "1m", description: "x" },
      { name: "dup", interval: "30m", maxRunMs: "1m", description: "x" },
      { name: "ok", interval: "every hour", maxRunMs: "1m", description: "x" },
      { name: "ok2", interval: "30m", maxRunMs: "0m", description: "x" },
    ]);
    assert.equal(errors.length, 4);
  });
});
