const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { formatOrderBody, opsTaskRecord, orderRecord } = require("../dist/records");
const { sampleOpsTask, sampleOrder, surfaceOf } = require("./helpers.cjs");

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

  it("stamps the same unit_kind on create and revise for one task instance", () => {
    const task = sampleOpsTask();
    const created = opsTaskRecord(task, "create", "r1");
    const revised = opsTaskRecord({ ...task, nextAction: "STILL_NEED_REVIEW" }, "revise", "r2");
    assert.equal(surfaceOf(created).unit_kind, "crm.ops_review");
    assert.equal(surfaceOf(revised).unit_kind, "crm.ops_review");
    assert.equal(surfaceOf(orderRecord(sampleOrder(), "create", "r1")).unit_kind, "crm.order_review");
    assert.equal(surfaceOf(orderRecord(sampleOrder(), "revise", "r2")).unit_kind, "crm.order_review");
  });
});
