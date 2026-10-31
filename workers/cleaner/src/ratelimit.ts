import type { CleanerStoreLike } from "./store.js";

export interface LlmRateLimits {
  /** Max real LLM calls in any rolling 60 minutes. <= 0 disables. */
  perHour: number;
  /** Max real LLM calls in any rolling 24 hours. <= 0 disables. */
  perDay: number;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/**
 * Rolling-window LLM budget, backed by the cleaner's llm_calls log so it
 * survives restarts. tryAcquire() records the call when it grants budget —
 * a failed provider call still consumed provider quota, so it stays counted.
 */
export class LlmRateLimiter {
  constructor(
    private readonly store: CleanerStoreLike,
    readonly limits: LlmRateLimits,
    private readonly now: () => number = Date.now,
  ) {}

  async usage(): Promise<{ lastHour: number; lastDay: number }> {
    const t = this.now();
    return {
      lastHour: await this.store.countLlmCalls(t - HOUR_MS),
      lastDay: await this.store.countLlmCalls(t - DAY_MS),
    };
  }

  async tryAcquire(): Promise<boolean> {
    const { perHour, perDay } = this.limits;
    const u = await this.usage();
    if (perHour > 0 && u.lastHour >= perHour) return false;
    if (perDay > 0 && u.lastDay >= perDay) return false;
    const t = this.now();
    await this.store.recordLlmCall(t);
    await this.store.pruneLlmCalls(t - DAY_MS);
    return true;
  }
}
