import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LlmRateLimiter } from "../src/ratelimit.js";
import { CleanerStore } from "../src/store.js";

describe("LlmRateLimiter", () => {
  it("enforces the hourly cap, then frees budget as the window rolls", () => {
    const store = new CleanerStore(":memory:");
    let now = 1_700_000_000_000;
    const limiter = new LlmRateLimiter(store, { perHour: 2, perDay: 500 }, () => now);
    assert.equal(limiter.tryAcquire(), true);
    assert.equal(limiter.tryAcquire(), true);
    assert.equal(limiter.tryAcquire(), false);
    now += 3_600_001; // just past the rolling hour
    assert.equal(limiter.tryAcquire(), true);
    store.close();
  });

  it("enforces the daily cap independently of the hourly one", () => {
    const store = new CleanerStore(":memory:");
    let now = 1_700_000_000_000;
    const limiter = new LlmRateLimiter(store, { perHour: 0, perDay: 2 }, () => now);
    assert.equal(limiter.tryAcquire(), true);
    now += 7_200_000; // 2h later: hourly is disabled, daily still counts
    assert.equal(limiter.tryAcquire(), true);
    assert.equal(limiter.tryAcquire(), false);
    store.close();
  });

  it("persists usage across limiter instances (restart-safe)", () => {
    const store = new CleanerStore(":memory:");
    const now = 1_700_000_000_000;
    assert.equal(new LlmRateLimiter(store, { perHour: 1, perDay: 500 }, () => now).tryAcquire(), true);
    assert.equal(new LlmRateLimiter(store, { perHour: 1, perDay: 500 }, () => now).tryAcquire(), false);
    store.close();
  });
});
