import Link from "next/link";
import { notFound } from "next/navigation";
import { fetchItem, fmtDateTime, IMPORTANCE_LABEL } from "../../../lib/api";

// Public mount path of the API (where nginx exposes it) — used only for the
// "raw record" link. This is NOT the internal fetch URL: DATA_PIPELINE_API_URL
// points at localhost and would be wrong in a visitor's browser.
const RECORDS_PATH = process.env.NEXT_PUBLIC_API_PATH ?? "/data-pipeline";

export default async function ItemPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let item;
  try {
    item = await fetchItem(id);
  } catch {
    notFound();
  }

  return (
    <div>
      <p className="muted">
        <Link href="/" style={{ color: "var(--accent)" }}>← 返回列表</Link>
        {"  ·  "}
        {item.category} · 重要性 {IMPORTANCE_LABEL[item.importance] ?? item.importance}
        {item.event_date ? ` · 事件日期 ${item.event_date}` : ""}
      </p>
      <h1 style={{ lineHeight: 1.4 }}>{item.title}</h1>
      <div style={{ margin: "10px 0" }}>
        {item.tags.map((t) => (
          <span className="tag" key={t}>{t}</span>
        ))}
      </div>

      <h2>摘要</h2>
      <div className="card">
        <p className="summary">{item.summary}</p>
      </div>

      {item.detail && (
        <>
          <h2>细节</h2>
          <div className="card">
            <p className="summary">{item.detail}</p>
          </div>
        </>
      )}

      {item.sources.length > 0 && (
        <>
          <h2>来源</h2>
          <div className="card srclist">
            {item.sources.map((s) => (
              <div key={s.url}>
                <a href={s.url} target="_blank" rel="noreferrer">{s.name || s.url}</a>
              </div>
            ))}
          </div>
        </>
      )}

      <p className="muted" style={{ marginTop: 24 }}>
        由 {item.provider} / {item.model} 于 {fmtDateTime(item.cleaned_at)} 清洗 ·
        原始记录{" "}
        <a href={`${RECORDS_PATH}/api/v1/records/${item.source_record_id}`} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>
          {item.source_record_id.slice(0, 8)}…
        </a>
      </p>
    </div>
  );
}
