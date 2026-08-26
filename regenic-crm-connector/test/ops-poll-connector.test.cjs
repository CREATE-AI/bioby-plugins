const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { conversationId, verifyPollConnectorConformance } = require("@regenic/domain");
const {
  CrmClient,
  CrmOpsPollConnector,
  formatSeenCursor,
} = require("../dist");
const { createFetch, jsonResponse, sampleOpsTask } = require("./helpers.cjs");

function createConnector(routes, extras = {}) {
  const fetch = createFetch(routes);
  const connector = new CrmOpsPollConnector(
    new CrmClient({
      baseUrl: "https://crm.internal",
      token: extras.token,
      fetch,
    }),
    {
      connector_id: "crm-ops",
      org_id: "local-owner",
      max_open_tasks: extras.max_open_tasks ?? 50,
      now: () => "2026-08-26T00:00:00.000Z",
    },
  );
  return { connector, fetch };
}

describe("CrmOpsPollConnector", () => {
  it("creates a task record with enough body for DSH and does not complete", async () => {
    const { connector, fetch } = createConnector({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask()],
      }),
    });
    const result = await connector.poll(null);
    assert.equal(result.batch.records.length, 1);
    assert.equal(result.batch.records[0].operation, "create");
    assert.equal(result.batch.records[0].type, "task");
    assert.equal(result.batch.records[0].thread.id, "crm:ops_task:task-1");
    assert.equal(
      conversationId("crm", result.batch.records[0].external_id),
      "crm:ops_task:task-1",
    );
    const body = result.batch.records[0].content.find((part) => part.role === "body").text;
    assert.match(body, /NEED_MANUAL_REVIEW/);
    assert.match(body, /报价不确定/);
    assert.match(body, /crm:order:pf-1/);
    assert.match(body, /建议回邮底稿/);
    assert.equal(
      fetch.calls.some((call) => call.method === "POST"),
      false,
    );
  });

  it("revises a changed task and tombstones one confirmed gone", async () => {
    const first = createConnector({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask(), sampleOpsTask({ id: "task-2" })],
      }),
    });
    const created = await first.connector.poll(null);
    const cursor = { value: created.next_cursor };
    const second = createConnector({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask({ nextAction: "STILL_NEED_REVIEW" })],
      }),
      "GET /internal/regenic/ops-tasks/task-2": jsonResponse(404),
    });
    const result = await second.connector.poll(cursor);
    const operations = Object.fromEntries(
      result.batch.records.map((record) => [record.external_id, record.operation]),
    );
    assert.equal(operations["ops_task:task-1:task"], "revise");
    assert.equal(operations["ops_task:task-2:task"], "tombstone");
  });

  it("does not tombstone a still-pending task that missed the max_open page", async () => {
    const cursor = {
      value: formatSeenCursor("all", { "task-1": "old", "task-2": "old" }),
    };
    const { connector, fetch } = createConnector(
      {
        "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
          items: [sampleOpsTask({ id: "task-2" }), sampleOpsTask({ id: "task-1" })],
        }),
        "GET /internal/regenic/ops-tasks/task-1": jsonResponse(200, sampleOpsTask()),
      },
      { max_open_tasks: 1 },
    );
    const result = await connector.poll(cursor);
    assert.equal(
      result.batch.records.some((record) => record.operation === "tombstone"),
      false,
    );
    assert.equal(
      fetch.calls.some((call) => call.pathname === "/internal/regenic/ops-tasks/task-1"),
      true,
    );
    assert.match(result.next_cursor, /"task-1"/);
  });

  it("drops the seen set when token scope changes", async () => {
    const scopedCursor = {
      value: formatSeenCursor("scoped", { "task-1": "old" }),
    };
    const { connector } = createConnector({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask()],
      }),
    });
    const result = await connector.poll(scopedCursor);
    assert.equal(result.batch.records[0].operation, "create");
    assert.match(result.next_cursor, /"scope":"all"/);
  });

  it("satisfies poll connector conformance on a non-empty page", async () => {
    const { connector } = createConnector({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask()],
      }),
    });
    const report = await verifyPollConnectorConformance({
      connector,
      cursor: null,
      connector_id: "crm-ops",
      source: "crm",
    });
    assert.equal(report.record_count, 1);
  });
});
