import type { ExportData, ExportItem } from "./reader.js";

export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Time-decay weight (mirrors @data-pipeline/shared computeWeight):
 *  100 at publish, halving every 48h. Tier 1 >= 50, tier 2 >= 20. */
export function computeWeight(publishedAtIso: string, nowMs: number = Date.now()): number {
  const t = Date.parse(publishedAtIso);
  if (Number.isNaN(t)) return 0;
  const ageHours = Math.max(0, (nowMs - t) / 3_600_000);
  return Math.round(100 * Math.pow(0.5, ageHours / 48));
}
export function weightTier(w: number): number {
  return w >= 50 ? 1 : w >= 20 ? 2 : 3;
}

/** Known categories get hand-picked colors; anything new falls back to a
 *  hash over a palette with no grays (gray read as "disabled"). */
const CATEGORY_COLORS: Record<string, string> = {
  "AI Agent": "#7c5cff",
  "Web3 DeFi": "#0ea5a4",
  "DeFi Protocol": "#3b82f6",
  "区块链技术": "#f59e0b",
};
const FALLBACK_PALETTE = ["#8b5cf6", "#06b6d4", "#f97316", "#22c55e", "#ec4899", "#6366f1"];

export function categoryColor(category: string): string {
  const known = CATEGORY_COLORS[category];
  if (known) return known;
  let hash = 0;
  for (let i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

/** "2026-10-22" -> "2026年10月22日" */
export function fmtZhDate(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return isoDate;
  return `${m[1]}年${Number(m[2])}月${Number(m[3])}日`;
}

const BOOK_ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`;

function head(title: string, cssHref: string, base = "./", showSearch = false, cssVersion = ""): string {
  const versioned = cssVersion ? `${cssHref}?v=${cssVersion}` : cssHref;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<link rel="stylesheet" href="${versioned}" />
</head>
<body>
<header class="topbar">
  <a class="logo" href="${base}"><span class="mark">${BOOK_ICON}</span>Agent 101<span>&nbsp;资讯</span></a>
  ${showSearch ? `<div class="head-search"><input id="q" placeholder="搜索标题、摘要或标签…" /></div>` : ""}
  <div class="spacer"></div>
  <a class="head-link" href="/">文档站</a>
</header>
<main>`;
}

const PAGE_JS = `
<script>
(function () {
  var state = { category: "", scope: "", q: "", gran: "day" };
  var cards = Array.prototype.slice.call(document.querySelectorAll(".news-card"));
  var grid = document.getElementById("grid");
  var count = document.getElementById("count");
  var pageTitle = document.getElementById("pageTitle");
  var HALF_LIFE_H = 48;
  function weightOf(iso) {
    var t = Date.parse(iso);
    if (isNaN(t)) return 0;
    var ageH = Math.max(0, (Date.now() - t) / 3600000);
    return Math.round(100 * Math.pow(0.5, ageH / HALF_LIFE_H));
  }
  function tierOf(w) { return w >= 50 ? 1 : w >= 20 ? 2 : 3; }
  function refreshWeights() {
    cards.forEach(function (el) {
      var badge = el.querySelector("[data-wt]");
      if (!badge) return;
      var w = weightOf(el.dataset.published);
      badge.textContent = "权重 " + w;
      badge.className = "wt wt-" + tierOf(w);
    });
  }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  function ymd(d) { return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); }
  function mondayOf(d) {
    var x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var shift = (x.getDay() + 6) % 7; // Monday = 0
    x.setDate(x.getDate() - shift);
    return x;
  }
  function inScope(iso) {
    if (!state.scope) return true;
    var d = new Date(iso), now = new Date();
    if (state.scope === "day") return ymd(d) === ymd(now);
    if (state.scope === "week") return ymd(mondayOf(d)) === ymd(mondayOf(now));
    if (state.scope === "month") return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    if (state.scope === "year") return d.getFullYear() === now.getFullYear();
    return true;
  }
  function groupKey(iso) {
    var d = new Date(iso);
    if (state.gran === "year") return String(d.getFullYear());
    if (state.gran === "month") return d.getFullYear() + "-" + pad(d.getMonth() + 1);
    if (state.gran === "week") return ymd(mondayOf(d));
    return ymd(d);
  }
  function groupLabel(key) {
    var p = key.split("-");
    if (state.gran === "year") return p[0] + "年";
    if (state.gran === "month") return p[0] + "年" + Number(p[1]) + "月";
    if (state.gran === "week") return Number(p[1]) + "月" + Number(p[2]) + "日当周";
    return p[0] + "年" + Number(p[1]) + "月" + Number(p[2]) + "日";
  }
  function render() {
    var shown = 0;
    grid.querySelectorAll(".group-head").forEach(function (h) { h.remove(); });
    var lastKey = null;
    cards.forEach(function (el) {
      var ok =
        (!state.category || el.dataset.category === state.category) &&
        inScope(el.dataset.published) &&
        (!state.q || el.dataset.search.indexOf(state.q) !== -1);
      el.style.display = ok ? "" : "none";
      if (!ok) return;
      shown++;
      var key = groupKey(el.dataset.published);
      if (key !== lastKey) {
        lastKey = key;
        var h = document.createElement("div");
        h.className = "group-head";
        h.textContent = groupLabel(key);
        grid.insertBefore(h, el);
      }
    });
    if (count) count.textContent = shown + " 条";
    var empty = document.getElementById("emptyFilter");
    if (empty) empty.style.display = shown === 0 && cards.length > 0 ? "" : "none";
  }
  function wireGroup(name, key, after) {
    var box = document.querySelector('[data-group="' + name + '"]');
    if (!box) return;
    box.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-value]");
      if (!btn) return;
      state[key] = btn.dataset.value;
      box.querySelectorAll(".side-item").forEach(function (c) { c.classList.toggle("on", c === btn); });
      if (after) after(btn);
      render();
    });
  }
  wireGroup("category", "category", function (btn) {
    if (pageTitle) {
      var label = btn.querySelector(".flex");
      pageTitle.textContent = label ? label.textContent : "全部资讯";
    }
  });
  wireGroup("scope", "scope");
  var seg = document.querySelector("[data-gran-group]");
  if (seg) {
    seg.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-gran]");
      if (!btn) return;
      state.gran = btn.dataset.gran;
      seg.querySelectorAll(".seg-btn").forEach(function (c) { c.classList.toggle("on", c === btn); });
      render();
    });
  }
  var input = document.getElementById("q");
  if (input) input.addEventListener("input", function () { state.q = input.value.trim().toLowerCase(); render(); });
  refreshWeights();
  render();
})();
</script>`;

function sideItem(opts: { value: string; label: string; count?: number; color?: string; on?: boolean }): string {
  return `<button type="button" class="side-item${opts.on ? " on" : ""}" data-value="${esc(opts.value)}">${
    opts.color ? `<span class="dot" style="background:${opts.color}"></span>` : ""
  }<span class="flex">${esc(opts.label)}</span>${
    opts.count !== undefined ? `<span class="cnt">${opts.count}</span>` : ""
  }</button>`;
}

function weightBadge(item: ExportItem): string {
  const w = computeWeight(item.cleaned_at);
  return `<span class="wt wt-${weightTier(w)}" data-wt>权重 ${w}</span>`;
}

export function renderIndex(data: ExportData, generatedAt: string, cssVersion = ""): string {
  const sidebar = `<aside>
  <nav>
    <div data-group="category">
      ${sideItem({ value: "", label: "全部资讯", count: data.items.length, color: "#7c5cff", on: true })}
      ${data.categories.map((c) => sideItem({ value: c.name, label: c.name, count: c.count, color: categoryColor(c.name) })).join("\n      ")}
    </div>
    <div class="side-title">时间</div>
    <div data-group="scope">
      ${sideItem({ value: "", label: "全部时间", on: true })}
      ${sideItem({ value: "day", label: "今天" })}
      ${sideItem({ value: "week", label: "本周" })}
      ${sideItem({ value: "month", label: "本月" })}
      ${sideItem({ value: "year", label: "今年" })}
    </div>
  </nav>
</aside>`;

  const cards = data.items
    .map((item) => {
      const search = `${item.title} ${item.summary} ${item.tags.join(" ")}`.toLowerCase();
      const displayDate = item.event_date ?? item.cleaned_at.slice(0, 10);
      return `<a class="news-card" href="item/${encodeURIComponent(item.id)}/" data-category="${esc(item.category)}" data-published="${esc(item.cleaned_at)}" data-search="${esc(search)}">
  <div class="card-top">
    <span class="pill" style="background:${categoryColor(item.category)}">${esc(item.category)}</span>
    ${item.sources[0] ? `<span class="pill-gray">${esc(item.sources[0].name)}</span>` : ""}
    ${weightBadge(item)}
  </div>
  <div class="card-title">${esc(item.title)}</div>
  <p class="card-sum">${esc(item.summary)}</p>
  <div class="card-foot"><span>${esc(fmtZhDate(displayDate))}</span>${item.source_agent ? `<span>${esc(item.source_agent)}</span>` : ""}</div>
</a>`;
    })
    .join("\n");

  return `${head("Agent 101 资讯 · 全部资讯", "./styles.css", "./", true, cssVersion)}
<div class="layout">
${sidebar}
<section class="content">
  <div class="page-head">
    <h1 id="pageTitle">全部资讯</h1><span class="muted" id="count">${data.items.length} 条</span>
    <div class="seg" data-gran-group>
      <button type="button" class="seg-btn on" data-gran="day">日</button><button type="button" class="seg-btn" data-gran="week">周</button><button type="button" class="seg-btn" data-gran="month">月</button><button type="button" class="seg-btn" data-gran="year">年</button>
    </div>
  </div>
  ${
    data.items.length === 0
      ? `<div class="card empty"><p>这里还没有资讯</p><p class="muted">新的简报清洗完成后会自动出现在这里</p></div>`
      : `<div class="grid" id="grid">\n${cards}\n</div>
  <div class="card empty" id="emptyFilter" style="display:none"><p>这个筛选下没有资讯</p><p class="muted">换个分类、时间范围或清除搜索试试</p></div>`
  }
</section>
</div>
</main>
${PAGE_JS}
</body>
</html>
`;
}

export function renderItem(item: ExportItem, publicApiPath: string, cssVersion = ""): string {
  const tags = item.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  const detail = item.detail
    ? `<h2>细节</h2><div class="card"><p class="summary">${esc(item.detail)}</p></div>`
    : "";
  const sources =
    item.sources.length > 0
      ? `<h2>来源</h2><div class="card srclist">${item.sources
          .map((s) => `<div><a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.name || s.url)}</a></div>`)
          .join("")}</div>`
      : "";
  const displayDate = item.event_date ?? item.cleaned_at.slice(0, 10);
  return `${head(item.title, "../../styles.css", "../../", false, cssVersion)}
<p class="muted"><a href="../../" style="color:var(--accent-strong)">← 返回列表</a></p>
<div class="card-top" style="margin-top:12px">
  <span class="pill" style="background:${categoryColor(item.category)}">${esc(item.category)}</span>
  ${item.sources[0] ? `<span class="pill-gray">${esc(item.sources[0].name)}</span>` : ""}
  ${weightBadge(item)}
</div>
<h1 style="line-height:1.45;font-size:22px;margin-top:12px">${esc(item.title)}</h1>
<p class="muted">${esc(fmtZhDate(displayDate))}${item.event_date ? " · 事件日期" : ""}</p>
<div style="margin:10px 0">${tags}</div>
<h2>摘要</h2>
<div class="card"><p class="summary">${esc(item.summary)}</p></div>
${detail}
${sources}
<p class="muted" style="margin-top:24px">由 ${esc(item.provider)} / ${esc(item.model)} 于 ${esc(fmtDateTime(item.cleaned_at))} 清洗${item.source_agent ? ` · 推送 agent ${esc(item.source_agent)}` : ""} · 原始记录 <a href="${esc(publicApiPath)}/api/v1/records/${encodeURIComponent(item.source_record_id)}" target="_blank" rel="noreferrer" style="color:var(--accent-strong)">${esc(item.source_record_id.slice(0, 8))}…</a></p>
</main>
</body>
</html>
`;
}
