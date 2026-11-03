export type CategoryId =
  | "agent"
  | "defi"
  | "blockchain"
  | "protocol"
  | "security"
  | "network"
  | "engineering"
  | "other";

export interface Category {
  id: CategoryId;
  label: string;
  labelEn: string;
  description: string;
  /** Tailwind-friendly hex used for chips / accents */
  color: string;
  /** lowercase keywords for auto-classification (title + body text) */
  keywords: string[];
}

export type DocSource = "upload" | "answer-me-with-html" | "import";

export interface DocMeta {
  id: string;
  title: string;
  description: string;
  category: CategoryId;
  tags: string[];
  source: DocSource;
  /** generator meta from the HTML, e.g. "Answer me with HTML 0.5.0" */
  generator?: string;
  originalName: string;
  fileName: string;
  size: number;
  createdAt: string;
  updatedAt: string;
  /** sha256(html)，AI 接口按内容去重用；老数据可能缺失，按需回算 */
  contentHash?: string;
  /** AI 侧的稳定标识：同一 externalId 再次提交 = 覆盖更新（upsert） */
  externalId?: string;
}

export interface ParsedHtml {
  title: string;
  description: string;
  generator?: string;
  /** plain text used for search + auto-classification */
  text: string;
}

export interface CategoryWithCount extends Category {
  count: number;
}
