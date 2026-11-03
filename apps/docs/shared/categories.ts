import type { Category, CategoryId } from "./types.js";

/**
 * 分类列表是稳定的：顺序、id 都写死在代码里，不随数据增减而漂移。
 * 前后端共用这一份定义（侧边栏顺序 = 这里的顺序）。
 */
export const CATEGORIES: Category[] = [
  {
    id: "agent",
    label: "Agent",
    labelEn: "Agent",
    description: "AI Agent、A2A、智能体协议与产品",
    color: "#7c5cff",
    keywords: [
      "agent", "agents", "a2a", "ap2", "x402", "acp", "智能体", "mcp",
      "personal agent", "coinbase for agents", "agent payments",
    ],
  },
  {
    id: "defi",
    label: "DeFi",
    labelEn: "DeFi",
    description: "去中心化金融、LP、借贷、交易协议",
    color: "#0ea371",
    keywords: [
      "defi", "lp", "amm", "uniswap", "kamino", "借贷", "流动性",
      "收益率", "vault", "金库", "swap", "永续", "dex", "agoreum",
    ],
  },
  {
    id: "blockchain",
    label: "Blockchain",
    labelEn: "Blockchain",
    description: "公链、扩容、链上基础设施",
    color: "#e08600",
    keywords: [
      "blockchain", "区块链", "公链", "solana", "ethereum", "以太坊",
      "ankr", "rpc", "layer 2", "l2", "rollup", "共识", "validator",
    ],
  },
  {
    id: "protocol",
    label: "协议",
    labelEn: "Protocol",
    description: "协议设计、支付协议、通信协议",
    color: "#1d6fd1",
    keywords: [
      "protocol", "协议", "app", "okx app", "escrow", "托管", "结算",
      "xmtp", "支付协议", "intent",
    ],
  },
  {
    id: "security",
    label: "安全",
    labelEn: "Security",
    description: "安全框架、认证授权、攻防",
    color: "#d13b3b",
    keywords: [
      "security", "安全", "oauth", "pkce", "slowmist", "审计", "漏洞",
      "攻击", "认证", "授权", "加密", "签名", "exploit",
    ],
  },
  {
    id: "network",
    label: "网络",
    labelEn: "Network",
    description: "TCP/HTTP/WebSocket 等网络基础",
    color: "#0e7490",
    keywords: [
      "tcp", "udp", "http", "websocket", "三次握手", "网络", "tls",
      "dns", "grpc", "连接",
    ],
  },
  {
    id: "engineering",
    label: "工程",
    labelEn: "Engineering",
    description: "软件工程、架构与开发实践",
    color: "#5b6472",
    keywords: [
      "engineering", "架构", "工程", "typescript", "node", "性能",
      "数据库", "缓存", "部署",
    ],
  },
  {
    id: "other",
    label: "其他",
    labelEn: "Other",
    description: "未归入以上分类的文档",
    color: "#8a8f98",
    keywords: [],
  },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id) as CategoryId[];

export function isCategoryId(v: unknown): v is CategoryId {
  return typeof v === "string" && (CATEGORY_IDS as string[]).includes(v);
}

export function getCategory(id: CategoryId): Category {
  return CATEGORIES.find((c) => c.id === id) ?? CATEGORIES[CATEGORIES.length - 1];
}

/**
 * 按关键词给标题 + 正文打分，返回得分最高的分类。
 * 标题命中权重是正文的 3 倍；全无命中时落到 other。
 */
export function suggestCategory(title: string, text: string): {
  category: CategoryId;
  scores: Partial<Record<CategoryId, number>>;
} {
  const t = title.toLowerCase();
  const body = text.toLowerCase().slice(0, 20000);
  const scores: Partial<Record<CategoryId, number>> = {};
  for (const cat of CATEGORIES) {
    if (cat.id === "other") continue;
    let score = 0;
    for (const kw of cat.keywords) {
      const k = kw.toLowerCase();
      if (t.includes(k)) score += 3;
      // 正文只计前两次出现，避免长文把分数冲爆
      const first = body.indexOf(k);
      if (first >= 0) score += 1;
      if (first >= 0 && body.indexOf(k, first + k.length) >= 0) score += 1;
    }
    if (score > 0) scores[cat.id] = score;
  }
  let best: CategoryId = "other";
  let bestScore = 0;
  for (const cat of CATEGORIES) {
    const s = scores[cat.id] ?? 0;
    if (s > bestScore) {
      bestScore = s;
      best = cat.id;
    }
  }
  return { category: best, scores };
}
