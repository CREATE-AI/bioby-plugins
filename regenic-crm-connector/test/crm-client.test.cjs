const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  CrmApiError,
  CrmClient,
  auditComment,
  crmClientFromConfig,
  crmClientFromEnv,
  crmHasToken,
  crmProbeCatalog,
  normalizeCrmBaseUrl,
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

  it("reads the optional token from credentials_ref, not config", async () => {
    const fetch = createFetch({
      "GET /api/internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask()],
      }),
    });
    const env = {
      REGENIC_CRM_BASE_URL: "https://crm.internal/api",
      REGENIC_CRM_TOKEN: "env-token",
    };
    const client = crmClientFromEnv({
      env,
      fetch,
      credentials_ref: "env:REGENIC_CRM_TOKEN",
    });
    await client.listPendingOpsTasks();
    assert.equal(fetch.calls[0].headers.authorization, "Bearer env-token");
    assert.equal(crmHasToken(env, "env:REGENIC_CRM_TOKEN"), true);
    assert.equal(crmHasToken(env, "keychain:crm"), false);
    assert.equal(crmHasToken({ REGENIC_CRM_BASE_URL: "https://crm.internal" }), false);
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

  it("parses AI review context on pending human orders", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/pending-human-orders": jsonResponse(200, {
        items: [
          sampleOrder({
            talent: {
              nickname: "小红",
              follower: 12000,
              engagementRate: 0.042,
            },
          }),
        ],
      }),
    });
    const client = new CrmClient({ baseUrl: "https://crm.internal", fetch });
    const [order] = await client.listPendingHumanOrders();
    assert.equal(order.talent.nickname, "小红");
    assert.equal(order.talent.follower, "12000");
    assert.equal(order.aiReview.summary, "报价和内容都需要人工看一下");
    assert.match(order.autoReviewLog.userMessage, /要竖屏带货/);
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

  it("does not invent APPROVE_AND_CONTINUE when CRM omits allowedActions", async () => {
    const task = sampleOpsTask();
    delete task.reviewGuide.allowedActions;
    const fetch = createFetch({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, { items: [task] }),
    });
    const client = new CrmClient({ baseUrl: "https://crm.internal", fetch });
    assert.deepEqual((await client.listPendingOpsTasks())[0].reviewGuide.allowedActions, [
      "CLOSE_TASK",
    ]);
  });

  it("keeps an explicit empty allowedActions list empty", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask({ reviewGuide: { allowedActions: [] } })],
      }),
    });
    const client = new CrmClient({ baseUrl: "https://crm.internal", fetch });
    assert.deepEqual((await client.listPendingOpsTasks())[0].reviewGuide.allowedActions, []);
  });

  it("drops ops and order rows that omit required status fields", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask(), { id: "ghost" }],
      }),
      "GET /internal/regenic/pending-human-orders": jsonResponse(200, {
        items: [sampleOrder(), { id: "pf-ghost" }],
      }),
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

  it("reads the CRM base URL from connector config before env", async () => {
    const fetch = createFetch({
      "GET /api/internal/regenic/pending-ops-tasks": jsonResponse(200, { items: [] }),
    });
    const client = crmClientFromConfig({
      config: { base_url: "https://from-form.example/api/" },
      env: { REGENIC_CRM_BASE_URL: "https://from-env.example/api" },
      fetch,
    });
    await client.listPendingOpsTasks();
    assert.equal(
      fetch.calls[0].url,
      "https://from-form.example/api/internal/regenic/pending-ops-tasks",
    );
  });

  it("falls back to REGENIC_CRM_BASE_URL when the install has no base_url", async () => {
    const fetch = createFetch({
      "GET /api/internal/regenic/pending-ops-tasks": jsonResponse(200, { items: [] }),
    });
    const client = crmClientFromConfig({
      config: {},
      env: { REGENIC_CRM_BASE_URL: "https://from-env.example/api" },
      fetch,
    });
    await client.listPendingOpsTasks();
    assert.equal(
      fetch.calls[0].url,
      "https://from-env.example/api/internal/regenic/pending-ops-tasks",
    );
  });

  it("rejects a CRM base URL that is not http(s) or that omits /api", () => {
    assert.equal(normalizeCrmBaseUrl("https://crm.internal/api/"), "https://crm.internal/api");
    assert.throws(
      () => normalizeCrmBaseUrl("https://crm.internal"),
      (error) => error.message.includes("including /api"),
    );
    assert.throws(
      () => normalizeCrmBaseUrl("ftp://crm.internal/api"),
      (error) => error.message.includes("including /api"),
    );
  });

  it("probes plugin loaded separately from leftover CRM URL env", () => {
    const empty = crmProbeCatalog({});
    assert.equal(empty.services["crm-connector"].ready, true);
    assert.equal(empty.services.crm.ready, false);
    const leftover = crmProbeCatalog({
      REGENIC_CRM_BASE_URL: "https://crm.internal/api",
    });
    assert.equal(leftover.services["crm-connector"].ready, true);
    assert.equal(leftover.services.crm.ready, true);
  });
});
