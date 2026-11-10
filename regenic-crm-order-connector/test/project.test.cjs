const assert = require("node:assert/strict");
const test = require("node:test");
const { conversationId } = require("@regenic/domain");
const { freshDirectoryMemory, listDirectoryPage, pageSelectedHeads } = require("../dist/directory");
const { crmProjectSyncDriver, projectInstallConfig, projectSelectionOf } = require("../dist/project-driver");
const { advanceProject, emptyProjectCursor, parseProjectCursor } = require("../dist/project-sync");
const { advanceDelivery, emptyOrderCursor } = require("../dist/sync");
const { PROJECT_SOURCE, projectStreamKey } = require("../dist/locators");

test("project steps stay on the project conversation", () => {
  assert.equal(conversationId(PROJECT_SOURCE, "p1:order-a"), "crm-project:p1");
  assert.equal(conversationId(PROJECT_SOURCE, "p1:log-abc"), "crm-project:p1");
});

test("project install keeps newest by default and only offers newest or all", () => {
  const config = projectInstallConfig({ mongo_uri: "mongodb://localhost:27017/crm" });
  assert.equal(config.selection, "recent");
  assert.equal(config.recent_limit, 30);
  assert.equal(config.mongo_db, "crm");
  const all = projectInstallConfig({ mongo_db: "crm", selection: "all" });
  assert.equal(all.selection, "all");
  assert.equal(all.recent_limit, undefined);
  assert.equal(projectSelectionOf({ selection: "pick" }), "recent");
  assert.throws(() => projectInstallConfig({ mongo_uri: "http://x" }), /连接串/);
  const catalog = crmProjectSyncDriver.installCatalog();
  assert.equal(catalog.form_version, 2);
  const selection = catalog.fields.find((field) => field.key === "selection");
  assert.deepEqual(selection.options.map((option) => option.value), ["recent", "all"]);
  assert.equal(selection.default, "recent");
  assert.equal(catalog.fields.find((field) => field.key === "mongo_uri").secret, true);
  assert.equal(catalog.install_confirm.when.value, "all");
});

test("project driver only owns project conversations", () => {
  const installation = { id: "i", org_id: "o", connector_type: "crm-project-sync", status: "enabled", config: {} };
  assert.equal(crmProjectSyncDriver.matchesThread(installation, { source: "crm-project", target: "p1" }), true);
  assert.equal(crmProjectSyncDriver.matchesThread(installation, { source: "crm-delivery", target: "a" }), false);
});

test("a new project writes info, status, activity and its in-delivery orders", async () => {
  const store = projectStore({
    logs: [
      log("l1", "PROJECT_CREATED", { message: "initialise successfully" }),
      log("l2", "ORDER_CUSTOMER_REVIEW_DELIVERY", {
        metadata: { projectFieldId: "a", stage: "DELIVERY", reviewResult: "REJECTED", reviewType: "VIDEO" },
      }),
      log("l3", "ONE_CLICK_SUBMIT", { message: "已批量提报5个达人", metadata: { submittedCount: 5 } }),
    ],
    orders: [orderRow("a", { status: "VIDEO_DRAFT_REVIEWING" }), orderRow("b", { nickname: "小红", status: "FOLLOWING" })],
  });
  const { records, cursor } = await runUntilLive(projectInfo(), store);
  const byStep = new Map(records.map((record) => [record.external_id.split(":")[1], record]));
  const context = recordText(byStep.get("context"));
  assert.match(context, /项目：春季/);
  assert.match(context, /项目 ID：p1/);
  assert.match(context, /平台：Instagram、TikTok/);
  assert.match(context, /总预算：1000 USD/);
  assert.match(context, /对接群：飞书 · 春季客户群/);
  assert.match(context, /项目权益：一条视频/);
  assert.doesNotMatch(context, /截止日期/);
  assert.match(recordText([...byStep.entries()].find(([key]) => key.startsWith("status-"))[1]), /项目状态：进行中/);
  assert.equal(recordText(byStep.get("log-l1")), "项目创建\n操作方：用户");
  const review = recordText(byStep.get("log-l2"));
  assert.match(review, /客户审核交付内容/);
  assert.match(review, /结果：驳回/);
  assert.match(review, /审核内容：视频草稿/);
  assert.match(review, /达人：小明/);
  assert.match(review, /订单会话：crm-delivery:a/);
  assert.match(recordText(byStep.get("log-l3")), /已批量提报5个达人/);
  const orderA = recordText(byStep.get("order-a"));
  assert.match(orderA, /交付状态：视频草稿审核/);
  assert.match(orderA, /订单会话：crm-delivery:a/);
  assert.doesNotMatch(orderA, /达人报价/);
  assert.deepEqual(cursor.orders, ["a", "b"]);
  assert.equal(records.every((record) => recordSurface(record).actor_label !== "系统"), true);
  const inbox = records.find((record) => record.external_id === "p1:inbox");
  assert.equal(recordSurface(inbox).kind, "user");
  assert.match(recordText(inbox), /收件箱/);
});

test("later polls add new activity, a status message, and update order lines", async () => {
  const store = projectStore({ logs: [log("l1", "PROJECT_CREATED")], orders: [orderRow("a"), orderRow("b")] });
  const first = await runUntilLive(projectInfo(), store);
  store.logs.push(log("l2", "PROJECT_RESUBMIT", { metadata: { fieldCount: 2 } }));
  store.orders = [orderRow("a", { status: "PENDING_PUBLISH" }), orderRow("c", { nickname: "小刚" })];
  store.rows.set("b", orderRow("b", { status: "SETTLED_COMPLETED" }));
  const next = await advanceProject({
    projectId: "p1",
    project: projectInfo({ status: "PAUSED", demands: "新需求", updatedTime: "2026-11-08T00:00:00.000Z" }),
    store,
    cursor: first.cursor,
    pageSize: 20,
    now: "2026-11-08T00:00:00.000Z",
  });
  const steps = next.records.map((record) => [record.external_id.split(":")[1], record]);
  const find = (prefix) => steps.find(([key]) => key.startsWith(prefix))?.[1];
  assert.match(recordText(find("context-")), /项目信息有更新[\s\S]*需求：新需求/);
  assert.equal(recordText(find("status-")), "项目状态：进行中 → 暂停");
  assert.equal(recordText(find("log-l2")), "重新提报\n重新提报人数：2\n操作方：用户");
  assert.equal(find("order-a").operation, "revise");
  assert.match(recordText(find("order-a")), /待发布/);
  assert.equal(find("order-b").operation, "revise");
  assert.match(recordText(find("order-b")), /已结清（已不在交付中）/);
  assert.equal(find("order-c").operation, "create");
  assert.deepEqual(next.cursor.orders, ["a", "c"]);

  const quiet = await advanceProject({
    projectId: "p1",
    project: projectInfo({ status: "PAUSED", demands: "新需求", updatedTime: "2026-11-08T00:00:00.000Z" }),
    store,
    cursor: parseProjectCursor(JSON.stringify(next.cursor)),
    pageSize: 20,
    now: "2026-11-08T01:00:00.000Z",
  });
  assert.equal(quiet.records.length, 0);
});

test("a deleted project writes one end message", async () => {
  const store = projectStore({});
  const first = await runUntilLive(projectInfo(), store);
  const ended = await advanceProject({
    projectId: "p1",
    project: projectInfo({ isDeleted: true }),
    store,
    cursor: first.cursor,
    pageSize: 20,
    now: "2026-11-09T00:00:00.000Z",
  });
  assert.equal(ended.wroteEnd, true);
  assert.equal(ended.records.length, 1);
  assert.match(ended.records[0].external_id, /^p1:end-deleted-/);
  const again = await advanceProject({
    projectId: "p1",
    project: null,
    store,
    cursor: ended.cursor,
    pageSize: 20,
    now: "2026-11-09T01:00:00.000Z",
  });
  assert.equal(again.records.length, 0);
  assert.equal(again.wroteEnd, true);
});

test("a project pushed out of the newest list is let go, a deleted one waits for its end", async () => {
  const memory = freshDirectoryMemory(0);
  memory.previousIds = ["old", "gone"];
  const heads = [{ id: "new", name: "新项目" }];
  const page = (cursor) => listDirectoryPage({
    cursor,
    concurrency: 5,
    now: 0,
    memory,
    kind: "project",
    member: (id) => ({ stream_key: projectStreamKey(id), thread_id: projectStreamKey(id) }),
    labelOf: (row) => row.name,
    listOpenIds: async (afterId, limit) => pageSelectedHeads(heads, afterId, limit),
    needsEnd: async (missing) => missing.filter((id) => id === "gone"),
  });
  const first = await page(JSON.stringify({ v: 1, afterId: null, seen: [], emitted: [], scanDone: false }));
  assert.equal(first.members[0].stream_key, "crm-project:new");
  assert.equal(first.members[0].kind, "project");
  assert.equal(first.members[0].label, "新项目");
  assert.equal(first.complete, false);
  memory.endWritten.add("gone");
  const done = await page(first.next_cursor);
  assert.equal(done.complete, true);
});

test("order context points to its project conversation", async () => {
  const advanced = await advanceDelivery({
    orderId: "a",
    order: {
      id: "a",
      projectId: "p1",
      nickname: "小明",
      status: "FOLLOWING",
      createdTime: "2026-11-01T00:00:00.000Z",
      updatedTime: "2026-11-06T09:00:00.000Z",
      follows: [],
    },
    project: null,
    store: {
      async listMails() { return { items: [], full: false }; },
      async listLogs() { return { items: [], full: false }; },
      async listDecisions() { return { items: [], full: false }; },
    },
    cursor: emptyOrderCursor(),
    pageSize: 20,
    now: "2026-11-06T10:00:00.000Z",
  });
  const context = advanced.records.find((record) => record.external_id === "a:context");
  assert.match(recordText(context), /项目 ID：p1\n项目会话：crm-project:p1/);
});

test("an order conversation written before the project link gets its context rewritten once", async () => {
  const order = {
    id: "a",
    projectId: "p1",
    nickname: "小明",
    status: "FOLLOWING",
    createdTime: "2026-11-01T00:00:00.000Z",
    updatedTime: "2026-11-06T09:00:00.000Z",
    follows: [],
  };
  const cursor = { ...emptyOrderCursor(), stage: "live", face: 2, projectFp: "x", status: "FOLLOWING", fp: { context: "old" } };
  const advanced = await advanceDelivery({
    orderId: "a",
    order,
    project: null,
    store: {
      async listMails() { return { items: [], full: false }; },
      async listLogs() { return { items: [], full: false }; },
      async listDecisions() { return { items: [], full: false }; },
    },
    cursor,
    pageSize: 20,
    now: "2026-11-06T10:00:00.000Z",
  });
  const context = advanced.records.find((record) => record.external_id === "a:context");
  assert.equal(context.operation, "revise");
  assert.match(recordText(context), /项目会话：crm-project:p1/);
  assert.equal(advanced.cursor.face, 4);
});

test("order context includes script, draft and publish links", async () => {
  const advanced = await advanceDelivery({
    orderId: "a",
    order: {
      id: "a",
      nickname: "小明",
      status: "VIDEO_DRAFT_REVIEWING",
      scriptLink: "https://example.com/script",
      publishLinks: ["https://example.com/post"],
      createdTime: "2026-11-01T00:00:00.000Z",
      updatedTime: "2026-11-06T09:00:00.000Z",
      follows: [{
        followTime: "2026-11-06T08:00:00.000Z",
        followContent: "草稿在这里",
        selectedStatus: "VIDEO_DRAFT_REVIEWING",
        attachmentUrls: ["https://example.com/draft"],
      }],
    },
    project: null,
    store: {
      async listMails() { return { items: [], full: false }; },
      async listLogs() { return { items: [], full: false }; },
      async listDecisions() { return { items: [], full: false }; },
    },
    cursor: emptyOrderCursor(),
    pageSize: 20,
    now: "2026-11-06T10:00:00.000Z",
  });
  const context = advanced.records.find((record) => record.external_id === "a:context");
  assert.match(recordText(context), /脚本链接：https:\/\/example.com\/script/);
  assert.match(recordText(context), /视频草稿链接：https:\/\/example.com\/draft/);
  assert.match(recordText(context), /发布链接：https:\/\/example.com\/post/);
  const note = advanced.records.find((record) => record.external_id.includes(":note-"));
  assert.match(recordText(note), /附件：https:\/\/example.com\/draft/);
});

function projectInfo(extra = {}) {
  return {
    id: "p1",
    name: "春季",
    status: "IN_PROGRESS",
    level: "MEDIUM",
    platforms: ["Instagram", "TikTok"],
    totalBudget: 1000,
    currency: "USD",
    contactGroupApp: "飞书",
    contactGroupName: "春季客户群",
    briefText: "brief",
    benefits: "一条视频",
    demands: "需求",
    createdTime: "2026-11-01T00:00:00.000Z",
    updatedTime: "2026-11-02T00:00:00.000Z",
    ...extra,
  };
}

function log(id, operationType, extra = {}) {
  return {
    id,
    operationType,
    actorType: "USER",
    createdAt: `2026-11-0${Math.min(9, 2 + Number(id.slice(1)))}T00:00:00.000Z`,
    metadata: {},
    ...extra,
  };
}

function orderRow(id, extra = {}) {
  return {
    id,
    nickname: "小明",
    platform: "Instagram",
    bloggerLink: `https://example/${id}`,
    externalQuote: 80,
    status: "FOLLOWING",
    selectedTime: "2026-11-03T00:00:00.000Z",
    ...extra,
  };
}

function projectStore(seed) {
  const store = {
    logs: seed.logs ?? [],
    orders: seed.orders ?? [],
    rows: new Map(),
    async listProjects() {
      return [];
    },
    async listGoneProjects() {
      return [];
    },
    async readProjectInfo() {
      return null;
    },
    async listProjectLogs(_projectId, afterId, limit) {
      const rest = store.logs.filter((item) => !afterId || item.id > afterId);
      return { items: rest.slice(0, limit), full: rest.length > limit };
    },
    async listProjectOrders() {
      return store.orders;
    },
    async readOrderRows(ids) {
      return ids.flatMap((id) => {
        const row = store.rows.get(id) ?? store.orders.find((item) => item.id === id);
        return row ? [row] : [];
      });
    },
  };
  return store;
}

async function runUntilLive(project, store) {
  let cursor = emptyProjectCursor();
  const records = [];
  for (let i = 0; i < 8; i += 1) {
    const advanced = await advanceProject({
      projectId: "p1",
      project,
      store,
      cursor,
      pageSize: 20,
      now: "2026-11-06T10:00:00.000Z",
    });
    records.push(...advanced.records);
    cursor = parseProjectCursor(JSON.stringify(advanced.cursor));
    if (!advanced.hasMore && cursor.stage === "live") {
      return { records, cursor };
    }
  }
  throw new Error("project poll did not finish");
}

function recordText(record) {
  const body = record?.content?.find((part) => part.role === "body");
  return body?.text ?? "";
}

function recordSurface(record) {
  const meta = record?.content?.find((part) => part.role === "metadata");
  return meta?.text ? JSON.parse(meta.text) : {};
}
