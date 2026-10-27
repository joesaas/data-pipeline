/**
 * LLM provider abstraction (dependency inversion): the pipeline depends on
 * this interface only, never on a concrete vendor.
 *
 * Two implementations:
 * - OpenAiCompatibleProvider: any /chat/completions endpoint (OpenRouter by
 *   default; OpenAI, DeepSeek etc. by changing LLM_BASE_URL / LLM_MODEL).
 * - MockProvider: deterministic heading-split heuristic, used when no
 *   LLM_API_KEY is set so the service runs end-to-end without a key.
 *   Its output is marked provider="mock" in storage — never pass it off
 *   as LLM output.
 */
import type { CleanedItem, RawRecord, TranslationZh } from "@data-pipeline/shared";
import { canonicalCategory, extractJson, SOURCE_CATEGORY, validateCleanedItems } from "./validate.js";
import { parseTranslationResponse } from "./translate.js";

export interface TranslateEntry {
  id: string;
  title: string;
  summary: string;
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  clean(record: RawRecord, systemPrompt: string): Promise<CleanedItem[]>;
  /** One batched call translating many items at once (per cleaning round). */
  translate(entries: TranslateEntry[], systemPrompt: string): Promise<Map<string, TranslationZh>>;
}

type FetchFn = typeof fetch;

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly name = "openai-compatible";
  constructor(
    private readonly opts: { baseUrl: string; apiKey: string; model: string },
    private readonly fetchFn: FetchFn = fetch,
  ) {}
  get model(): string {
    return this.opts.model;
  }

  async clean(record: RawRecord, systemPrompt: string): Promise<CleanedItem[]> {
    const user = `记录标题：${record.title ?? "(无标题)"}\n来源 Agent：${record.source_agent}\n\n正文：\n${record.content}`;
    let lastError: Error | null = null;
    // One retry: first without response_format if the endpoint rejected it, then once more as-is.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const text = await this.chat(systemPrompt, user, attempt === 0);
        const { items } = validateCleanedItems(extractJson(text), {
          forceCategory: SOURCE_CATEGORY[record.source_agent],
        });
        return items;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new Error("LLM call failed");
  }

  async translate(entries: TranslateEntry[], systemPrompt: string): Promise<Map<string, TranslationZh>> {
    if (entries.length === 0) return new Map();
    const wanted = new Set(entries.map((e) => e.id));
    const user = JSON.stringify(entries.map((e) => ({ id: e.id, title: e.title, summary: e.summary })));
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const text = await this.chat(systemPrompt, user, attempt === 0);
        return parseTranslationResponse(text, wanted);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw lastError ?? new Error("translation call failed");
  }

  private async chat(system: string, user: string, withFormat: boolean): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      temperature: 0.1,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    };
    if (withFormat) body.response_format = { type: "json_object" };
    const res = await this.fetchFn(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.opts.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`LLM HTTP ${res.status}: ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("LLM response has no message content");
    return content;
  }
}

/** Heuristic fallback: split a markdown brief on ### headings into items. */
export class MockProvider implements LlmProvider {
  readonly name = "mock";
  readonly model = "heading-split-v1";

  /** The mock never translates; items stay untranslated (translation_zh NULL). */
  async translate(): Promise<Map<string, TranslationZh>> {
    return new Map();
  }

  async clean(record: RawRecord): Promise<CleanedItem[]> {
    const lines = record.content.split("\n");
    const items: CleanedItem[] = [];
    let category = "Other";
    let current: { title: string; body: string[]; category: string } | null = null;
    const flush = () => {
      if (!current) return;
      const bodyText = current.body.join("\n").trim();
      const summary =
        bodyText
          .split(/\n\s*\n/)
          .map((p) => p.replace(/\*\*/g, "").trim())
          .find((p) => p.length > 0)
          ?.slice(0, 300) ?? current.title;
      const sources = [...bodyText.matchAll(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g)].map((m) => ({
        name: m[1],
        url: m[2],
      }));
      items.push({
        title: current.title,
        summary,
        category: current.category,
        tags: [],
        event_date: null,
        sources,
      });
      current = null;
    };
    for (const line of lines) {
      const section = line.match(/^##\s+(.+)/);
      const heading = line.match(/^###\s+(?:\d+[.、]\s*)?(.+)/);
      if (heading) {
        flush();
        current = { title: heading[1].replace(/\*\*/g, "").trim(), body: [], category };
      } else if (section && !line.startsWith("###")) {
        flush();
        category = section[1].replace(/^[A-Z][.、]\s*/, "").trim() || category;
      } else if (current) {
        current.body.push(line);
      }
    }
    flush();
    if (items.length === 0) {
      items.push({
        title: record.title ?? "未命名记录",
        summary: record.content.trim().slice(0, 300),
        category,
        tags: [],
        event_date: null,
        sources: [],
      });
    }
    const forced = SOURCE_CATEGORY[record.source_agent];
    return items.map((item) => ({ ...item, category: forced ?? canonicalCategory(item.category) }));
  }
}

export function createLlmProvider(env: NodeJS.ProcessEnv, fetchFn: FetchFn = fetch): LlmProvider {
  const apiKey = env.LLM_API_KEY?.trim();
  if (apiKey) {
    return new OpenAiCompatibleProvider(
      {
        baseUrl: env.LLM_BASE_URL?.trim() || "https://openrouter.ai/api/v1",
        apiKey,
        model: env.LLM_MODEL?.trim() || "openai/gpt-4o-mini",
      },
      fetchFn,
    );
  }
  return new MockProvider();
}
