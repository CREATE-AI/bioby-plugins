const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { locallyFinishedIds } = require("../dist/local-work-finished");

describe("locallyFinishedIds", () => {
  it("drops ids whose thread has only inactive work items", () => {
    const finished = locallyFinishedIds(
      [
        { thread_id: "crm:ops_task:a", status: "done" },
        { thread_id: "crm:ops_task:b", status: "running" },
        { thread_id: "crm:ops_task:c", status: "failed" },
      ],
      ["a", "b", "c", "d"],
      (id) => `crm:ops_task:${id}`,
    );
    assert.deepEqual(finished, ["a", "c"]);
  });

  it("keeps ids with no work items or still-active work", () => {
    const finished = locallyFinishedIds(
      [{ thread_id: "crm:ops_task:a", status: "running" }],
      ["a", "orphan"],
      (id) => `crm:ops_task:${id}`,
    );
    assert.deepEqual(finished, []);
  });
});
