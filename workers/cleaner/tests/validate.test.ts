import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractJson, validateCleanedItems } from "../src/validate.js";

describe("extractJson", () => {
  it("parses plain JSON", () => {
    assert.deepEqual(extractJson('{"items":[]}'), { items: [] });
  });
  it("tolerates code fences and prose", () => {
    const out = extractJson('结果如下：\n```json\n{"items":[1]}\n```') as { items: number[] };
    assert.deepEqual(out.items, [1]);
  });
  it("throws when there is no JSON", () => {
    assert.throws(() => extractJson("no json here"));
  });
});

describe("validateCleanedItems", () => {
  it("keeps good items and fills defaults", () => {
    const { items, dropped } = validateCleanedItems({
      items: [{ title: "Aave 发布 V3.8", summary: "升级重入防护", sources: [{ name: "Aave", url: "https://aave.com" }] }],
    });
    assert.equal(dropped, 0);
    assert.equal(items[0].category, "未分类");
    assert.equal(items[0].event_date, null);
  });
  it("drops items without a title and bad sources", () => {
    const { items, dropped } = validateCleanedItems({
      items: [
        { summary: "no title" },
        { title: "正常条目", summary: "s", sources: [{ name: "x", url: "notaurl" }, { name: "y", url: "https://ok.dev" }] },
      ],
    });
    assert.equal(dropped, 1);
    assert.equal(items.length, 1);
    assert.equal(items[0].sources.length, 1);
  });
  it("normalizes event_date and importance", () => {
    const { items } = validateCleanedItems({
      items: [{ title: "t", summary: "s", event_date: "2026-10-21T13:36:00Z", importance: "HIGH" }],
    });
    assert.equal(items[0].event_date, "2026-10-21");
  });
  it("folds category aliases to the canonical name", () => {
    const { items } = validateCleanedItems({
      items: [
        { title: "a", summary: "s", category: "GitHub 热点" },
        { title: "b", summary: "s", category: "开源项目" },
        { title: "c", summary: "s", category: "Web3 DeFi" },
      ],
    });
    assert.equal(items[0].category, "GitHub 热点项目");
    assert.equal(items[1].category, "GitHub 热点项目");
    assert.equal(items[2].category, "Web3 DeFi");
  });
  it("forceCategory overrides whatever the model said", () => {
    const { items } = validateCleanedItems(
      { items: [{ title: "a", summary: "s" }, { title: "b", summary: "s", category: "AI Agent" }] },
      { forceCategory: "GitHub 热点项目" },
    );
    assert.equal(items[0].category, "GitHub 热点项目");
    assert.equal(items[1].category, "GitHub 热点项目");
  });
  it("throws when items is not an array", () => {
    assert.throws(() => validateCleanedItems({ nope: 1 }));
  });
});
