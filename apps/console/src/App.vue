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
          webhook 地址和 token 只存在服务器根 .env 里——这里可以设置它们，但永远不显示已有值。
        </p>
        <div v-if="cursor" class="grid">
          <div><label>上次触发</label><div>{{ cursor.lastTriggeredAt ? fmtTime(cursor.lastTriggeredAt) : "从未" }}</div></div>
          <div><label>当前区间</label><div>{{ cursor.effectiveIntervalMinutes }} 分钟</div></div>
          <div><label>下次触发约</label><div>{{ cursor.nextDueAt ? fmtTime(cursor.nextDueAt) : "下一 tick 即触发" }}</div></div>
          <div><label>webhook 配置</label><div>{{ cursor.webhookConfigured ? "已配置" : "未配置（检查服务器 .env）" }}</div></div>
          <div><label>区间来源</label><div>{{ cursor.intervalMinutes !== null ? "控制台设置" : "环境变量 / 默认 60 分钟" }}</div></div>
          <div><label>runner 脚本</label><div>{{ cursor.runnerScriptPresent ? "存在" : "缺失（job-runner 未构建？）" }}</div></div>
        </div>
        <form class="create" @submit.prevent="saveInterval">
          <input v-model.number="intervalInput" type="number" min="1" max="1440" class="input" />
          <button class="btn primary" :disabled="busy">保存区间（分钟）</button>
        </form>
        <form class="create" @submit.prevent="saveWebhook">
          <input v-model="webhookUrl" placeholder="Webhook URL（https://…，留空则不改）" class="input" />
          <input v-model="webhookToken" type="password" placeholder="Webhook token（留空则不改）" class="input" autocomplete="off" />
          <button class="btn primary" :disabled="busy">保存 webhook 配置</button>
        </form>
        <p class="hint">只写不回显：保存后这里不显示已有值；只填要改的项，空着不动。保存后定时任务需重启 job-runner 才用新配置，手动触发则立即用新配置。</p>
        <p v-if="webhookOk" class="ok">{{ webhookOk }}</p>
        <p v-if="webhookError" class="err">{{ webhookError }}</p>
        <form class="create" @submit.prevent="savePrompt">
          <textarea v-model="promptInput" rows="8" placeholder="每次触发时 body 里带的 prompt（留空则只发 ping）" class="input"></textarea>
          <button class="btn primary" :disabled="busy">保存 prompt</button>
        </form>
        <p class="hint">prompt 不是密钥：明文存在触发状态文件里，页面上直接显示；每次触发（定时或手动）body 都会带上它。清空保存即恢复只发 ping。</p>
        <p v-if="promptOk" class="ok">{{ promptOk }}</p>
        <p v-if="promptError" class="err">{{ promptError }}</p>
        <div class="row">
          <button class="btn" :disabled="busy || restarting" @click="restartRunner">
            {{ restarting ? "重启中…" : "重启 job-runner（使新配置对定时任务生效）" }}
          </button>
        </div>
        <p class="hint">重启不会导致重复触发：触发状态文件还在，门控按上次触发时间继续算。</p>
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
const triggering = ref(false);
const triggerResult = ref("");
const webhookUrl = ref("");
const webhookToken = ref("");
const webhookError = ref("");
const webhookOk = ref("");
const promptInput = ref("");
const savedPrompt = ref("");
const promptError = ref("");
const promptOk = ref("");
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
    intervalInput.value = cursor.value.effectiveIntervalMinutes;
    // Never clobber an unsaved prompt draft: sync the textarea only when
    // it still holds the last saved value (or is untouched).
    const serverPrompt = cursor.value.prompt ?? "";
    if (promptInput.value === savedPrompt.value) {
      promptInput.value = serverPrompt;
    }
    savedPrompt.value = serverPrompt;
  } catch (e) {
    cursorError.value = e.message;
  }
}

async function saveInterval() {
  busy.value = true;
  cursorError.value = "";
  try {
    cursor.value = await adminApi.cursorInterval(key.value, intervalInput.value);
    intervalInput.value = cursor.value.effectiveIntervalMinutes;
  } catch (e) {
    cursorError.value = e.message;
  } finally {
    busy.value = false;
  }
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

async function saveWebhook() {
  busy.value = true;
  webhookError.value = "";
  webhookOk.value = "";
  const body = {};
  if (webhookUrl.value.trim()) body.webhookUrl = webhookUrl.value.trim();
  if (webhookToken.value.trim()) body.webhookToken = webhookToken.value.trim();
  if (Object.keys(body).length === 0) {
    webhookError.value = "至少填一项（URL 或 token）";
    busy.value = false;
    return;
  }
  try {
    cursor.value = await adminApi.cursorWebhook(key.value, body);
    intervalInput.value = cursor.value.effectiveIntervalMinutes;
    webhookUrl.value = "";
    webhookToken.value = "";
    webhookOk.value = "已保存到服务器 .env（值不会回显）。定时任务需重启 job-runner 后生效，手动触发立即用新配置。";
  } catch (e) {
    webhookError.value = e.message;
  } finally {
    busy.value = false;
  }
}

async function savePrompt() {
  busy.value = true;
  promptError.value = "";
  promptOk.value = "";
  try {
    cursor.value = await adminApi.cursorPrompt(key.value, promptInput.value);
    intervalInput.value = cursor.value.effectiveIntervalMinutes;
    savedPrompt.value = cursor.value.prompt ?? "";
    promptInput.value = savedPrompt.value;
    promptOk.value = savedPrompt.value ? "prompt 已保存，下次触发 body 会带上它。" : "prompt 已清空，下次触发恢复只发 ping。";
  } catch (e) {
    promptError.value = e.message;
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
