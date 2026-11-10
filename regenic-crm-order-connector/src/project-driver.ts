import {
  ChannelDriverError,
  type ChannelDriver,
  type ConnectorHost,
  type ConnectorInstallation,
  type JsonValue,
  type SyncSource,
} from "@regenic/domain";
import { freshDirectoryMemory, listDirectoryPage, pageSelectedHeads } from "./directory";
import {
  asSyncError,
  boundedInt,
  databaseFromUri,
  pollResult,
  readConnection,
  rememberDeliveryCursor,
  selectStoredCursor,
} from "./driver";
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_PROJECT_RECENT,
  DEFAULT_PROJECT_REFRESH_MS,
  PAGE_SIZE,
  PROJECT_CONNECTOR_TYPE,
  PROJECT_RECENT_MAX,
  PROJECT_SOURCE,
  projectStreamKey,
  projectSubjectCatalog,
  projectThreadId,
} from "./locators";
import type { ProjectHead } from "./model";
import { projectStore } from "./mongo-store";
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
          const limit = mode === "recent" ? projectRecentOf(installation.config) : null;
          const key = `${mode}:${limit ?? ""}`;
          return await listDirectoryPage<ProjectHead>({
            cursor,
            concurrency: concurrencyOf(installation),
            now: Date.now(),
            memory: projectDirectory,
            kind: "project",
            member: (id) => ({ stream_key: projectStreamKey(id), thread_id: projectThreadId(id) }),
            labelOf: (row) => row.name?.trim() || row.id,
            listOpenIds: async (afterId, pageLimit) => {
              if (!heads || headsKey !== key || !afterId) {
                headsKey = key;
                heads = await store.listProjects(limit);
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
          widget: "password" as const,
          label: "field.mongoUri",
          description: "field.mongoUri.description",
          group: "group.connection",
          required: true,
          secret: true,
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
        {
          key: "sync_concurrency",
          type: "number" as const,
          widget: "number" as const,
          label: "field.concurrency",
          description: "field.concurrency.description",
          group: "group.advanced",
          advanced: true,
          required: false,
          default: DEFAULT_CONCURRENCY,
          min: 1,
          max: 20,
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

  async probeCatalog() {
    return {
      services: {
        mongo: { ready: true, hint: "probe.loaded" },
      },
    };
  },
};

export function projectInstallConfig(config: Record<string, unknown>): Record<string, JsonValue> {
  const uri = stringOf(config.mongo_uri);
  if (uri && !/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new ChannelDriverError("invalid_config", "MongoDB 连接串不对");
  }
  const db = stringOf(config.mongo_db) || (uri ? databaseFromUri(uri) : "");
  const selection = projectSelectionOf(config);
  return {
    ...(uri ? { mongo_uri: uri } : {}),
    ...(db ? { mongo_db: db } : {}),
    refresh_interval_ms: boundedInt(config.refresh_interval_ms, DEFAULT_PROJECT_REFRESH_MS, 5_000, 3_600_000),
    sync_concurrency: boundedInt(config.sync_concurrency, DEFAULT_CONCURRENCY, 1, 20),
    selection,
    ...(selection === "recent" ? { recent_limit: projectRecentOf(config) } : {}),
  };
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

function concurrencyOf(installation: ConnectorInstallation): number {
  return boundedInt(installation.config.sync_concurrency, DEFAULT_CONCURRENCY, 1, 20);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
