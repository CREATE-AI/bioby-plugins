const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { ChannelDriverError } = require("@regenic/domain");
const {
  CrmClient,
  answerOpsPrompt,
  answerOrderPrompt,
  listOpsPrompts,
  listOrderPrompts,
} = require("../dist");
const { createFetch, jsonResponse, sampleOpsTask, sampleOrder } = require("./helpers.cjs");

describe("CRM prompts", () => {
  it("lists only the actions allowed by reviewGuide", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/ops-tasks/task-1": jsonResponse(
        200,
        sampleOpsTask({
          reviewGuide: { headline: "只能关", allowedActions: ["CLOSE_ONLY"] },
        }),
      ),
    });
    const prompts = await listOpsPrompts(
      new CrmClient({ baseUrl: "https://crm.internal", fetch }),
      "ops_task:task-1",
    );
    assert.deepEqual(
      prompts[0].questions[0].options.map((option) => option.label),
      ["CLOSE_ONLY", "NO_FOLLOW", "NOT_OUTREACH"],
    );
  });

  it("refuses to complete an ops task without a DSH conclusion", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/ops-tasks/task-1": jsonResponse(200, sampleOpsTask()),
    });
    await assert.rejects(
      () =>
        answerOpsPrompt(
          new CrmClient({ baseUrl: "https://crm.internal", fetch }),
          "ops_task:task-1",
          { prompt_id: "crm:ops:task-1", answers: [{ id: "decision", selected: [] }] },
        ),
      (error) =>
        error instanceof ChannelDriverError &&
        error.message.includes("DSH conclusion"),
    );
    assert.equal(
      fetch.calls.some((call) => call.method === "POST"),
      false,
    );
  });

  it("rejects complete when reviewGuide allowedActions is an empty list", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/ops-tasks/task-1": jsonResponse(
        200,
        sampleOpsTask({
          reviewGuide: { allowedActions: [] },
        }),
      ),
    });
    await assert.rejects(
      () =>
        answerOpsPrompt(
          new CrmClient({ baseUrl: "https://crm.internal", fetch }),
          "ops_task:task-1",
          {
            prompt_id: "crm:ops:task-1",
            answers: [{ id: "decision", selected: ["CLOSE_TASK"] }],
          },
        ),
      (error) => error instanceof ChannelDriverError,
    );
    assert.equal(
      fetch.calls.some((call) => call.method === "POST"),
      false,
    );
  });

  it("rejects a continue action when reviewGuide only allows close", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/ops-tasks/task-1": jsonResponse(
        200,
        sampleOpsTask({
          reviewGuide: { allowedActions: ["CLOSE_ONLY"] },
        }),
      ),
    });
    await assert.rejects(
      () =>
        answerOpsPrompt(
          new CrmClient({ baseUrl: "https://crm.internal", fetch }),
          "ops_task:task-1",
          {
            prompt_id: "crm:ops:task-1",
            answers: [{ id: "decision", selected: ["SEND_AND_CLOSE"] }],
          },
        ),
      (error) => error instanceof ChannelDriverError,
    );
    assert.equal(
      fetch.calls.some((call) => call.method === "POST"),
      false,
    );
  });

  it("completes an ops task from the DSH action and never reviews an order", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/ops-tasks/task-1": jsonResponse(200, sampleOpsTask()),
      "POST /internal/regenic/ops-tasks/task-1/complete": jsonResponse(204),
    });
    const result = await answerOpsPrompt(
      new CrmClient({ baseUrl: "https://crm.internal", token: "tok", fetch }),
      "ops_task:task-1",
      {
        prompt_id: "crm:ops:task-1",
        answers: [
          { id: "decision", selected: ["SEND_AND_CLOSE"] },
        ],
      },
    );
    assert.equal(result.accepted, true);
    assert.equal(fetch.calls[1].pathname, "/internal/regenic/ops-tasks/task-1/complete");
    const body = JSON.parse(fetch.calls[1].body);
    assert.equal(body.action, "SEND_AND_CLOSE");
    assert.equal(body.scene, undefined);
    assert.match(body.comment, /source=regenic/);
    assert.equal(
      fetch.calls.some((call) => call.pathname.includes("/internal-review")),
      false,
    );
  });

  it("maps a scene key on the first line to the CRM action", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/ops-tasks/task-1": jsonResponse(200, sampleOpsTask()),
      "POST /internal/regenic/ops-tasks/task-1/complete": jsonResponse(204),
    });
    const result = await answerOpsPrompt(
      new CrmClient({ baseUrl: "https://crm.internal", fetch }),
      "ops_task:task-1",
      {
        prompt_id: "crm:ops:task-1",
        answers: [{ id: "decision", selected: ["NEED_QUOTE_BRIEF"] }],
      },
    );
    assert.equal(result.accepted, true);
    const body = JSON.parse(fetch.calls.at(-1).body);
    assert.equal(body.action, "SEND_AND_CLOSE");
    assert.equal(body.scene, "NEED_QUOTE_BRIEF");
  });

  it("does not infer an order review result from narrative custom text", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/orders/pf-1": jsonResponse(200, sampleOrder()),
    });
    await assert.rejects(
      () =>
        answerOrderPrompt(
          new CrmClient({ baseUrl: "https://crm.internal", fetch }),
          "order:pf-1",
          {
            prompt_id: "crm:audit:pf-1",
            answers: [
              {
                id: "decision",
                selected: [],
                custom: "未通过，地区不符，不建议通过",
              },
            ],
          },
        ),
      (error) =>
        error instanceof ChannelDriverError &&
        error.message.includes("APPROVED or REJECTED"),
    );
    assert.equal(
      fetch.calls.some((call) => call.method === "POST"),
      false,
    );
  });

  it("writes order internal-review without completing an ops task", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/orders/pf-1": jsonResponse(200, sampleOrder()),
      "POST /internal/regenic/orders/pf-1/internal-review": jsonResponse(204),
    });
    const listed = await listOrderPrompts(
      new CrmClient({ baseUrl: "https://crm.internal", fetch }),
      "order:pf-1",
    );
    assert.equal(listed[0].prompt_id, "crm:audit:pf-1");
    const result = await answerOrderPrompt(
      new CrmClient({ baseUrl: "https://crm.internal", fetch }),
      "order:pf-1",
      {
        prompt_id: "crm:audit:pf-1",
        answers: [{ id: "decision", selected: ["通过"] }],
      },
    );
    assert.equal(result.accepted, true);
    assert.equal(JSON.parse(fetch.calls.at(-1).body).result, "APPROVED");
    assert.equal(
      fetch.calls.some((call) => call.pathname.includes("/complete")),
      false,
    );
  });

  it("treats a 409 complete as already settled", async () => {
    const fetch = createFetch({
      "GET /internal/regenic/ops-tasks/task-1": jsonResponse(200, sampleOpsTask()),
      "POST /internal/regenic/ops-tasks/task-1/complete": jsonResponse(409, { error: "gone" }),
    });
    const result = await answerOpsPrompt(
      new CrmClient({ baseUrl: "https://crm.internal", fetch }),
      "ops_task:task-1",
      {
        prompt_id: "crm:ops:task-1",
        answers: [{ id: "decision", selected: ["CLOSE_TASK"] }],
      },
    );
    assert.equal(result.accepted, true);
  });
});
