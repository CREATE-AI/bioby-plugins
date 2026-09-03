const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { conversationId, verifyPollConnectorConformance } = require("@regenic/domain");
const {
  CrmClient,
  CrmOpsPollConnector,
  OpenWindowLedger,
  formatSeenCursor,
} = require("../dist");
const { createFetch, jsonResponse, sampleOpsTask, surfaceOf } = require("./helpers.cjs");

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
      hideThread: extras.hideThread,
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
    assert.equal(surfaceOf(result.batch.records[0]).unit_kind, "crm.ops_review");
    assert.equal(result.batch.records[0].thread.id, "ops_task:task-1");
    assert.equal(
      conversationId("crm", result.batch.records[0].external_id),
      `crm:${result.batch.records[0].thread.id}`,
    );
    const body = result.batch.records[0].content.find((part) => part.role === "body").text;
    assert.match(body, /NEED_MANUAL_REVIEW/);
    assert.match(body, /报价不确定/);
    assert.match(body, /crm:order:pf-1/);
    assert.match(body, /建议回邮底稿/);
    assert.match(body, /### 最近来信/);
    assert.match(body, /达人问能否改期/);
    assert.match(body, /### 往来摘要/);
    assert.match(body, /folder=SENT/);
    assert.doesNotMatch(body, /crm:mail:/);
    assert.equal(
      fetch.calls.some((call) => call.method === "POST"),
      false,
    );
  });

  it("revises a changed task and hides one confirmed gone without tombstone", async () => {
    const hidden = [];
    const first = createConnector({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask(), sampleOpsTask({ id: "task-2" })],
      }),
    });
    const created = await first.connector.poll(null);
    const { connector } = createConnector(
      {
        "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
          items: [sampleOpsTask({ nextAction: "STILL_NEED_REVIEW" })],
        }),
        "GET /internal/regenic/ops-tasks/task-2": jsonResponse(404),
      },
      {
        hideThread: async (threadId) => {
          hidden.push(threadId);
        },
      },
    );
    const result = await connector.poll({ value: created.next_cursor });
    const operations = Object.fromEntries(
      result.batch.records.map((record) => [record.external_id, record.operation]),
    );
    assert.equal(operations["ops_task:task-1:task"], "revise");
    assert.equal(surfaceOf(result.batch.records[0]).unit_kind, "crm.ops_review");
    assert.equal(operations["ops_task:task-2:task"], undefined);
    assert.equal(
      result.batch.records.some((record) => record.operation === "tombstone"),
      false,
    );
    assert.deepEqual(hidden, ["crm:ops_task:task-2"]);
    assert.equal(result.next_cursor.includes("task-2"), false);
  });

  it("drops a gone task from seen when the host cannot fold the list", async () => {
    const first = createConnector({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask()],
      }),
    });
    const created = await first.connector.poll(null);
    const { connector } = createConnector({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, { items: [] }),
      "GET /internal/regenic/ops-tasks/task-1": jsonResponse(404),
    });
    const result = await connector.poll({ value: created.next_cursor });
    assert.equal(
      result.batch.records.some((record) => record.operation === "tombstone"),
      false,
    );
    assert.equal(result.next_cursor.includes("task-1"), false);
  });

  it("keeps revising active tasks when fold write fails but still drops gone ids from seen", async () => {
    const first = createConnector({
      "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
        items: [sampleOpsTask(), sampleOpsTask({ id: "task-2" })],
      }),
    });
    const created = await first.connector.poll(null);
    const { connector } = createConnector(
      {
        "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
          items: [sampleOpsTask({ nextAction: "STILL_NEED_REVIEW" })],
        }),
        "GET /internal/regenic/ops-tasks/task-2": jsonResponse(404),
      },
      {
        hideThread: async () => {
          throw new Error("pref write failed");
        },
      },
    );
    const result = await connector.poll({ value: created.next_cursor });
    const operations = Object.fromEntries(
      result.batch.records.map((record) => [record.external_id, record.operation]),
    );
    assert.equal(operations["ops_task:task-1:task"], "revise");
    assert.match(result.next_cursor, /"task-1"/);
    assert.equal(result.next_cursor.includes("task-2"), false);
  });

  it("revises seen pending tasks even when they miss the max_open window", async () => {
    const cursor = {
      value: formatSeenCursor("all", { "task-1": "old", "task-2": "old" }),
    };
    const { connector, fetch } = createConnector(
      {
        "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
          items: [
            sampleOpsTask({ id: "task-2" }),
            sampleOpsTask({ id: "task-1", nextAction: "STILL_NEED_REVIEW" }),
            sampleOpsTask({ id: "task-3" }),
          ],
        }),
      },
      { max_open_tasks: 1 },
    );
    const result = await connector.poll(cursor);
    const operations = Object.fromEntries(
      result.batch.records.map((record) => [record.external_id, record.operation]),
    );
    assert.equal(operations["ops_task:task-1:task"], "revise");
    assert.equal(operations["ops_task:task-2:task"], "revise");
    assert.equal(operations["ops_task:task-3:task"], undefined);
    assert.equal(
      result.batch.records.some((record) => record.operation === "tombstone"),
      false,
    );
    assert.equal(
      fetch.calls.some((call) => call.pathname === "/internal/regenic/ops-tasks/task-1"),
      false,
    );
    assert.match(result.next_cursor, /"task-1"/);
    assert.match(result.next_cursor, /"task-2"/);
    assert.equal(result.next_cursor.includes("task-3"), false);
  });

  it("does not ingest an unseen parked task into the open window", async () => {
    const { connector } = createConnector(
      {
        "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
          items: [
            sampleOpsTask({
              id: "task-parked",
              regenicComplete: { action: "LEAVE_PENDING", scene: "REAL_HUMAN" },
            }),
            sampleOpsTask({ id: "task-new" }),
          ],
        }),
      },
      { max_open_tasks: 1 },
    );
    const result = await connector.poll(null);
    const ids = result.batch.records.map((record) => record.external_id);
    assert.deepEqual(ids, ["ops_task:task-new:task"]);
    assert.equal(result.next_cursor.includes("task-parked"), false);
    assert.match(result.next_cursor, /"task-new"/);
  });

  it("drops parked LEAVE_PENDING tasks from seen during sync", async () => {
    const cursor = {
      value: formatSeenCursor("all", { "task-parked": "old" }),
    };
    const { connector } = createConnector(
      {
        "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
          items: [
            sampleOpsTask({
              id: "task-parked",
              regenicComplete: { action: "LEAVE_PENDING", scene: "REAL_HUMAN" },
            }),
            sampleOpsTask({ id: "task-new" }),
          ],
        }),
      },
      { max_open_tasks: 1 },
    );
    const result = await connector.poll(cursor);
    const operations = Object.fromEntries(
      result.batch.records.map((record) => [record.external_id, record.operation]),
    );
    assert.equal(operations["ops_task:task-new:task"], "create");
    assert.equal(operations["ops_task:task-parked:task"], undefined);
    assert.match(result.next_cursor, /"task-new"/);
    assert.equal(result.next_cursor.includes("task-parked"), false);
  });

  it("drops rejected complete tasks from seen during sync", async () => {
    const cursor = {
      value: formatSeenCursor("all", { "task-failed": "old" }),
    };
    const { connector } = createConnector(
      {
        "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
          items: [
            sampleOpsTask({
              id: "task-failed",
              regenicLastAttempt: {
                action: "SUBMIT_THEN_CLOSE",
                error: "SUBMIT_THEN_CLOSE requires submit_quote.raw",
              },
            }),
            sampleOpsTask({ id: "task-new" }),
          ],
        }),
      },
      { max_open_tasks: 1 },
    );
    const result = await connector.poll(cursor);
    const operations = Object.fromEntries(
      result.batch.records.map((record) => [record.external_id, record.operation]),
    );
    assert.equal(operations["ops_task:task-new:task"], "create");
    assert.match(result.next_cursor, /"task-new"/);
    assert.equal(result.next_cursor.includes("task-failed"), false);
  });

  it("folds a parked LEAVE_PENDING task off shown instead of unhiding", async () => {
    const hidden = [];
    const cursor = {
      value: formatSeenCursor("all", { "task-parked": "old" }),
    };
    const { connector } = createConnector(
      {
        "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, { items: [] }),
        "GET /internal/regenic/ops-tasks/task-parked": jsonResponse(
          200,
          sampleOpsTask({
            id: "task-parked",
            regenicComplete: { action: "LEAVE_PENDING", scene: "REAL_HUMAN" },
          }),
        ),
      },
      {
        hideThread: async (threadId) => {
          hidden.push(threadId);
        },
      },
    );
    const result = await connector.poll(cursor);
    assert.equal(result.next_cursor.includes("task-parked"), false);
    assert.deepEqual(hidden, ["crm:ops_task:task-parked"]);
  });

  it("drops ledger-released tasks from seen on the next poll", async () => {
    const ledger = new OpenWindowLedger();
    const first = createConnector(
      {
        "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
          items: [sampleOpsTask(), sampleOpsTask({ id: "task-2" })],
        }),
      },
      { max_open_tasks: 1, openWindowLedger: ledger },
    );
    const created = await first.connector.poll(null);
    ledger.release("task-1");
    const { connector } = createConnector(
      {
        "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
          items: [sampleOpsTask({ id: "task-2" }), sampleOpsTask({ id: "task-3" })],
        }),
      },
      { max_open_tasks: 1, openWindowLedger: ledger },
    );
    const result = await connector.poll({ value: created.next_cursor });
    const operations = Object.fromEntries(
      result.batch.records.map((record) => [record.external_id, record.operation]),
    );
    assert.equal(operations["ops_task:task-2:task"], "create");
    assert.equal(operations["ops_task:task-3:task"], undefined);
    assert.equal(result.next_cursor.includes("task-1"), false);
    assert.match(result.next_cursor, /"task-2"/);
    assert.equal(result.next_cursor.includes("task-3"), false);
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
