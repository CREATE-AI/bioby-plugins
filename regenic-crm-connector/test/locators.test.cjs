const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { conversationId } = require("@regenic/domain");
const {
  CRM_SOURCE,
  opsTaskExternalId,
  opsTaskThreadId,
  orderExternalId,
  orderThreadId,
  parseOpsTaskId,
  parseOrderId,
  parseOpsCompleteAction,
  parseOrderReviewResult,
  opsStreamKey,
  orderStreamKey,
  isOpsTaskTarget,
  isOrderTarget,
} = require("../dist");

describe("CRM locators", () => {
  it("groups ops and order records onto the designed thread ids", () => {
    assert.equal(opsTaskThreadId("task-1"), "crm:ops_task:task-1");
    assert.equal(orderThreadId("pf-1"), "crm:order:pf-1");
    assert.equal(
      conversationId(CRM_SOURCE, opsTaskExternalId("task-1")),
      "crm:ops_task:task-1",
    );
    assert.equal(
      conversationId(CRM_SOURCE, orderExternalId("pf-1")),
      "crm:order:pf-1",
    );
  });

  it("parses thread targets and prompt ids without crossing queues", () => {
    assert.equal(parseOpsTaskId("ops_task:task-1"), "task-1");
    assert.equal(parseOpsTaskId("crm:ops:task-1"), "task-1");
    assert.equal(parseOpsTaskId("ops_task:task-1:task"), "task-1");
    assert.equal(parseOrderId("order:pf-1"), "pf-1");
    assert.equal(parseOrderId("crm:audit:pf-1"), "pf-1");
    assert.equal(parseOpsTaskId("order:pf-1"), undefined);
    assert.equal(parseOrderId("ops_task:task-1"), undefined);
    assert.equal(isOpsTaskTarget("ops_task:task-1"), true);
    assert.equal(isOrderTarget("ops_task:task-1"), false);
  });

  it("keeps stream keys and action vocabularies separate", () => {
    assert.equal(opsStreamKey("scoped"), "crm:pending-ops:scoped");
    assert.equal(orderStreamKey("all"), "crm:pending-review:all");
    assert.equal(parseOpsCompleteAction("继续自动化"), "APPROVE_AND_CONTINUE");
    assert.equal(parseOpsCompleteAction("CLOSE_TASK"), "CLOSE_TASK");
    assert.equal(parseOpsCompleteAction("APPROVED"), undefined);
    assert.equal(parseOrderReviewResult("通过"), "APPROVED");
    assert.equal(parseOrderReviewResult("不通过"), "REJECTED");
    assert.equal(parseOrderReviewResult("未通过"), undefined);
    assert.equal(parseOrderReviewResult("不建议通过"), undefined);
    assert.equal(parseOrderReviewResult("审核结果：**不通过**\n地区不符"), undefined);
    assert.equal(parseOrderReviewResult("CLOSE_TASK"), undefined);
  });
});
