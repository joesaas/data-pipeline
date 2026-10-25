<template>
  <div class="wrap">
    <header class="top">
      <h1>data-pipeline 控制台</h1>
      <div class="top-right">
        <span class="health" :class="{ ok: healthOk, bad: healthOk === false }">
          {{ healthOk === null ? "健康检查…" : healthOk ? "API 正常" : "API 不可达" }}
        </span>
        <button v-if="key" class="btn ghost" @click="logout">退出登录</button>
      </div>
    </header>

    <!-- Login gate: the console itself has no accounts; any admin key opens it. -->
    <section v-if="!key" class="card login">
      <h2>用 admin 钥匙登录</h2>
      <p class="hint">
        控制台没有独立账号：粘贴一把 role 为 admin 的钥匙即可进入。
        钥匙只存在浏览器 localStorage，不会发给除本 API 以外的任何地方。
        还没有 admin 钥匙时，先在服务器上跑
        <code>npm run create-token -- --admin console-admin</code>（进 apps/api 目录跑，或等根脚本修复拉取后在根目录跑）。
      </p>
      <form @submit.prevent="login">
        <input
          v-model="keyInput"
          type="password"
          placeholder="粘贴 admin 钥匙"
          autocomplete="off"
          class="input"
        />
        <button class="btn primary" :disabled="busy">进入控制台</button>
      </form>
      <p v-if="loginError" class="err">{{ loginError }}</p>
    </section>

    <template v-else>
      <nav class="tabs">
        <button :class="{ active: tab === 'tokens' }" @click="openTokensTab">Tokens</button>
        <button :class="{ active: tab === 'webhooks' }" @click="openWebhooksTab">Webhooks</button>
        <button :class="{ active: tab === 'records' }" @click="openRecordsTab">Records</button>
        <button :class="{ active: tab === 'news' }" @click="openNewsTab">News</button>
      </nav>

      <!-- Tokens -->
      <section v-if="tab === 'tokens'" class="card">
        <div class="row space">
          <h2>Tokens</h2>
          <button class="btn" :disabled="tokensRefreshing" @click="refreshTokens">
            <span v-if="tokensRefreshing" class="spin">⟳</span>
            {{ tokensRefreshing ? "刷新中…" : "刷新" }}
          </button>
        </div>
        <p class="hint">
          明文钥匙只在创建那一刻显示一次，库里只存哈希——这里永远查不回已发钥匙的明文，丢了只能吊销重发。
        </p>
        <p class="hint">
          上次刷新：{{ tokensLastRefreshed || "尚未刷新" }}
          <span v-if="tokensRefreshing"> · 正在从服务器拉取最新数据…</span>
          <span v-else-if="tokens.length"> · 当前共 {{ tokens.length }} 条</span>
        </p>
        <table v-if="tokens.length">
          <thead>
            <tr><th>名字</th><th>角色</th><th>id</th><th>创建时间</th><th>状态</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="t in tokens" :key="t.id">
              <td>{{ t.name }}</td>
              <td><span class="badge" :class="t.role">{{ t.role }}</span></td>
              <td class="mono short">{{ t.id }}</td>
              <td>{{ fmtTime(t.created_at) }}</td>
              <td>{{ t.revoked_at ? "已吊销 " + fmtTime(t.revoked_at) : "使用中" }}</td>
              <td>
                <button
                  v-if="!t.revoked_at"
                  class="btn danger small"
                  :disabled="busy"
                  @click="revoke(t)"
                >吊销</button>
              </td>
            </tr>
          </tbody>
        </table>
        <p v-else class="hint">还没有 token。</p>

        <form class="create" @submit.prevent="create">
          <input v-model="newName" placeholder="新 token 名字，如 feed" class="input" />
          <select v-model="newRole" class="input">
            <option value="user">user（只能读写自己的桶）</option>
            <option value="admin">admin（可跨桶读，控制台登录也用它）</option>
          </select>
          <button class="btn primary" :disabled="busy">新建</button>
        </form>

        <div v-if="createdKey" class="once">
          <p><strong>新钥匙（只显示这一次，复制后点“我已保存”）：</strong></p>
          <code class="keybox">{{ createdKey.api_key }}</code>
          <div class="row">
            <button class="btn" @click="copyKey">复制</button>
            <button class="btn primary" @click="createdKey = null">我已保存</button>
          </div>
          <p v-if="copied" class="ok">已复制到剪贴板。</p>
        </div>
        <p v-if="tokensError" class="err">{{ tokensError }}</p>
      </section>

      <!-- Webhooks -->
      <section v-if="tab === 'webhooks'" class="card">
        <div class="row space">
          <h2>Webhooks</h2>
          <button class="btn" :disabled="webhooksRefreshing" @click="refreshWebhooks">
            <span v-if="webhooksRefreshing" class="spin">⟳</span>
            {{ webhooksRefreshing ? "刷新中…" : "刷新" }}
          </button>
        </div>
        <p class="hint">
          每个 webhook 是一组接收地址（URL + token + 可选 payload 模板），存在数据库 webhooks 表里。
          后台定时触发只发标为“定时”的那条；任何一条都可以点“测试一次”单独发一次，不改定时设置、不动触发节奏。
          没有标为定时的行时，定时触发当轮跳过。token 永远不显示。
        </p>
        <p class="hint">
          上次刷新：{{ webhooksLastRefreshed || "尚未刷新" }}
          <span v-if="webhooksRefreshing"> · 正在从服务器拉取最新数据…</span>
          <span v-else-if="webhooks.length"> · 当前共 {{ webhooks.length }} 条</span>
        </p>
        <div v-if="webhookView === 'list'">
          <table v-if="webhooks.length">
            <thead>
              <tr><th>名字</th><th>URL</th><th>定时</th><th>更新时间</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="w in webhooks" :key="w.id" @click="openWebhook(w)">
                <td>{{ w.name }}</td>
                <td class="mono short">{{ w.url }}</td>
                <td><span v-if="w.is_active" class="badge">定时</span><span v-else>—</span></td>
                <td>{{ fmtTime(w.updated_at) }}</td>
                <td @click.stop>
                  <button class="btn small" :disabled="busy" @click="openWebhook(w)">详情</button>
                  <button class="btn small" :disabled="busy" @click="startEditWebhook(w)">编辑</button>
                  <button class="btn small" :disabled="busy" @click="testWebhook(w)">测试一次</button>
                  <button v-if="!w.is_active" class="btn small" :disabled="busy" @click="setWebhookActive(w, true)">设为定时</button>
                  <button v-else class="btn small" :disabled="busy" @click="setWebhookActive(w, false)">取消定时</button>
                  <button class="btn danger small" :disabled="busy" @click="deleteWebhook(w)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="hint">还没有 webhook，在下方新建一个。</p>
          <form class="create" @submit.prevent="createWebhook">
            <input v-model="newWebhookName" placeholder="新 webhook 名字，如：grok-bot" class="input" />
            <input v-model="newWebhookUrl" placeholder="Webhook URL（https://…）" class="input" />
            <input v-model="newWebhookToken" type="password" placeholder="Webhook token" class="input" autocomplete="off" />
            <textarea v-model="newWebhookPayload" rows="4" placeholder='payload 模板（可选，JSON 对象，如 {"prompt": "…"})' class="input"></textarea>
            <button class="btn primary" :disabled="busy">新建</button>
          </form>
        </div>
        <div v-if="webhookView === 'detail' && selectedWebhook">
          <h4>{{ selectedWebhook.name }} <span v-if="selectedWebhook.is_active" class="badge">定时</span></h4>
          <div class="hint">更新于 {{ fmtTime(selectedWebhook.updated_at) }}</div>
          <div class="grid">
            <div><label>URL</label><div class="mono short">{{ selectedWebhook.url }}</div></div>
            <div><label>token</label><div>{{ selectedWebhook.hasToken ? "已配置（不显示）" : "未配置" }}</div></div>
            <div><label>payload 模板</label><div>{{ selectedWebhook.payload ? "已设置" : "未设置" }}</div></div>
          </div>
          <pre v-if="selectedWebhook.payload" class="out">{{ selectedWebhook.payload }}</pre>
          <div class="row">
            <button class="btn" @click="webhookView = 'list'">返回列表</button>
            <button class="btn" :disabled="busy" @click="startEditWebhook(selectedWebhook)">编辑</button>
            <button class="btn" :disabled="busy" @click="testWebhook(selectedWebhook)">测试一次</button>
            <button v-if="!selectedWebhook.is_active" class="btn" :disabled="busy" @click="setWebhookActive(selectedWebhook, true)">设为定时</button>
            <button v-else class="btn" :disabled="busy" @click="setWebhookActive(selectedWebhook, false)">取消定时</button>
            <button class="btn danger" :disabled="busy" @click="deleteWebhook(selectedWebhook)">删除</button>
          </div>
        </div>
        <form v-if="webhookView === 'edit'" class="create" @submit.prevent="saveWebhookForm">
          <div class="hint">正在编辑 {{ editWebhookName }}（名字不可改）。URL 与 token 留空则不改；payload 模板是完整值，留空即清除。</div>
          <input v-model="editWebhookUrl" placeholder="Webhook URL（https://…，留空则不改）" class="input" />
          <input v-model="editWebhookToken" type="password" placeholder="Webhook token（留空则不改）" class="input" autocomplete="off" />
          <textarea v-model="editWebhookPayload" rows="10" placeholder='JSON 对象，如 {"prompt": "…"}（留空则清除模板）' class="input"></textarea>
          <div class="row">
            <button class="btn primary" :disabled="busy">保存</button>
            <button class="btn" type="button" @click="webhookView = 'list'">取消</button>
          </div>
        </form>
        <p v-if="webhookOk" class="ok">{{ webhookOk }}</p>
        <p v-if="webhookError" class="err">{{ webhookError }}</p>
        <pre v-if="webhookTestResult" class="out">{{ webhookTestResult }}</pre>
      </section>

      <!-- Records -->
      <section v-if="tab === 'records'" class="card">
        <div class="row space">
          <h2>Records</h2>
          <button class="btn" :disabled="recordsRefreshing" @click="refreshRecords">
            <span v-if="recordsRefreshing" class="spin">⟳</span>
            {{ recordsRefreshing ? "刷新中…" : "刷新" }}
          </button>
        </div>
        <p class="hint">
          这里是数据库 records 表的全部记录（admin 跨桶可见，桶名按 token_id 对应到 Tokens 页的名字）。
          记录只能从 push 接口进来，控制台不新建、不编辑，只能看详情和删除。列表只显示标题等摘要，
          prompt 与 content 正文只在详情页展开。
        </p>
        <p class="hint">
          上次刷新：{{ recordsLastRefreshed || "尚未刷新" }}
          <span v-if="recordsRefreshing"> · 正在从服务器拉取最新数据…</span>
          <span v-else-if="recordsTotal"> · 当前共 {{ recordsTotal }} 条</span>
        </p>
        <form class="create" @submit.prevent="applyRecordsFilter">
          <input v-model="recordsFilterAgent" placeholder="按来源筛选，如 muse" class="input" />
          <input v-model="recordsFilterTag" placeholder="按标签筛选，如 inbox" class="input" />
          <button class="btn primary" :disabled="busy">筛选</button>
          <button class="btn" type="button" :disabled="busy" @click="clearRecordsFilter">清除筛选</button>
        </form>
        <div v-if="recordsView === 'list'">
          <table v-if="records.length">
            <thead>
              <tr><th>标题</th><th>来源</th><th>桶</th><th>external_id</th><th>标签</th><th>内容字数</th><th>更新时间</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="r in records" :key="r.id" @click="openRecord(r)">
                <td class="short">{{ r.title || "(无标题)" }}</td>
                <td>{{ r.source_agent }}</td>
                <td>{{ tokenName(r.token_id) }}</td>
                <td class="mono short">{{ r.external_id || "—" }}</td>
                <td class="short">{{ (r.tags || []).join(", ") || "—" }}</td>
                <td>{{ (r.content || "").length }}</td>
                <td>{{ fmtTime(r.updated_at) }}</td>
                <td @click.stop>
                  <button class="btn small" :disabled="busy" @click="openRecord(r)">详情</button>
                  <button class="btn danger small" :disabled="busy" @click="deleteRecord(r)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="hint">没有符合条件的记录。</p>
          <div class="row space">
            <span class="hint">共 {{ recordsTotal }} 条，当前第 {{ recordsOffset + 1 }}–{{ recordsOffset + records.length }} 条</span>
            <span class="row">
              <button class="btn small" :disabled="busy || recordsOffset === 0" @click="recordsPage(-1)">上一页</button>
              <button class="btn small" :disabled="busy || recordsOffset + records.length >= recordsTotal" @click="recordsPage(1)">下一页</button>
            </span>
          </div>
        </div>
        <div v-if="recordsView === 'detail' && selectedRecord">
          <h4>{{ selectedRecord.title || "(无标题)" }}</h4>
          <div class="grid">
            <div><label>id</label><div class="mono short">{{ selectedRecord.id }}</div></div>
            <div><label>桶</label><div>{{ tokenName(selectedRecord.token_id) }}（{{ selectedRecord.token_id }}）</div></div>
            <div><label>external_id</label><div class="mono short">{{ selectedRecord.external_id || "—" }}</div></div>
            <div><label>来源</label><div>{{ selectedRecord.source_agent }}</div></div>
            <div><label>skill_version</label><div>{{ selectedRecord.skill_version || "—" }}</div></div>
            <div><label>content_format</label><div>{{ selectedRecord.content_format }}</div></div>
            <div><label>标签</label><div>{{ (selectedRecord.tags || []).join(", ") || "—" }}</div></div>
            <div><label>创建时间</label><div>{{ fmtTime(selectedRecord.created_at) }}</div></div>
            <div><label>更新时间</label><div>{{ fmtTime(selectedRecord.updated_at) }}</div></div>
          </div>
          <h4>metadata</h4>
          <pre class="out">{{ JSON.stringify(selectedRecord.metadata || {}, null, 2) }}</pre>
          <h4>prompt</h4>
          <pre class="out">{{ selectedRecord.prompt }}</pre>
          <h4>content</h4>
          <pre class="out">{{ selectedRecord.content }}</pre>
          <div class="row">
            <button class="btn" @click="recordsView = 'list'">返回列表</button>
            <button class="btn danger" :disabled="busy" @click="deleteRecord(selectedRecord)">删除这条</button>
          </div>
        </div>
        <p v-if="recordsOk" class="ok">{{ recordsOk }}</p>
        <p v-if="recordsError" class="err">{{ recordsError }}</p>
      </section>

      <!-- News -->
      <section v-if="tab === 'news'" class="card">
        <div class="row space">
          <h2>News</h2>
          <button class="btn" :disabled="newsRefreshing" @click="refreshNews">
            <span v-if="newsRefreshing" class="spin">⟳</span>
            {{ newsRefreshing ? "刷新中…" : "刷新" }}
          </button>
        </div>
        <p class="hint">
          这里就是新闻站（agent101.uk/news）展示的那份数据：cleaner 清洗后的
          cleaned_items 条目。控制台只读不改——清洗结果归 cleaner 所有，没有
          新建、编辑、删除。列表只显示标题等摘要，摘要与详情只在详情页展开。
        </p>
        <p class="hint">
          上次刷新：{{ newsLastRefreshed || "尚未刷新" }}
          <span v-if="newsRefreshing"> · 正在从服务器拉取最新数据…</span>
          <span v-else-if="newsStats"> · 共 {{ newsStats.items }} 条 · 清洗记录 {{ newsStats.records }} 条 · 最近清洗 {{ newsStats.last_cleaned_at ? fmtTime(newsStats.last_cleaned_at) : "—" }}</span>
        </p>
        <p v-if="newsStats && newsStats.categories.length" class="hint">
          分类：{{ newsStats.categories.map((c) => `${c.name} ${c.count}`).join(" · ") }}
        </p>
        <form class="create" @submit.prevent="applyNewsFilter">
          <input v-model="newsFilterCategory" placeholder="按分类筛选，如 Web3 DeFi" class="input" />
          <input v-model="newsFilterQ" placeholder="按关键词搜索标题/摘要" class="input" />
          <button class="btn primary" :disabled="newsRefreshing">筛选</button>
          <button class="btn" type="button" :disabled="newsRefreshing" @click="clearNewsFilter">清除筛选</button>
        </form>
        <div v-if="newsView === 'list'">
          <table v-if="news.length">
            <thead>
              <tr><th>标题</th><th>分类</th><th>事件日期</th><th>权重</th><th>来源</th><th>清洗时间</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="n in news" :key="n.id" @click="openNews(n)">
                <td class="short">{{ n.title || "(无标题)" }}</td>
                <td>{{ n.category }}</td>
                <td>{{ n.event_date || "—" }}</td>
                <td>{{ n.weight }}</td>
                <td class="short">{{ (n.sources || []).map((s) => s.name).join(", ") || n.source_agent || "—" }}</td>
                <td>{{ fmtTime(n.cleaned_at) }}</td>
                <td @click.stop>
                  <button class="btn small" :disabled="newsRefreshing" @click="openNews(n)">详情</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="hint">没有符合条件的新闻条目。</p>
          <div class="row space">
            <span class="hint">共 {{ newsTotal }} 条，当前第 {{ newsOffset + 1 }}–{{ newsOffset + news.length }} 条</span>
            <span class="row">
              <button class="btn small" :disabled="newsRefreshing || newsOffset === 0" @click="newsPage(-1)">上一页</button>
              <button class="btn small" :disabled="newsRefreshing || newsOffset + news.length >= newsTotal" @click="newsPage(1)">下一页</button>
            </span>
          </div>
        </div>
        <div v-if="newsView === 'detail' && selectedNews">
          <h4>{{ selectedNews.title || "(无标题)" }}</h4>
          <p v-if="selectedNews.title_zh" class="hint">{{ selectedNews.title_zh }}</p>
          <div class="grid">
            <div><label>分类</label><div>{{ selectedNews.category }}</div></div>
            <div><label>事件日期</label><div>{{ selectedNews.event_date || "—" }}</div></div>
            <div><label>权重 / 档</label><div>{{ selectedNews.weight }} / {{ selectedNews.weight_tier }}</div></div>
            <div><label>标签</label><div>{{ (selectedNews.tags || []).join(", ") || "—" }}</div></div>
            <div><label>推送 agent</label><div>{{ selectedNews.source_agent || "—" }}</div></div>
            <div><label>清洗模型</label><div>{{ selectedNews.provider }} / {{ selectedNews.model }}</div></div>
            <div><label>清洗时间</label><div>{{ fmtTime(selectedNews.cleaned_at) }}</div></div>
            <div><label>原始记录 id</label><div class="mono short">{{ selectedNews.source_record_id }}</div></div>
          </div>
          <h4>摘要</h4>
          <pre class="out">{{ selectedNews.summary }}</pre>
          <p v-if="selectedNews.summary_zh" class="hint">{{ selectedNews.summary_zh }}</p>
          <div v-if="selectedNews.detail">
            <h4>详情</h4>
            <pre class="out">{{ selectedNews.detail }}</pre>
          </div>
          <div v-if="(selectedNews.sources || []).length">
            <h4>来源</h4>
            <ul>
              <li v-for="s in selectedNews.sources" :key="s.url">
                <a :href="s.url" target="_blank" rel="noreferrer">{{ s.name }}</a>
              </li>
            </ul>
          </div>
          <div class="row">
            <button class="btn" @click="newsView = 'list'">返回列表</button>
          </div>
        </div>
        <p v-if="newsError" class="err">{{ newsError }}</p>
      </section>
    </template>
  </div>
</template>

<script setup>
import { onMounted, ref } from "vue";
import { adminApi, clearKey, loadKey, saveKey } from "./api.js";

const key = ref(loadKey());
const keyInput = ref("");
const loginError = ref("");
const busy = ref(false);
const tab = ref("tokens");
const healthOk = ref(null);

const tokens = ref([]);
const tokensError = ref("");
const tokensRefreshing = ref(false);
const tokensLastRefreshed = ref("");
let tokensRefreshSeq = 0;
const newName = ref("");
const newRole = ref("user");
const createdKey = ref(null);
const copied = ref(false);

const webhooks = ref([]);
const webhookView = ref("list");
const selectedWebhook = ref(null);
const newWebhookName = ref("");
const newWebhookUrl = ref("");
const newWebhookToken = ref("");
const newWebhookPayload = ref("");
const editWebhookId = ref(null);
const editWebhookName = ref("");
const editWebhookUrl = ref("");
const editWebhookToken = ref("");
const editWebhookPayload = ref("");
const webhookOk = ref("");
const webhookError = ref("");
const webhookTestResult = ref("");
const webhooksRefreshing = ref(false);
const webhooksLastRefreshed = ref("");
let webhooksRefreshSeq = 0;

const records = ref([]);
const recordsTotal = ref(0);
const recordsOffset = ref(0);
const recordsPageSize = 20;
const recordsFilterAgent = ref("");
const recordsFilterTag = ref("");
const recordsView = ref("list");
const selectedRecord = ref(null);
const recordsOk = ref("");
const recordsError = ref("");
const recordsRefreshing = ref(false);
const recordsLastRefreshed = ref("");
let recordsRefreshSeq = 0;

const news = ref([]);
const newsTotal = ref(0);
const newsOffset = ref(0);
const newsPageSize = 20;
const newsFilterCategory = ref("");
const newsFilterQ = ref("");
const newsView = ref("list");
const selectedNews = ref(null);
const newsStats = ref(null);
const newsError = ref("");
const newsRefreshing = ref(false);
const newsLastRefreshed = ref("");
let newsRefreshSeq = 0;

function fmtTime(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

async function login() {
  busy.value = true;
  loginError.value = "";
  try {
    await adminApi.listTokens(keyInput.value.trim());
    saveKey(keyInput.value.trim());
    key.value = keyInput.value.trim();
    keyInput.value = "";
    await Promise.all([refreshTokens(), refreshWebhooks(), refreshRecords(), refreshNews()]);
  } catch (e) {
    loginError.value = e.status === 401 ? "钥匙无效（401）" : e.status === 403 ? "这把不是 admin 钥匙（403）" : e.message;
  } finally {
    busy.value = false;
  }
}

function logout() {
  clearKey();
  key.value = "";
  tokens.value = [];
  webhooks.value = [];
  records.value = [];
  recordsTotal.value = 0;
  selectedRecord.value = null;
  recordsView.value = "list";
  recordsLastRefreshed.value = "";
  tokensLastRefreshed.value = "";
  webhooksLastRefreshed.value = "";
  news.value = [];
  newsTotal.value = 0;
  newsStats.value = null;
  selectedNews.value = null;
  newsView.value = "list";
  newsLastRefreshed.value = "";
}

function openTokensTab() {
  tab.value = "tokens";
  refreshTokens();
}

function openWebhooksTab() {
  tab.value = "webhooks";
  refreshWebhooks();
}

function tokenName(tokenId) {
  const t = tokens.value.find((x) => x.id === tokenId);
  return t ? t.name : tokenId;
}

async function refreshTokens() {
  // Sequence token, not an early-return guard: two overlapping fetches
  // (e.g. a manual Refresh, then a post-delete refresh) must not let
  // the older response overwrite the newer one, and the post-mutation
  // refresh must never be dropped — that would leave a deleted row
  // on screen looking like the refresh did nothing.
  const seq = ++tokensRefreshSeq;
  tokensRefreshing.value = true;
  tokensError.value = "";
  try {
    const data = await adminApi.listTokens(key.value);
    if (seq !== tokensRefreshSeq) return;
    tokens.value = data.items;
    tokensLastRefreshed.value = new Date().toLocaleString();
  } catch (e) {
    if (seq === tokensRefreshSeq) tokensError.value = e.message;
  } finally {
    if (seq === tokensRefreshSeq) tokensRefreshing.value = false;
  }
}

async function create() {
  busy.value = true;
  tokensError.value = "";
  copied.value = false;
  try {
    const data = await adminApi.createToken(key.value, newName.value.trim(), newRole.value);
    createdKey.value = data;
    newName.value = "";
    await refreshTokens();
  } catch (e) {
    tokensError.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function copyKey() {
  try {
    await navigator.clipboard.writeText(createdKey.value.api_key);
    copied.value = true;
  } catch {
    copied.value = false;
  }
}

async function revoke(t) {
  if (!window.confirm(`吊销 token「${t.name}」？吊销后立即失效，不可恢复。`)) return;
  busy.value = true;
  try {
    await adminApi.revokeToken(key.value, t.id);
    await refreshTokens();
  } catch (e) {
    tokensError.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function refreshWebhooks() {
  const seq = ++webhooksRefreshSeq;
  webhooksRefreshing.value = true;
  try {
    const rows = await adminApi.listWebhooks(key.value);
    if (seq !== webhooksRefreshSeq) return;
    webhooks.value = rows;
    webhooksLastRefreshed.value = new Date().toLocaleString();
    if (selectedWebhook.value) {
      selectedWebhook.value =
        webhooks.value.find((w) => w.id === selectedWebhook.value.id) ?? null;
      if (!selectedWebhook.value && webhookView.value === "detail") webhookView.value = "list";
    }
  } catch (e) {
    if (seq === webhooksRefreshSeq) webhookError.value = e.message;
  } finally {
    if (seq === webhooksRefreshSeq) webhooksRefreshing.value = false;
  }
}

function openWebhook(w) {
  selectedWebhook.value = w;
  webhookView.value = "detail";
}

async function createWebhook() {
  webhookError.value = "";
  webhookOk.value = "";
  busy.value = true;
  try {
    const saved = await adminApi.createWebhook(key.value, {
      name: newWebhookName.value,
      webhookUrl: newWebhookUrl.value,
      webhookToken: newWebhookToken.value,
      payload: newWebhookPayload.value,
    });
    newWebhookName.value = "";
    newWebhookUrl.value = "";
    newWebhookToken.value = "";
    newWebhookPayload.value = "";
    webhookOk.value = "webhook 已新增（默认不定时）。";
    selectedWebhook.value = saved;
    await refreshWebhooks();
  } catch (e) {
    webhookError.value = e.message;
  } finally {
    busy.value = false;
  }
}

function startEditWebhook(w) {
  editWebhookId.value = w.id;
  editWebhookName.value = w.name;
  editWebhookUrl.value = w.url;
  editWebhookToken.value = "";
  editWebhookPayload.value = w.payload ?? "";
  webhookView.value = "edit";
  webhookError.value = "";
  webhookOk.value = "";
}

async function saveWebhookForm() {
  webhookError.value = "";
  webhookOk.value = "";
  busy.value = true;
  try {
    // URL/token are partial updates (empty = keep); the payload template
    // is a full value (empty clears it).
    const body = {};
    if (editWebhookUrl.value.trim()) body.webhookUrl = editWebhookUrl.value.trim();
    if (editWebhookToken.value.trim()) body.webhookToken = editWebhookToken.value.trim();
    body.payload = editWebhookPayload.value;
    const saved = await adminApi.updateWebhook(key.value, editWebhookId.value, body);
    webhookView.value = "list";
    webhookOk.value = "webhook 已更新。";
    selectedWebhook.value = saved;
    await refreshWebhooks();
  } catch (e) {
    webhookError.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function deleteWebhook(w) {
  if (!window.confirm(`删除 webhook「${w.name}」？删除后不可恢复；如果它是定时 webhook，定时触发将没有可发的地址（当轮跳过）。`)) return;
  webhookError.value = "";
  webhookOk.value = "";
  busy.value = true;
  try {
    await adminApi.deleteWebhook(key.value, w.id);
    webhookView.value = "list";
    selectedWebhook.value = null;
    webhookOk.value = "webhook 已删除。";
    await refreshWebhooks();
  } catch (e) {
    webhookError.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function setWebhookActive(w, active) {
  webhookError.value = "";
  webhookOk.value = "";
  busy.value = true;
  try {
    const saved = await adminApi.setWebhookActive(key.value, w.id, active);
    webhookOk.value = active ? `「${w.name}」已设为定时，定时触发改发这一条。` : `「${w.name}」已取消定时。`;
    selectedWebhook.value = saved;
    await refreshWebhooks();
  } catch (e) {
    webhookError.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function testWebhook(w) {
  webhookError.value = "";
  webhookOk.value = "";
  webhookTestResult.value = "";
  busy.value = true;
  try {
    const data = await adminApi.testWebhook(key.value, w.id);
    webhookTestResult.value = data.output || "测试成功";
    await refreshWebhooks();
  } catch (e) {
    webhookTestResult.value = `测试失败：${e.message}\n${e.data?.output || ""}`.trim();
  } finally {
    busy.value = false;
  }
}

async function refreshRecords() {
  // Same sequence-token rule as Tokens/Webhooks: the button is disabled
  // while refreshing, so a manual double-click cannot start a second
  // fetch — but a post-delete refresh must never be dropped, and an
  // older fetch resolving late must never overwrite a newer page.
  const seq = ++recordsRefreshSeq;
  recordsRefreshing.value = true;
  recordsError.value = "";
  try {
    const data = await adminApi.listRecords(key.value, {
      source_agent: recordsFilterAgent.value.trim() || undefined,
      tag: recordsFilterTag.value.trim() || undefined,
      limit: recordsPageSize,
      offset: recordsOffset.value,
    });
    if (seq !== recordsRefreshSeq) return;
    records.value = data.items;
    recordsTotal.value = data.total;
    // The timestamp is the visible proof the refresh actually ran:
    // it moves on every click even when no row changed.
    recordsLastRefreshed.value = new Date().toLocaleString();
    if (selectedRecord.value) {
      selectedRecord.value =
        records.value.find((r) => r.id === selectedRecord.value.id) ?? null;
      if (!selectedRecord.value && recordsView.value === "detail") recordsView.value = "list";
    }
  } catch (e) {
    if (seq === recordsRefreshSeq) recordsError.value = e.message;
  } finally {
    if (seq === recordsRefreshSeq) recordsRefreshing.value = false;
  }
}

function openRecordsTab() {
  tab.value = "records";
  // Entering the tab always re-reads the server: a Records page left
  // open while new records are pushed must not keep showing old rows
  // until the user remembers to hit Refresh.
  refreshRecords();
}

async function refreshNews() {
  const seq = ++newsRefreshSeq;
  newsRefreshing.value = true;
  newsError.value = "";
  try {
    const [data, stats] = await Promise.all([
      adminApi.listNews(key.value, {
        category: newsFilterCategory.value.trim() || undefined,
        q: newsFilterQ.value.trim() || undefined,
        limit: newsPageSize,
        offset: newsOffset.value,
      }),
      adminApi.getNewsStats(key.value),
    ]);
    if (seq !== newsRefreshSeq) return;
    news.value = data.items;
    newsTotal.value = data.total;
    newsStats.value = stats;
    newsLastRefreshed.value = new Date().toLocaleString();
    if (selectedNews.value) {
      selectedNews.value =
        news.value.find((n) => n.id === selectedNews.value.id) ?? null;
      if (!selectedNews.value && newsView.value === "detail") newsView.value = "list";
    }
  } catch (e) {
    if (seq === newsRefreshSeq) newsError.value = e.message;
  } finally {
    if (seq === newsRefreshSeq) newsRefreshing.value = false;
  }
}

function openNewsTab() {
  tab.value = "news";
  refreshNews();
}

function openNews(n) {
  selectedNews.value = n;
  newsView.value = "detail";
}

function applyNewsFilter() {
  newsOffset.value = 0;
  newsView.value = "list";
  refreshNews();
}

function clearNewsFilter() {
  newsFilterCategory.value = "";
  newsFilterQ.value = "";
  newsOffset.value = 0;
  newsView.value = "list";
  refreshNews();
}

function newsPage(dir) {
  const next = newsOffset.value + dir * newsPageSize;
  if (next < 0 || (dir > 0 && newsOffset.value + news.value.length >= newsTotal.value)) return;
  newsOffset.value = next;
  newsView.value = "list";
  refreshNews();
}

function openRecord(r) {
  selectedRecord.value = r;
  recordsView.value = "detail";
}

function applyRecordsFilter() {
  recordsOffset.value = 0;
  recordsView.value = "list";
  refreshRecords();
}

function clearRecordsFilter() {
  recordsFilterAgent.value = "";
  recordsFilterTag.value = "";
  recordsOffset.value = 0;
  recordsView.value = "list";
  refreshRecords();
}

function recordsPage(dir) {
  const next = recordsOffset.value + dir * recordsPageSize;
  if (next < 0 || (dir > 0 && recordsOffset.value + records.value.length >= recordsTotal.value)) return;
  recordsOffset.value = next;
  recordsView.value = "list";
  refreshRecords();
}

async function deleteRecord(r) {
  if (!window.confirm(`删除记录「${r.title || r.id}」？删除后不可恢复。`)) return;
  recordsError.value = "";
  recordsOk.value = "";
  busy.value = true;
  try {
    await adminApi.deleteRecord(key.value, r.id);
    recordsView.value = "list";
    selectedRecord.value = null;
    recordsOk.value = "记录已删除。";
    // Deleting the last row of a page would leave an empty page; step back one page then.
    if (records.value.length === 1 && recordsOffset.value > 0) recordsOffset.value -= recordsPageSize;
    await refreshRecords();
  } catch (e) {
    recordsError.value = e.message;
  } finally {
    busy.value = false;
  }
}

onMounted(async () => {
  try {
    await adminApi.health();
    healthOk.value = true;
  } catch {
    healthOk.value = false;
  }
  if (key.value) {
    await Promise.all([refreshTokens(), refreshWebhooks(), refreshRecords(), refreshNews()]);
  }
});
</script>

<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif; background: #f4f5f7; color: #222; }
.wrap { max-width: 920px; margin: 0 auto; padding: 24px 16px 64px; }
.top { display: flex; justify-content: space-between; align-items: center; }
.top h1 { font-size: 22px; margin: 0; }
.top-right { display: flex; gap: 12px; align-items: center; }
.health { font-size: 13px; color: #888; }
.health.ok { color: #1a7f37; }
.health.bad { color: #cf222e; }
.tabs { display: flex; gap: 8px; margin: 20px 0 0; }
.tabs button { border: 1px solid #ddd; background: #fff; padding: 8px 16px; border-radius: 8px 8px 0 0; cursor: pointer; }
.tabs button.active { background: #222; color: #fff; border-color: #222; }
.card { background: #fff; border: 1px solid #ddd; border-radius: 0 12px 12px 12px; padding: 20px; margin-top: -1px; }
.card h2 { margin: 0 0 12px; font-size: 18px; }
.card h3 { margin: 24px 0 8px; font-size: 16px; }
.card h4 { margin: 20px 0 8px; font-size: 15px; }
.hint { color: #666; font-size: 13px; line-height: 1.7; }
.hint code { background: #f0f0f0; padding: 1px 6px; border-radius: 4px; }
.row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.row.space { justify-content: space-between; }
.input { border: 1px solid #ccc; border-radius: 8px; padding: 9px 12px; font-size: 14px; }
.create textarea.input { width: 100%; min-height: 120px; font-family: inherit; line-height: 1.5; }
.login .input { width: 100%; margin: 12px 0; }
.btn { border: 1px solid #ccc; background: #fff; border-radius: 8px; padding: 8px 16px; cursor: pointer; }
.btn:disabled { opacity: 0.5; cursor: default; }
.btn.primary { background: #222; color: #fff; border-color: #222; }
.btn.danger { color: #cf222e; border-color: #f0b8bc; }
.btn.ghost { border: none; background: transparent; color: #666; }
.btn.small { padding: 4px 10px; font-size: 13px; }
.spin { display: inline-block; animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
th, td { text-align: left; padding: 8px 6px; border-bottom: 1px solid #eee; }
.mono { font-family: ui-monospace, monospace; }
.short { max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { padding: 2px 8px; border-radius: 99px; font-size: 12px; background: #eef2ff; }
.badge.admin { background: #fff1d6; }
.create { display: flex; gap: 12px; margin-top: 16px; flex-wrap: wrap; }
.once { margin-top: 16px; border: 1px solid #e8c87a; background: #fffbe6; border-radius: 8px; padding: 12px; }
.keybox { display: block; background: #fff; border: 1px solid #ddd; border-radius: 6px; padding: 10px; word-break: break-all; margin: 8px 0; }
.err { color: #cf222e; font-size: 14px; }
.ok { color: #1a7f37; font-size: 14px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 12px; margin: 12px 0; }
.grid label { color: #888; font-size: 12px; }
.out { background: #111; color: #ddd; border-radius: 8px; padding: 12px; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
</style>
