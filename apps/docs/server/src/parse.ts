import type { ParsedHtml } from "../../shared/types.js";

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/** 从 HTML 里抽标题、简介、generator 和纯文本。不引入 DOM 依赖，正则足够覆盖自包含文档页。 */
export function parseHtml(html: string, fallbackTitle: string): ParsedHtml {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "").trim())
    : fallbackTitle;

  const genMatch = html.match(
    /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i,
  ) ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']generator["']/i);
  const generator = genMatch?.[1];

  const descMatch = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i,
  );

  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

  let description = descMatch?.[1]?.trim() ?? "";
  if (!description) {
    // 取正文里标题之后的第一段有意义的文字当简介。
    // 注意：answer-me-with-html 页面的纯文本开头是「标题 → 工具栏文字
    // （主题/图纸/明暗/复制源稿等）→ 标题 → 正文」，工具栏夹在两处标题之间，
    // 所以要在开头一小段内反复切掉标题，才能落到真正的正文。
    let body = text;
    if (title) {
      for (let i = 0; i < 3; i++) {
        const idx = body.indexOf(title);
        if (idx < 0 || idx > 200) break;
        body = body.slice(idx + title.length).trim();
        const next = body.indexOf(title);
        if (next < 0 || next > 100) break;
      }
    }
    description = body.slice(0, 160);
  }

  return { title: title || fallbackTitle, description, generator, text };
}

export function isAnswerMeWithHtml(parsed: ParsedHtml): boolean {
  return /answer me with html/i.test(parsed.generator ?? "");
}
