import {
  ChannelDriverError,
  type ChannelDriver,
  type ConnectorHost,
  type ConnectorInstallation,
  type JsonValue,
  type SyncSource,
} from "@regenic/domain";
import { brandIdsOf, pageChoices } from "./brands";
import { freshDirectoryMemory, listDirectoryPage, pageSelectedHeads } from "./directory";
import {
  asSyncError,
  boundedInt,
  databaseFromUri,
  pollResult,
  connectionFromFormValues,
  readConnection,
  readSavedMongo,
  rememberDeliveryCursor,
  selectStoredCursor,
} from "./driver";
import { bindPushWebhook, clearPushArmed, kickPush, markPushArmed, pushArmed, readPushProgress, startProjectPush, stopPush } from "./push";
import {
  DEFAULT_PROJECT_RECENT,
  DEFAULT_PROJECT_REFRESH_MS,
  ORDER_PAGE_SIZE,
  PAGE_SIZE,
  PROJECT_CONNECTOR_TYPE,
  PROJECT_DIRECTORY_PAGE,
  PROJECT_RECENT_MAX,
  PROJECT_SOURCE,
  projectStreamKey,
  projectSubjectCatalog,
  projectThreadId,
} from "./locators";
import type { ProjectHead } from "./model";
import { listBrandChoices, projectStore } from "./mongo-store";
import { projectLocaleTables } from "./project-locales";
import { advanceProject, parseProjectCursor } from "./project-sync";

const projectDirectory = freshDirectoryMemory();

export function resetProjectDirectoryMemory(now = Date.now()): void {
  const fresh = freshDirectoryMemory(now);
  projectDirectory.previousIds = fresh.previousIds;
  projectDirectory.endWritten = fresh.endWritten;
  projectDirectory.startedAt = fresh.startedAt;
}

export const crmProjectSyncDriver: ChannelDriver = {
  connector_type: PROJECT_CONNECTOR_TYPE,
  source: PROJECT_SOURCE,
  source_mode: "webhook",

  install(input) {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: PROJECT_CONNECTOR_TYPE,
      status: "enabled",
      config: projectInstallConfig(input.config),
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    return (
      installation.status === "enabled" &&
      thread.source === PROJECT_SOURCE &&
      thread.target.trim().length > 0
    );
  },

  ownsThread(installation, thread) {
    return this.matchesThread(installation, thread);
  },

  async startInstallation(installation, host) {
    markPushArmed(installation.id);
    startProjectPush({
      installation,
      intervalMs: refreshOf(installation),
      concurrency: 4,
      pageSize: ORDER_PAGE_SIZE,
      listHeads: async () => {
        const brands = brandIdsOf(installation.config);
        if (brands.length === 0) {
          return [];
        }
        const store = await openProjectStore(installation, host);
        const mode = projectSelectionOf(installation.config);
        const limit = mode === "recent" ? projectRecentOf(installation.config) : null;
        return store.listProjects(limit, brands);
      },
      readProject: async (projectId) => {
        const store = await openProjectStore(installation, host);
        return { project: await store.readProjectInfo(projectId), store };
      },
    });
  },

  async stopInstallation(installation, _host, context) {
    stopPush(installation.id);
    if (context?.reason === "delete") {
      clearPushArmed(installation.id);
    }
  },

  bindWebhook(installation) {
    kickPush(installation.id);
    return Promise.resolve(bindPushWebhook(installation, PROJECT_SOURCE));
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
    };
  },

  async resolveStreams() {
    return [];
  },

  async bindSyncSource(installation, host): Promise<SyncSource> {
    let heads: ProjectHead[] | null = null;
    let headsKey = "";
    return {
      async listDirectory(cursor) {
        try {
          const store = await openProjectStore(installation, host);
          const mode = projectSelectionOf(installation.config);
          const brands = brandIdsOf(installation.config);
          const limit = mode === "recent" ? projectRecentOf(installation.config) : null;
          const key = `${mode}:${limit ?? ""}:${brands.join(",")}`;
          return await listDirectoryPage<ProjectHead>({
            cursor,
            concurrency: PROJECT_DIRECTORY_PAGE,
            now: Date.now(),
            memory: projectDirectory,
            kind: "project",
            member: (id) => ({ stream_key: projectStreamKey(id), thread_id: projectThreadId(id) }),
            labelOf: (row) => row.name?.trim() || row.id,
            listOpenIds: async (afterId, pageLimit) => {
              if (!heads || headsKey !== key || !afterId) {
                headsKey = key;
                heads = await store.listProjects(limit, brands);
              }
              return pageSelectedHeads(heads, afterId, pageLimit);
            },
            needsEnd: (missing) => store.listGoneProjects(missing),
          });
        } catch (error) {
          throw asSyncError(error);
        }
      },
    };
  },

  async resolveThreadStream(installation, thread, host) {
    const projectId = thread.target.trim();
    return {
      stream_key: projectStreamKey(projectId),
      thread_id: projectThreadId(projectId),
      label: projectId,
      pace: { idle_ms: refreshOf(installation) },
      connector: {
        source: PROJECT_SOURCE,
        poll: async (cursor) => {
          try {
            const store = await openProjectStore(installation, host);
            const project = await store.readProjectInfo(projectId);
            const now = new Date().toISOString();
            const cursorKey = `${installation.id}:project:${projectId}`;
            const selected = selectStoredCursor(cursorKey, cursor?.value);
            const advanced = await advanceProject({
              projectId,
              project,
              store,
              cursor: parseProjectCursor(selected),
              pageSize: PAGE_SIZE,
              now,
            });
            if (advanced.wroteEnd) {
              projectDirectory.endWritten.add(projectId);
            }
            const nextCursor = JSON.stringify(advanced.cursor);
            rememberDeliveryCursor(cursorKey, nextCursor);
            return pollResult({
              installation,
              cursor: selected,
              nextCursor,
              records: advanced.records,
              hasMore: advanced.hasMore,
              now,
            });
          } catch (error) {
            throw asSyncError(error);
          }
        },
      },
    };
  },

  locales() {
    return projectLocaleTables;
  },

  subjectCatalog() {
    return projectSubjectCatalog();
  },

  installCatalog() {
    return {
      form_version: 2 as const,
      title: "catalog.title",
      channel_label: "catalog.channelLabel",
      description: "catalog.description",
      credential_hint: "catalog.credentialHint",
      singleton: true,
      fields: [
        {
          key: "mongo_uri",
          type: "string" as const,
          widget: "text" as const,
          label: "field.mongoUri",
          description: "field.mongoUri.description",
          group: "group.connection",
          required: false,
          placeholder: "field.mongoUri.placeholder",
        },
        {
          key: "mongo_db",
          type: "string" as const,
          widget: "text" as const,
          label: "field.mongoDb",
          description: "field.mongoDb.description",
          group: "group.connection",
          required: false,
          placeholder: "field.mongoDb.placeholder",
        },
        {
          key: "brand_ids",
          type: "string_array" as const,
          widget: "multi_select" as const,
          label: "field.brands",
          description: "field.brands.description",
          group: "group.scope",
          required: false,
          multiple: true,
          dynamic_options: true,
          options_depends_on: ["mongo_uri", "mongo_db"],
          option_labels_key: "brand_names",
          placeholder: "field.brands.placeholder",
        },
        {
          key: "selection",
          type: "string" as const,
          widget: "select" as const,
          label: "field.selection",
          description: "field.selection.description",
          group: "group.scope",
          required: true,
          default: "recent",
          options: [
            { value: "recent", label: "option.selection.recent" },
            { value: "all", label: "option.selection.all" },
          ],
        },
        {
          key: "recent_limit",
          type: "number" as const,
          widget: "number" as const,
          label: "field.recentLimit",
          description: "field.recentLimit.description",
          group: "group.scope",
          required: false,
          default: DEFAULT_PROJECT_RECENT,
          min: 1,
          max: PROJECT_RECENT_MAX,
          visible_when: { field: "selection", value: "recent" },
        },
        {
          key: "refresh_interval_ms",
          type: "number" as const,
          widget: "number" as const,
          label: "field.refresh",
          description: "field.refresh.description",
          group: "group.advanced",
          advanced: true,
          required: false,
          default: DEFAULT_PROJECT_REFRESH_MS,
          min: 5_000,
          max: 3_600_000,
        },
      ],
      install_confirm: {
        when: { field: "selection", value: "all" },
        warning: "confirm.all.warning",
        ack: "confirm.all.ack",
      },
    };
  },

  presentInstall(installation) {
    const db = stringOf(installation.config.mongo_db);
    return {
      label: "present.project",
      detail: db ? { literal: db } : null,
    };
  },

  async listCatalogFieldOptionsPage({ env, field, query, cursor, limit, values }) {
    if (field !== "brand_ids") {
      return { options: [] };
    }
    const saved = connectionFromFormValues(values) ?? await readSavedMongo(env, [PROJECT_CONNECTOR_TYPE, "crm-delivery-sync"]);
    if (!saved) {
      return { options: [] };
    }
    try {
      return pageChoices(await listBrandChoices(saved.uri, saved.db), query, cursor, limit);
    } catch {
      throw new ChannelDriverError("sync_failed", "读取品牌失败");
    }
  },

  async probeCatalog() {
    return {
      services: {
        mongo: { ready: true, hint: "probe.loaded" },
      },
    };
  },
};

Object.assign(crmProjectSyncDriver, {
  readPushProgress: (installationId: string) => readPushProgress(installationId, PROJECT_SOURCE),
  pushArmed,
});

export function projectInstallConfig(config: Record<string, unknown>): Record<string, JsonValue> {
  const uri = stringOf(config.mongo_uri);
  if (uri && !/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new ChannelDriverError("invalid_config", "MongoDB 连接串不对");
  }
  const db = stringOf(config.mongo_db) || (uri ? databaseFromUri(uri) : "");
  const selection = projectSelectionOf(config);
  const brandIds = brandIdsOf(config);
  const brandNames = stringList(config.brand_names);
  return {
    ...(uri ? { mongo_uri: uri } : {}),
    ...(db ? { mongo_db: db } : {}),
    refresh_interval_ms: boundedInt(config.refresh_interval_ms, DEFAULT_PROJECT_REFRESH_MS, 5_000, 3_600_000),
    selection,
    brand_ids: brandIds,
    ...(brandNames.length > 0 && brandNames.length === brandIds.length ? { brand_names: brandNames } : {}),
    ...(selection === "recent" ? { recent_limit: projectRecentOf(config) } : {}),
  };
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter((item) => item.length > 0);
  }
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter((item) => item.length > 0) : [];
}

export function projectSelectionOf(config: Record<string, unknown>): "all" | "recent" {
  return stringOf(config.selection) === "all" ? "all" : "recent";
}

function projectRecentOf(config: Record<string, unknown>): number {
  return boundedInt(config.recent_limit, DEFAULT_PROJECT_RECENT, 1, PROJECT_RECENT_MAX);
}

async function openProjectStore(installation: ConnectorInstallation, host: ConnectorHost) {
  const { uri, db } = await readConnection(PROJECT_CONNECTOR_TYPE, installation, host);
  return projectStore(uri, db);
}

function refreshOf(installation: ConnectorInstallation): number {
  return boundedInt(installation.config.refresh_interval_ms, DEFAULT_PROJECT_REFRESH_MS, 5_000, 3_600_000);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
