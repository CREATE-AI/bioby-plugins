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
  DEFAULT_MAX_OPEN_TASKS,
  mapCrmError,
  requireCrmBaseUrl,
  type CrmFetch,
} from "./crm-client";
import {
  CRM_SOURCE,
  crmScopeOf,
  crmSubjectCatalog,
  isOpsTaskTarget,
  OPS_CONNECTOR_TYPE,
  opsStreamKey,
  writeBackLabels,
} from "./locators";
import { crmLocaleTables } from "./locales";
import { answerOpsPrompt, listOpsPrompts } from "./prompts";
import { crmOpsReviewPlugin } from "./plugin";
import { opsConversationLabel } from "./records";
import { createCrmOpsSyncSource } from "./sync-source";

export const crmOpsReviewDriver: ChannelDriver = {
  connector_type: OPS_CONNECTOR_TYPE,
  source: CRM_SOURCE,
  connector_protocol: CONNECTOR_PROTOCOL,

  install(input): NewConnectorInstallation {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: OPS_CONNECTOR_TYPE,
      status: "enabled",
      config: opsInstallConfig(input.config),
      credentials_ref: envCredentialsRef(CRM_TOKEN_ENV),
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

  async resolveStreams(installation, host, env) {
    return [await mountOpsStream(host, installation, env)];
  },

  async bindSyncSource(installation, _host, env): Promise<SyncSource> {
    return createCrmOpsSyncSource(
      crmScopeOf(crmHasToken(env, installation.credentials_ref)),
    );
  },

  async resolveThreadStream(installation, _thread, host, env) {
    return mountOpsStream(host, installation, env);
  },

  locales() {
    return crmLocaleTables;
  },

  subjectCatalog() {
    return crmSubjectCatalog();
  },

  installCatalog() {
    return {
      title: "catalog.opsTitle",
      channel_label: "catalog.channelLabel",
      description: "catalog.opsDescription",
      credential_hint: "catalog.credentialHint",
      singleton: true,
      fields: crmCatalogFields([
        {
          key: "max_open_tasks",
          label: "field.maxOpenTasks",
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
      label: "present.ops",
      detail: { literal: crmInstallDetail(installation.config, "max_open_tasks", "50") },
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
      return await listOpsPrompts(
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
        "This CRM ops installation cannot answer a prompt",
      );
    }
    try {
      return await answerOpsPrompt(
        crmClientFromConfig({
          config: installation.config,
          env,
          credentials_ref: installation.credentials_ref,
        }),
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
  return {
    base_url: requireCrmBaseUrl(config),
    max_open_tasks: String(max),
  };
}

export async function mountOpsStream(
  host: ConnectorHost,
  installation: ConnectorInstallation,
  env: NodeJS.ProcessEnv,
  extras: { fetch?: CrmFetch; now?: () => string } = {},
) {
  const scope = crmScopeOf(crmHasToken(env, installation.credentials_ref));
  const streamKey = opsStreamKey(scope);
  if (!host.get("connectors").getStream(installation.id, streamKey)) {
    await host.plugin(crmOpsReviewPlugin, {
      installation_id: installation.id,
      org_id: installation.org_id,
      max_open_tasks: configNumber(installation.config, "max_open_tasks"),
      base_url: configString(installation.config, "base_url"),
      credentials_ref: installation.credentials_ref,
      env,
      fetch: extras.fetch,
      now: extras.now,
    });
  }
  return requireConnectorStream(host.get("connectors"), installation.id, streamKey);
}
