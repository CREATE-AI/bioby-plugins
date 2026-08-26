const assert = require("node:assert/strict");
const { describe, it } = require("node:test");
const { ChannelDriverError, ChannelDriverRegistry, MemoryConnectorRegistry } = require("@regenic/domain");
const { createHost, definePlugin } = require("@regenic/plugin-host");
const {
  crmOpsReviewDriver,
  crmOrderReviewDriver,
  crmOpsReviewPlugin,
  registerCrmDrivers,
} = require("../dist");
const { createFetch, jsonResponse, sampleOpsTask } = require("./helpers.cjs");

const env = {
  REGENIC_CRM_BASE_URL: "https://crm.internal",
};

describe("CRM drivers and plugins", () => {
  it("splits ownsThread by locator prefix and refuses egress", async () => {
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
    await assert.rejects(
      () => crmOpsReviewDriver.bindEgress(),
      (error) => error instanceof ChannelDriverError && error.code === "unsupported_channel",
    );
    await assert.rejects(
      () => crmOrderReviewDriver.createThread(),
      (error) => error instanceof ChannelDriverError && error.code === "unsupported_channel",
    );
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
      env,
      fetch: createFetch({
        "GET /internal/regenic/pending-ops-tasks": jsonResponse(200, {
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
});
