import { useCallback, useEffect, useRef, useState } from "react";
import { CloudUpload, FileText, X, Loader2, Sparkles } from "lucide-react";
import { CATEGORIES } from "../../../shared/categories";
import type { CategoryId } from "../../../shared/types";
import { api, formatSize, type ParseResult } from "../lib/api";

interface PendingFile {
  file: File;
  parse?: ParseResult;
  category: CategoryId;
  error?: string;
}

export default function UploadModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [items, setItems] = useState<PendingFile[]>([]);
  const [tagsInput, setTagsInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const htmlFiles = Array.from(files).filter((f) => /\.html?$/i.test(f.name));
    for (const file of htmlFiles) {
      const pending: PendingFile = { file, category: "other" };
      setItems((prev) => [...prev, pending]);
      try {
        const parse = await api.parse(file);
        setItems((prev) =>
          prev.map((p) =>
            p.file === file
              ? { ...p, parse, category: (parse.suggestedCategory as CategoryId) || "other" }
              : p,
          ),
        );
      } catch (e) {
        setItems((prev) =>
          prev.map((p) => (p.file === file ? { ...p, error: (e as Error).message } : p)),
        );
      }
    }
  }, []);

  const submit = async () => {
    const valid = items.filter((p) => !p.error);
    if (valid.length === 0) return;
    setUploading(true);
    try {
      const tags = tagsInput.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
      await api.upload(
        valid.map((p) => p.file),
        valid.map((p) => ({
          originalName: p.file.name,
          title: p.parse?.title,
          category: p.category,
          tags,
        })),
      );
      onDone();
      onClose();
    } catch (e) {
      alert((e as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div
        className="w-full max-w-2xl max-h-[88vh] overflow-y-auto rounded-2xl bg-white dark:bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 dark:border-zinc-800">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">上传 HTML 文档</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800">
            <X size={18} />
          </button>
        </div>

        <div className="px-6 py-4 space-y-4">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); void addFiles(e.dataTransfer.files); }}
            onClick={() => inputRef.current?.click()}
            className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors ${
              dragOver
                ? "border-violet-500 bg-violet-50 dark:bg-violet-950/30"
                : "border-zinc-300 dark:border-zinc-700 hover:border-violet-400"
            }`}
          >
            <CloudUpload className="mx-auto mb-2 text-violet-500" size={28} />
            <p className="text-sm text-zinc-700 dark:text-zinc-200">拖拽 .html 文件到这里，或点击选择（可多选）</p>
            <p className="mt-1 text-xs text-zinc-400">支持 answer-me-with-html 生成的自包含页面，标题与分类会自动识别</p>
            <input
              ref={inputRef}
              type="file"
              accept=".html,.htm"
              multiple
              className="hidden"
              onChange={(e) => { if (e.target.files) void addFiles(e.target.files); e.target.value = ""; }}
            />
          </div>

          {items.map((p, i) => (
            <div key={i} className="flex items-start gap-3 rounded-xl border border-zinc-200 dark:border-zinc-800 px-4 py-3">
              <FileText size={18} className="mt-0.5 shrink-0 text-zinc-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">
                  {p.parse?.title ?? p.file.name}
                </p>
                <p className="text-xs text-zinc-400">
                  {p.file.name} · {formatSize(p.file.size)}
                  {p.parse?.generator ? ` · ${p.parse.generator}` : ""}
                </p>
                {p.error && <p className="text-xs text-red-500 mt-1">{p.error}</p>}
                {!p.parse && !p.error && (
                  <p className="flex items-center gap-1 text-xs text-zinc-400 mt-1">
                    <Loader2 size={12} className="animate-spin" /> 解析中…
                  </p>
                )}
                {p.parse && (
                  <p className="flex items-center gap-1 text-xs text-violet-500 mt-1">
                    <Sparkles size={12} /> 已自动识别标题与分类，可在右侧调整
                  </p>
                )}
              </div>
              <select
                value={p.category}
                onChange={(e) =>
                  setItems((prev) =>
                    prev.map((x, j) => (j === i ? { ...x, category: e.target.value as CategoryId } : x)),
                  )
                }
                className="shrink-0 rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5 text-sm"
              >
                {CATEGORIES.map((c) => (
                  <option key={c.id} value={c.id}>{c.label}</option>
                ))}
              </select>
              <button
                onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))}
                className="shrink-0 p-1 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800"
              >
                <X size={15} />
              </button>
            </div>
          ))}

          <div>
            <label className="block text-sm font-medium text-zinc-700 dark:text-zinc-200 mb-1.5">
              标签（可选，逗号分隔，本批共用）
            </label>
            <input
              value={tagsInput}
              onChange={(e) => setTagsInput(e.target.value)}
              placeholder="如：协议对比, 重点"
              className="w-full rounded-lg border border-zinc-300 dark:border-zinc-700 bg-transparent px-3 py-2 text-sm outline-none focus:border-violet-500"
            />
          </div>
        </div>

        <div className="flex justify-end gap-2 px-6 py-4 border-t border-zinc-200 dark:border-zinc-800">
          <button onClick={onClose} className="rounded-lg px-4 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800">
            取消
          </button>
          <button
            onClick={() => void submit()}
            disabled={uploading || items.filter((p) => !p.error).length === 0}
            className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-40"
          >
            {uploading && <Loader2 size={14} className="animate-spin" />}
            上传 {items.filter((p) => !p.error).length > 0 ? `(${items.filter((p) => !p.error).length})` : ""}
          </button>
        </div>
      </div>
    </div>
  );
}
