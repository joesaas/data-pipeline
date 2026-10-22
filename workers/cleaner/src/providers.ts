/**
 * LLM provider abstraction (dependency inversion): the cleaning pipeline
 * depends on this interface only, never on a concrete vendor SDK.
 *
 * Status: NO concrete provider is wired yet. Which LLM to use is an open
 * decision (2026-10-22); createLlmProvider returns null until one is chosen
 * and implemented here.
 */
import type { RawRecord } from "@data-pipeline/shared";

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  /** Turn one raw record into structured cleaned items (shape: packages/shared CleanedItem, draft v0). */
  clean(record: RawRecord): Promise<unknown[]>;
}

export function createLlmProvider(env: NodeJS.ProcessEnv): LlmProvider | null {
  if (!env.LLM_API_KEY) return null;
  // A key is set but no provider implementation exists yet.
  return null;
}
