import type { ExportData, ExportItem } from "./reader.js";

export function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const IMPORTANCE_LABEL: Record<string, string> = { high: "高", medium: "中", low: "低" };

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("zh-CN", { hour12: false });
}

/** Category accent colors, from the agent101.uk palette family. */
const CATEGORY_PALETTE = ["#7c5cff", "#0ea5a4", "#f59e0b", "#3b82f6", "#ef4444", "#06b6d4", "#71717a"];

export function categoryColor(category: string): string {
  let hash = 0;
  for (let i = 0; i < category.length; i++) hash = (hash * 31 + category.charCodeAt(i)) >>> 0;
  return CATEGORY_PALETTE[hash % CATEGORY_PALETTE.length];
}

const BOOK_ICON = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`;

function head(title: string, cssHref: string, base = "./", showSearch = false): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<link rel="stylesheet" href="${cssHref}" />
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

const FILTER_JS = `
<script>
(function () {
  var state = { category: "", importance: "", q: "" };
  var items = Array.prototype.slice.call(document.querySelectorAll(".news-card"));
  var count = document.getElementById("count");
  var pageTitle = document.getElementById("pageTitle");
  function apply() {
    var shown = 0;
    items.forEach(function (el) {
      var ok =
        (!state.category || el.dataset.category === state.category) &&
        (!state.importance || el.dataset.importance === state.importance) &&
        (!state.q || el.dataset.search.indexOf(state.q) !== -1);
      el.style.display = ok ? "" : "none";
      if (ok) shown++;
    });
    if (count) count.textContent = shown + " 条";
    var empty = document.getElementById("emptyFilter");
    if (empty) empty.style.display = shown === 0 && items.length > 0 ? "" : "none";
  }
  function wire(group, key) {
    var box = document.querySelector('[data-group="' + group + '"]');
    if (!box) return;
    box.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-value]");
      if (!btn) return;
      state[key] = btn.dataset.value;
      box.querySelectorAll(".side-item").forEach(function (c) { c.classList.toggle("on", c === btn); });
      if (key === "category" && pageTitle) {
        var label = btn.querySelector(".flex");
        pageTitle.textContent = label ? label.textContent : "全部资讯";
      }
      apply();
    });
  }
  wire("category", "category");
  wire("importance", "importance");
  var input = document.getElementById("q");
  if (input) input.addEventListener("input", function () { state.q = input.value.trim().toLowerCase(); apply(); });
  apply();
})();
</script>`;

function sideItem(opts: { value: string; label: string; count?: number; color?: string; on?: boolean }): string {
  return `<button type="button" class="side-item${opts.on ? " on" : ""}" data-value="${esc(opts.value)}">${
    opts.color ? `<span class="dot" style="background:${opts.color}"></span>` : ""
  }<span class="flex">${esc(opts.label)}</span>${
    opts.count !== undefined ? `<span class="cnt">${opts.count}</span>` : ""
  }</button>`;
}

export function renderIndex(data: ExportData, generatedAt: string): string {
  const impCount = (imp: string) => data.items.filter((i) => i.importance === imp).length;
  const sidebar = `<aside>
  <nav>
    <div data-group="category">
      ${sideItem({ value: "", label: "全部资讯", count: data.items.length, color: "#7c5cff", on: true })}
      ${data.categories.map((c) => sideItem({ value: c.name, label: c.name, count: c.count, color: categoryColor(c.name) })).join("\n      ")}
    </div>
    <div class="side-title">重要性</div>
    <div data-group="importance">
      ${sideItem({ value: "", label: "全部重要性", on: true })}
      ${sideItem({ value: "high", label: "高", count: impCount("high") })}
      ${sideItem({ value: "medium", label: "中", count: impCount("medium") })}
      ${sideItem({ value: "low", label: "低", count: impCount("low") })}
    </div>
  </nav>
</aside>`;

  const cards = data.items
    .map((item) => {
      const search = `${item.title} ${item.summary} ${item.tags.join(" ")}`.toLowerCase();
      const date = item.event_date ?? fmtDateTime(item.cleaned_at).slice(0, 10);
      return `<a class="news-card" href="item/${encodeURIComponent(item.id)}/" data-category="${esc(item.category)}" data-importance="${esc(item.importance)}" data-search="${esc(search)}">
  <div class="card-top">
    <span class="pill" style="background:${categoryColor(item.category)}">${esc(item.category)}</span>
    ${item.sources[0] ? `<span class="pill-gray">${esc(item.sources[0].name)}</span>` : ""}
    <span class="imp imp-${esc(item.importance)}">${esc(IMPORTANCE_LABEL[item.importance] ?? item.importance)}</span>
  </div>
  <div class="card-title">${esc(item.title)}</div>
  <p class="card-sum">${esc(item.summary)}</p>
  <div class="card-foot"><span>${esc(date)}</span>${item.tags[0] ? `<span>${esc(item.tags[0])}</span>` : ""}</div>
</a>`;
    })
    .join("\n");

  return `${head("Agent 101 资讯 · 全部资讯", "./styles.css", "./", true)}
<div class="layout">
${sidebar}
<section class="content">
  <div class="page-head"><h1 id="pageTitle">全部资讯</h1><span class="muted" id="count">${data.items.length} 条</span></div>
  ${
    data.items.length === 0
      ? `<div class="card empty"><p>这里还没有资讯</p><p class="muted">新的简报清洗完成后会自动出现在这里</p></div>`
      : `<div class="grid">\n${cards}\n</div>
  <div class="card empty" id="emptyFilter" style="display:none"><p>这个筛选下没有资讯</p><p class="muted">换个分类或清除搜索试试</p></div>`
  }
</section>
</div>
</main>
${FILTER_JS}
</body>
</html>
`;
}

export function renderItem(item: ExportItem, publicApiPath: string): string {
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
  const date = item.event_date ?? fmtDateTime(item.cleaned_at).slice(0, 10);
  return `${head(item.title, "../../styles.css", "../../")}
<p class="muted"><a href="../../" style="color:var(--accent-strong)">← 返回列表</a></p>
<div class="card-top" style="margin-top:12px">
  <span class="pill" style="background:${categoryColor(item.category)}">${esc(item.category)}</span>
  ${item.sources[0] ? `<span class="pill-gray">${esc(item.sources[0].name)}</span>` : ""}
  <span class="imp imp-${esc(item.importance)}">重要性 ${esc(IMPORTANCE_LABEL[item.importance] ?? item.importance)}</span>
</div>
<h1 style="line-height:1.45;font-size:22px;margin-top:12px">${esc(item.title)}</h1>
<p class="muted">${esc(date)}${item.event_date ? " · 事件日期" : ""}</p>
<div style="margin:10px 0">${tags}</div>
<h2>摘要</h2>
<div class="card"><p class="summary">${esc(item.summary)}</p></div>
${detail}
${sources}
<p class="muted" style="margin-top:24px">由 ${esc(item.provider)} / ${esc(item.model)} 于 ${esc(fmtDateTime(item.cleaned_at))} 清洗 · 原始记录 <a href="${esc(publicApiPath)}/api/v1/records/${encodeURIComponent(item.source_record_id)}" target="_blank" rel="noreferrer" style="color:var(--accent-strong)">${esc(item.source_record_id.slice(0, 8))}…</a></p>
</main>
</body>
</html>
`;
}
