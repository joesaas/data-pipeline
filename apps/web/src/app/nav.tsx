import Link from "next/link";
import { fetchStats, fmtDateTime } from "../lib/api";

export async function Nav() {
  let summary = "";
  try {
    const stats = await fetchStats();
    summary = stats.items > 0 ? `共 ${stats.items} 条 · 最近清洗 ${fmtDateTime(stats.last_cleaned_at)}` : "暂无清洗结果";
  } catch {
    summary = "";
  }
  return (
    <header className="topbar">
      <Link href="/" className="logo">
        data<span>-pipeline</span>
      </Link>
      <nav>
        <Link href="/">清洗结果</Link>
      </nav>
      <div className="spacer" />
      {summary && <span className="muted">{summary}</span>}
    </header>
  );
}
