import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft, BookOpen, Download, ExternalLink, LayoutGrid, List, Moon,
  Pencil, Search, Sun, Trash2, Upload,
} from "lucide-react";
import { getCategory } from "../../shared/categories";
import type { CategoryId, DocMeta } from "../../shared/types";
import { CATEGORIES } from "../../shared/categories";
import { api, formatDate, formatSize, type CategoriesResponse } from "./lib/api";
import UploadModal from "./components/UploadModal";

/* ---------------- hash 路由：#/ 列表，#/doc/<id> 阅读 ---------------- */
function parseHash(): string | null {
  const m = location.hash.match(/^#\/doc\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

export default function App() {
  const [docId, setDocId] = useState<string | null>(() => parseHash());
  useEffect(() => {
    const onHash = () => setDocId(parseHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const [dark, setDark] = useState(() => localStorage.getItem("doc-reader-theme") === "dark");
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    localStorage.setItem("doc-reader-theme", dark ? "dark" : "light");
  }, [dark]);

  if (docId) {
    return <Reader id={docId} onBack={() => { location.hash = "#/"; }} />;
  }
  return <Library dark={dark} onToggleDark={() => setDark((d) => !d)} />;
}

/* ---------------- 列表页 ---------------- */
function Library({ dark, onToggleDark }: { dark: boolean; onToggleDark: () => void }) {
  const [cats, setCats] = useState<CategoriesResponse | null>(null);
  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [category, setCategory] = useState<CategoryId | "all">("all");
  const [q, setQ] = useState("");
  const [sort, setSort] = useState("newest");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [showUpload, setShowUpload] = useState(false);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [c, d] = await Promise.all([
        api.categories(),
        api.docs({ category: category === "all" ? undefined : category, q: q || undefined, sort }),
      ]);
      setCats(c);
      setDocs(d);
    } finally {
      setLoading(false);
    }
  }, [category, q, sort]);

  useEffect(() => { void refresh(); }, [refresh]);

  const catOf = useMemo(() => (id: CategoryId) => getCategory(id), []);

  return (
    <div className="min-h-screen bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <header className="sticky top-0 z-40 border-b border-zinc-200 bg-white/85 backdrop-blur dark:border-zinc-800 dark:bg-zinc-950/85">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="flex items-center gap-2 font-semibold text-lg">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-600 text-white">
              <BookOpen size={17} />
            </span>
            Agent 101
          </div>
          <div className="relative mx-auto w-full max-w-md flex-1">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索标题、标签或全文…"
              className="w-full rounded-lg border border-zinc-300 bg-transparent py-2 pl-9 pr-3 text-sm outline-none focus:border-violet-500 dark:border-zinc-700"
            />
          </div>
          <button onClick={onToggleDark} className="rounded-lg p-2 hover:bg-zinc-100 dark:hover:bg-zinc-800" title="切换深浅色">
            {dark ? <Sun size={17} /> : <Moon size={17} />}
          </button>
          <button
            onClick={() => setShowUpload(true)}
            className="flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-violet-500"
          >
            <Upload size={15} /> 上传文档
          </button>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-4 py-6 sm:px-6">
        {/* 侧边栏：分类顺序稳定，来自 shared/categories.ts */}
        <aside className="hidden w-52 shrink-0 md:block">
          <nav className="sticky top-20 space-y-1">
            <SidebarItem
              active={category === "all"}
              color="#7c5cff"
              label="全部文档"
              count={cats?.total ?? 0}
              onClick={() => setCategory("all")}
            />
            {cats?.categories.map((c) => (
              <SidebarItem
                key={c.id}
                active={category === c.id}
                color={c.color}
                label={c.label}
                desc={c.description}
                count={c.count}
                onClick={() => setCategory(c.id)}
              />
            ))}
          </nav>
        </aside>

        <main className="min-w-0 flex-1">
          {/* 移动端分类横排 */}
          <div className="mb-4 flex gap-2 overflow-x-auto md:hidden pb-1">
            <Chip active={category === "all"} onClick={() => setCategory("all")} label={`全部 ${cats?.total ?? 0}`} />
            {cats?.categories.map((c) => (
              <Chip key={c.id} active={category === c.id} onClick={() => setCategory(c.id)} label={`${c.label} ${c.count}`} />
            ))}
          </div>

          <div className="mb-4 flex items-center justify-between">
            <h1 className="text-base font-medium text-zinc-600 dark:text-zinc-300">
              {category === "all" ? "全部文档" : catOf(category as CategoryId).label}
              <span className="ml-2 text-sm text-zinc-400">{docs.length} 篇</span>
            </h1>
            <div className="flex items-center gap-2">
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                className="rounded-lg border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
              >
                <option value="newest">最新优先</option>
                <option value="oldest">最早优先</option>
                <option value="title">按标题</option>
              </select>
              <div className="flex rounded-lg border border-zinc-300 dark:border-zinc-700 overflow-hidden">
                <button onClick={() => setView("grid")} className={`p-1.5 ${view === "grid" ? "bg-zinc-200 dark:bg-zinc-700" : ""}`}><LayoutGrid size={15} /></button>
                <button onClick={() => setView("list")} className={`p-1.5 ${view === "list" ? "bg-zinc-200 dark:bg-zinc-700" : ""}`}><List size={15} /></button>
              </div>
            </div>
          </div>

          {loading ? (
            <p className="py-16 text-center text-sm text-zinc-400">加载中…</p>
          ) : docs.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-300 py-16 text-center dark:border-zinc-700">
              <BookOpen className="mx-auto mb-3 text-zinc-300" size={36} />
              <p className="text-zinc-500">这里还没有文档</p>
              <p className="mt-1 text-sm text-zinc-400">点右上角「上传文档」添加第一篇</p>
            </div>
          ) : view === "grid" ? (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {docs.map((d) => <DocCard key={d.id} doc={d} />)}
            </div>
          ) : (
            <div className="divide-y divide-zinc-200 rounded-2xl border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
              {docs.map((d) => <DocRow key={d.id} doc={d} />)}
            </div>
          )}
        </main>
      </div>

      {showUpload && <UploadModal onClose={() => setShowUpload(false)} onDone={() => void refresh()} />}
    </div>
  );
}

function SidebarItem({ active, color, label, desc, count, onClick }: {
  active: boolean; color: string; label: string; desc?: string; count: number; onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      title={desc}
      className={`flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
        active ? "bg-violet-50 font-medium text-violet-700 dark:bg-violet-950/40 dark:text-violet-300" : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
      }`}
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />
      <span className="flex-1 truncate">{label}</span>
      <span className="text-xs text-zinc-400">{count}</span>
    </button>
  );
}

function Chip({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3 py-1.5 text-sm ${
        active ? "border-violet-500 bg-violet-50 text-violet-700 dark:bg-violet-950/40" : "border-zinc-300 dark:border-zinc-700"
      }`}
    >
      {label}
    </button>
  );
}

function DocCard({ doc }: { doc: DocMeta }) {
  const cat = getCategory(doc.category);
  return (
    <a
      href={`#/doc/${doc.id}`}
      className="group flex flex-col rounded-2xl border border-zinc-200 bg-white p-5 transition-shadow hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className="rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ background: cat.color }}>
          {cat.label}
        </span>
        {doc.source === "answer-me-with-html" && (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">answer-me-with-html</span>
        )}
      </div>
      <h3 className="mb-1.5 line-clamp-2 font-medium leading-snug group-hover:text-violet-600">{doc.title}</h3>
      <p className="mb-4 line-clamp-3 flex-1 text-sm leading-relaxed text-zinc-500">{doc.description || "暂无简介"}</p>
      {doc.tags.length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {doc.tags.map((t) => (
            <span key={t} className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">{t}</span>
          ))}
        </div>
      )}
      <p className="text-xs text-zinc-400">{formatDate(doc.createdAt)} · {formatSize(doc.size)}</p>
    </a>
  );
}

function DocRow({ doc }: { doc: DocMeta }) {
  const cat = getCategory(doc.category);
  return (
    <a href={`#/doc/${doc.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-zinc-50 dark:hover:bg-zinc-800/50">
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: cat.color }} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium">{doc.title}</span>
        <span className="block truncate text-xs text-zinc-400">{doc.description}</span>
      </span>
      <span className="shrink-0 text-xs text-zinc-400">{cat.label}</span>
      <span className="shrink-0 text-xs text-zinc-400">{formatDate(doc.createdAt)}</span>
    </a>
  );
}

/* ---------------- 阅读页 ---------------- */
function Reader({ id, onBack }: { id: string; onBack: () => void }) {
  const [doc, setDoc] = useState<DocMeta | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editCategory, setEditCategory] = useState<CategoryId>("other");

  useEffect(() => {
    api.doc(id).then(setDoc).catch((e: Error) => setError(e.message));
  }, [id]);

  if (error) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-zinc-50 dark:bg-zinc-950">
        <p className="text-zinc-500">{error}</p>
        <button onClick={onBack} className="text-violet-600 text-sm">返回列表</button>
      </div>
    );
  }
  if (!doc) return <p className="py-16 text-center text-sm text-zinc-400">加载中…</p>;

  const cat = getCategory(doc.category);

  const saveEdit = async () => {
    const updated = await api.update(doc.id, { title: editTitle, category: editCategory });
    setDoc(updated);
    setEditing(false);
  };

  const remove = async () => {
    if (!confirm(`删除《${doc.title}》？此操作不可恢复。`)) return;
    await api.remove(doc.id);
    onBack();
  };

  return (
    <div className="flex min-h-screen flex-col bg-zinc-100 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
          <button onClick={onBack} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <ArrowLeft size={15} /> 返回
          </button>
          <span className="rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ background: cat.color }}>{cat.label}</span>
          <h1 className="min-w-0 flex-1 truncate text-sm font-medium sm:text-base">{doc.title}</h1>
          <div className="flex items-center gap-1">
            <a href={`/api/docs/${doc.id}/raw`} target="_blank" rel="noreferrer" className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <ExternalLink size={14} /> 新窗口打开
            </a>
            <a href={`/api/docs/${doc.id}/download`} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
              <Download size={14} /> 下载
            </a>
            <button
              onClick={() => { setEditTitle(doc.title); setEditCategory(doc.category); setEditing((v) => !v); }}
              className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
            >
              <Pencil size={14} /> 编辑
            </button>
            <button onClick={() => void remove()} className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30">
              <Trash2 size={14} /> 删除
            </button>
          </div>
        </div>
        {editing && (
          <div className="border-t border-zinc-100 dark:border-zinc-800">
            <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-2 px-4 py-2.5 sm:px-6">
              <input
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="min-w-52 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-1.5 text-sm outline-none focus:border-violet-500 dark:border-zinc-700"
              />
              <select
                value={editCategory}
                onChange={(e) => setEditCategory(e.target.value as CategoryId)}
                className="rounded-lg border border-zinc-300 bg-transparent px-2 py-1.5 text-sm dark:border-zinc-700"
              >
                {CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </select>
              <button onClick={() => void saveEdit()} className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm text-white hover:bg-violet-500">保存</button>
            </div>
          </div>
        )}
      </header>
      {/*
        sandbox 给 allow-scripts + allow-same-origin：文档脚本可跑（交互排版），
        且与主站同源、Clipboard API 可用（复制按钮）。代价：上传的 HTML 理论上
        能碰主站 DOM——本站文档均为站长本人上传，风险可控；更稳妥的方案是把
        /raw 挪到独立子域后再开 allow-same-origin。
      */}
      <iframe
        title={doc.title}
        src={`/api/docs/${doc.id}/raw`}
        sandbox="allow-scripts allow-same-origin"
        className="w-full flex-1 border-0 bg-white"
      />
    </div>
  );
}
