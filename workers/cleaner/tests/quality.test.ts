import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkQuality } from "../src/quality.js";

const longText = "这是一条足够长的内容用于通过质量门检查。".repeat(4);

describe("quality gate", () => {
  it("accepts a normal record", () => {
    assert.equal(checkQuality({ title: "科技简报", content: longText }).ok, true);
  });
  it("rejects too-short content", () => {
    const r = checkQuality({ title: "标题正常", content: "太短" });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /too short/);
  });
  it("rejects spam patterns", () => {
    const r = checkQuality({ title: "一条正常标题", content: `${longText} 免费领取，先到先得` });
    assert.equal(r.ok, false);
    assert.match(r.reason ?? "", /spam/);
  });
  it("allows a null title (records may omit it)", () => {
    assert.equal(checkQuality({ title: null, content: longText }).ok, true);
  });
});
