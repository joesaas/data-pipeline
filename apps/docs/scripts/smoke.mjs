/** 冒烟自检：服务起来后跑 `npm run smoke`，验证 健康检查→上传→分类→列表→原文→删除 全链路 */
const BASE = process.env.BASE ?? "http://localhost:3001";

function assert(cond, msg) {
  if (!cond) {
    console.error("✗", msg);
    process.exit(1);
  }
  console.log("✓", msg);
}

const health = await (await fetch(`${BASE}/api/health`)).json();
assert(health.ok === true, "health ok");

const sample = `<!doctype html><html><head><meta name="generator" content="Answer me with HTML 0.5.0"><title>冒烟测试：Agent 协议</title></head><body><h1>Agent</h1><p>这是一个 agent a2a 协议的冒烟样本。</p></body></html>`;
const form = new FormData();
form.append("files", new Blob([sample], { type: "text/html" }), "smoke-agent.html");
form.append("meta", JSON.stringify([{ originalName: "smoke-agent.html" }]));
const upRes = await fetch(`${BASE}/api/docs`, { method: "POST", body: form });
assert(upRes.status === 201, `upload status ${upRes.status}`);
const created = await upRes.json();
assert(created.length === 1, "created 1 doc");
const doc = created[0];
assert(doc.title.includes("Agent"), `title parsed: ${doc.title}`);
assert(doc.category === "agent", `auto category = agent (got ${doc.category})`);
assert(doc.source === "answer-me-with-html", "generator detected");

const list = await (await fetch(`${BASE}/api/docs?category=agent`)).json();
assert(list.some((d) => d.id === doc.id), "listed under category agent");

const cats = await (await fetch(`${BASE}/api/categories`)).json();
assert(cats.categories.find((c) => c.id === "agent").count >= 1, "category count >= 1");

const raw = await fetch(`${BASE}/api/docs/${doc.id}/raw`);
assert(raw.status === 200 && (await raw.text()).includes("冒烟样本"), "raw html served");
assert((raw.headers.get("content-security-policy") ?? "").includes("sandbox"), "raw has sandbox CSP");

const search = await (await fetch(`${BASE}/api/docs?q=${encodeURIComponent("a2a")}`)).json();
assert(search.some((d) => d.id === doc.id), "full-text search hit");

const del = await fetch(`${BASE}/api/docs/${doc.id}`, { method: "DELETE" });
assert(del.status === 204, "delete ok");
const gone = await fetch(`${BASE}/api/docs/${doc.id}`);
assert(gone.status === 404, "deleted doc 404");

console.log("\n全部通过 ✅");
