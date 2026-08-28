import {
  ChannelDriverError,
  requireConnectorStream,
  type ChannelDriver,
  type ConnectorInstallation,
  type ConversationThread,
  type JsonValue,
  type NewConnectorInstallation,
} from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";
import {
  configNumber,
  configString,
  crmCatalogFields,
  crmCatalogPrerequisites,
  crmClientFromConfig,
  crmHasToken,
  crmInstallDetail,
  DEFAULT_MAX_OPEN_ORDER_REVIEWS,
  mapCrmError,
  requireCrmBaseUrl,
  type CrmFetch,
} from "./crm-client";
import {
  CRM_SOURCE,
  crmScopeOf,
  isOrderTarget,
  ORDER_CONNECTOR_TYPE,
  orderStreamKey,
  writeBackLabels,
} from "./locators";
import { crmOrderReviewPlugin } from "./plugin";
import { answerOrderPrompt, listOrderPrompts } from "./prompts";
import { orderConversationLabel } from "./records";

export const crmOrderReviewDriver: ChannelDriver = {
  connector_type: ORDER_CONNECTOR_TYPE,
  source: CRM_SOURCE,

  install(input): NewConnectorInstallation {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: ORDER_CONNECTOR_TYPE,
      status: "enabled",
      config: orderInstallConfig(input.config),
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

  canReply() {
    return false;
  },

  async createThread() {
    throw new ChannelDriverError(
      "unsupported_channel",
      "Creating a CRM order is not available",
    );
  },

  async resolveStreams(installation, host, env) {
    return [await mountOrderStream(host, installation, env)];
  },

  async resolveThreadStream(installation, _thread, host, env) {
    return mountOrderStream(host, installation, env);
  },

  async bindEgress() {
    throw new ChannelDriverError(
      "unsupported_channel",
      "CRM order review must go through answerPrompt, not egress",
    );
  },

  outboundId(thread: ConversationThread) {
    return `${thread.target}:out:local`;
  },

  installCatalog() {
    return {
      title: "CRM order review",
      description:
        "Private plugin. Pulls orders whose AI internal review is waiting for a human.",
      credential_hint: "CRM base URL in the form; REGENIC_CRM_TOKEN optional",
      singleton: true,
      fields: crmCatalogFields([
        {
          key: "max_open_order_reviews",
          label: "Max open order reviews",
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
      label: "Order internal review",
      detail: crmInstallDetail(installation.config, "max_open_order_reviews", "50"),
    };
  },

  async probeCatalog() {
    return {
      services: {
        "crm-connector": {
          ready: true,
          hint: "Private CRM connector is loaded. Set the CRM base URL in the connector form.",
        },
      },
    };
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
      const client = crmClientFromConfig({ config: installation.config, env });
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
        crmClientFromConfig({ config: installation.config, env }),
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
        crmClientFromConfig({ config: installation.config, env }),
        thread.target,
        answer,
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
  host: Host,
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
  extras: { fetch?: CrmFetch; now?: () => string } = {},
) {
  const scope = crmScopeOf(crmHasToken(env));
  const streamKey = orderStreamKey(scope);
  if (!host.get("connectors").getStream(installation.id, streamKey)) {
    await host.plugin(crmOrderReviewPlugin, {
      installation_id: installation.id,
      org_id: installation.org_id,
      max_open_order_reviews: configNumber(installation.config, "max_open_order_reviews"),
      base_url: configString(installation.config, "base_url"),
      env,
      fetch: extras.fetch,
      now: extras.now,
    });
  }
  return requireConnectorStream(host.get("connectors"), installation.id, streamKey);
}
