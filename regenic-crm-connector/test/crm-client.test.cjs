const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  CrmApiError,
  CrmClient,
  auditComment,
} = require("../dist");
const { createFetch, jsonResponse, sampleOpsTask, sampleOrder } = require("./helpers.cjs");

describe("CrmClient", () => {
  it("sends a bearer token when present and never downgrades a 401", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(401, { error: "nope" }),
    });
    const client = new CrmClient({
      baseUrl: "https://crm.internal/",
      token: "user-token",
      fetch,
    });
    await assert.rejects(
      () => client.listPendingOpsTasks(),
      (error) => error instanceof CrmApiError && error.status === 401,
    );
    assert.match(fetch.calls[0].headers.authorization, /^Bearer user-token$/);
  });

  it("omits authorization when no token is configured", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask()],
      }),
    });
    const client = new CrmClient({
      baseUrl: "https://crm.internal",
      fetch,
    });
    const tasks = await client.listPendingOpsTasks();
    assert.equal(tasks[0].id, "task-1");
    assert.equal(fetch.calls[0].headers.authorization, undefined);
  });

  it("filters list pages to the designed pending kinds", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, [
        sampleOpsTask(),
        sampleOpsTask({ id: "other", taskType: "DELIVERY" }),
        sampleOpsTask({ id: "done", status: "IN_PROGRESS" }),
      ]),
      "GET /internal/regenic/pending-human-orders": jsonResponse(200, [
        sampleOrder(),
        sampleOrder({ id: "pf-auto", internalReviewStatus: "IN_PROGRESS" }),
      ]),
    });
    const client = new CrmClient({ baseUrl: "https://crm.internal", fetch });
    assert.deepEqual(
      (await client.listPendingOpsTasks()).map((item) => item.id),
      ["task-1"],
    );
    assert.deepEqual(
      (await client.listPendingHumanOrders()).map((item) => item.id),
      ["pf-1"],
    );
  });

  it("writes complete and internal-review to separate URLs", async () => {
    const fetch = createFetch({
      "POST /internal/regenic/ops-tasks/task-1/complete": jsonResponse(204),
      "POST /internal/regenic/orders/pf-1/internal-review": jsonResponse(204),
    });
    const client = new CrmClient({ baseUrl: "https://crm.internal", fetch });
    await client.completeOpsTask("task-1", {
      action: "APPROVE_AND_CONTINUE",
      comment: "go",
    });
    await client.submitOrderInternalReview("pf-1", {
      result: "APPROVED",
      comment: "ok",
    });
    assert.equal(fetch.calls[0].pathname, "/internal/regenic/ops-tasks/task-1/complete");
    assert.equal(fetch.calls[1].pathname, "/internal/regenic/orders/pf-1/internal-review");
    assert.equal(JSON.parse(fetch.calls[0].body).action, "APPROVE_AND_CONTINUE");
    assert.equal(JSON.parse(fetch.calls[1].body).result, "APPROVED");
  });

  it("unwraps CRM ApiResponse.data wrappers", async () => {
    const fetch = createFetch({
      "GET /api/internal/regenic/pending-ops-tasks": jsonResponse(200, {
        success: true,
        data: { items: [sampleOpsTask()] },
      }),
      "GET /api/internal/regenic/ops-tasks/task-1": jsonResponse(200, {
        success: true,
        data: sampleOpsTask(),
      }),
    });
    const client = new CrmClient({ baseUrl: "https://crm.internal/api", fetch });
    assert.equal((await client.listPendingOpsTasks())[0].id, "task-1");
    assert.equal((await client.getOpsTask("task-1")).id, "task-1");
    assert.equal(fetch.calls[0].pathname, "/api/internal/regenic/pending-ops-tasks");
  });

  it("prefixes write-back comments with the queue audit line", () => {
    assert.match(
      auditComment({ queue: "ops", hasToken: true, reportingOperationsUserId: "ops-9", promptText: "继续" }),
      /source=regenic\ntoken=yes\nreportingOperationsUserId=ops-9\n继续/,
    );
    assert.match(
      auditComment({ queue: "order", hasToken: false, promptText: "通过" }),
      /source=regenic-order-review\ntoken=no\n通过/,
    );
  });
});
