import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  cronMinuteKey,
  isCronDue,
  isPullTaskDue,
  matchesCron,
  parseCron,
  previousCronOccurrence,
} from "@data-pipeline/shared";

// Shanghai is UTC+8 with no DST, so these UTC instants have exact
// Shanghai wall-clock times: 2026-10-25 is a Sunday in both zones.
const SUN_09_SHANGHAI = new Date("2026-10-25T01:00:00.000Z"); // 09:00 CST, Sunday
const SUN_09_UTC = new Date("2026-10-25T09:00:00.000Z"); // 17:00 CST, Sunday
const SUN_10_SHANGHAI = new Date("2026-10-25T02:00:00.000Z"); // 10:00 CST
const MON_09_SHANGHAI = new Date("2026-10-26T01:00:00.000Z"); // 09:00 CST, Monday

describe("cron: parsing", () => {
  it("accepts *, steps, ranges, lists and n/step", () => {
    assert.ok(parseCron("* * * * *"));
    assert.ok(parseCron("*/30 * * * *"));
    assert.ok(parseCron("0 9-17 * * 1-5"));
    assert.ok(parseCron("0 9,18 * * *"));
    assert.ok(parseCron("0 9 * * 0"));
    assert.equal(parseCron("0 9 * * 7")?.dayOfWeek.has(0), true);
    assert.ok(parseCron("15 2/6 * * *"));
  });

  it("rejects wrong field counts, out-of-range values and bad steps", () => {
    assert.equal(parseCron(""), null);
    assert.equal(parseCron("0 9 * *"), null);
    assert.equal(parseCron("0 9 * * * *"), null);
    assert.equal(parseCron("60 * * * *"), null);
    assert.equal(parseCron("0 24 * * *"), null);
    assert.equal(parseCron("0 9 32 * *"), null);
    assert.equal(parseCron("0 9 * 13 *"), null);
    assert.equal(parseCron("0 9 * * 8"), null);
    assert.equal(parseCron("*/0 * * * *"), null);
    assert.equal(parseCron("0 9 * * Mon"), null);
    assert.equal(parseCron("0 9 * * 5-2"), null);
    assert.equal(parseCron("0 9 * * foo"), null);
  });
});

describe("cron: matching in Asia/Shanghai time", () => {
  it("09:00 Shanghai matches '0 9 * * *', 09:00 UTC does not", () => {
    const cron = parseCron("0 9 * * *")!;
    assert.equal(matchesCron(cron, SUN_09_SHANGHAI), true);
    assert.equal(matchesCron(cron, SUN_09_UTC), false);
    assert.equal(matchesCron(cron, SUN_10_SHANGHAI), false);
  });

  it("weekday field uses Shanghai weekday", () => {
    const weekday = parseCron("0 9 * * 1")!;
    assert.equal(matchesCron(weekday, SUN_09_SHANGHAI), false);
    assert.equal(matchesCron(weekday, MON_09_SHANGHAI), true);
  });

  it("dom/dow: either restricted field matching fires, both restricted is OR", () => {
    const cron = parseCron("0 9 25 * 1")!;
    // 25th (Sunday) matches via dom; Monday 26th matches via dow.
    assert.equal(matchesCron(cron, SUN_09_SHANGHAI), true);
    assert.equal(matchesCron(cron, MON_09_SHANGHAI), true);
    // A Tuesday the 27th matches neither.
    assert.equal(matchesCron(cron, new Date("2026-10-27T01:00:00.000Z")), false);
  });

  it("steps and lists", () => {
    assert.equal(matchesCron(parseCron("*/30 * * * *")!, SUN_09_SHANGHAI), true);
    assert.equal(matchesCron(parseCron("0 9,18 * * *")!, SUN_10_SHANGHAI), false);
    assert.equal(matchesCron(parseCron("0 9,18 * * *")!, new Date("2026-10-25T10:00:00.000Z")), true);
  });
});

describe("cron: due + same-minute suppression", () => {
  it("fires when the minute matches and nothing fired this minute", () => {
    const cron = parseCron("0 9 * * *")!;
    assert.equal(isCronDue(cron, SUN_09_SHANGHAI, null), true);
    assert.equal(isCronDue(cron, SUN_09_SHANGHAI, "2026-10-25T00:30:00.000Z"), true);
  });

  it("does not double-fire within the same Shanghai minute", () => {
    const cron = parseCron("* * * * *")!;
    // Now is 09:00:45 Shanghai; a fire at 09:00:10 Shanghai is the same minute.
    const now = new Date("2026-10-25T01:00:45.000Z");
    assert.equal(isCronDue(cron, now, "2026-10-25T01:00:10.000Z"), false);
    // A fire at 08:59:50 Shanghai is the previous minute, so it may fire again.
    assert.equal(isCronDue(cron, now, "2026-10-25T00:59:50.000Z"), true);
  });

  it("does not fire when the minute does not match, even with no last fire", () => {
    assert.equal(isCronDue(parseCron("0 9 * * *")!, SUN_10_SHANGHAI, null), false);
  });

  it("cronMinuteKey is Shanghai wall-clock time", () => {
    assert.equal(cronMinuteKey(SUN_09_SHANGHAI), "10/25 09:00");
    assert.equal(cronMinuteKey(SUN_09_UTC), "10/25 17:00");
  });
});

describe("cron: pull-task due (previous occurrence beats last run)", () => {
  it("finds the most recent occurrence, in Shanghai time", () => {
    const cron = parseCron("0 9 * * *")!;
    // Now is 09:07 Shanghai: previous occurrence is today 09:00 Shanghai.
    assert.equal(
      previousCronOccurrence(cron, new Date("2026-10-25T01:07:00.000Z"))?.toISOString(),
      "2026-10-25T01:00:00.000Z",
    );
    // Now is 08:30 Shanghai: previous occurrence is yesterday 09:00 Shanghai.
    assert.equal(
      previousCronOccurrence(cron, new Date("2026-10-25T00:30:00.000Z"))?.toISOString(),
      "2026-10-24T01:00:00.000Z",
    );
  });

  it("due when the previous occurrence is after the last run, even minutes late", () => {
    const cron = parseCron("0 9 * * *")!;
    const now = new Date("2026-10-25T01:07:00.000Z"); // 09:07 Shanghai
    assert.equal(isPullTaskDue(cron, now, null), true);
    assert.equal(isPullTaskDue(cron, now, "2026-10-24T01:05:00.000Z"), true);
    // Ran at 09:02 Shanghai, after today's 09:00 occurrence: not due again.
    assert.equal(isPullTaskDue(cron, now, "2026-10-25T01:02:00.000Z"), false);
  });

  it("a cron rarer than the 7-day lookback is not immediately due", () => {
    const cron = parseCron("0 0 29 2 *")!;
    assert.equal(previousCronOccurrence(cron, SUN_09_SHANGHAI, 60), null);
    assert.equal(isPullTaskDue(cron, SUN_09_SHANGHAI, null), false);
  });
});

describe("pull-task scheduler: one pending row per occurrence", () => {
  // Imported lazily to keep this file's cron tests independent of the
  // scheduler module's node:sqlite import in non-node runners.
  it("queues the latest occurrence once, skips inactive/invalid/existing", async () => {
    const { tasksToSchedule } = await import("../src/pull-task-scheduler.js");
    const now = new Date("2026-10-25T01:07:00.000Z"); // 09:07 Shanghai
    const tasks = [
      { id: 1, name: "daily", prompt: "p", cron: "0 9 * * *", target: "muse", is_active: true },
      { id: 2, name: "off", prompt: "p", cron: "0 9 * * *", target: "muse", is_active: false },
      { id: 3, name: "bad", prompt: "p", cron: "nope", target: "muse", is_active: true },
      { id: 4, name: "rare", prompt: "p", cron: "0 0 29 2 *", target: "muse", is_active: true },
    ];
    // No existing rows: only the daily task queues, for today 09:00 Shanghai.
    const first = tasksToSchedule(tasks, new Set(), now);
    assert.deepEqual(first, [
      {
        pull_task_id: 1,
        pull_task_name: "daily",
        target: "muse",
        prompt: "p",
        due_at: "2026-10-25T01:00:00.000Z",
      },
    ]);
    // The same occurrence already queued (any status): nothing new.
    const second = tasksToSchedule(tasks, new Set(["1|2026-10-25T01:00:00.000Z"]), now);
    assert.deepEqual(second, []);
  });
});
