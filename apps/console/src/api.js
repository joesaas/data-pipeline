/**
 * API client for the console. The console is served by the API process
 * itself (same origin), under /console or /data-pipeline/console; the API
 * base is derived from the page path so both mounts work.
 *
 * The admin key lives in localStorage (this is a single-user self-hosted
 * tool). It is sent only as the X-API-Key header, never in URLs or bodies.
 * Plaintext keys are shown exactly once, right after creation, and are
 * never fetched again — the API does not store them.
 */

export function apiBase() {
  return window.location.pathname.startsWith("/data-pipeline") ? "/data-pipeline" : "";
}

const KEY_STORAGE = "dp-console-key";

export function loadKey() {
  return window.localStorage.getItem(KEY_STORAGE) || "";
}

export function saveKey(key) {
  window.localStorage.setItem(KEY_STORAGE, key);
}

export function clearKey() {
  window.localStorage.removeItem(KEY_STORAGE);
}

export async function api(method, path, key, body) {
  const res = await fetch(`${apiBase()}${path}`, {
    method,
    // Load-bearing: the API sends no Cache-Control, so a plain GET may
    // be served from the browser's heuristic cache and a console Refresh
    // click would silently show stale rows (looking exactly like a dead
    // button). no-store forces every console request onto the network.
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...(key ? { "x-api-key": key } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const adminApi = {
  health: () => api("GET", "/api/v1/health"),
  listTokens: (key) => api("GET", "/api/v1/admin/tokens", key),
  createToken: (key, name, role) =>
    api("POST", "/api/v1/admin/tokens", key, { name, role }),
  revokeToken: (key, id) => api("POST", `/api/v1/admin/tokens/${id}/revoke`, key),
  deleteToken: (key, id) => api("DELETE", `/api/v1/admin/tokens/${id}`, key),
  listWebhooks: (key) => api("GET", "/api/v1/admin/webhooks", key),
  createWebhook: (key, body) => api("POST", "/api/v1/admin/webhooks", key, body),
  updateWebhook: (key, id, body) => api("PUT", `/api/v1/admin/webhooks/${id}`, key, body),
  deleteWebhook: (key, id) => api("DELETE", `/api/v1/admin/webhooks/${id}`, key),
  setWebhookActive: (key, id, active) =>
    api("POST", `/api/v1/admin/webhooks/${id}/active`, key, { active }),
  testWebhook: (key, id) => api("POST", `/api/v1/admin/webhooks/${id}/test`, key, {}),
  // Records: no admin-only route exists, and none is needed — the
  // ordinary records endpoints already serve an admin key cross-bucket
  // (ADMIN_IDENTITY reads every identity's records, deletes any row).
  listRecords: (key, { source_agent, tag, limit, offset }) => {
    const q = new URLSearchParams();
    if (source_agent) q.set("source_agent", source_agent);
    if (tag) q.set("tag", tag);
    q.set("limit", String(limit));
    q.set("offset", String(offset));
    return api("GET", `/api/v1/records?${q}`, key);
  },
  deleteRecord: (key, id) => api("DELETE", `/api/v1/records/${id}`, key),
  // News: the cleaned items the news site renders (exporter static pages
  // and these endpoints read the same cleaned_items table). Read-only:
  // the cleaner owns this data, the console never writes it.
  listNews: (key, { category, q, limit, offset }) => {
    const qs = new URLSearchParams();
    if (category) qs.set("category", category);
    if (q) qs.set("q", q);
    qs.set("limit", String(limit));
    qs.set("offset", String(offset));
    return api("GET", `/api/v1/cleaned/items?${qs}`, key);
  },
  getNewsStats: (key) => api("GET", "/api/v1/cleaned/stats", key),
  // Pull tasks: console-configured prompts agents pull from a queue.
  // Many may be active at once, each on its own cron; each task names
  // its target agent, and a worker only takes its own target's rows.
  listPullTasks: (key) => api("GET", "/api/v1/admin/pull-tasks", key),
  createPullTask: (key, body) => api("POST", "/api/v1/admin/pull-tasks", key, body),
  updatePullTask: (key, id, body) => api("PUT", `/api/v1/admin/pull-tasks/${id}`, key, body),
  deletePullTask: (key, id) => api("DELETE", `/api/v1/admin/pull-tasks/${id}`, key),
  setPullTaskActive: (key, id, active) =>
    api("POST", `/api/v1/admin/pull-tasks/${id}/active`, key, { active }),
  runPullTaskNow: (key, id) => api("POST", `/api/v1/admin/pull-tasks/${id}/run-now`, key, {}),
  listPendingTasks: (key) => api("GET", "/api/v1/admin/pull-tasks/pending?limit=100", key),
};
