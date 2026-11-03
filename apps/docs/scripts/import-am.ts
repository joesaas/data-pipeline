/**
 * 把 answer-me-with-html 已生成的页面一键导入平台。
 *
 * 用法：
 *   npm run import:am                      # 默认扫描 ~/.answer-me-with-html/pages
 *   npm run import:am -- <dir> [<dir>...]  # 指定目录
 *
 * 同名文件已导入过会自动跳过，可重复运行。分类由关键词自动建议，
 * 导入后可以在平台里再调整。
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseHtml, isAnswerMeWithHtml } from "../server/src/parse.js";
import { addDoc, findByOriginalName, findByTitle } from "../server/src/store.js";
import { suggestCategory, getCategory } from "../shared/categories.js";

const dirs = process.argv.slice(2);
if (dirs.length === 0) dirs.push(path.join(os.homedir(), ".answer-me-with-html", "pages"));

let imported = 0;
let skipped = 0;
for (const dir of dirs) {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((f) => /\.html?$/i.test(f)).sort();
  } catch {
    console.error(`目录读不到，跳过：${dir}`);
    continue;
  }
  for (const name of entries) {
    if (await findByOriginalName(name)) {
      skipped++;
      continue;
    }
    const html = await fs.readFile(path.join(dir, name), "utf8");
    const parsed = parseHtml(html, name.replace(/\.html?$/i, ""));
    const dupTitle = await findByTitle(parsed.title);
    if (dupTitle && dupTitle.originalName !== name) {
      skipped++;
      console.log(`↷ 重复标题跳过：${parsed.title}（已有 ${dupTitle.originalName}）`);
      continue;
    }
    const { category } = suggestCategory(parsed.title, parsed.text);
    const stat = await fs.stat(path.join(dir, name));
    await addDoc(
      {
        title: parsed.title,
        description: parsed.description,
        category,
        tags: [],
        source: isAnswerMeWithHtml(parsed) ? "answer-me-with-html" : "import",
        generator: parsed.generator,
        originalName: name,
        size: stat.size,
      },
      html,
    );
    imported++;
    console.log(`✓ [${getCategory(category).label}] ${parsed.title}`);
  }
}
console.log(`\n导入完成：新增 ${imported} 篇，跳过（已存在）${skipped} 篇`);
