const assert = require("node:assert/strict");
const test = require("node:test");
const { conversationId } = require("@regenic/domain");
const {
  freshDirectoryMemory,
  listDirectoryPage,
  markDeliveryEndWritten,
  pageSelectedHeads,
} = require("../dist/directory");
const {
  crmDeliverySyncDriver,
  deliveryPollHint,
  installConfig,
  rememberDeliveryCursor,
  resetDeliveryCursorMemory,
  selectStoredCursor,
  selectionOf,
} = require("../dist/driver");
const { advanceDelivery, emptyOrderCursor, parseOrderCursor } = require("../dist/sync");
const { influencerMailScope } = require("../dist/mongo-store");
const { compactTime } = require("../dist/time");
const { SOURCE } = require("../dist/locators");

test("mail scope keeps untagged influencer mail when the order has no campaign", () => {
  const scope = influencerMailScope(order({ campaignId: "", projectId: "p1", influencerId: "inf", id: "order-a" }));
  const json = JSON.stringify(scope);
  assert.equal(json.includes("campaignId"), false);
  assert.equal(json.includes("inf"), true);
  assert.equal(json.includes("order-a"), true);
  assert.equal(json.includes("p1"), true);
});

test("compact time has no colon", () => {
  const compact = compactTime("2026-11-06T17:50:00.123Z");
  assert.equal(compact.includes(":"), false);
  assert.equal(compact, "20261106175000123");
});

test("step id stays on the delivery conversation", () => {
  const external = "order1:notice-20261106175000123-customer";
  assert.equal(conversationId(SOURCE, external), "crm-delivery:order1");
});

test("install rejects a bad Mongo URI and keeps the secret field for the host to move", async () => {
  assert.throws(() => installConfig({ mongo_uri: "http://localhost" }), /连接串/);
  const config = installConfig({
    mongo_uri: "mongodb://localhost:27017/crm",
    sync_concurrency: 2,
  });
  assert.equal(config.mongo_uri, "mongodb://localhost:27017/crm");
  assert.equal(config.mongo_db, "crm");
  assert.equal(config.sync_concurrency, 2);
  assert.equal(config.selection, "all");
  assert.equal(selectionOf({}), "all");
  assert.throws(() => installConfig({
    mongo_uri: "mongodb://localhost:27017/crm",
    selection: "pick",
  }), /至少选一张/);
  const picked = installConfig({
    mongo_uri: "mongodb://localhost:27017/crm",
    selection: "pick",
    order_ids: "a,b",
    order_names: "甲,乙",
  });
  assert.deepEqual(picked.order_ids, ["a", "b"]);
  const recent = installConfig({
    mongo_uri: "mongodb://localhost:27017/crm",
    selection: "recent",
    recent_limit: "10",
  });
  assert.equal(recent.selection, "recent");
  assert.equal(recent.recent_limit, 10);
  const kept = installConfig({ mongo_db: "crm", selection: "all" });
  assert.equal(kept.mongo_uri, undefined);
  assert.equal(kept.mongo_db, "crm");
  const catalog = crmDeliverySyncDriver.installCatalog();
  assert.equal(catalog.form_version, 2);
  assert.deepEqual(catalog.fields.map((field) => field.group), [
    "group.connection",
    "group.connection",
    "group.scope",
    "group.scope",
    "group.scope",
    "group.advanced",
    "group.advanced",
  ]);
  assert.equal(catalog.fields.find((field) => field.key === "mongo_uri").widget, "password");
  assert.equal(catalog.fields.every((field) => field.type), true);
  const options = await crmDeliverySyncDriver.listCatalogFieldOptions({ env: {} });
  assert.deepEqual(options, { order_ids: [] });
});

test("selected orders page in the saved order", () => {
  const heads = ["a", "b", "c"].map((id) => ({ id }));
  assert.deepEqual(pageSelectedHeads(heads, null, 2).map((row) => row.id), ["a", "b"]);
  assert.deepEqual(pageSelectedHeads(heads, "b", 2).map((row) => row.id), ["c"]);
  assert.deepEqual(pageSelectedHeads(heads, "missing", 2), []);
});

test("delivery threads do not match the AI review source", () => {
  const installation = {
    id: "inst",
    org_id: "org",
    connector_type: "crm-delivery-sync",
    status: "enabled",
    config: {},
    created_at: "2026-11-06T00:00:00.000Z",
    updated_at: "2026-11-06T00:00:00.000Z",
  };
  assert.equal(
    crmDeliverySyncDriver.matchesThread(installation, { source: "crm", target: "order:1" }),
    false,
  );
  assert.equal(
    crmDeliverySyncDriver.matchesThread(installation, { source: SOURCE, target: "1" }),
    true,
  );
  assert.equal(crmDeliverySyncDriver.resolveStreams().constructor.name, "Promise");
});

test("directory waits until the id scan finishes and the end step is written", async () => {
  const memory = freshDirectoryMemory(0);
  const open = [
    { id: "a", nickname: "小明", projectName: "春季" },
    { id: "b", nickname: "小红", projectName: "夏季" },
  ];
  const first = await listDirectoryPage({
    cursor: null,
    concurrency: 1,
    now: 0,
    memory,
    restartWaitMs: 1_000,
    listOpenIds: async (afterId, limit) => open.filter((row) => !afterId || row.id > afterId).slice(0, limit),
  });
  assert.equal(first.complete, false);
  assert.equal(first.members.length, 1);
  assert.equal(first.members[0].stream_key, "crm-delivery:a");
  assert.equal(first.members[0].label, "小明 · 春季");

  const second = await listDirectoryPage({
    cursor: first.next_cursor,
    concurrency: 1,
    now: 0,
    memory,
    restartWaitMs: 1_000,
    listOpenIds: async (afterId, limit) => open.filter((row) => !afterId || row.id > afterId).slice(0, limit),
  });
  assert.equal(second.complete, false);
  assert.equal(second.members[0].stream_key, "crm-delivery:b");

  memory.previousIds = ["a", "b", "gone"];
  const waiting = await listDirectoryPage({
    cursor: second.next_cursor,
    concurrency: 1,
    now: 5_000,
    memory,
    restartWaitMs: 1_000,
    listOpenIds: async () => [],
  });
  assert.equal(waiting.complete, false);
  assert.equal(waiting.members.some((member) => member.stream_key.includes("gone")), false);

  memory.endWritten.add("gone");
  const done = await listDirectoryPage({
    cursor: waiting.next_cursor,
    concurrency: 1,
    now: 5_000,
    memory,
    restartWaitMs: 1_000,
    listOpenIds: async () => [],
  });
  assert.equal(done.complete, true);
  assert.deepEqual(memory.previousIds, ["a", "b"]);
});

test("a closed order writes one end step and can be marked finished", async () => {
  const store = emptyStore();
  const advanced = await advanceDelivery({
    orderId: "a",
    order: order({ status: "CANCELLED" }),
    project: null,
    store,
    cursor: emptyOrderCursor(),
    pageSize: 20,
    now: "2026-11-06T10:00:00.000Z",
  });
  assert.equal(advanced.wroteEnd, true);
  assert.equal(advanced.records.length, 1);
  assert.match(advanced.records[0].external_id, /^a:end-CANCELLED-/);
  assert.equal(advanced.records[0].external_id.includes(":"), true);
  assert.equal(advanced.records[0].external_id.split(":").length, 2);
  markDeliveryEndWritten("a");
});

test("status log is kept and a second status step is not added", async () => {
  const store = emptyStore({
    logs: [{
      id: "log1",
      logTime: "2026-11-06T09:00:00.000Z",
      changeType: "UPDATE",
      operatorName: "运营",
      changes: [{ fieldName: "selectedWorkflow.status", oldValue: "FOLLOWING", newValue: "BARGAINING" }],
    }],
  });
  let cursor = emptyOrderCursor();
  const records = [];
  for (let i = 0; i < 6; i += 1) {
    const advanced = await advanceDelivery({
      orderId: "a",
      order: order({ status: "BARGAINING" }),
      project: project(),
      store,
      cursor,
      pageSize: 20,
      now: "2026-11-06T10:00:00.000Z",
    });
    records.push(...advanced.records);
    cursor = advanced.cursor;
    if (!advanced.hasMore) {
      break;
    }
  }
  const statusSteps = records.filter((record) => record.external_id.includes(":status-"));
  const logs = records.filter((record) => record.external_id.includes(":log-"));
  assert.equal(logs.length, 1);
  assert.equal(statusSteps.length, 0);
});

test("human review writes an ops notice, and a scene code alone does not write to the customer", async () => {
  const quiet = await runUntilLive(order({ status: "BARGAINING", sharedScene: "TOO_LOW" }), project());
  assert.equal(quiet.records.some((record) => recordText(record).startsWith("[给客户]")), false);

  const handed = await runUntilLive(order({
    status: "BARGAINING",
    sharedScene: "TOO_LOW",
    reviewNeeded: true,
    reviewAt: "2026-11-06T09:30:00.000Z",
    reviewReason: "价格要客户看",
    externalQuote: 100,
    nickname: "小明",
    bloggerLink: "https://example/xiaoming",
  }), project());
  const notices = handed.records.filter((record) => record.external_id.includes(":notice-"));
  assert.equal(notices.some((record) => recordText(record).startsWith("[给客户]")), true);
  assert.equal(notices.some((record) => recordText(record).startsWith("[给运营]")), true);
  assert.match(recordText(notices.find((record) => recordText(record).startsWith("[给运营]"))), /服务费/);
  assert.equal(recordText(notices.find((record) => recordText(record).startsWith("[给客户]"))).includes("服务费"), false);
});

test("a changed follow-up tombs the old step, and a real mail removes the auto note", async () => {
  const first = await runUntilLive(order({
    follows: [{ followTime: "2026-11-06T08:00:00.000Z", followerName: "运营", followContent: "先问档期" }],
  }), project());
  const note = first.records.find((record) => record.external_id.includes(":note-"));
  assert.ok(note);
  assert.equal(recordKind(note), "assistant");
  assert.equal(recordSpeaker(note), "运营");
  assert.match(recordText(note), /先问档期/);
  const second = await advanceDelivery({
    orderId: "a",
    order: order({
      follows: [{ followTime: "2026-11-06T08:00:00.000Z", followerName: "运营", followContent: "先问档期，改过" }],
    }),
    project: project(),
    store: emptyStore(),
    cursor: first.cursor,
    pageSize: 20,
    now: "2026-11-06T11:00:00.000Z",
  });
  assert.equal(second.records.some((record) => record.operation === "tombstone" && record.external_id === note.external_id), true);
  assert.equal(second.records.some((record) => record.operation === "create" && record.external_id.includes(":note-")), true);

  const auto = await runUntilLive(order({
    follows: [{ followTime: "2026-11-06T08:00:00.000Z", followerName: "系统", followContent: "发送跟进邮件：你好" }],
  }), project());
  assert.equal(auto.records.some((record) => record.external_id.includes(":note-auto-")), true);
  const withMail = await advanceDelivery({
    orderId: "a",
    order: order({
      follows: [{ followTime: "2026-11-06T08:00:00.000Z", followerName: "系统", followContent: "发送跟进邮件：你好" }],
    }),
    project: project(),
    store: emptyStore({
      mails: [{
        id: "m1",
        folder: "SENT",
        subject: "你好",
        content: "正文",
        sentDate: "2026-11-06T12:00:00.000Z",
        campaignId: "camp",
      }],
    }),
    cursor: auto.cursor,
    pageSize: 20,
    now: "2026-11-06T12:30:00.000Z",
  });
  assert.equal(withMail.records.some((record) => record.operation === "tombstone" && record.external_id.includes(":note-auto-")), true);
  assert.equal(withMail.records.some((record) => record.external_id.includes(":mail-m1")), true);
  const mail = withMail.records.find((record) => record.external_id.includes(":mail-m1"));
  assert.equal(recordKind(mail), "assistant");
  assert.equal(recordSpeaker(mail), "我们");
  assert.match(recordText(mail), /主题：你好/);
  assert.match(recordText(mail), /正文/);
});

test("mail keeps the new text and drops the quoted history", async () => {
  const page = await runUntilLive(order(), project(), emptyStore({
    mails: [
      {
        id: "m-quote",
        folder: "INBOX",
        from: "a@b.com",
        subject: "Re: 合作",
        content: "可以，按 200 做。\n\nOn Mon, Nov 2, 2026 at 10:00 AM Sans <sans@gmail.com> wrote:\n请报价",
        sentDate: "2026-11-06T08:00:00.000Z",
      },
      {
        id: "m-html",
        folder: "INBOX",
        from: "a@b.com",
        subject: "html",
        htmlContent: "<p>新的一段</p><blockquote>旧的一段</blockquote>",
        sentDate: "2026-11-06T08:01:00.000Z",
      },
    ],
  }));
  const quoted = page.records.find((record) => record.external_id.includes(":mail-m-quote"));
  assert.match(recordText(quoted), /按 200 做/);
  assert.equal(recordText(quoted).includes("请报价"), false);
  assert.equal(recordText(quoted).includes("wrote:"), false);
  const html = page.records.find((record) => record.external_id.includes(":mail-m-html"));
  assert.match(recordText(html), /新的一段/);
  assert.equal(recordText(html).includes("旧的一段"), false);
});

test("a multi-line follow-up becomes one message per line", async () => {
  const diary = await runUntilLive(order({
    follows: [{
      followTime: "2026-02-04T00:00:00.000Z",
      followerName: "罗瑶",
      followContent: "3.4达人回复3天内给草稿\n2.28客户说删除一个小点可以拍摄",
    }],
  }), project());
  const notes = diary.records.filter((record) => record.external_id.includes(":note-") && record.operation !== "tombstone");
  assert.equal(notes.length, 2);
  assert.equal(recordSpeaker(notes[0]), "罗瑶");
  assert.match(recordText(notes.find((record) => recordText(record).startsWith("3.4"))), /3天内给草稿/);
  assert.match(recordText(notes.find((record) => recordText(record).startsWith("2.28"))), /可以拍摄/);

  const one = await runUntilLive(order({
    follows: [{ followTime: "2026-11-06T08:00:00.000Z", followerName: "运营", followContent: "只有一句" }],
  }), project());
  const single = one.records.filter((record) => record.external_id.includes(":note-") && record.operation !== "tombstone");
  assert.equal(single.length, 1);
  assert.match(recordText(single[0]), /只有一句/);
});

test("stored system steps are rewritten with a readable speaker", async () => {
  const cursor = emptyOrderCursor();
  cursor.stage = "live";
  cursor.fp.context = "old";
  cursor.fp["notice-20261106093000000-ops"] = "old";
  const page = await advanceDelivery({
    orderId: "a",
    order: order({ reviewNeeded: true, reviewAt: "2026-11-06T09:30:00.000Z", reviewReason: "要看" }),
    project: project(),
    store: emptyStore(),
    cursor,
    pageSize: 20,
    now: "2026-11-06T11:00:00.000Z",
  });
  const context = page.records.find((record) => record.external_id.endsWith(":context"));
  assert.equal(context.operation, "revise");
  assert.equal(recordSpeaker(context), "订单");
  assert.match(recordText(context), /小明/);
  assert.match(recordText(context), /结算方式：未记录/);
  assert.doesNotMatch(recordText(context), /合作权益：/);
  assert.doesNotMatch(recordText(context), /交付物：/);
  assert.doesNotMatch(recordText(context), /权益：权益/);
  const prepaid = await advanceDelivery({
    orderId: "a",
    order: order({ settlementMethod: "PREPAID" }),
    project: project(),
    store: emptyStore(),
    cursor: emptyOrderCursor(),
    pageSize: 20,
    now: "2026-11-06T11:00:00.000Z",
  });
  const prepaidContext = prepaid.records.find((record) => record.external_id.endsWith(":context"));
  assert.match(recordText(prepaidContext), /结算方式：预充值/);
  const ops = page.records.find((record) => record.external_id.endsWith("-ops"));
  assert.equal(ops.operation, "revise");
  assert.equal(recordSpeaker(ops), "给运营");
  assert.equal(page.cursor.face, 4);
});

test("an old summary is removed and a later round does not add one", async () => {
  const cursor = emptyOrderCursor();
  cursor.stage = "live";
  cursor.face = 1;
  cursor.status = "FOLLOWING";
  cursor.fp["summary-20261107021100000"] = "old";
  const page = await advanceDelivery({
    orderId: "a",
    order: order({ status: "FOLLOWING" }),
    project: project(),
    store: emptyStore(),
    cursor,
    pageSize: 20,
    now: "2026-11-07T03:00:00.000Z",
  });
  const summaries = page.records.filter((record) => record.external_id.includes(":summary-"));
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].operation, "tombstone");
  assert.equal(page.cursor.fp["summary-20261107021100000"], undefined);
  const again = await advanceDelivery({
    orderId: "a",
    order: order({ status: "FOLLOWING", updatedTime: "2026-11-07T04:00:00.000Z" }),
    project: project(),
    store: emptyStore(),
    cursor: page.cursor,
    pageSize: 20,
    now: "2026-11-07T04:00:00.000Z",
  });
  assert.equal(again.records.some((record) => record.external_id.includes(":summary-")), false);
});

test("a customer script found after the handoff still writes a customer notice", async () => {
  const cursor = emptyOrderCursor();
  cursor.stage = "live";
  cursor.face = 1;
  cursor.reviewAt = "2026-11-06T09:30:00.000Z";
  cursor.decisionRewind = "done";
  const page = await advanceDelivery({
    orderId: "a",
    order: order({ reviewNeeded: true, reviewAt: "2026-11-06T09:30:00.000Z", reviewReason: "要客户确认" }),
    project: project(),
    store: emptyStore({
      decisions: [{
        id: "d1",
        updatedAt: "2026-11-01T00:00:00.000Z",
        ask: { party: "CUSTOMER", scriptTemplate: "请确认报价" },
      }],
    }),
    cursor,
    pageSize: 20,
    now: "2026-11-06T11:00:00.000Z",
  });
  const customer = page.records.find((record) => recordText(record).startsWith("[给客户]"));
  assert.ok(customer);
  assert.equal(recordSpeaker(customer), "给客户");
  assert.equal(recordKind(customer), "user");
  assert.match(recordText(customer), /请确认报价/);
});

test("an ops handoff with a script template writes the customer sentence", async () => {
  const handed = await runUntilLive(order({
    status: "FOLLOWING",
    reviewNeeded: true,
    reviewAt: "2026-11-06T09:30:00.000Z",
    reviewReason: "达人确认合作",
  }), project(), emptyStore({
    decisions: [{
      id: "d-ops",
      updatedAt: "2026-11-06T09:30:00.000Z",
      reason: "FOLLOWING_CONFIRM",
      waitingOn: "OPS",
      ask: {
        party: "OPS",
        lead: "待人工，达人确认合作",
        scriptTemplate: "达人确认{price}合作，请问是否确认推进。",
        facts: [{ kind: "EXTERNAL_PRICE", value: "100" }],
      },
    }],
  }));
  const customer = handed.records.find((record) => recordText(record).startsWith("[给客户]"));
  assert.ok(customer);
  assert.match(recordText(customer), /达人确认100合作/);
  assert.equal(recordText(customer).includes("待人工"), false);

  const opsOnly = await runUntilLive(order({
    status: "FOLLOWING",
    reviewNeeded: true,
    reviewAt: "2026-11-06T09:30:00.000Z",
    reviewReason: "CAMPAIGN_MISSING",
    reviewHint: "缺项目",
  }), project(), emptyStore({
    decisions: [{
      id: "d-missing",
      updatedAt: "2026-11-06T09:30:00.000Z",
      reason: "CAMPAIGN_MISSING",
      waitingOn: "OPS",
      ask: { party: "OPS", lead: "请运营补项目" },
    }],
  }));
  assert.equal(opsOnly.records.some((record) => recordText(record).startsWith("[给客户]")), false);
  assert.equal(opsOnly.records.some((record) => recordText(record).startsWith("[给运营]")), true);
});

test("a handoff notice stays after the flag is cleared or the quote changes", async () => {
  const handed = await runUntilLive(order({
    status: "BARGAINING",
    sharedScene: "TOO_LOW",
    reviewNeeded: true,
    reviewAt: "2026-11-06T09:30:00.000Z",
    reviewReason: "价格要客户看",
    externalQuote: 100,
  }), project());
  const customerId = handed.records.find((record) => recordText(record).startsWith("[给客户]")).external_id;
  const cleared = await advanceDelivery({
    orderId: "a",
    order: order({
      status: "BARGAINING",
      sharedScene: "REJECT",
      reviewNeeded: false,
      externalQuote: 999,
    }),
    project: project(),
    store: emptyStore(),
    cursor: handed.cursor,
    pageSize: 20,
    now: "2026-11-06T12:00:00.000Z",
  });
  assert.equal(cleared.records.some((record) => record.external_id === customerId), false);
  assert.equal(cleared.records.some((record) => record.operation === "tombstone" && record.external_id.includes(":notice-")), false);

  const again = await runUntilLive(order({
    status: "FOLLOWING",
    reviewNeeded: true,
    reviewAt: "2026-11-06T09:30:00.000Z",
    reviewReason: "缺项目",
  }), project());
  assert.equal(again.records.some((record) => recordText(record).startsWith("[给客户]")), false);
  const filled = await advanceDelivery({
    orderId: "a",
    order: order({
      status: "FOLLOWING",
      reviewNeeded: false,
      externalQuote: 100,
    }),
    project: project(),
    store: emptyStore({
      decisions: [{
        id: "d-late",
        updatedAt: "2026-11-06T12:00:00.000Z",
        ask: {
          party: "OPS",
          scriptTemplate: "达人确认{price}合作，请问是否确认推进。",
          facts: [{ kind: "EXTERNAL_PRICE", value: "100" }],
        },
      }],
    }),
    cursor: again.cursor,
    pageSize: 20,
    now: "2026-11-06T12:00:00.000Z",
  });
  const added = filled.records.filter((record) => recordText(record).startsWith("[给客户]"));
  assert.equal(added.length, 1);
  assert.match(recordText(added[0]), /达人确认100合作/);
  const rewritten = await advanceDelivery({
    orderId: "a",
    order: order({
      status: "FOLLOWING",
      reviewNeeded: true,
      reviewAt: "2026-11-06T09:30:00.000Z",
      externalQuote: 100,
    }),
    project: project(),
    store: emptyStore({
      decisions: [{
        id: "d-late",
        updatedAt: "2026-11-06T13:00:00.000Z",
        ask: {
          party: "OPS",
          scriptTemplate: "达人改口了，请问是否继续。",
        },
      }],
    }),
    cursor: filled.cursor,
    pageSize: 20,
    now: "2026-11-06T13:00:00.000Z",
  });
  assert.equal(rewritten.records.some((record) => record.external_id.includes(":notice-")), false);

  const nextRound = await advanceDelivery({
    orderId: "a",
    order: order({
      status: "FOLLOWING",
      reviewNeeded: true,
      reviewAt: "2026-11-07T01:00:00.000Z",
      reviewReason: "又一次转人工",
      sharedScene: "SCHEDULE",
    }),
    project: project(),
    store: emptyStore(),
    cursor: filled.cursor,
    pageSize: 20,
    now: "2026-11-07T01:00:00.000Z",
  });
  const freshNotices = nextRound.records.filter((record) => record.external_id.includes(":notice-") && record.operation !== "tombstone");
  assert.equal(freshNotices.some((record) => record.external_id.endsWith("-ops")), true);
  assert.equal(freshNotices.some((record) => record.external_id.endsWith("-customer")), true);
  assert.equal(nextRound.records.some((record) => record.operation === "tombstone"), false);
});

test("older influencer mail is read once even when the live watermark is already ahead", async () => {
  const cursor = emptyOrderCursor();
  cursor.stage = "live";
  cursor.face = 1;
  cursor.watermark = "2026-11-06T12:00:00.000Z";
  const page = await advanceDelivery({
    orderId: "a",
    order: order({ campaignId: "" }),
    project: project(),
    store: emptyStore({
      mails: [{
        id: "m-old",
        folder: "INBOX",
        from: "达人",
        subject: "旧邮件",
        content: "还在",
        sentDate: "2026-01-01T00:00:00.000Z",
      }],
    }),
    cursor,
    pageSize: 20,
    now: "2026-11-06T13:00:00.000Z",
  });
  assert.equal(page.records.some((record) => record.external_id.includes(":mail-m-old")), true);
  assert.equal(page.cursor.mailRewind, "done");
});

test("a changed project brief appends a context step", async () => {
  const first = await runUntilLive(order(), project({ briefText: "旧 brief" }));
  assert.equal(first.records.some((record) => record.external_id.endsWith(":context")), true);
  const second = await advanceDelivery({
    orderId: "a",
    order: order(),
    project: project({ briefText: "新 brief", updatedTime: "2026-11-06T13:00:00.000Z" }),
    store: emptyStore(),
    cursor: first.cursor,
    pageSize: 20,
    now: "2026-11-06T13:00:00.000Z",
  });
  assert.equal(second.records.some((record) => record.external_id.includes(":context-")), true);
  assert.equal(second.records.some((record) => record.operation === "revise" && record.external_id.endsWith(":context")), false);
});

test("poll hint stays in backfill until the order page is finished", () => {
  assert.deepEqual(deliveryPollHint(true), { live_seeded: true, history_pending: true });
  assert.deepEqual(deliveryPollHint(false), { live_seeded: true, history_pending: false });
});

test("a later live poll keeps the further history cursor", () => {
  resetDeliveryCursorMemory();
  const key = "inst:a";
  const early = JSON.stringify({ ...emptyOrderCursor(), seq: 1, stage: "mails" });
  const later = JSON.stringify({ ...emptyOrderCursor(), seq: 4, stage: "live" });
  rememberDeliveryCursor(key, later);
  assert.equal(parseOrderCursor(selectStoredCursor(key, early)).seq, 4);
  assert.equal(parseOrderCursor(selectStoredCursor(key, early)).stage, "live");
  assert.equal(parseOrderCursor(selectStoredCursor(key, later)).seq, 4);
});

function order(extra = {}) {
  return {
    id: "a",
    projectId: "p1",
    campaignId: "camp",
    influencerId: "inf",
    nickname: "小明",
    platform: "小红书",
    bloggerLink: "https://example/xiaoming",
    externalQuote: 80,
    influencerQuote: 50,
    cooperationBenefits: "一条视频",
    bargainServiceFeeUsd: 12,
    status: "FOLLOWING",
    createdTime: "2026-11-01T00:00:00.000Z",
    updatedTime: "2026-11-06T09:00:00.000Z",
    follows: [],
    ...extra,
  };
}

function project(extra = {}) {
  return {
    id: "p1",
    name: "春季",
    briefText: "brief",
    benefits: "权益",
    demands: "需求",
    updatedTime: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

function emptyStore(seed = {}) {
  const mails = seed.mails ?? [];
  const logs = seed.logs ?? [];
  const decisions = seed.decisions ?? [];
  return {
    async listOpenIds() {
      return [];
    },
    async readOrder() {
      return null;
    },
    async readProject() {
      return null;
    },
    async listMails(_order, query, limit) {
      return slicePage(mails, query, limit);
    },
    async listLogs(_orderId, query, limit) {
      return slicePage(logs, query, limit);
    },
    async listDecisions(_orderId, query, limit) {
      return slicePage(decisions, query, limit);
    },
  };
}

function slicePage(items, query, limit) {
  const filtered = items.filter((item) => {
    if (query.afterId && item.id <= query.afterId) {
      return false;
    }
    if (!query.since) {
      return true;
    }
    const time = item.sentDate || item.updatedTime || item.logTime || item.updatedAt || "";
    return time > query.since;
  });
  return { items: filtered.slice(0, limit), full: filtered.length > limit };
}

async function runUntilLive(orderDoc, projectDoc, store = emptyStore()) {
  let cursor = emptyOrderCursor();
  const records = [];
  for (let i = 0; i < 8; i += 1) {
    const advanced = await advanceDelivery({
      orderId: "a",
      order: orderDoc,
      project: projectDoc,
      store,
      cursor,
      pageSize: 20,
      now: "2026-11-06T10:00:00.000Z",
    });
    records.push(...advanced.records);
    cursor = parseOrderCursor(JSON.stringify(advanced.cursor));
    if (!advanced.hasMore) {
      return { records, cursor };
    }
  }
  throw new Error("poll did not finish");
}

function recordText(record) {
  const body = record?.content?.find((part) => part.role === "body");
  return body?.text ?? "";
}

function recordSurface(record) {
  const meta = record?.content?.find((part) => part.role === "metadata");
  return meta?.text ? JSON.parse(meta.text) : {};
}

function recordKind(record) {
  return recordSurface(record).kind;
}

function recordSpeaker(record) {
  return recordSurface(record).actor_label;
}
