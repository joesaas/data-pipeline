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
        <button :class="{ active: tab === 'tokens' }" @click="tab = 'tokens'">Tokens</button>
        <button :class="{ active: tab === 'cursor' }" @click="tab = 'cursor'">Cursor 定时触发</button>
      </nav>

      <!-- Tokens -->
      <section v-if="tab === 'tokens'" class="card">
        <div class="row space">
          <h2>Tokens</h2>
          <button class="btn" :disabled="busy" @click="refreshTokens">刷新</button>
        </div>
        <p class="hint">
          明文钥匙只在创建那一刻显示一次，库里只存哈希——这里永远查不回已发钥匙的明文，丢了只能吊销重发。
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

      <!-- Cursor job -->
      <section v-if="tab === 'cursor'" class="card">
        <div class="row space">
          <h2>Cursor 定时触发</h2>
          <button class="btn" :disabled="busy" @click="refreshCursor">刷新</button>
        </div>
        <p class="hint">
          定时任务现在跑在 job-runner 里：每 1 分钟 tick 一次，到 interval 才真正发一次 webhook。
          webhook 配置存在数据库 webhook_configs 表里——这里可以设置它，但 token 永远不显示。
        </p>
        <div v-if="cursor" class="grid">
          <div><label>上次触发</label><div>{{ cursor.lastTriggeredAt ? fmtTime(cursor.lastTriggeredAt) : "从未" }}</div></div>
          <div><label>当前区间</label><div>{{ cursor.effectiveIntervalMinutes }} 分钟</div></div>
          <div><label>下次触发约</label><div>{{ cursor.nextDueAt ? fmtTime(cursor.nextDueAt) : "下一 tick 即触发" }}</div></div>
          <div><label>webhook 配置</label><div>{{ cursor.webhookConfigured ? "已配置" : "未配置" }}</div></div>
          <div><label>配置来源</label><div>{{ cursor.webhookSource === "db" ? "数据库" : cursor.webhookSource === "env" ? "服务器 .env（回落）" : "—" }}</div></div>
          <div><label>定时 webhook</label><div>{{ cursor.activeWebhookName || "未设" }}</div></div>
          <div><label>数据库配置更新于</label><div>{{ cursor.webhookUpdatedAt ? fmtTime(cursor.webhookUpdatedAt) : "—" }}</div></div>
          <div><label>payload 列表</label><div>{{ cursor.payloadCount > 0 ? "共 " + cursor.payloadCount + " 条，定时：" + (cursor.activePayloadName || "未设") : "未设置（用内置 body）" }}</div></div>
          <div><label>区间来源</label><div>{{ cursor.intervalMinutes !== null ? "控制台设置" : "环境变量 / 默认 60 分钟" }}</div></div>
          <div><label>runner 脚本</label><div>{{ cursor.runnerScriptPresent ? "存在" : "缺失（job-runner 未构建？）" }}</div></div>
        </div>
        <h3>触发设置</h3>
        <div class="create">
          <input v-model.number="intervalInput" type="number" min="1" max="1440" class="input" />
          <span class="hint">分钟；到 interval 才真正发一次 webhook。</span>
        </div>
        <h3>Webhook 列表</h3>
        <p class="hint">每个 webhook 是一组接收地址（URL + token）。定时触发只发标为“定时”的那条；任何一条都可以点“测试一次”单独发一次，不改定时设置、不动触发节奏。token 永远不显示。</p>
        <div v-if="webhookView === 'list'">
          <table v-if="webhooks.length">
            <thead>
              <tr><th>名字</th><th>URL</th><th>定时</th><th>更新时间</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="w in webhooks" :key="w.name" @click="openWebhook(w)">
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
            <textarea v-model="newWebhookPayload" rows="4" placeholder='单个 payload 模板（可选，JSON 对象，如 {"prompt": "…"})' class="input"></textarea>
            <button class="btn primary" :disabled="busy">新建</button>
          </form>
          <div class="row">
            <button v-if="cursor?.webhookInEnv && cursor?.webhookSource !== 'db'" class="btn" :disabled="busy" @click="importWebhook">
              从 .env 导入到数据库
            </button>
          </div>
        </div>
        <div v-if="webhookView === 'detail' && selectedWebhook">
          <h4>{{ selectedWebhook.name }} <span v-if="selectedWebhook.is_active" class="badge">定时</span></h4>
          <div class="hint">更新于 {{ fmtTime(selectedWebhook.updated_at) }}</div>
          <div class="grid">
            <div><label>URL</label><div class="mono short">{{ selectedWebhook.url }}</div></div>
            <div><label>token</label><div>{{ selectedWebhook.hasToken ? "已配置（不显示）" : "未配置" }}</div></div>
            <div><label>单个 payload 模板</label><div>{{ selectedWebhook.payload ? "已设置" : "未设置" }}</div></div>
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
        <h4>Payload 列表</h4>
        <p class="hint">每条 payload 是一份触发 body 的 JSON（里面通常含 prompt）。定时触发发的是标为“定时”的那条；单条的“触发一次”只发那条，不改定时设置。定时未设时，触发按老规则走：单个 payload 模板 → 单个 prompt → 只发 ping。</p>
        <div v-if="payloadView === 'list'">
          <table v-if="payloads.length">
            <thead>
              <tr><th>名字</th><th>内容预览</th><th>定时</th><th>更新时间</th><th></th></tr>
            </thead>
            <tbody>
              <tr v-for="p in payloads" :key="p.id" @click="openPayload(p)">
                <td>{{ p.name }}</td>
                <td class="mono short">{{ payloadPreview(p.content) }}</td>
                <td><span v-if="p.is_active" class="badge">定时</span><span v-else>—</span></td>
                <td>{{ fmtTime(p.updated_at) }}</td>
                <td @click.stop>
                  <button class="btn small" :disabled="busy" @click="openPayload(p)">详情</button>
                  <button class="btn small" :disabled="busy" @click="startEditPayload(p)">编辑</button>
                  <button class="btn small" :disabled="busy" @click="triggerPayload(p)">触发一次</button>
                  <button v-if="!p.is_active" class="btn small" :disabled="busy" @click="setPayloadActive(p, true)">设为定时</button>
                  <button v-else class="btn small" :disabled="busy" @click="setPayloadActive(p, false)">取消定时</button>
                  <button class="btn danger small" :disabled="busy" @click="deletePayload(p)">删除</button>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-else class="hint">还没有 payload，在下方新建一份。</p>
          <form class="create" @submit.prevent="createPayload">
            <input v-model="newPayloadName" placeholder="新 payload 名字，如：新闻简报" class="input" />
            <textarea v-model="newPayloadContent" rows="4" placeholder='JSON 对象，如 {"prompt": "…"}' class="input"></textarea>
            <button class="btn primary" :disabled="busy">新建</button>
          </form>
        </div>
        <div v-if="payloadView === 'detail' && selectedPayload">
          <h4>{{ selectedPayload.name }} <span v-if="selectedPayload.is_active" class="badge">定时</span></h4>
          <div class="hint">更新于 {{ fmtTime(selectedPayload.updated_at) }}</div>
          <pre class="out">{{ selectedPayload.content }}</pre>
          <div class="row">
            <button class="btn" @click="payloadView = 'list'">返回列表</button>
            <button class="btn" :disabled="busy" @click="startEditPayload(selectedPayload)">编辑</button>
            <button class="btn" :disabled="busy" @click="triggerPayload(selectedPayload)">触发一次</button>
            <button v-if="!selectedPayload.is_active" class="btn" :disabled="busy" @click="setPayloadActive(selectedPayload, true)">设为定时</button>
            <button v-else class="btn" :disabled="busy" @click="setPayloadActive(selectedPayload, false)">取消定时</button>
            <button class="btn danger" :disabled="busy" @click="deletePayload(selectedPayload)">删除</button>
          </div>
        </div>
        <form v-if="payloadView === 'edit'" class="create" @submit.prevent="savePayloadForm">
          <input v-model="editName" placeholder="名字（如：新闻简报）" class="input" />
          <textarea v-model="editContent" rows="10" placeholder='JSON 对象，如 {"prompt": "…"}' class="input"></textarea>
          <div class="row">
            <button class="btn primary" :disabled="busy">保存</button>
            <button class="btn" type="button" @click="payloadView = 'list'">取消</button>
          </div>
        </form>
        <p v-if="payloadOk" class="ok">{{ payloadOk }}</p>
        <p v-if="payloadError" class="err">{{ payloadError }}</p>
        <h3>Prompt 设置</h3>
        <div class="create">
          <textarea v-model="promptInput" rows="8" placeholder="每次触发时 body 里带的 prompt（留空则只发 ping）" class="input"></textarea>
        </div>
        <p class="hint">prompt 不是密钥：明文存在触发状态文件里，页面上直接显示；每次触发（定时或手动）body 都会带上它。清空保存即恢复只发 ping。</p>
        <div class="row">
          <button class="btn primary" :disabled="busy" @click="savePage">保存</button>
        </div>
        <p v-if="pageOk" class="ok">{{ pageOk }}</p>
        <p v-if="pageError" class="err">{{ pageError }}</p>
        <div class="row">
          <button class="btn" :disabled="busy || restarting" @click="restartRunner">
            {{ restarting ? "重启中…" : "重启 job-runner" }}
          </button>
        </div>
        <p class="hint">数据库保存的配置与状态文件设置无需重启即生效；只有直接改服务器 .env 才需要重启 job-runner。重启不会导致重复触发：触发状态文件还在，门控按上次触发时间继续算。</p>
        <pre v-if="restartResult" class="out">{{ restartResult }}</pre>
        <div class="row">
          <button class="btn primary" :disabled="busy || triggering" @click="trigger">
            {{ triggering ? "触发中…" : "手动触发一次" }}
          </button>
        </div>
        <pre v-if="triggerResult" class="out">{{ triggerResult }}</pre>
        <p v-if="cursorError" class="err">{{ cursorError }}</p>
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
const newName = ref("");
const newRole = ref("user");
const createdKey = ref(null);
const copied = ref(false);

const cursor = ref(null);
const cursorError = ref("");
const intervalInput = ref(60);
const savedInterval = ref(null);
const triggering = ref(false);
const triggerResult = ref("");
const webhooks = ref([]);
const webhookView = ref("list");
const selectedWebhook = ref(null);
const newWebhookName = ref("");
const newWebhookUrl = ref("");
const newWebhookToken = ref("");
const newWebhookPayload = ref("");
const editWebhookName = ref("");
const editWebhookUrl = ref("");
const editWebhookToken = ref("");
const editWebhookPayload = ref("");
const webhookOk = ref("");
const webhookError = ref("");
const webhookTestResult = ref("");
const payloads = ref([]);
const payloadView = ref("list");
const selectedPayload = ref(null);
const newPayloadName = ref("");
const newPayloadContent = ref("");
const editId = ref(null);
const editName = ref("");
const editContent = ref("");
const payloadError = ref("");
const payloadOk = ref("");
const pageError = ref("");
const pageOk = ref("");
const promptInput = ref("");
const savedPrompt = ref("");
const restarting = ref(false);
const restartResult = ref("");

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
    await Promise.all([refreshTokens(), refreshCursor()]);
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
  cursor.value = null;
}

async function refreshTokens() {
  tokensError.value = "";
  try {
    const data = await adminApi.listTokens(key.value);
    tokens.value = data.items;
  } catch (e) {
    tokensError.value = e.message;
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

async function refreshCursor() {
  cursorError.value = "";
  try {
    cursor.value = await adminApi.cursorStatus(key.value);
    // Same no-clobber guard as the prompt draft: sync the interval input
    // only on first load or while it still holds the last saved value.
    const serverInterval = cursor.value.effectiveIntervalMinutes;
    if (savedInterval.value === null || intervalInput.value === savedInterval.value) {
      intervalInput.value = serverInterval;
    }
    savedInterval.value = serverInterval;
    // Never clobber an unsaved prompt draft: sync the textarea only when
    // it still holds the last saved value (or is untouched).
    const serverPrompt = cursor.value.prompt ?? "";
    if (promptInput.value === savedPrompt.value) {
      promptInput.value = serverPrompt;
    }
    savedPrompt.value = serverPrompt;
    await refreshPayloads();
    await refreshWebhooks();
  } catch (e) {
    cursorError.value = e.message;
  }
}

async function refreshPayloads() {
  try {
    payloads.value = await adminApi.cursorPayloads(key.value);
    if (selectedPayload.value) {
      selectedPayload.value =
        payloads.value.find((p) => p.id === selectedPayload.value.id) ?? null;
      if (!selectedPayload.value && payloadView.value === "detail") payloadView.value = "list";
    }
  } catch (e) {
    payloadError.value = e.message;
  }
}

function openPayload(p) {
  selectedPayload.value = p;
  payloadView.value = "detail";
  payloadError.value = "";
  payloadOk.value = "";
}

/** Table preview: the prompt inside the JSON when there is one, else the
 * raw JSON — truncated so the row stays one line. */
function payloadPreview(content) {
  let text = content || "";
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.prompt === "string" && parsed.prompt) {
      text = parsed.prompt;
    }
  } catch {
    // Not JSON (should not happen — the server validates): show it raw.
  }
  return text.length > 40 ? text.slice(0, 40) + "…" : text;
}

async function createPayload() {
  payloadError.value = "";
  payloadOk.value = "";
  busy.value = true;
  try {
    const saved = await adminApi.cursorPayloadCreate(key.value, {
      name: newPayloadName.value,
      content: newPayloadContent.value,
    });
    newPayloadName.value = "";
    newPayloadContent.value = "";
    payloadOk.value = "payload 已新增。";
    selectedPayload.value = saved;
    await refreshPayloads();
    await refreshCursor();
  } catch (e) {
    payloadError.value = e.message;
  } finally {
    busy.value = false;
  }
}

function startEditPayload(p) {
  editId.value = p.id;
  editName.value = p.name;
  editContent.value = p.content;
  payloadView.value = "edit";
  payloadError.value = "";
  payloadOk.value = "";
}

async function savePayloadForm() {
  payloadError.value = "";
  payloadOk.value = "";
  busy.value = true;
  try {
    const body = { name: editName.value, content: editContent.value };
    const saved = editId.value
      ? await adminApi.cursorPayloadUpdate(key.value, editId.value, body)
      : await adminApi.cursorPayloadCreate(key.value, body);
    payloadView.value = "list";
    payloadOk.value = editId.value ? "payload 已更新。" : "payload 已新增。";
    selectedPayload.value = saved;
    await refreshPayloads();
    await refreshCursor();
  } catch (e) {
    payloadError.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function deletePayload(p) {
  if (!window.confirm(`删除 payload「${p.name}」？删除后不可恢复。`)) return;
  payloadError.value = "";
  payloadOk.value = "";
  busy.value = true;
  try {
    await adminApi.cursorPayloadDelete(key.value, p.id);
    payloadView.value = "list";
    selectedPayload.value = null;
    payloadOk.value = "payload 已删除。";
    await refreshPayloads();
    await refreshCursor();
  } catch (e) {
    payloadError.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function setPayloadActive(p, active) {
  payloadError.value = "";
  payloadOk.value = "";
  busy.value = true;
  try {
    await adminApi.cursorPayloadActive(key.value, p.id, active);
    payloadOk.value = active ? `「${p.name}」已设为定时 payload。` : "已取消定时 payload。";
    await refreshPayloads();
    await refreshCursor();
  } catch (e) {
    payloadError.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function triggerPayload(p) {
  triggering.value = true;
  triggerResult.value = "";
  payloadError.value = "";
  try {
    const data = await adminApi.cursorTrigger(key.value, { payloadId: p.id });
    triggerResult.value = data.output || "触发成功";
    payloadOk.value = `已触发「${p.name}」。`;
    await refreshCursor();
  } catch (e) {
    triggerResult.value = `触发失败：${e.message}\n${e.data?.output || ""}`.trim();
  } finally {
    triggering.value = false;
  }
}

/**
 * The page's single save: persists every changed setting — interval and
 * prompt — in one click. The two parts are independent, so both are
 * attempted and the result reports each part separately; only a part that
 * actually succeeded updates its saved value, and a failed edit stays in
 * its input for fixing. Webhook and payload list operations are not part
 * of this save: they take effect immediately when used, because a
 * per-item test or trigger needs a saved row to fire.
 */
async function savePage() {
  busy.value = true;
  pageError.value = "";
  pageOk.value = "";
  const done = [];
  const failed = [];
  if (intervalInput.value !== savedInterval.value) {
    if (
      Number.isInteger(intervalInput.value) &&
      intervalInput.value >= 1 &&
      intervalInput.value <= 1440
    ) {
      try {
        cursor.value = await adminApi.cursorInterval(key.value, intervalInput.value);
        savedInterval.value = intervalInput.value;
        done.push("区间");
      } catch (e) {
        failed.push(`区间：${e.message}`);
      }
    } else {
      failed.push("区间：必须是 1–1440 的整数分钟");
    }
  }
  if (promptInput.value !== savedPrompt.value) {
    try {
      cursor.value = await adminApi.cursorPrompt(key.value, promptInput.value);
      savedPrompt.value = promptInput.value;
      done.push("prompt");
    } catch (e) {
      failed.push(`prompt：${e.message}`);
    }
  }
  if (done.length === 0 && failed.length === 0) {
    pageOk.value = "没有改动。";
  } else {
    if (done.length) pageOk.value = `已保存：${done.join("、")}，下次触发即生效，无需重启。`;
    if (failed.length) pageError.value = `保存失败：${failed.join("；")}。`;
  }
  busy.value = false;
  await refreshCursor();
}

async function trigger() {
  triggering.value = true;
  triggerResult.value = "";
  cursorError.value = "";
  try {
    const data = await adminApi.cursorTrigger(key.value);
    triggerResult.value = data.output || "触发成功";
    await refreshCursor();
  } catch (e) {
    triggerResult.value = `触发失败：${e.message}\n${e.data?.output || ""}`.trim();
  } finally {
    triggering.value = false;
  }
}

async function refreshWebhooks() {
  try {
    webhooks.value = await adminApi.cursorWebhooks(key.value);
    if (selectedWebhook.value) {
      selectedWebhook.value =
        webhooks.value.find((w) => w.name === selectedWebhook.value.name) ?? null;
      if (!selectedWebhook.value && webhookView.value === "detail") webhookView.value = "list";
    }
  } catch (e) {
    webhookError.value = e.message;
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
    const saved = await adminApi.cursorWebhookCreate(key.value, {
      name: newWebhookName.value,
      webhookUrl: newWebhookUrl.value,
      webhookToken: newWebhookToken.value,
      payload: newWebhookPayload.value,
    });
    newWebhookName.value = "";
    newWebhookUrl.value = "";
    newWebhookToken.value = "";
    newWebhookPayload.value = "";
    webhookOk.value = "webhook 已新增（默认不定时，定时仍发原来那条）。";
    selectedWebhook.value = saved;
    await refreshWebhooks();
    await refreshCursor();
  } catch (e) {
    webhookError.value = e.message;
  } finally {
    busy.value = false;
  }
}

function startEditWebhook(w) {
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
    // is a full value (empty clears it) — same rule as the old form.
    const body = {};
    if (editWebhookUrl.value.trim()) body.webhookUrl = editWebhookUrl.value.trim();
    if (editWebhookToken.value.trim()) body.webhookToken = editWebhookToken.value.trim();
    body.payload = editWebhookPayload.value;
    const saved = await adminApi.cursorWebhookUpdate(key.value, editWebhookName.value, body);
    webhookView.value = "list";
    webhookOk.value = "webhook 已更新。";
    selectedWebhook.value = saved;
    await refreshWebhooks();
    await refreshCursor();
  } catch (e) {
    webhookError.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function deleteWebhook(w) {
  if (!window.confirm(`删除 webhook「${w.name}」？删除后不可恢复；如果它是定时 webhook，定时触发将回落到 .env（如有）。`)) return;
  webhookError.value = "";
  webhookOk.value = "";
  busy.value = true;
  try {
    await adminApi.cursorWebhookDelete(key.value, w.name);
    webhookView.value = "list";
    selectedWebhook.value = null;
    webhookOk.value = "webhook 已删除。";
    await refreshWebhooks();
    await refreshCursor();
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
    const saved = await adminApi.cursorWebhookActive(key.value, w.name, active);
    webhookOk.value = active ? `「${w.name}」已设为定时，定时触发改发这一条。` : `「${w.name}」已取消定时。`;
    selectedWebhook.value = saved;
    await refreshWebhooks();
    await refreshCursor();
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
    const data = await adminApi.cursorWebhookTest(key.value, w.name);
    webhookTestResult.value = data.output || "测试成功";
    await refreshWebhooks();
    await refreshCursor();
  } catch (e) {
    webhookTestResult.value = `测试失败：${e.message}\n${e.data?.output || ""}`.trim();
  } finally {
    busy.value = false;
  }
}

async function importWebhook() {
  busy.value = true;
  webhookError.value = "";
  webhookOk.value = "";
  try {
    await adminApi.cursorWebhookImport(key.value);
    webhookOk.value = "已从 .env 导入到数据库并设为定时；.env 里的旧行可删可留（数据库优先）。";
    await refreshCursor();
  } catch (e) {
    webhookError.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function restartRunner() {
  restarting.value = true;
  restartResult.value = "";
  cursorError.value = "";
  try {
    const data = await adminApi.cursorRestart(key.value);
    restartResult.value = data.output || "重启成功";
    await refreshCursor();
  } catch (e) {
    restartResult.value = `重启失败：${e.message}\n${e.data?.output || ""}`.trim();
  } finally {
    restarting.value = false;
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
    await Promise.all([refreshTokens(), refreshCursor()]);
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
