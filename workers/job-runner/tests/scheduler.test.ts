import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import Bree from "bree";

/**
 * Proves the guarantees the runner is built on, against real Bree:
 * 1. Independence: a throwing job's worker thread dies, the good job
 *    keeps ticking and the scheduler stays alive.
 * 2. Automatic recovery: a failed job is retried on its next tick, and
 *    a hung job is terminated after closeWorkerAfterMs and retried too.
 */
describe("scheduler isolation (real Bree)", () => {
  it("crashing and hanging jobs do not stop other jobs; both are retried", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-job-runner-"));
    const outFile = join(dir, "ok-count.txt");
    writeFileSync(join(dir, "ok.js"), `require("node:fs").appendFileSync(${JSON.stringify(outFile)}, "ok\\n");`);
    writeFileSync(join(dir, "boom.js"), `throw new Error("boom");`);
    writeFileSync(join(dir, "hang.js"), `setTimeout(() => {}, 60000);`);
    const failures: string[] = [];
    const bree = new Bree({
      root: dir,
      logger: false,
      jobs: [
        { name: "ok", interval: 1000 },
        { name: "boom", interval: 1000 },
        { name: "hang", interval: 1000, closeWorkerAfterMs: 1200 },
      ],
      errorHandler: (error, data) => {
        failures.push(`${data.name}:${error instanceof Error ? error.message : String(error)}`);
      },
    });
    await bree.start();
    try {
      await new Promise((r) => setTimeout(r, 4600));
    } finally {
      await bree.stop();
    }
    const okRuns = readFileSync(outFile, "utf8").trim().split("\n").filter(Boolean).length;
    assert.ok(okRuns >= 3, `good job should tick repeatedly while other jobs fail/hang (got ${okRuns})`);
    assert.ok(failures.filter((f) => f.startsWith("boom:")).length >= 2, `bad job should fail and be retried each tick (${failures})`);
    assert.ok(failures.some((f) => f.startsWith("hang:")), `hung job should be terminated and reported (${failures})`);
    rmSync(dir, { recursive: true, force: true });
  });
});
