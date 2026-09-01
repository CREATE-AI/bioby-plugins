const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { conversationId } = require("@regenic/domain");
const {
  CrmClient,
  CrmOrderPollConnector,
} = require("../dist");
const { createFetch, jsonResponse, sampleOrder, surfaceOf } = require("./helpers.cjs");

describe("CrmOrderPollConnector", () => {
  it("ingests a pending-human order as its own task thread", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/pending-human-orders": jsonResponse(200, {
        items: [sampleOrder()],
      }),
    });
    const connector = new CrmOrderPollConnector(
      new CrmClient({ baseUrl: "https://crm.internal", fetch }),
      {
        connector_id: "crm-order",
        org_id: "local-owner",
        now: () => "2026-08-26T00:00:00.000Z",
      },
    );
    const result = await connector.poll(null);
    assert.equal(result.batch.records[0].type, "task");
    assert.equal(surfaceOf(result.batch.records[0]).unit_kind, "crm.order_review");
    assert.equal(result.batch.records[0].thread.id, "order:pf-1");
    assert.equal(
      conversationId("crm", result.batch.records[0].external_id),
      `crm:${result.batch.records[0].thread.id}`,
    );
    const body = result.batch.records[0].content.find((part) => part.role === "body").text;
    assert.match(body, /订单 AI 内审待人工/);
    assert.doesNotMatch(body, /locator:|projectFieldId:|internalReviewStatus:/);
    assert.equal(
      fetch.calls.some((call) => call.pathname.includes("/complete")),
      false,
    );
    assert.equal(
      fetch.calls.some((call) => call.pathname.includes("/internal-review")),
      false,
    );
  });
});
