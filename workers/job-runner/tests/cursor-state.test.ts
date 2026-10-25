import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  defaultState,
  loadState,
  resolveIntervalMinutes,
  saveState,
  shouldTrigger,
  stateFilePath,
} from "../src/cursor-state.js";

describe("cursor-state", () => {
  it("missing or corrupt file behaves like never triggered", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-cursor-state-"));
    try {
      const missing = loadState(join(dir, "nope.json"));
      assert.deepEqual(missing, defaultState());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("save/load round-trips, and a bad interval is dropped", () => {
    const dir = mkdtempSync(join(tmpdir(), "dp-cursor-state-"));
    try {
      const path = join(dir, "state.json");
      saveState(path, { lastTriggeredAt: "2026-10-25T00:00:00.000Z", intervalMinutes: 30 });
      assert.deepEqual(loadState(path), {
        lastTriggeredAt: "2026-10-25T00:00:00.000Z",
        intervalMinutes: 30,
      });
      saveState(path, { lastTriggeredAt: null, intervalMinutes: 0 });
      assert.equal(loadState(path).intervalMinutes, null);
      const raw = JSON.parse(readFileSync(path, "utf8")) as { intervalMinutes: number };
      assert.equal(raw.intervalMinutes, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shouldTrigger: never, recent, elapsed, unusable timestamp", () => {
    const now = new Date("2026-10-25T10:00:00.000Z");
    assert.equal(shouldTrigger(defaultState(), 60, now), true);
    assert.equal(
      shouldTrigger({ lastTriggeredAt: "2026-10-25T09:30:00.000Z", intervalMinutes: null }, 60, now),
      false,
    );
    assert.equal(
      shouldTrigger({ lastTriggeredAt: "2026-10-25T09:00:00.000Z", intervalMinutes: null }, 60, now),
      true,
    );
    assert.equal(
      shouldTrigger({ lastTriggeredAt: "not-a-date", intervalMinutes: null }, 60, now),
      true,
    );
  });

  it("resolveIntervalMinutes: console override wins, else env, else 60, clamped >= 1", () => {
    assert.equal(resolveIntervalMinutes({ lastTriggeredAt: null, intervalMinutes: 15 }, {}), 15);
    assert.equal(
      resolveIntervalMinutes(
        { lastTriggeredAt: null, intervalMinutes: 15 },
        { CURSOR_TRIGGER_INTERVAL_MINUTES: "30" },
      ),
      15,
    );
    assert.equal(
      resolveIntervalMinutes({ lastTriggeredAt: null, intervalMinutes: null }, {
        CURSOR_TRIGGER_INTERVAL_MINUTES: "30",
      }),
      30,
    );
    assert.equal(resolveIntervalMinutes(defaultState(), {}), 60);
    assert.equal(
      resolveIntervalMinutes(defaultState(), { CURSOR_TRIGGER_INTERVAL_MINUTES: "0" }),
      60,
    );
  });

  it("stateFilePath: env file wins, else package-relative", () => {
    assert.equal(
      stateFilePath("/srv/app/.env", "/srv/app/workers/job-runner/dist/src/jobs"),
      join("/srv/app", "workers/job-runner/data/cursor-trigger-state.json"),
    );
    assert.equal(
      stateFilePath(null, "/srv/app/workers/job-runner/dist/src/jobs"),
      join("/srv/app/workers/job-runner/data/cursor-trigger-state.json"),
    );
  });
});
