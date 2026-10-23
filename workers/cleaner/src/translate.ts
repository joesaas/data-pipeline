import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranslationZh } from "@data-pipeline/shared";
import { extractJson } from "./validate.js";

export const TRANSLATE_PROMPT_VERSION = "translate-v1";

const FALLBACK = `你是一名科技新闻翻译。把输入 JSON 数组里每条的 title 和 summary 翻译成简体中文，只输出 JSON：
{"items":[{"id":"原样返回输入的 id","title_zh":"...","summary_zh":"..."}]}
规则：专有名词（项目/协议/公司名、仓库名、代币符号、人名）保留原文；译文通顺简洁，不增删事实；已经是中文的字段原样返回。`;

/** Load prompts/translate.md, mirroring loadCleanPrompt's lookup order. */
export function loadTranslatePrompt(env: NodeJS.ProcessEnv = process.env): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.CLEANER_TRANSLATE_PROMPT_PATH,
    join(process.cwd(), "prompts/translate.md"),
    join(process.cwd(), "workers/cleaner/prompts/translate.md"),
    join(here, "../../prompts/translate.md"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return FALLBACK;
}

const CJK = /[\u3400-\u9fff]/g;

/** True when CJK characters make up at least half of the CJK+Latin letters. */
export function isMostlyChinese(text: string): boolean {
  const cjk = (text.match(CJK) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk > 0 && cjk >= latin;
}

/** An item needs translation when its title+summary are not already Chinese. */
export function needsTranslation(title: string, summary: string): boolean {
  return !isMostlyChinese(`${title} ${summary}`);
}

/** Parse a batched translation response; unknown ids and empty fields are dropped. */
export function parseTranslations(raw: unknown, wantedIds: Set<string>): Map<string, TranslationZh> {
  const root = raw as { items?: unknown };
  if (!root || !Array.isArray(root.items)) throw new Error("translation output has no items array");
  const out = new Map<string, TranslationZh>();
  for (const entry of root.items) {
    const e = entry as Record<string, unknown>;
    const id = typeof e?.id === "string" ? e.id : "";
    if (!id || !wantedIds.has(id) || out.has(id)) continue;
    const title = typeof e.title_zh === "string" ? e.title_zh.trim() : "";
    const summary = typeof e.summary_zh === "string" ? e.summary_zh.trim() : "";
    if (!title && !summary) continue;
    out.set(id, { title, summary });
  }
  return out;
}

export function parseTranslationResponse(text: string, wantedIds: Set<string>): Map<string, TranslationZh> {
  return parseTranslations(extractJson(text), wantedIds);
}
