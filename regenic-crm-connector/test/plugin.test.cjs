const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const {
  ChannelDriverError,
  ChannelDriverRegistry,
  MemoryConnectorRegistry,
  verifyChannelDriverConformance,
} = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  crmOpsReviewDriver,
  crmOrderReviewDriver,
  crmOpsReviewPlugin,
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
    assert.equal(ops.title, "CRM ops review");
    assert.equal(ops.channel_label, "CRM");
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
    assert.equal(order.title, "CRM order review");
    assert.equal(order.channel_label, "CRM");
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
      label: "Email submit review",
      detail: "crm.internal · 50",
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
});
