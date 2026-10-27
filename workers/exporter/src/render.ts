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
  "GitHub 热点项目": "#8250df",
  "安全": "#dc2626",
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

const REFRESH_ICON = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;

/** Contact link: the site's only contact channel (2026-10-25). It lives in
 *  the sticky topbar (visible without scrolling) and in the page footer,
 *  on both the index and every detail page, because head() is shared. */
const CONTACT_URL = "https://x.com/agentci_101";
const CONTACT_LINK = `<a href="${CONTACT_URL}" target="_blank" rel="noreferrer">X @agentci_101</a>`;

/** Default public URL of the news site; exportSite overrides it from
 *  PUBLIC_SITE_URL. Canonical / OG / sitemap URLs all derive from it, so
 *  a staging export never canonicalizes to production by accident. */
export const DEFAULT_SITE_URL = "https://agent101.uk/news";

interface SeoOpts {
  description: string;
  canonical: string;
  ogType: "website" | "article";
  /** Extra <meta> lines, e.g. article:published_time (already escaped by the caller). */
  articleMeta?: string;
  /** A complete <script type="application/ld+json"> block, or "". */
  jsonLd?: string;
}

/** Collapse whitespace and cap at ~160 chars — meta descriptions longer
 *  than that are truncated by search engines anyway. */
export function metaDesc(text: string, len = 160): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > len ? `${t.slice(0, len - 1)}…` : t;
}

function head(
  title: string,
  cssHref: string,
  base = "./",
  showSearch = false,
  cssVersion = "",
  seo: SeoOpts = { description: "", canonical: "", ogType: "website" },
): string {
  const versioned = cssVersion ? `${cssHref}?v=${cssVersion}` : cssHref;
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(seo.description)}" />
<link rel="canonical" href="${esc(seo.canonical)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(seo.description)}" />
<meta property="og:type" content="${seo.ogType}" />
<meta property="og:url" content="${esc(seo.canonical)}" />
<meta property="og:site_name" content="Agent 101 资讯" />
<link rel="icon" type="image/svg+xml" href="${base}favicon.svg" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(seo.description)}" />
${seo.articleMeta ?? ""}
${seo.jsonLd ?? ""}
<link rel="stylesheet" href="${versioned}" />
</head>
<body>
<header class="topbar">
  <a class="logo" href="${base}"><span class="mark">${BOOK_ICON}</span>Agent 101<span>&nbsp;资讯</span></a>
  ${showSearch ? `<div class="head-search"><input id="q" placeholder="搜索标题、摘要或标签…" /></div>` : ""}
  <div class="spacer"></div>
  <a class="head-link" href="${CONTACT_URL}" target="_blank" rel="noreferrer">联系我们</a>
  <span class="head-auth" id="headAuth">
    <button type="button" class="head-link-btn" id="loginBtn">登录</button>
    <span id="authLoggedIn" hidden>
      <span id="authAddr" class="mono"></span>
      <button type="button" class="head-link-btn" id="favViewBtn">我的收藏</button>
      <button type="button" class="head-link-btn" id="logoutBtn">退出</button>
    </span>
  </span>
</header>
<div class="auth-modal" id="authModal" hidden>
  <div class="auth-modal-card">
    <h3>请先登录</h3>
    <p class="muted">收藏需要登录。选择一个钱包并签名一条登录消息即可完成，不会产生任何链上交易，也不会扣费。</p>
    <p class="auth-error" id="authError" hidden></p>
    <div id="walletList" class="wallet-list"></div>
    <p class="muted" id="walletEmpty" hidden>未检测到浏览器钱包，请先安装 MetaMask、OKX Wallet、Coinbase Wallet 或 Binance Web3 Wallet 扩展后再试。</p>
    <button type="button" class="head-link-btn" id="authCancelBtn">取消</button>
  </div>
</div>
<main>`;
}

const FOOTER = `<footer class="site-footer">联系方式：${CONTACT_LINK}</footer>`;

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
  if (grid) {
    grid.addEventListener("click", function (e) {
      var src = e.target.closest("[data-src]");
      if (!src) return;
      e.preventDefault();
      e.stopPropagation();
      window.open(src.dataset.src, "_blank", "noreferrer");
    });
  }
  var refreshBtn = document.getElementById("refreshBtn");
  if (refreshBtn && grid) {
    refreshBtn.addEventListener("click", function () {
      if (refreshBtn.classList.contains("spinning")) return;
      refreshBtn.classList.add("spinning");
      fetch("./?__refresh=" + Date.now(), { cache: "no-store" })
        .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.text(); })
        .then(function (html) {
          var doc = new DOMParser().parseFromString(html, "text/html");
          var newGrid = doc.getElementById("grid");
          var newCat = doc.querySelector('[data-group="category"]');
          var curCat = document.querySelector('[data-group="category"]');
          if (newCat && curCat) curCat.innerHTML = newCat.innerHTML;
          if (newGrid) {
            grid.innerHTML = newGrid.innerHTML;
            cards = Array.prototype.slice.call(document.querySelectorAll(".news-card"));
          }
          document.querySelectorAll('[data-group="category"] .side-item').forEach(function (c) {
            c.classList.toggle("on", c.dataset.value === state.category);
          });
          refreshWeights();
          render();
        })
        .catch(function () { /* keep the current list when the refresh fails */ })
        .then(function () { refreshBtn.classList.remove("spinning"); });
    });
  }
  refreshWeights();
  render();
})();
</script>`;

/** Wallet login + favorites (shared by index and detail pages). The
 *  index PAGE_JS above only handles filtering; this script owns auth
 *  state, the favorite buttons, the login modal and the favorites-only
 *  view. It talks to the API on the same host under
 *  /data-pipeline/api/v1 (the API and the news site share the domain,
 *  so no CORS is involved). A favorite click while logged out opens
 *  the login modal, and the pending favorite is applied right after a
 *  successful login, so the user never has to click twice.
 *  Wallet discovery is EIP-6963 first: the page asks every installed
 *  wallet to announce itself (MetaMask, OKX, Coinbase and Binance all
 *  do this in current versions), so the modal can list them all instead
 *  of racing for the single window.ethereum slot. Legacy injected
 *  globals are only a fallback for wallets too old to announce. */
const SITE_JS = `
<script>
(function () {
  var API = "/data-pipeline/api/v1";
  var session = null;
  try { session = window.localStorage.getItem("agent101-session"); } catch (e) { session = null; }
  var favIds = {};
  var pendingFav = null;
  function $(id) { return document.getElementById(id); }
  function shortAddr(a) { return a.slice(0, 6) + "…" + a.slice(-4); }
  function headers() { return session ? { "Authorization": "Bearer " + session, "Content-Type": "application/json" } : { "Content-Type": "application/json" }; }
  function api(path, opts) {
    var o = opts || {};
    o.headers = headers();
    return fetch(API + path, o).then(function (r) {
      if (!r.ok) throw new Error("http " + r.status);
      return r.json().catch(function () { return {}; });
    });
  }
  function setLoggedIn(addr) {
    var loginBtn = $("loginBtn"), loggedIn = $("authLoggedIn"), addrEl = $("authAddr");
    if (loginBtn) loginBtn.hidden = true;
    if (loggedIn) loggedIn.hidden = false;
    if (addrEl) addrEl.textContent = shortAddr(addr);
  }
  function setLoggedOut() {
    var loginBtn = $("loginBtn"), loggedIn = $("authLoggedIn");
    if (loginBtn) loginBtn.hidden = false;
    if (loggedIn) loggedIn.hidden = true;
  }
  function paint() {
    var btns = document.querySelectorAll(".fav-btn");
    btns.forEach(function (b) {
      var on = !!favIds[b.dataset.fav];
      b.classList.toggle("on", on);
      if (b.dataset.detail) { b.textContent = on ? "★ 已收藏" : "☆ 收藏"; }
      else { b.textContent = on ? "★" : "☆"; }
    });
  }
  function favBanner(show, n) {
    var old = $("favBanner");
    if (old) old.remove();
    if (!show) return;
    var grid = $("grid");
    if (!grid) return;
    var div = document.createElement("div");
    div.id = "favBanner";
    div.className = "fav-banner";
    div.innerHTML = "正在查看我的收藏（" + n + " 条） <button type=\\"button\\" class=\\"head-link-btn\\" id=\\"favBackBtn\\">查看全部</button>";
    grid.parentNode.insertBefore(div, grid);
    $("favBackBtn").addEventListener("click", function () { window.location.href = window.location.pathname; });
  }
  function applyFavView() {
    var params = new URLSearchParams(window.location.search);
    if (params.get("favorites") !== "1") { favBanner(false); return; }
    var cards = document.querySelectorAll(".news-card");
    var shown = 0;
    cards.forEach(function (c) {
      var ok = !!favIds[c.dataset.itemId];
      c.style.display = ok ? "" : "none";
      if (ok) shown++;
    });
    favBanner(true, shown);
    var count = $("count");
    if (count) count.textContent = shown + " 条";
  }
  function refreshFavs() {
    if (!session) { favIds = {}; paint(); applyFavView(); return Promise.resolve(); }
    return api("/site-favorites/ids").then(function (d) {
      favIds = {};
      (d.ids || []).forEach(function (id) { favIds[id] = true; });
      paint();
      applyFavView();
    }).catch(function () { favIds = {}; paint(); });
  }
  var walletList = [];
  function addWallet(name, icon, provider, rdns) {
    if (!provider || typeof provider.request !== "function") return;
    for (var i = 0; i < walletList.length; i++) {
      if (walletList[i].provider === provider) return;
      if (walletList[i].name === name) {
        if (!walletList[i].icon && icon) walletList[i].icon = icon;
        return;
      }
    }
    walletList.push({ name: name, icon: icon || "", provider: provider, rdns: rdns || "" });
  }
  function legacyName(p) {
    if (p.isMetaMask) return "MetaMask";
    if (p.isCoinbaseWallet) return "Coinbase Wallet";
    if (p.isOkxWallet || p.isOKExWallet) return "OKX Wallet";
    return "浏览器钱包";
  }
  function collectLegacy() {
    var eth = window.ethereum;
    if (eth) {
      if (eth.providers && eth.providers.length) {
        eth.providers.forEach(function (p) { addWallet(legacyName(p), "", p, ""); });
      } else {
        addWallet(legacyName(eth), "", eth, "");
      }
    }
    if (window.okxwallet) addWallet("OKX Wallet", "", window.okxwallet.ethereum || window.okxwallet, "com.okx.wallet");
    if (window.coinbaseWalletExtension) addWallet("Coinbase Wallet", "", window.coinbaseWalletExtension, "com.coinbase.wallet");
    if (window.binancew3w && window.binancew3w.ethereum) addWallet("Binance Web3 Wallet", "", window.binancew3w.ethereum, "com.binance.wallet");
  }
  function renderWalletList() {
    var list = $("walletList"), empty = $("walletEmpty");
    if (!list) return;
    while (list.firstChild) list.removeChild(list.firstChild);
    var order = ["MetaMask", "OKX Wallet", "Coinbase Wallet", "Binance Web3 Wallet"];
    var sorted = walletList.slice().sort(function (a, b) {
      var ia = order.indexOf(a.name), ib = order.indexOf(b.name);
      if (ia >= 0 && ib >= 0) return ia - ib;
      if (ia >= 0) return -1;
      if (ib >= 0) return 1;
      return a.name < b.name ? -1 : 1;
    });
    if (empty) empty.hidden = sorted.length > 0;
    sorted.forEach(function (w) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wallet-option";
      if (w.icon) {
        var img = document.createElement("img");
        img.src = w.icon;
        img.alt = "";
        img.width = 24;
        img.height = 24;
        btn.appendChild(img);
      }
      var span = document.createElement("span");
      span.textContent = w.name;
      btn.appendChild(span);
      btn.addEventListener("click", function () { loginWith(w.provider, btn); });
      list.appendChild(btn);
    });
  }
  function discoverWallets() {
    collectLegacy();
    try { window.dispatchEvent(new Event("eip6963:requestProvider")); } catch (e) {}
    renderWalletList();
  }
  window.addEventListener("eip6963:announceProvider", function (e) {
    var detail = (e && e.detail) || {};
    var info = detail.info || {};
    if (detail.provider) {
      addWallet(info.name || "钱包", info.icon || "", detail.provider, info.rdns || "");
      renderWalletList();
    }
  });
  function openModal(pending) {
    pendingFav = pending || null;
    var m = $("authModal"), err = $("authError");
    if (err) err.hidden = true;
    if (m) m.hidden = false;
    discoverWallets();
  }
  function closeModal() { var m = $("authModal"); if (m) m.hidden = true; pendingFav = null; }
  function showError(msg) {
    var err = $("authError");
    if (err) { err.textContent = msg; err.hidden = false; }
  }
  function toggleFav(id, forceAdd) {
    if (!session) { openModal(id); return Promise.resolve(); }
    if (favIds[id] && !forceAdd) {
      return api("/site-favorites/" + encodeURIComponent(id), { method: "DELETE" }).then(function () {
        delete favIds[id];
        paint();
        applyFavView();
      }).catch(function () { paint(); });
    }
    return api("/site-favorites", { method: "POST", body: JSON.stringify({ item_id: id }) }).then(function () {
      favIds[id] = true;
      paint();
    }).catch(function () { paint(); });
  }
  document.addEventListener("click", function (e) {
    var btn = e.target.closest ? e.target.closest(".fav-btn") : null;
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    toggleFav(btn.dataset.fav, false);
  }, true);
  var loginBtn = $("loginBtn");
  if (loginBtn) loginBtn.addEventListener("click", function () { openModal(null); });
  var cancelBtn = $("authCancelBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", closeModal);
  var modal = $("authModal");
  if (modal) modal.addEventListener("click", function (e) { if (e.target === modal) closeModal(); });
  var logoutBtn = $("logoutBtn");
  if (logoutBtn) logoutBtn.addEventListener("click", function () {
    if (session) api("/site-auth/logout", { method: "POST" }).catch(function () {});
    try { window.localStorage.removeItem("agent101-session"); window.localStorage.removeItem("agent101-address"); } catch (e) {}
    session = null; favIds = {}; setLoggedOut(); paint(); applyFavView();
  });
  var favViewBtn = $("favViewBtn");
  if (favViewBtn) favViewBtn.addEventListener("click", function () {
    if (window.AGENT101_INDEX_URL) { window.location.href = window.AGENT101_INDEX_URL + "?favorites=1"; return; }
    window.location.href = window.location.pathname + "?favorites=1";
  });
  function loginWith(provider, btn) {
    if (btn) btn.disabled = true;
    provider.request({ method: "eth_requestAccounts" }).then(function (accounts) {
      var addr = String(accounts[0]).toLowerCase();
      return api("/site-auth/nonce", { method: "POST", body: JSON.stringify({ address: addr }) }).then(function (d) {
        return provider.request({ method: "personal_sign", params: [d.message, addr] }).then(function (sig) {
          return api("/site-auth/verify", { method: "POST", body: JSON.stringify({ address: addr, signature: sig }) });
        });
      });
    }).then(function (d) {
      session = d.session_token;
      try {
        window.localStorage.setItem("agent101-session", session);
        window.localStorage.setItem("agent101-address", d.address);
      } catch (e) {}
      setLoggedIn(d.address);
      closeModal();
      return refreshFavs().then(function () {
        if (pendingFav) { var p = pendingFav; pendingFav = null; return toggleFav(p, true); }
      });
    }).catch(function (err) {
      if (err && (err.code === 4001 || /rejected/i.test(String(err.message || "")))) showError("已取消签名，请重新尝试。");
      else showError("登录失败，请检查钱包连接后重试。");
    }).then(function () { if (btn) btn.disabled = false; });
  }
  discoverWallets();
  if (session) {
    api("/site-auth/me").then(function (d) {
      setLoggedIn(d.address);
      return refreshFavs();
    }).catch(function () {
      try { window.localStorage.removeItem("agent101-session"); window.localStorage.removeItem("agent101-address"); } catch (e) {}
      session = null; setLoggedOut(); paint(); applyFavView();
    });
  } else {
    setLoggedOut();
    paint();
    var params = new URLSearchParams(window.location.search);
    if (params.get("favorites") === "1") openModal(null);
  }
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

/** Homepage title/description: the keywords li wants found (2026-10-25) —
 *  agent101 / agent 101 / web3 / ai agent / defi protocol / 安全 — all
 *  appear here, in the H1 and in the intro line below, not just in meta
 *  tags, because on-page text is what actually ranks. */
export const INDEX_TITLE = "Agent 101 资讯 | AI Agent、Web3、DeFi 协议与安全资讯";
export const INDEX_DESCRIPTION =
  "Agent101（Agent 101）资讯站：每日更新 AI Agent、Web3、DeFi 协议（DeFi protocol）与网络安全资讯，覆盖最新协议动态、Agent 工具与安全事件。";

/** List-page link rule, new-old compatible: an item with a rich detail
 *  page (its HTML file landed in NEWS_DETAIL_DIR, served directly at
 *  /docs/news/<id>.html) links to that page; every other item keeps
 *  its original `item/<id>/` link. Callers pass the set of item ids
 *  that have a detail file; an empty set means "no rich pages yet",
 *  so the list is byte-identical to before. No copy into the release
 *  is needed: the detail file is already publicly reachable at its
 *  /docs/news/ address. */
export function renderIndex(
  data: ExportData,
  generatedAt: string,
  cssVersion = "",
  siteUrl: string = DEFAULT_SITE_URL,
  detailIds: ReadonlySet<string> = new Set(),
): string {
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
      const search = `${item.title} ${item.title_zh ?? ""} ${item.summary} ${item.summary_zh ?? ""} ${item.tags.join(" ")}`.toLowerCase();
      const displayDate = item.event_date ?? item.cleaned_at.slice(0, 10);
      const shownTitle = item.title_zh || item.title;
      const origTitle =
        item.title_zh && item.title_zh !== item.title ? `<div class="card-orig">${esc(item.title)}</div>` : "";
      const href = detailIds.has(item.id)
        ? `/docs/news/${encodeURIComponent(item.id)}.html`
        : `item/${encodeURIComponent(item.id)}/`;
      return `<a class="news-card" href="${href}" data-item-id="${esc(item.id)}" data-category="${esc(item.category)}" data-published="${esc(item.cleaned_at)}" data-search="${esc(search)}">
  <div class="card-top">
    <span class="pill" style="background:${categoryColor(item.category)}">${esc(item.category)}</span>
    ${item.sources[0] ? (item.sources[0].url ? `<span class="pill-gray pill-src" data-src="${esc(item.sources[0].url)}" title="打开来源">${esc(item.sources[0].name)}</span>` : `<span class="pill-gray">${esc(item.sources[0].name)}</span>`) : ""}
    ${weightBadge(item)}
    <button type="button" class="fav-btn" data-fav="${esc(item.id)}" aria-label="收藏" title="收藏">☆</button>
  </div>
  <div class="card-title">${esc(shownTitle)}</div>
  ${origTitle}
  <p class="card-sum">${esc(item.summary_zh || item.summary)}</p>
  <div class="card-foot"><span>${esc(fmtZhDate(displayDate))}</span>${item.source_agent ? `<span>${esc(item.source_agent)}</span>` : ""}</div>
</a>`;
    })
    .join("\n");

  const siteJsonLd = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: "Agent 101 资讯",
    alternateName: "Agent101",
    url: `${siteUrl}/`,
    inLanguage: "zh-CN",
  })}</script>`;
  return `${head(INDEX_TITLE, "./styles.css", "./", true, cssVersion, {
    description: INDEX_DESCRIPTION,
    canonical: `${siteUrl}/`,
    ogType: "website",
    jsonLd: siteJsonLd,
  })}
<div class="layout">
${sidebar}
<section class="content">
  <div class="page-head">
    <h1 id="pageTitle">Agent 101 资讯</h1><span class="muted" id="count">${data.items.length} 条</span>
    <div class="seg" data-gran-group>
      <button type="button" class="seg-btn on" data-gran="day">日</button><button type="button" class="seg-btn" data-gran="week">周</button><button type="button" class="seg-btn" data-gran="month">月</button><button type="button" class="seg-btn" data-gran="year">年</button>
    </div>
    <button type="button" class="refresh-btn" id="refreshBtn" title="刷新列表" aria-label="刷新列表">${REFRESH_ICON}</button>
  </div>
  <p class="muted" style="margin:0 0 16px">AI Agent、Web3、DeFi 协议与安全资讯，每日更新。</p>
  ${
    data.items.length === 0
      ? `<div class="card empty"><p>这里还没有资讯</p><p class="muted">新的简报清洗完成后会自动出现在这里</p></div>`
      : `<div class="grid" id="grid">\n${cards}\n</div>
  <div class="card empty" id="emptyFilter" style="display:none"><p>这个筛选下没有资讯</p><p class="muted">换个分类、时间范围或清除搜索试试</p></div>`
  }
</section>
</div>
</main>
${FOOTER}
${PAGE_JS}
${SITE_JS}
</body>
</html>
`;
}

export function renderItem(
  item: ExportItem,
  publicApiPath: string,
  cssVersion = "",
  siteUrl: string = DEFAULT_SITE_URL,
): string {
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
  const shownTitle = item.title_zh || item.title;
  const desc = metaDesc(item.summary_zh || item.summary);
  const canonical = `${siteUrl}/item/${encodeURIComponent(item.id)}/`;
  const itemJsonLd = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org",
    "@type": "NewsArticle",
    headline: shownTitle,
    description: desc,
    datePublished: item.cleaned_at,
    dateModified: item.cleaned_at,
    inLanguage: "zh-CN",
    articleSection: item.category,
    author: { "@type": "Organization", name: "Agent 101 资讯", url: `${siteUrl}/` },
    publisher: { "@type": "Organization", name: "Agent 101 资讯", url: `${siteUrl}/` },
    mainEntityOfPage: canonical,
  })}</script>`;
  return `${head(`${shownTitle} | Agent 101 资讯`, "../../styles.css", "../../", false, cssVersion, {
    description: desc,
    canonical,
    ogType: "article",
    articleMeta: `<meta property="article:published_time" content="${esc(item.cleaned_at)}" />\n<meta property="article:section" content="${esc(item.category)}" />`,
    jsonLd: itemJsonLd,
  })}
<p class="muted"><a href="../../" style="color:var(--accent-strong)">← 返回列表</a></p>
<div class="card-top" style="margin-top:12px">
  <span class="pill" style="background:${categoryColor(item.category)}">${esc(item.category)}</span>
  ${item.sources[0] ? `<span class="pill-gray">${esc(item.sources[0].name)}</span>` : ""}
  ${weightBadge(item)}
  <button type="button" class="fav-btn" data-fav="${esc(item.id)}" data-detail="1" aria-label="收藏">☆ 收藏</button>
</div>
<h1 style="line-height:1.45;font-size:22px;margin-top:12px">${esc(item.title_zh || item.title)}</h1>
${item.title_zh && item.title_zh !== item.title ? `<p class="muted" style="margin-top:4px">原文：${esc(item.title)}</p>` : ""}
<p class="muted">${esc(fmtZhDate(displayDate))}${item.event_date ? " · 事件日期" : ""}</p>
<div style="margin:10px 0">${tags}</div>
<h2>摘要</h2>
<div class="card"><p class="summary">${esc(item.summary_zh || item.summary)}</p></div>
${item.summary_zh && item.summary_zh !== item.summary ? `<div class="card"><p class="muted" style="margin:0 0 6px">原文摘要</p><p class="summary">${esc(item.summary)}</p></div>` : ""}
${detail}
${sources}
<p class="muted" style="margin-top:24px">由 ${esc(item.provider)} / ${esc(item.model)} 于 ${esc(fmtDateTime(item.cleaned_at))} 清洗${item.source_agent ? ` · 推送 agent ${esc(item.source_agent)}` : ""} · 原始记录 <a href="${esc(publicApiPath)}/api/v1/records/${encodeURIComponent(item.source_record_id)}" target="_blank" rel="noreferrer" style="color:var(--accent-strong)">${esc(item.source_record_id.slice(0, 8))}…</a></p>
</main>
${FOOTER}
<script>window.AGENT101_INDEX_URL = ${JSON.stringify(siteUrl + "/")};</script>
${SITE_JS}
</body>
</html>
`;
}
