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

function head(title: string, cssHref: string): string {
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
  <a class="logo" href="./">data<span>-pipeline</span></a>
  <nav><a href="./">清洗结果</a></nav>
  <div class="spacer"></div>
</header>
<main>`;
}

const FILTER_JS = `
<script>
(function () {
  var state = { category: "", importance: "", q: "" };
  var items = Array.prototype.slice.call(document.querySelectorAll(".feed-item"));
  var count = document.getElementById("count");
  function apply() {
    var shown = 0;
    items.forEach(function (el, i) {
      var ok =
        (!state.category || el.dataset.category === state.category) &&
        (!state.importance || el.dataset.importance === state.importance) &&
        (!state.q || el.dataset.search.indexOf(state.q) !== -1);
      el.style.display = ok ? "" : "none";
      if (ok) { shown++; el.querySelector(".idx").textContent = String(shown).padStart(2, "0"); }
    });
    if (count) count.textContent = "共 " + shown + " 条";
  }
  function wire(group, key) {
    var box = document.querySelector('[data-group="' + group + '"]');
    if (!box) return;
    box.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-value]");
      if (!btn) return;
      state[key] = btn.dataset.value;
      box.querySelectorAll(".chip").forEach(function (c) { c.classList.toggle("on", c === btn); });
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

export function renderIndex(data: ExportData, generatedAt: string): string {
  const chips = (group: string, values: { value: string; label: string }[]) =>
    `<div class="chips" data-group="${group}"><span class="lbl">${group === "category" ? "分类" : "重要性"}</span>` +
    values
      .map(
        (v, i) =>
          `<button type="button" class="chip${i === 0 ? " on" : ""}" data-value="${esc(v.value)}">${esc(v.label)}</button>`,
      )
      .join("") +
    `</div>`;

  const cards = data.items
    .map((item) => {
      const search = `${item.title} ${item.summary} ${item.tags.join(" ")}`.toLowerCase();
      const srcLine = [item.category, item.event_date ? `事件 ${item.event_date}` : "", item.sources[0]?.name ?? ""]
        .filter(Boolean)
        .join(" · ");
      return `<a class="feed-item" href="item/${encodeURIComponent(item.id)}/" data-category="${esc(item.category)}" data-importance="${esc(item.importance)}" data-search="${esc(search)}">
  <div class="idx">00</div>
  <div class="body">
    <div class="src">${esc(srcLine)}</div>
    <div class="ttl">${esc(item.title)}</div>
    <div class="sum">${esc(item.summary)}</div>
  </div>
  <div class="side">
    <span class="imp imp-${esc(item.importance)}">${esc(IMPORTANCE_LABEL[item.importance] ?? item.importance)}</span>
    <span class="time">${esc(item.event_date ?? fmtDateTime(item.cleaned_at).slice(0, 10))}</span>
  </div>
</a>`;
    })
    .join("\n");

  return `${head("data-pipeline · 清洗结果", "./styles.css")}
<h1>清洗结果</h1>
<div class="stats">
  <div class="stat"><b>${data.items.length}</b><span>结构化条目</span></div>
  <div class="stat"><b>${data.records}</b><span>已清洗原始记录</span></div>
  <div class="stat"><b>${data.categories.length}</b><span>分类</span></div>
  <div class="stat"><b style="font-size:14px;padding-top:4px">${esc(fmtDateTime(data.lastCleanedAt))}</b><span>最近清洗</span></div>
</div>
${chips("category", [{ value: "", label: "全部" }, ...data.categories.map((c) => ({ value: c.name, label: `${c.name} · ${c.count}` }))])}
${chips("importance", [
  { value: "", label: "全部重要性" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
])}
<div class="searchbar"><input id="q" placeholder="搜索标题或摘要…" /></div>
<p class="muted" id="count" style="margin:14px 0 10px">共 ${data.items.length} 条</p>
${data.items.length === 0 ? `<div class="card"><p>还没有清洗结果。等 cleaner 下一轮跑完，这里会自动更新。</p></div>` : cards}
<p class="muted" style="margin-top:24px">静态页面 · 生成于 ${esc(fmtDateTime(generatedAt))} · 数据随清洗批次更新</p>
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
  return `${head(item.title, "../../styles.css")}
<p class="muted"><a href="../../" style="color:var(--accent)">← 返回列表</a> · ${esc(item.category)} · 重要性 ${esc(IMPORTANCE_LABEL[item.importance] ?? item.importance)}${item.event_date ? ` · 事件日期 ${esc(item.event_date)}` : ""}</p>
<h1 style="line-height:1.4">${esc(item.title)}</h1>
<div style="margin:10px 0">${tags}</div>
<h2>摘要</h2>
<div class="card"><p class="summary">${esc(item.summary)}</p></div>
${detail}
${sources}
<p class="muted" style="margin-top:24px">由 ${esc(item.provider)} / ${esc(item.model)} 于 ${esc(fmtDateTime(item.cleaned_at))} 清洗 · 原始记录 <a href="${esc(publicApiPath)}/api/v1/records/${encodeURIComponent(item.source_record_id)}" target="_blank" rel="noreferrer" style="color:var(--accent)">${esc(item.source_record_id.slice(0, 8))}…</a></p>
</main>
</body>
</html>
`;
}
