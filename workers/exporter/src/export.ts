import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readExportData } from "./reader.js";
import { DEFAULT_SITE_URL, esc, renderIndex, renderItem } from "./render.js";

export interface ExportResult {
  items: number;
  /** How many list cards link to a rich detail page (the rest link old-style). */
  detailPages: number;
  releaseDir: string;
  currentLink: string;
}

const KEEP_RELEASES = 3;

function stylesPath(): string {
  // dist/src/export.js -> ../../assets/styles.css (assets live next to src in the package)
  return join(dirname(fileURLToPath(import.meta.url)), "../../assets/styles.css");
}

function assetPath(name: string): string {
  return join(dirname(fileURLToPath(import.meta.url)), "../../assets", name);
}

/**
 * Render the whole site into a fresh release directory, then flip the
 * `current` symlink to it atomically (single rename). nginx points at
 * <outDir>/current, so it always sees a complete generation. Old releases
 * are pruned to the newest few. A failure mid-export leaves `current`
 * untouched.
 */
export function exportSite(options: {
  dbFile: string;
  outDir: string;
  publicApiPath?: string;
  /** Public base URL of the news site, e.g. https://agent101.uk/news (no trailing slash). */
  publicSiteUrl?: string;
  /** Directory the news-detail push API writes rich detail HTML into
   *  (NEWS_DETAIL_DIR, e.g. /home/ec2-user/app/docs/news). When set,
   *  an item whose `<id>.html` exists there gets its list card linked
   *  to the rich page at /docs/news/<id>.html; items without a file
   *  keep the old `item/<id>/` link. When unset, the export is exactly
   *  as before. No copy is made: /docs/news/ is already served
   *  directly, so the detail file is reachable without entering the
   *  release. */
  detailDir?: string;
  now?: Date;
}): ExportResult {
  const { dbFile, outDir } = options;
  const publicApiPath = (options.publicApiPath ?? "/data-pipeline").replace(/\/$/, "");
  const siteUrl = (options.publicSiteUrl ?? DEFAULT_SITE_URL).replace(/\/$/, "");
  const now = options.now ?? new Date();
  const data = readExportData(dbFile);

  // Rich detail pages present at export time. File existence is the
  // check, not the detail_pages DB: the exporter and the API share
  // the machine but not a database. A detail file pushed after this
  // export starts linking only on the next export (the file itself
  // is reachable at /docs/news/ immediately; only the list card
  // waits for the next export).
  const detailIds = new Set<string>();
  if (options.detailDir) {
    for (const item of data.items) {
      if (existsSync(join(options.detailDir, `${item.id}.html`))) detailIds.add(item.id);
    }
  }

  const stamp = now.toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const releaseName = `${stamp}-${process.pid}`;
  const releasesDir = join(outDir, "releases");
  const releaseDir = join(releasesDir, releaseName);
  mkdirSync(join(releaseDir, "item"), { recursive: true });

  // Version the stylesheet URL by content hash: CDN/browser caches happily
  // serve a stale styles.css for hours (Cloudflare defaults CSS to 4h),
  // which once shipped new markup with old styles. A new hash = a new URL.
  const cssVersion = createHash("md5").update(readFileSync(stylesPath())).digest("hex").slice(0, 8);
  writeFileSync(join(releaseDir, "index.html"), renderIndex(data, now.toISOString(), cssVersion, siteUrl, detailIds), "utf8");
  writeFileSync(join(releaseDir, "items.json"), JSON.stringify({ generated_at: now.toISOString(), ...data }, null, 2), "utf8");
  copyFileSync(stylesPath(), join(releaseDir, "styles.css"));
  // Browser icon: the head() link points at the site root, so the
  // file must live in every release, not just next to the sources.
  copyFileSync(assetPath("favicon.svg"), join(releaseDir, "favicon.svg"));
  for (const item of data.items) {
    const dir = join(releaseDir, "item", item.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), renderItem(item, publicApiPath, cssVersion, siteUrl), "utf8");
  }
  // Sitemap for search engines (2026-10-25 SEO): homepage + every detail
  // page, lastmod from the cleaning time. It is served at
  // <siteUrl>/sitemap.xml by the same nginx location as the site; the
  // domain-root robots.txt (outside this repo) should point at it, and
  // it should be submitted in Search Console — a sitemap file under
  // /news/ alone does not make crawlers discover the site.
  // Rich detail pages live under /docs/news/, a sibling of the /news/
  // site on the same host (verified 2026-10-27: /docs/news/<id>.html
  // returns 200). Derive its base from the site URL by swapping the
  // trailing /news for /docs/news.
  const docsSiteUrl = siteUrl.endsWith("/news") ? `${siteUrl.slice(0, -5)}/docs/news` : `${siteUrl}/docs/news`;
  const today = now.toISOString().slice(0, 10);
  const urlEntry = (loc: string, lastmod: string, changefreq: string, priority: string): string =>
    `  <url><loc>${esc(loc)}</loc><lastmod>${lastmod}</lastmod><changefreq>${changefreq}</changefreq><priority>${priority}</priority></url>`;
  const sitemap = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`,
    urlEntry(`${siteUrl}/`, today, "daily", "1.0"),
    ...data.items.map((item) =>
      urlEntry(
        detailIds.has(item.id)
          ? `${docsSiteUrl}/${encodeURIComponent(item.id)}.html`
          : `${siteUrl}/item/${encodeURIComponent(item.id)}/`,
        item.cleaned_at.slice(0, 10),
        "weekly",
        "0.8",
      ),
    ),
    `</urlset>`,
    ``,
  ].join("\n");
  writeFileSync(join(releaseDir, "sitemap.xml"), sitemap, "utf8");

  // Flip `current` atomically: build a temp symlink, then rename over.
  const currentLink = join(outDir, "current");
  const tmpLink = join(outDir, `.current-${process.pid}`);
  rmSync(tmpLink, { force: true });
  symlinkSync(join("releases", releaseName), tmpLink);
  renameSync(tmpLink, currentLink);

  // Prune older releases.
  const releases = readdirSync(releasesDir).sort().reverse();
  for (const old of releases.slice(KEEP_RELEASES)) {
    rmSync(join(releasesDir, old), { recursive: true, force: true });
  }

  return { items: data.items.length, detailPages: detailIds.size, releaseDir, currentLink };
}
