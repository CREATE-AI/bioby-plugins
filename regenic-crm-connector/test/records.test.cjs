const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { formatOrderBody } = require("../dist/records");
const { sampleOrder } = require("./helpers.cjs");

describe("formatOrderBody", () => {
  it("assembles AI review context into the ticket body", () => {
    const body = formatOrderBody(sampleOrder());
    assert.match(body, /# 订单 AI 内审待人工/);
    assert.match(body, /## AI 内审结论/);
    assert.match(body, /报价和内容都需要人工看一下/);
    assert.match(body, /粉丝量够/);
    assert.match(body, /## 项目需求/);
    assert.match(body, /要竖屏带货/);
    assert.match(body, /## 达人/);
    assert.match(body, /tiktok/);
    assert.match(body, /https:\/\/www\.tiktok\.com\/@xiaohong/);
    assert.match(body, /## 自动内审日志/);
    assert.match(body, /### userMessage/);
    assert.match(body, /clientRequirement/);
    assert.match(body, /### agentResponse/);
    assert.match(body, /需要人工确认/);
    assert.doesNotMatch(body, /locator:|projectFieldId:|internalReviewStatus:/);
  });
});
