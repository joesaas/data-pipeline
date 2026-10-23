import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROMPT_VERSION = "clean-v4";

const FALLBACK = `你是一名数据清洗员。把输入的资讯简报拆成结构化条目，只输出 JSON：
{"items":[{"title":"...","summary":"...","category":"...","tags":[],"event_date":null,"sources":[{"name":"...","url":"https://..."}]}]}
规则：一条新闻一条目、重复合并；event_date 用事件发生日期、没写填 null、禁止编造；sources 只收原文真实链接；非新闻内容（标题、窗口说明、自查清单）不要做成条目。`;

/** Load prompts/clean.md; try env override, then paths relative to cwd and to this module. */
export function loadCleanPrompt(env: NodeJS.ProcessEnv = process.env): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    env.CLEANER_PROMPT_PATH,
    join(process.cwd(), "prompts/clean.md"),
    join(process.cwd(), "workers/cleaner/prompts/clean.md"),
    join(here, "../../prompts/clean.md"),
  ].filter((p): p is string => typeof p === "string" && p.length > 0);
  for (const path of candidates) {
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  return FALLBACK;
}
