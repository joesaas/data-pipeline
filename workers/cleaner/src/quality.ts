/**
 * Quality gate: a raw record must pass here before any LLM call is spent on
 * it. Rules mirror workers/cleaner in joesaas/agentic-news (same pipeline
 * shape): too-short content and obvious marketing/spam never reach the LLM.
 */
export interface QualityResult {
  ok: boolean;
  reason?: string;
}

const SPAM_PATTERNS: RegExp[] = [
  /(免费领取|扫码进群|加微信|点击领取|限时优惠|赚钱项目)/,
  /(casino|赌场|博彩|代孕|刷单)/i,
  /(seo|关键词排名|网站推广服务)/i,
];

export function checkQuality(record: { title: string | null; content: string }): QualityResult {
  const content = (record.content ?? "").trim();
  if (record.title != null && record.title.trim().length > 0 && record.title.trim().length < 4)
    return { ok: false, reason: "title too short" };
  if (content.length < 50) return { ok: false, reason: "content too short" };
  const hay = `${record.title ?? ""} ${content}`;
  for (const pattern of SPAM_PATTERNS) {
    if (pattern.test(hay)) return { ok: false, reason: `spam pattern: ${pattern}` };
  }
  const linkCount = (content.match(/https?:\/\//g) ?? []).length;
  if (linkCount > 10 && content.length < 2000)
    return { ok: false, reason: "link-dense content" };
  return { ok: true };
}
