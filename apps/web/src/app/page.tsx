import Link from "next/link";
import { fetchItems, fetchStats, fmtDateTime, IMPORTANCE_LABEL, type CleanedStats } from "../lib/api";

interface SearchParams {
  category?: string;
  importance?: string;
  q?: string;
}

function hrefWith(base: SearchParams, patch: Partial<SearchParams>): string {
  const merged = { ...base, ...patch };
  const qs = new URLSearchParams();
  if (merged.category) qs.set("category", merged.category);
  if (merged.importance) qs.set("importance", merged.importance);
  if (merged.q) qs.set("q", merged.q);
  const s = qs.toString();
  return s ? `/?${s}` : "/";
}

export default async function FeedPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  let stats: CleanedStats | null = null;
  let items: Awaited<ReturnType<typeof fetchItems>> | null = null;
  let error = "";
  try {
    [stats, items] = await Promise.all([
      fetchStats(),
      fetchItems({ category: sp.category, importance: sp.importance, q: sp.q, limit: 100 }),
    ]);
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }

  if (error || !stats || !items) {
    return (
      <div>
        <h1>清洗结果</h1>
        <div className="card">
          <p className="error">连不上 API 服务：{error}</p>
          <p className="muted">请确认 apps/api 已启动，且 DATA_PIPELINE_API_URL 指向它（默认 http://localhost:8080/data-pipeline）。</p>
        </div>
      </div>
    );
  }

  const importanceOptions: { value?: string; label: string }[] = [
    { value: undefined, label: "全部重要性" },
    { value: "high", label: "高" },
    { value: "medium", label: "中" },
    { value: "low", label: "低" },
  ];

  return (
    <div>
      <h1>清洗结果</h1>
      <div className="stats">
        <div className="stat"><b>{stats.items}</b><span>结构化条目</span></div>
        <div className="stat"><b>{stats.records}</b><span>已清洗原始记录</span></div>
        <div className="stat"><b>{stats.categories.length}</b><span>分类</span></div>
        <div className="stat"><b style={{ fontSize: 14, paddingTop: 4 }}>{fmtDateTime(stats.last_cleaned_at)}</b><span>最近清洗</span></div>
      </div>

      <div className="chips">
        <span className="lbl">分类</span>
        <Link className={`chip ${!sp.category ? "on" : ""}`} href={hrefWith(sp, { category: undefined })}>全部</Link>
        {stats.categories.map((c) => (
          <Link key={c.name} className={`chip ${sp.category === c.name ? "on" : ""}`} href={hrefWith(sp, { category: c.name })}>
            {c.name} · {c.count}
          </Link>
        ))}
      </div>
      <div className="chips">
        <span className="lbl">重要性</span>
        {importanceOptions.map((o) => (
          <Link key={o.label} className={`chip ${sp.importance === o.value ? "on" : ""}`} href={hrefWith(sp, { importance: o.value })}>
            {o.label}
          </Link>
        ))}
      </div>
      <form className="searchbar" method="get" action="/">
        {sp.category && <input type="hidden" name="category" value={sp.category} />}
        {sp.importance && <input type="hidden" name="importance" value={sp.importance} />}
        <input name="q" placeholder="搜索标题或摘要…" defaultValue={sp.q ?? ""} />
        <button className="btn" type="submit">搜索</button>
      </form>

      <p className="muted" style={{ margin: "14px 0 10px" }}>
        共 {items.total} 条{items.total > items.items.length ? `，显示前 ${items.items.length} 条` : ""}
      </p>
      {items.items.length === 0 && (
        <div className="card">
          <p>这个筛选下还没有条目。等 cleaner 下一轮跑完（或先去推一条原始记录）就会出现在这里。</p>
        </div>
      )}
      {items.items.map((item, i) => (
        <Link key={item.id} href={`/item/${item.id}`} className="feed-item">
          <div className="idx">{String(i + 1).padStart(2, "0")}</div>
          <div className="body">
            <div className="src">
              {item.category}
              {item.event_date ? ` · 事件 ${item.event_date}` : ""}
              {item.sources[0] ? ` · ${item.sources[0].name}` : ""}
            </div>
            <div className="ttl">{item.title}</div>
            <div className="sum">{item.summary}</div>
          </div>
          <div className="side">
            <span className={`imp imp-${item.importance}`}>{IMPORTANCE_LABEL[item.importance] ?? item.importance}</span>
            <span className="time">{item.event_date ?? fmtDateTime(item.cleaned_at).slice(0, 10)}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}
