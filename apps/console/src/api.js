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
  cursorStatus: (key) => api("GET", "/api/v1/admin/jobs/cursor-trigger", key),
  cursorTrigger: (key, body) => api("POST", "/api/v1/admin/jobs/cursor-trigger/trigger", key, body),
  cursorPayloads: (key) => api("GET", "/api/v1/admin/jobs/cursor-trigger/payloads", key),
  cursorPayloadCreate: (key, body) =>
    api("POST", "/api/v1/admin/jobs/cursor-trigger/payloads", key, body),
  cursorPayloadUpdate: (key, id, body) =>
    api("PUT", `/api/v1/admin/jobs/cursor-trigger/payloads/${id}`, key, body),
  cursorPayloadDelete: (key, id) =>
    api("DELETE", `/api/v1/admin/jobs/cursor-trigger/payloads/${id}`, key),
  cursorPayloadActive: (key, id, active) =>
    api("POST", `/api/v1/admin/jobs/cursor-trigger/payloads/${id}/active`, key, { active }),
  cursorInterval: (key, intervalMinutes) =>
    api("PUT", "/api/v1/admin/jobs/cursor-trigger/interval", key, { intervalMinutes }),
  cursorWebhooks: (key) => api("GET", "/api/v1/admin/jobs/cursor-trigger/webhooks", key),
  cursorWebhookCreate: (key, body) =>
    api("POST", "/api/v1/admin/jobs/cursor-trigger/webhooks", key, body),
  cursorWebhookUpdate: (key, name, body) =>
    api("PUT", `/api/v1/admin/jobs/cursor-trigger/webhooks/${encodeURIComponent(name)}`, key, body),
  cursorWebhookDelete: (key, name) =>
    api("DELETE", `/api/v1/admin/jobs/cursor-trigger/webhooks/${encodeURIComponent(name)}`, key),
  cursorWebhookActive: (key, name, active) =>
    api("POST", `/api/v1/admin/jobs/cursor-trigger/webhooks/${encodeURIComponent(name)}/active`, key, { active }),
  cursorWebhookTest: (key, name) =>
    api("POST", `/api/v1/admin/jobs/cursor-trigger/webhooks/${encodeURIComponent(name)}/test`, key, {}),
  cursorWebhookImport: (key) =>
    api("POST", "/api/v1/admin/jobs/cursor-trigger/webhook/import", key),
  cursorPrompt: (key, prompt) =>
    api("PUT", "/api/v1/admin/jobs/cursor-trigger/prompt", key, { prompt }),
  cursorRestart: (key) => api("POST", "/api/v1/admin/jobs/cursor-trigger/restart", key),
};
