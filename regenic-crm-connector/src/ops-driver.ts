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
  CRM_BASE_URL_ENV,
  crmCatalogPrerequisites,
  crmClientFromEnv,
  crmHasToken,
  DEFAULT_MAX_OPEN_TASKS,
  mapCrmError,
  type CrmFetch,
} from "./crm-client";
import {
  CRM_SOURCE,
  crmScopeOf,
  isOpsTaskTarget,
  OPS_CONNECTOR_TYPE,
  opsStreamKey,
  writeBackLabels,
} from "./locators";
import { answerOpsPrompt, listOpsPrompts } from "./prompts";
import { crmOpsReviewPlugin } from "./plugin";
import { opsConversationLabel } from "./records";

export const crmOpsReviewDriver: ChannelDriver = {
  connector_type: OPS_CONNECTOR_TYPE,
  source: CRM_SOURCE,

  install(input): NewConnectorInstallation {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: OPS_CONNECTOR_TYPE,
      status: "enabled",
      config: opsInstallConfig(input.config),
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    return (
      installation.status === "enabled" &&
      thread.source === CRM_SOURCE &&
      isOpsTaskTarget(thread.target)
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
      "Creating a CRM ops task is not available",
    );
  },

  async resolveStreams(installation, host, env) {
    return [await mountOpsStream(host, installation, env)];
  },

  async resolveThreadStream(installation, _thread, host, env) {
    return mountOpsStream(host, installation, env);
  },

  async bindEgress() {
    throw new ChannelDriverError(
      "unsupported_channel",
      "CRM ops complete must go through answerPrompt, not egress",
    );
  },

  outboundId(thread: ConversationThread) {
    return `${thread.target}:out:local`;
  },

  installCatalog() {
    return {
      title: "CRM ops review",
      description:
        "Private plugin. Pulls email-submit PENDING_REVIEW tasks; DSH decides, the connector completes.",
      credential_hint: "REGENIC_CRM_BASE_URL; REGENIC_CRM_TOKEN optional",
      singleton: true,
      fields: [
        {
          key: "max_open_tasks",
          label: "Max open tasks",
          required: false,
          default: "50",
          placeholder: "50",
        },
      ],
      prerequisites: crmCatalogPrerequisites(),
    };
  },

  writeBackLabels,

  presentInstall(installation) {
    return {
      label: "Email submit review",
      detail: configString(installation.config, "max_open_tasks") ?? "50",
    };
  },

  async probeCatalog({ env }) {
    const ready = Boolean(env[CRM_BASE_URL_ENV]?.trim());
    return {
      services: {
        "crm-connector": {
          ready: true,
          hint: "Private CRM connector is loaded.",
        },
        crm: {
          ready,
          hint: ready ? undefined : `Set ${CRM_BASE_URL_ENV}`,
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
      const client = crmClientFromEnv({ env });
      await Promise.all(
        wanted.map(async (thread) => {
          const taskId = thread.target.slice("ops_task:".length);
          try {
            const task = await client.getOpsTask(taskId);
            labels.set(`${CRM_SOURCE}:${thread.target}`, opsConversationLabel(task));
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
      return await listOpsPrompts(crmClientFromEnv({ env }), thread.target);
    } catch (error) {
      mapCrmError(error, "sync");
    }
  },

  async answerPrompt(installation, thread, answer, _host, env) {
    if (!this.capabilities(installation).prompts) {
      throw new ChannelDriverError(
        "unsupported_channel",
        "This CRM ops installation cannot answer a prompt",
      );
    }
    try {
      return await answerOpsPrompt(
        crmClientFromEnv({ env }),
        thread.target,
        answer,
      );
    } catch (error) {
      mapCrmError(error, "send");
    }
  },
};

export function opsInstallConfig(
  config: Record<string, unknown>,
): Record<string, JsonValue> {
  const max = configNumber(config, "max_open_tasks") ?? DEFAULT_MAX_OPEN_TASKS;
  if (!Number.isInteger(max) || max < 1) {
    throw new ChannelDriverError("invalid_config", "max_open_tasks must be a positive integer");
  }
  return { max_open_tasks: String(max) };
}

export async function mountOpsStream(
  host: Host,
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
  extras: { fetch?: CrmFetch; now?: () => string } = {},
) {
  const scope = crmScopeOf(crmHasToken(env));
  const streamKey = opsStreamKey(scope);
  if (!host.get("connectors").getStream(installation.id, streamKey)) {
    await host.plugin(crmOpsReviewPlugin, {
      installation_id: installation.id,
      org_id: installation.org_id,
      max_open_tasks: configNumber(installation.config, "max_open_tasks"),
      env,
      fetch: extras.fetch,
      now: extras.now,
    });
  }
  return requireConnectorStream(host.get("connectors"), installation.id, streamKey);
}

function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function configNumber(
  config: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = config[name];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}
