import {
  CONNECTOR_PROTOCOL,
  ChannelDriverError,
  envCredentialsRef,
  requireConnectorStream,
  type ChannelDriver,
  type ConnectorHost,
  type ConnectorInstallation,
  type JsonValue,
  type NewConnectorInstallation,
  type SyncSource,
} from "@regenic/domain";
import {
  CRM_TOKEN_ENV,
  configNumber,
  configString,
  crmCatalogFields,
  crmCatalogPrerequisites,
  crmClientFromConfig,
  crmHasToken,
  crmInstallDetail,
  crmProbeCatalog,
  DEFAULT_MAX_OPEN_ORDER_REVIEWS,
  mapCrmError,
  requireCrmBaseUrl,
  type CrmFetch,
} from "./crm-client";
import {
  CRM_SOURCE,
  crmScopeOf,
  crmSubjectCatalog,
  isOrderTarget,
  ORDER_CONNECTOR_TYPE,
  orderStreamKey,
  writeBackLabels,
} from "./locators";
import { crmLocaleTables } from "./locales";
import { crmOrderReviewPlugin } from "./plugin";
import { answerOrderPrompt, listOrderPrompts } from "./prompts";
import { orderConversationLabel } from "./records";
import { createCrmOrderSyncSource } from "./sync-source";
import {
  OpenWindowLedger,
  bindOrderOpenWindowLedger,
  releaseOrderOpenWindow,
} from "./open-window";

export const crmOrderReviewDriver: ChannelDriver = {
  connector_type: ORDER_CONNECTOR_TYPE,
  source: CRM_SOURCE,
  connector_protocol: CONNECTOR_PROTOCOL,

  install(input): NewConnectorInstallation {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: ORDER_CONNECTOR_TYPE,
      status: "enabled",
      config: orderInstallConfig(input.config),
      credentials_ref: envCredentialsRef(CRM_TOKEN_ENV),
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    return (
      installation.status === "enabled" &&
      thread.source === CRM_SOURCE &&
      isOrderTarget(thread.target)
    );
  },

  ownsThread(installation, thread) {
    return this.matchesThread(installation, thread);
  },

  capabilities(installation) {
    if (installation.status !== "enabled") {
      return { sync: false, reply: false, create: false };
    }
    return {
      sync: true,
      reply: false,
      create: false,
      list_title: "conversation",
      prompts: true,
    };
  },

  async resolveStreams(installation, host, env) {
    return [await mountOrderStream(host, installation, env)];
  },

  async bindSyncSource(installation, _host, env): Promise<SyncSource> {
    return createCrmOrderSyncSource(
      crmScopeOf(crmHasToken(env, installation.credentials_ref)),
    );
  },

  async resolveThreadStream(installation, _thread, host, env) {
    return mountOrderStream(host, installation, env);
  },

  locales() {
    return crmLocaleTables;
  },

  subjectCatalog() {
    return crmSubjectCatalog();
  },

  installCatalog() {
    return {
      title: "catalog.orderTitle",
      channel_label: "catalog.channelLabel",
      description: "catalog.orderDescription",
      credential_hint: "catalog.credentialHint",
      singleton: true,
      fields: crmCatalogFields([
        {
          key: "max_open_order_reviews",
          label: "field.maxOpenOrders",
          required: false,
          default: "50",
          placeholder: "50",
        },
      ]),
      prerequisites: crmCatalogPrerequisites(),
    };
  },

  writeBackLabels,

  presentInstall(installation) {
    return {
      label: "present.order",
      detail: {
        literal: crmInstallDetail(installation.config, "max_open_order_reviews", "50"),
      },
    };
  },

  async probeCatalog({ env }) {
    return crmProbeCatalog(env);
  },

  async resolveConversationLabels(installation, threads, env) {
    const labels = new Map<string, string>();
    const wanted = threads.filter(
      (thread) => this.ownsThread(installation, thread),
    );
    if (wanted.length === 0) {
      return labels;
    }
    try {
      const client = crmClientFromConfig({
        config: installation.config,
        env,
        credentials_ref: installation.credentials_ref,
      });
      await Promise.all(
        wanted.map(async (thread) => {
          const orderId = thread.target.slice("order:".length);
          try {
            const order = await client.getOrder(orderId);
            labels.set(`${CRM_SOURCE}:${thread.target}`, orderConversationLabel(order));
          } catch {
            // A lookup failure must not block inbox.
          }
        }),
      );
    } catch {
      return labels;
    }
    return labels;
  },

  async listPrompts(installation, thread, _host, env) {
    if (!this.capabilities(installation).prompts) {
      return [];
    }
    try {
      return await listOrderPrompts(
        crmClientFromConfig({
          config: installation.config,
          env,
          credentials_ref: installation.credentials_ref,
        }),
        thread.target,
      );
    } catch (error) {
      mapCrmError(error, "sync");
    }
  },

  async answerPrompt(installation, thread, answer, _host, env) {
    if (!this.capabilities(installation).prompts) {
      throw new ChannelDriverError(
        "unsupported_channel",
        "This CRM order installation cannot answer a prompt",
      );
    }
    try {
      return await answerOrderPrompt(
        crmClientFromConfig({
          config: installation.config,
          env,
          credentials_ref: installation.credentials_ref,
        }),
        thread.target,
        answer,
        (orderId) => releaseOrderOpenWindow(installation.id, orderId),
      );
    } catch (error) {
      mapCrmError(error, "send");
    }
  },
};

export function orderInstallConfig(
  config: Record<string, unknown>,
): Record<string, JsonValue> {
  const max =
    configNumber(config, "max_open_order_reviews") ?? DEFAULT_MAX_OPEN_ORDER_REVIEWS;
  if (!Number.isInteger(max) || max < 1) {
    throw new ChannelDriverError(
      "invalid_config",
      "max_open_order_reviews must be a positive integer",
    );
  }
  return {
    base_url: requireCrmBaseUrl(config),
    max_open_order_reviews: String(max),
  };
}

export async function mountOrderStream(
  host: ConnectorHost,
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
  extras: { fetch?: CrmFetch; now?: () => string } = {},
) {
  const scope = crmScopeOf(crmHasToken(env, installation.credentials_ref));
  const streamKey = orderStreamKey(scope);
  if (!host.get("connectors").getStream(installation.id, streamKey)) {
    const openWindowLedger = new OpenWindowLedger();
    bindOrderOpenWindowLedger(installation.id, openWindowLedger);
    await host.plugin(crmOrderReviewPlugin, {
      installation_id: installation.id,
      org_id: installation.org_id,
      max_open_order_reviews: configNumber(installation.config, "max_open_order_reviews"),
      base_url: configString(installation.config, "base_url"),
      credentials_ref: installation.credentials_ref,
      env,
      fetch: extras.fetch,
      now: extras.now,
      openWindowLedger,
    });
  }
  return requireConnectorStream(host.get("connectors"), installation.id, streamKey);
}
