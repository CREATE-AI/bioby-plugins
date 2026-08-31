const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ChannelDriverError,
  ChannelDriverRegistry,
  MemoryAuthorityStore,
  MemoryConnectorRegistry,
  resolveCopyText,
  verifyChannelDriverConformance,
} = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  crmOpsReviewDriver,
  crmOrderReviewDriver,
  crmOpsReviewPlugin,
  CrmListFoldError,
  hideThreadFromHost,
  registerCrmDrivers,
} = require("../dist");
const { createFetch, jsonResponse, sampleOpsTask } = require("./helpers.cjs");

describe("CRM drivers and plugins", () => {
  it("splits ownsThread by locator prefix and stays sync-only", () => {
    const ops = {
      id: "ops-1",
      org_id: "local-owner",
      connector_type: "crm-ops-review",
      status: "enabled",
      config: { max_open_tasks: 50 },
      created_at: "2026-08-26T00:00:00.000Z",
    };
    const order = {
      ...ops,
      id: "order-1",
      connector_type: "crm-order-review",
      config: { max_open_order_reviews: 50 },
    };
    const disabled = { ...ops, status: "disabled" };
    assert.equal(
      crmOpsReviewDriver.ownsThread(ops, { source: "crm", target: "ops_task:1" }),
      true,
    );
    assert.equal(
      crmOpsReviewDriver.ownsThread(ops, { source: "crm", target: "order:1" }),
      false,
    );
    assert.equal(
      crmOrderReviewDriver.ownsThread(order, { source: "crm", target: "order:1" }),
      true,
    );
    assert.deepEqual(crmOpsReviewDriver.capabilities(ops), {
      sync: true,
      reply: false,
      create: false,
      list_title: "conversation",
      prompts: true,
    });
    assert.equal(crmOpsReviewDriver.connector_protocol, "1.0");
    assert.equal(crmOrderReviewDriver.connector_protocol, "1.0");
    assert.deepEqual(crmOpsReviewDriver.subjectCatalog(), {
      kinds: [
        { id: "crm.ops_review", label: "kind.opsReview" },
        { id: "crm.order_review", label: "kind.orderReview" },
      ],
    });
    assert.equal(
      resolveCopyText(crmOpsReviewDriver.locales(), "zh", "kind.opsReview"),
      "邮件提报待审",
    );
    assert.equal(
      resolveCopyText(crmOpsReviewDriver.locales(), "en", "kind.orderReview"),
      "Order AI review",
    );
    assert.deepEqual(
      crmOrderReviewDriver.subjectCatalog(),
      crmOpsReviewDriver.subjectCatalog(),
    );
    const manifest = require("../package.json").regenic;
    assert.equal(manifest.plugin, true);
    assert.deepEqual(manifest.contributes.drivers, [
      "crmOpsReviewDriver",
      "crmOrderReviewDriver",
    ]);
    assert.equal(manifest.engines.regenic, "1.0");
    assert.equal(crmOpsReviewDriver.createThread, undefined);
    assert.equal(crmOpsReviewDriver.bindEgress, undefined);
    assert.equal(crmOpsReviewDriver.outboundId, undefined);
    assert.equal(crmOpsReviewDriver.canReply, undefined);
    assert.equal(crmOrderReviewDriver.createThread, undefined);
    assert.equal(crmOrderReviewDriver.bindEgress, undefined);
    assert.equal(
      crmOpsReviewDriver.install({
        id: "ops-1",
        org_id: "local-owner",
        config: { base_url: "https://crm.internal/api", max_open_tasks: "50" },
        now: "2026-08-26T00:00:00.000Z",
      }).credentials_ref,
      "env:REGENIC_CRM_TOKEN",
    );
    assert.equal(
      crmOrderReviewDriver.install({
        id: "order-1",
        org_id: "local-owner",
        config: {
          base_url: "https://crm.internal/api",
          max_open_order_reviews: "50",
        },
        now: "2026-08-26T00:00:00.000Z",
      }).credentials_ref,
      "env:REGENIC_CRM_TOKEN",
    );
    verifyChannelDriverConformance({
      driver: crmOpsReviewDriver,
      enabled: ops,
      disabled,
    });
    verifyChannelDriverConformance({
      driver: crmOrderReviewDriver,
      enabled: order,
      disabled: { ...order, status: "disabled" },
    });
  });

  it("registers the ops stream on the host and unregisters on dispose", async () => {
    const host = await createHost();
    const registry = new MemoryConnectorRegistry();
    await host.plugin(
      definePlugin({
        name: "connectors",
        apply(ctx) {
          ctx.provide("connectors", registry);
        },
      }),
    );
    const plugin = await host.plugin(crmOpsReviewPlugin, {
      installation_id: "crm-1",
      org_id: "local-owner",
      base_url: "https://crm.internal/api",
      fetch: createFetch({
        "GET /api/internal/regenic/pending-ops-tasks": jsonResponse(200, {
          items: [sampleOpsTask()],
        }),
      }),
    });
    assert.equal(registry.get("crm-1")?.source, "crm");
    assert.equal(registry.getStream("crm-1")?.stream_key, "crm:pending-ops:all");
    await plugin.dispose();
    assert.equal(registry.get("crm-1"), undefined);
    await host.dispose();
  });

  it("exposes a one-member SyncEngine directory for each CRM queue", async () => {
    const ops = {
      id: "ops-1",
      org_id: "local-owner",
      connector_type: "crm-ops-review",
      status: "enabled",
      config: { base_url: "https://crm.internal/api", max_open_tasks: "50" },
      created_at: "2026-08-26T00:00:00.000Z",
    };
    const order = {
      ...ops,
      id: "order-1",
      connector_type: "crm-order-review",
      config: {
        base_url: "https://crm.internal/api",
        max_open_order_reviews: "50",
      },
    };
    const opsPage = await (
      await crmOpsReviewDriver.bindSyncSource(ops, {}, {})
    ).listDirectory(null);
    assert.deepEqual(opsPage, {
      members: [
        {
          stream_key: "crm:pending-ops:all",
          thread_id: "crm:ops",
          label: "CRM 待审运营任务",
          kind: "ops",
        },
      ],
      complete: true,
    });
    const scoped = await (
      await crmOpsReviewDriver.bindSyncSource(ops, {}, {
        REGENIC_CRM_TOKEN: "jwt-test",
      })
    ).listDirectory(null);
    assert.equal(scoped.members[0].stream_key, "crm:pending-ops:scoped");
    const orderPage = await (
      await crmOrderReviewDriver.bindSyncSource(order, {}, {})
    ).listDirectory(null);
    assert.deepEqual(orderPage, {
      members: [
        {
          stream_key: "crm:pending-review:all",
          thread_id: "crm:order",
          label: "CRM 待人工内审订单",
          kind: "order",
        },
      ],
      complete: true,
    });
  });

  it("lets the registry route ops and order threads to different drivers", () => {
    const drivers = new ChannelDriverRegistry();
    registerCrmDrivers(drivers);
    const found = drivers.findForThread(
      [
        {
          id: "ops-1",
          org_id: "local-owner",
          connector_type: "crm-ops-review",
          status: "enabled",
          config: {},
          created_at: "2026-08-26T00:00:00.000Z",
        },
        {
          id: "order-1",
          org_id: "local-owner",
          connector_type: "crm-order-review",
          status: "enabled",
          config: {},
          created_at: "2026-08-26T00:00:00.000Z",
        },
      ],
      { source: "crm", target: "order:pf-1" },
    );
    assert.equal(found?.driver.connector_type, "crm-order-review");
  });

  it("declares install catalog cards and write-back labels on the drivers", () => {
    const ops = crmOpsReviewDriver.installCatalog();
    const order = crmOrderReviewDriver.installCatalog();
    assert.equal(ops.title, "catalog.opsTitle");
    assert.equal(ops.channel_label, "catalog.channelLabel");
    assert.equal(
      resolveCopyText(crmOpsReviewDriver.locales(), "zh", ops.title),
      "CRM 运营待审",
    );
    assert.equal(ops.singleton, true);
    assert.equal(ops.fields[0].key, "base_url");
    assert.equal(ops.fields[0].required, true);
    assert.equal(ops.fields[1].key, "max_open_tasks");
    assert.equal(
      ops.prerequisites.some((item) => item.key === "REGENIC_CRM_BASE_URL"),
      false,
    );
    assert.equal(
      ops.prerequisites.some((item) => item.key === "REGENIC_CRM_SHARED_SECRET"),
      true,
    );
    assert.equal(
      ops.prerequisites.some((item) => item.key === "REGENIC_CRM_TOKEN"),
      true,
    );
    assert.equal(order.title, "catalog.orderTitle");
    assert.equal(order.channel_label, "catalog.channelLabel");
    assert.equal(order.singleton, true);
    assert.equal(order.fields[0].key, "base_url");
    assert.equal(order.fields[1].key, "max_open_order_reviews");
    assert.deepEqual(crmOrderReviewDriver.writeBackLabels("REJECTED"), [
      "REJECTED",
      "不通过",
    ]);
    assert.deepEqual(crmOrderReviewDriver.writeBackLabels("APPROVED"), [
      "APPROVED",
      "通过",
    ]);
    assert.equal(
      ops.prerequisites.some((item) => item.kind === "local_service"),
      false,
    );
    assert.deepEqual(crmOpsReviewDriver.presentInstall({
      id: "crm-1",
      org_id: "local-owner",
      connector_type: "crm-ops-review",
      status: "enabled",
      config: {
        base_url: "https://crm.internal/api",
        max_open_tasks: "50",
      },
      created_at: "2026-08-26T00:00:00.000Z",
    }), {
      label: "present.ops",
      detail: { literal: "crm.internal · 50" },
    });
  });

  it("stores the CRM base URL on the connector install, not an env var", () => {
    const installed = crmOrderReviewDriver.install({
      id: "order-1",
      org_id: "local-owner",
      config: {
        base_url: "https://crm.internal/api/",
        max_open_order_reviews: "20",
      },
      now: "2026-08-26T00:00:00.000Z",
    });
    assert.deepEqual(installed.config, {
      base_url: "https://crm.internal/api",
      max_open_order_reviews: "20",
    });
    assert.equal(installed.credentials_ref, "env:REGENIC_CRM_TOKEN");
    assert.throws(
      () =>
        crmOpsReviewDriver.install({
          id: "ops-1",
          org_id: "local-owner",
          config: { max_open_tasks: "50" },
          now: "2026-08-26T00:00:00.000Z",
        }),
      (error) =>
        error instanceof ChannelDriverError &&
        error.message.includes("connector form"),
    );
    assert.throws(
      () =>
        crmOpsReviewDriver.install({
          id: "ops-1",
          org_id: "local-owner",
          config: { base_url: "https://crm.internal", max_open_tasks: "50" },
          now: "2026-08-26T00:00:00.000Z",
        }),
      (error) =>
        error instanceof ChannelDriverError &&
        error.message.includes("including /api"),
    );
  });

  it("folds a gone thread with conversation_prefs.hidden, not tombstone", async () => {
    const store = new MemoryAuthorityStore();
    const host = await createHost();
    await host.plugin(
      definePlugin({
        name: "authority",
        apply(ctx) {
          ctx.provide("authority", store);
        },
      }),
    );
    const hide = hideThreadFromHost(host, "local-owner", () => "2026-08-26T00:00:00.000Z");
    await hide("crm:ops_task:task-2");
    const pref = await store.getConversationPref("local-owner", "crm:ops_task:task-2");
    assert.equal(pref?.hidden, true);
    assert.equal(pref?.hidden_reason, "policy");
    await host.dispose();
  });

  it("refuses to pretend a fold succeeded when the host has no authority", async () => {
    const host = await createHost();
    const hide = hideThreadFromHost(host, "local-owner", () => "2026-08-26T00:00:00.000Z");
    await assert.rejects(
      () => hide("crm:ops_task:task-2"),
      (error) =>
        error instanceof CrmListFoldError && /no conversation pref store/.test(error.message),
    );
    await host.dispose();
  });
});
