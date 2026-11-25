import {
  ChannelDriverError,
  INGEST_SCHEMA_VERSION,
  readInstallSecret,
  type ChannelDriver,
  type ConnectorHost,
  type ConnectorInstallation,
  type IngestBatch,
  type JsonValue,
  type PollResult,
  type SyncSource,
} from "@regenic/domain";
import { createHash } from "node:crypto";
import {
  deliveryCursorKey,
  rememberDeliveryCursor,
  selectStoredCursor,
} from "./cursor-store";
import { refreshInstallationsFromKernel, rememberedInstallation } from "./installation-snapshot";
import {
  listDirectoryPage,
  markDeliveryEndWritten,
  pageSelectedHeads,
} from "./directory";
import { deliveryLocaleTables } from "./locales";
import {
  CONNECTOR_TYPE,
  DEFAULT_CONCURRENCY,
  MAX_CONCURRENCY,
  DEFAULT_RECENT,
  DEFAULT_REFRESH_MS,
  ORDER_PAGE_SIZE,
  SOURCE,
  streamKey,
  subjectCatalog as deliverySubjectCatalog,
  threadId,
} from "./locators";
import { brandIdsOf, pageChoices, projectIdsOf, uniqueStrings } from "./brands";
import { listBrandChoices, listBrandChoicesByIds, listChooserHeads, listOrderHeadsByIds, listProjectChoices, listProjectChoicesByIds, mongoStore } from "./mongo-store";
import { bindPushWebhook, clearPushArmed, forgetPushHost, kickPush, markPushArmed, pushArmed, readPushProgress, rememberPushHost, startDeliveryPush, stopPush } from "./push";
import type { DeliveryStore, OpenOrderHead } from "./model";
import { advanceDelivery, parseOrderCursor } from "./sync";

export const crmDeliverySyncDriver: ChannelDriver = {
  connector_type: CONNECTOR_TYPE,
  source: SOURCE,
  source_mode: "webhook",

  install(input) {
    return {
      id: input.id,
      org_id: input.org_id,
      connector_type: CONNECTOR_TYPE,
      status: "enabled",
      config: installConfig(input.config),
      created_at: input.now,
    };
  },

  matchesThread(installation, thread) {
    return (
      installation.status === "enabled" &&
      thread.source === SOURCE &&
      thread.target.trim().length > 0 &&
      !thread.target.startsWith("order:") &&
      !thread.target.startsWith("ops_task:")
    );
  },

  ownsThread(installation, thread) {
    return this.matchesThread(installation, thread);
  },

  async startInstallation(installation, host) {
    markPushArmed(installation.id);
    rememberPushHost(installation.id, host);
    startDeliveryPush(deliveryPushInput(installation, () => openStore(installation, host)));
  },

  async stopInstallation(installation, _host, context) {
    stopPush(installation.id);
    forgetPushHost(installation.id);
    if (context?.reason === "delete") {
      clearPushArmed(installation.id);
    }
  },

  bindWebhook(installation) {
    kickPush(installation.id);
    return Promise.resolve(bindPushWebhook(installation, SOURCE));
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
    let selected: OpenOrderHead[] | null = null;
    let selectedKey = "";
    return {
      async listDirectory(cursor) {
        try {
          const store = await openStore(installation, host);
          const mode = selectionOf(installation.config);
          const brands = brandIdsOf(installation.config);
          const projects = projectIdsOf(installation.config);
          const key = `${mode}:${brands.join(",")}:${projects.join(",")}:${mode === "pick"
            ? orderIdsOf(installation.config).join(",")
            : mode === "recent"
              ? String(recentOf(installation.config))
              : "all"}`;
          return await listDirectoryPage({
            cursor,
            concurrency: concurrencyOf(installation),
            now: Date.now(),
            listOpenIds: async (afterId, limit) => {
              if (mode === "all" || mode === "after_external") {
                return store.listOpenIds(
                  afterId,
                  limit,
                  brands,
                  mode === "after_external" ? "after_external" : "delivery",
                  projects,
                );
              }
              if (!selected || selectedKey !== key || !afterId) {
                selectedKey = key;
                selected = mode === "pick"
                  ? await store.listHeadsByIds(orderIdsOf(installation.config), brands, projects)
                  : await store.listRecentHeads(recentOf(installation.config), brands, projects);
              }
              return pageSelectedHeads(selected, afterId, limit);
            },
          });
        } catch (error) {
          throw asSyncError(error);
        }
      },
    };
  },

  async resolveThreadStream(installation, thread, host) {
    const orderId = thread.target.trim();
    const refresh = refreshOf(installation);
    return {
      stream_key: streamKey(orderId),
      thread_id: threadId(orderId),
      label: orderId,
      pace: { idle_ms: refresh },
      connector: {
        source: SOURCE,
        poll: async (cursor) => {
          try {
            const store = await openStore(installation, host);
            const order = await store.readOrder(orderId);
            const project = order?.projectId ? await store.readProject(order.projectId) : null;
            const now = new Date().toISOString();
            const cursorKey = deliveryCursorKey(installation.id, orderId);
            const selected = selectStoredCursor(cursorKey, cursor?.value);
            const advanced = await advanceDelivery({
              orderId,
              order,
              project,
              store,
              cursor: parseOrderCursor(selected),
              pageSize: ORDER_PAGE_SIZE,
              now,
              keepExternalSubmit: selectionOf(installation.config) === "after_external",
            });
            if (advanced.wroteEnd) {
              markDeliveryEndWritten(orderId);
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
    return deliveryLocaleTables;
  },

  subjectCatalog() {
    return deliverySubjectCatalog();
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
          key: "project_ids",
          type: "string_array" as const,
          widget: "multi_select" as const,
          label: "field.projects",
          description: "field.projects.description",
          group: "group.scope",
          required: false,
          multiple: true,
          dynamic_options: true,
          options_depends_on: ["mongo_uri", "mongo_db", "brand_ids"],
          option_labels_key: "project_names",
          placeholder: "field.projects.placeholder",
        },
        {
          key: "selection",
          type: "string" as const,
          widget: "select" as const,
          label: "field.selection",
          description: "field.selection.description",
          group: "group.scope",
          required: true,
          default: "all",
          options: [
            { value: "pick", label: "option.selection.pick" },
            { value: "recent", label: "option.selection.recent" },
            { value: "all", label: "option.selection.all" },
            { value: "after_external", label: "option.selection.afterExternal" },
          ],
        },
        {
          key: "order_ids",
          type: "string_array" as const,
          widget: "multi_select" as const,
          label: "field.orderIds",
          description: "field.orderIds.description",
          group: "group.scope",
          required: true,
          multiple: true,
          dynamic_options: true,
          options_depends_on: ["mongo_uri", "mongo_db", "brand_ids", "project_ids"],
          placeholder: "field.orderIds.placeholder",
          option_labels_key: "order_names",
          visible_when: { field: "selection", value: "pick" },
        },
        {
          key: "recent_limit",
          type: "number" as const,
          widget: "number" as const,
          label: "field.recentLimit",
          description: "field.recentLimit.description",
          group: "group.scope",
          required: false,
          default: DEFAULT_RECENT,
          min: 1,
          max: 200,
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
          default: DEFAULT_REFRESH_MS,
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
          max: MAX_CONCURRENCY,
        },
      ],
      install_confirm: {
        when: { field: "selection", value: "all" },
        warning: "confirm.all.warning",
        ack: "confirm.all.ack",
      },
    };
  },

  async listCatalogFieldOptions() {
    return { order_ids: [] };
  },

  async listCatalogFieldOptionsPage({ env, field, query, cursor, limit, values }) {
    const saved = connectionFromFormValues(values) ?? await readSavedMongo(env, [CONNECTOR_TYPE, "crm-project-sync"]);
    if (!saved) {
      return { options: [] };
    }
    try {
      if (field === "brand_ids") {
        const selected = await savedChoiceIds(env, values, "brand_ids", CONNECTOR_TYPE);
        const listed = await cachedBrandOptions(saved);
        return pageChoices(
          await withMissingBrands(saved, listed, selected),
          query, cursor, limit, selected,
        );
      }
      if (field === "project_ids") {
        const brands = brandIdsOf({ brand_ids: values?.brand_ids });
        const selected = await savedChoiceIds(env, values, "project_ids", CONNECTOR_TYPE);
        const listed = await cachedProjectOptions(saved, brands);
        return pageChoices(
          await withMissingProjects(saved, listed, selected),
          query, cursor, limit, selected,
        );
      }
      if (field === "order_ids") {
        const brands = brandIdsOf({ brand_ids: values?.brand_ids });
        const projects = projectIdsOf({ project_ids: values?.project_ids });
        const selected = await savedChoiceIds(env, values, "order_ids", CONNECTOR_TYPE);
        const listed = await cachedOrderOptions(saved, brands, projects);
        return pageChoices(
          await withMissingOrders(saved, listed, selected),
          query, cursor, limit, selected,
        );
      }
      return { options: [] };
    } catch {
      throw new ChannelDriverError("sync_failed", "读取选项失败");
    }
  },

  presentInstall(installation) {
    const db = stringOf(installation.config.mongo_db);
    return {
      label: "present.delivery",
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

Object.assign(crmDeliverySyncDriver, {
  readPushProgress: (installationId: string) => readPushProgress(installationId, SOURCE),
  pushArmed,
});

export function installConfig(config: Record<string, unknown>): Record<string, JsonValue> {
  const uri = stringOf(config.mongo_uri);
  if (uri && !/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new ChannelDriverError("invalid_config", "MongoDB 连接串不对");
  }
  const db = stringOf(config.mongo_db) || (uri ? databaseFromUri(uri) : "");
  const selection = selectionOf(config);
  const brandIds = brandIdsOf(config);
  const projectIds = projectIdsOf(config);
  const stored: Record<string, JsonValue> = {
    ...(uri ? { mongo_uri: uri } : {}),
    ...(db ? { mongo_db: db } : {}),
    refresh_interval_ms: boundedInt(config.refresh_interval_ms, DEFAULT_REFRESH_MS, 5_000, 3_600_000),
    sync_concurrency: boundedInt(config.sync_concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY),
    selection,
    brand_ids: brandIds,
    project_ids: projectIds,
  };
  const brandNames = csvList(config.brand_names);
  if (brandNames.length > 0 && brandNames.length === brandIds.length) {
    stored.brand_names = brandNames;
  }
  const projectNames = csvList(config.project_names);
  if (projectNames.length > 0 && projectNames.length === projectIds.length) {
    stored.project_names = projectNames;
  }
  if (selection === "recent") {
    stored.recent_limit = recentOf(config);
  }
  if (selection === "pick") {
    const orderIds = orderIdsOf(config);
    if (orderIds.length === 0) {
      throw new ChannelDriverError("invalid_config", "自选订单时至少选一张");
    }
    stored.order_ids = orderIds;
    const names = csvList(config.order_names);
    if (names.length === orderIds.length) {
      stored.order_names = names;
    }
  }
  return stored;
}

async function listScopedOrderHeads(
  store: DeliveryStore,
  config: Record<string, unknown>,
): Promise<OpenOrderHead[]> {
  const brands = brandIdsOf(config);
  if (brands.length === 0) {
    return [];
  }
  const projects = projectIdsOf(config);
  const mode = selectionOf(config);
  if (mode === "pick") {
    return store.listHeadsByIds(orderIdsOf(config), brands, projects);
  }
  if (mode === "recent") {
    return store.listRecentHeads(recentOf(config), brands, projects);
  }
  const scope = mode === "after_external" ? "after_external" : "delivery";
  const all: OpenOrderHead[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await store.listOpenIds(after, 500, brands, scope, projects);
    all.push(...page);
    if (page.length < 500) {
      return all;
    }
    after = page[page.length - 1]?.id ?? null;
    if (!after) {
      return all;
    }
  }
}

async function openStore(installation: ConnectorInstallation, host: ConnectorHost) {
  const { uri, db } = await readConnection(CONNECTOR_TYPE, installation, host);
  return mongoStore(uri, db);
}

export function resumeDeliveryPush(installation: ConnectorInstallation): void {
  startDeliveryPush(deliveryPushInput(installation, async () => {
    const { uri, db } = connectionFromConfig(installation.config);
    return mongoStore(uri, db);
  }));
}

function deliveryPushInput(
  installation: ConnectorInstallation,
  open: () => Promise<DeliveryStore>,
) {
  return {
    installation,
    intervalMs: refreshOf(installation),
    concurrency: concurrencyOf(installation),
    pageSize: ORDER_PAGE_SIZE,
    keepExternalSubmit: selectionOf(installation.config) === "after_external",
    listHeads: async () => {
      if (brandIdsOf(installation.config).length === 0) {
        return [];
      }
      return listScopedOrderHeads(await open(), installation.config);
    },
    readOrder: async (orderId: string) => {
      const store = await open();
      const order = await store.readOrder(orderId);
      const project = order?.projectId ? await store.readProject(order.projectId) : null;
      return { order, project, store };
    },
  };
}

export function connectionFromConfig(config: Record<string, unknown>): { uri: string; db: string } {
  const uri = stringOf(config.mongo_uri);
  const db = stringOf(config.mongo_db) || (uri ? databaseFromUri(uri) : "");
  if (!/^mongodb(\+srv)?:\/\//.test(uri) || !db) {
    throw new ChannelDriverError("missing_credentials", "没有 MongoDB 连接串");
  }
  return { uri, db };
}

export async function readConnection(
  connectorType: string,
  installation: ConnectorInstallation,
  host: ConnectorHost,
): Promise<{ uri: string; db: string }> {
  const uri = await readUri(connectorType, installation, host);
  const db = stringOf(installation.config.mongo_db) || databaseFromUri(uri);
  if (!db) {
    throw new ChannelDriverError("invalid_config", "没有库名");
  }
  return { uri, db };
}

/** 每读一次钥匙串都要起一个 security 进程。会话多了一起读会把文件句柄用光，所以留一分钟。 */
const URI_CACHE_MS = 60_000;
const uriCache = new Map<string, { at: number; uri: Promise<string | undefined> }>();

async function readUri(
  connectorType: string,
  installation: ConnectorInstallation,
  host: ConnectorHost,
): Promise<string> {
  const fromConfig = stringOf(installation.config.mongo_uri);
  if (fromConfig) {
    return fromConfig;
  }
  const key = `${connectorType}\u0000${installation.id}`;
  const now = Date.now();
  let cached = uriCache.get(key);
  if (!cached || now - cached.at >= URI_CACHE_MS) {
    cached = { at: now, uri: host.secrets.read(connectorType, installation.id, "mongo_uri") };
    uriCache.set(key, cached);
    cached.uri.catch(() => uriCache.delete(key));
  }
  const stored = await cached.uri;
  const uri = stringOf(installation.config.mongo_uri) || stored?.trim();
  if (!uri) {
    uriCache.delete(key);
    throw new ChannelDriverError("missing_credentials", "没有 MongoDB 连接串");
  }
  return uri;
}

export function pollResult(input: {
  installation: ConnectorInstallation;
  cursor: string | undefined;
  nextCursor: string;
  records: PollResult["batch"]["records"];
  hasMore: boolean;
  now: string;
}): PollResult {
  const batch: IngestBatch = {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: input.installation.id,
    org_id: input.installation.org_id,
    delivery_id: deliveryId(input.installation.id, input.cursor, input.nextCursor, input.records),
    received_at: input.now,
    next_cursor: input.nextCursor,
    records: input.records,
  };
  return {
    batch,
    next_cursor: input.nextCursor,
    has_more: input.hasMore,
    poll_hint: deliveryPollHint(input.hasMore),
  };
}

/**
 * 这一页已经写进会话，就告诉内核可以离开「还没开始」。
 * 后面还有历史时标 history_pending，拉完再关掉，卡片上的「已跟上」才会加一。
 */
export function deliveryPollHint(hasMore: boolean): { live_seeded: boolean; history_pending: boolean } {
  return {
    live_seeded: true,
    history_pending: hasMore,
  };
}

export {
  rememberDeliveryCursor,
  resetDeliveryCursorMemory,
  selectStoredCursor,
  setDeliveryCursorDir,
} from "./cursor-store";

function deliveryId(
  connectorId: string,
  cursor: string | undefined,
  nextCursor: string,
  records: PollResult["batch"]["records"],
): string {
  const identity = [
    connectorId,
    cursor ?? "initial",
    nextCursor,
    ...records.map((record) => `${record.operation}:${record.external_id}:${record.revision_id ?? ""}`),
  ].join("\u0000");
  return `crm-delivery:${createHash("sha256").update(identity).digest("hex")}`;
}

export function asSyncError(error: unknown): ChannelDriverError {
  if (error instanceof ChannelDriverError) {
    return error;
  }
  const message = error instanceof Error ? error.message : "读取 CRM 失败";
  return new ChannelDriverError("sync_failed", message);
}

function refreshOf(installation: ConnectorInstallation): number {
  return boundedInt(installation.config.refresh_interval_ms, DEFAULT_REFRESH_MS, 5_000, 3_600_000);
}

function concurrencyOf(installation: ConnectorInstallation): number {
  return boundedInt(installation.config.sync_concurrency, DEFAULT_CONCURRENCY, 1, MAX_CONCURRENCY);
}

export function selectionOf(config: Record<string, unknown>): "all" | "recent" | "pick" | "after_external" {
  const value = stringOf(config.selection);
  if (value === "recent" || value === "pick" || value === "after_external") {
    return value;
  }
  return "all";
}

function recentOf(config: Record<string, unknown>): number {
  return boundedInt(config.recent_limit, DEFAULT_RECENT, 1, 200);
}

function orderIdsOf(config: Record<string, unknown>): string[] {
  return csvList(config.order_ids);
}

function csvList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((item) => stringOf(item)).filter((item) => item.length > 0);
  }
  return stringOf(value).split(",").map((item) => item.trim()).filter((item) => item.length > 0);
}

const ORDER_OPTION_CACHE_MS = 15_000;
let brandOptionCache: {
  key: string;
  at: number;
  options: Array<{ value: string; label: { literal: string }; title?: string }>;
} | undefined;
let projectOptionCache: {
  key: string;
  at: number;
  options: Array<{ value: string; label: { literal: string }; title?: string }>;
} | undefined;
let orderOptionCache: {
  key: string;
  at: number;
  options: Array<{ value: string; label: { literal: string }; title: string }>;
} | undefined;

export async function readSavedMongo(
  env: NodeJS.ProcessEnv,
  connectorTypes: string[],
): Promise<{ uri: string; db: string } | undefined> {
  for (const connectorType of connectorTypes) {
    const saved = await readSavedInstallation(env, connectorType);
    if (saved) {
      return saved;
    }
  }
  return undefined;
}

async function readSavedInstallation(
  env: NodeJS.ProcessEnv,
  connectorType: string,
): Promise<{ uri: string; db: string } | undefined> {
  let saved = rememberedInstallation(connectorType);
  if (!saved) {
    await refreshInstallationsFromKernel(env);
    saved = rememberedInstallation(connectorType);
  }
  if (!saved) {
    return undefined;
  }
  try {
    const fromConfig = stringOf(saved.config.mongo_uri);
    const stored = fromConfig ? undefined : await readInstallSecret(connectorType, saved.id, "mongo_uri");
    const uri = fromConfig || stored?.trim() || "";
    const db = stringOf(saved.config.mongo_db) || databaseFromUri(uri);
    if (!uri || !db) {
      return undefined;
    }
    return { uri, db };
  } catch {
    return undefined;
  }
}

async function cachedBrandOptions(saved: { uri: string; db: string }): Promise<Array<{
  value: string;
  label: { literal: string };
  title?: string;
}>> {
  const key = createHash("sha256").update(`brand\u0000${saved.db}\u0000${saved.uri}`).digest("hex");
  const now = Date.now();
  if (brandOptionCache && brandOptionCache.key === key && now - brandOptionCache.at < ORDER_OPTION_CACHE_MS) {
    return brandOptionCache.options;
  }
  const options = await listBrandChoices(saved.uri, saved.db);
  brandOptionCache = { key, at: now, options };
  return options;
}

async function cachedProjectOptions(
  saved: { uri: string; db: string },
  brandIds: string[],
): Promise<Array<{ value: string; label: { literal: string }; title?: string }>> {
  const key = createHash("sha256").update(`project\u0000${saved.db}\u0000${saved.uri}\u0000${brandIds.join(",")}`).digest("hex");
  const now = Date.now();
  if (projectOptionCache && projectOptionCache.key === key && now - projectOptionCache.at < ORDER_OPTION_CACHE_MS) {
    return projectOptionCache.options;
  }
  const options = brandIds.length === 0 ? [] : await listProjectChoices(saved.uri, saved.db, brandIds);
  projectOptionCache = { key, at: now, options };
  return options;
}

async function cachedOrderOptions(
  saved: { uri: string; db: string },
  brandIds: string[],
  projectIds: string[],
): Promise<Array<{
  value: string;
  label: { literal: string };
  title: string;
}>> {
  const key = createHash("sha256")
    .update(`${saved.db}\u0000${saved.uri}\u0000${brandIds.join(",")}\u0000${projectIds.join(",")}`)
    .digest("hex");
  const now = Date.now();
  if (orderOptionCache && orderOptionCache.key === key && now - orderOptionCache.at < ORDER_OPTION_CACHE_MS) {
    return orderOptionCache.options;
  }
  const heads = brandIds.length === 0
    ? []
    : await listChooserHeads(mongoStore(saved.uri, saved.db), brandIds, projectIds);
  const options = heads.map((row) => ({
    value: row.id,
    label: { literal: chooserLabel(row) },
    title: chooserTitle(row),
  }));
  orderOptionCache = { key, at: now, options };
  return options;
}

export function chooserLabel(row: OpenOrderHead): string {
  const nick = row.nickname?.trim();
  const project = row.projectName?.trim();
  const name = nick && project ? `${nick} · ${project}` : nick || project || row.id;
  const owner = row.deliveryOwner?.trim();
  const parts = [name];
  if (owner) {
    parts.push(`交付：${owner}`);
  }
  const link = row.bloggerLink?.trim().replace(/^https?:\/\//, "");
  if (link) {
    parts.push(link.length > 48 ? `${link.slice(0, 45)}…` : link);
  }
  return parts.join(" · ");
}

function chooserTitle(row: OpenOrderHead): string {
  const owner = row.deliveryOwner?.trim();
  return [row.nickname, row.projectName, owner ? `交付：${owner}` : undefined, row.bloggerLink]
    .filter((item) => item?.trim())
    .join(" ");
}

/** 表单里已经记住的编号。这一页没带时，再用上次保存的安装配置。 */
export async function savedChoiceIds(
  env: NodeJS.ProcessEnv,
  values: Record<string, unknown> | undefined,
  key: string,
  connectorType: string,
): Promise<string[]> {
  if (values && Object.prototype.hasOwnProperty.call(values, key)) {
    return uniqueStrings(values[key]).slice(0, 200);
  }
  await refreshInstallationsFromKernel(env);
  return uniqueStrings(rememberedInstallation(connectorType)?.config[key]).slice(0, 200);
}

export async function withMissingProjects<T extends { value: string }>(
  saved: { uri: string; db: string },
  listed: T[],
  selected: readonly string[],
): Promise<T[]> {
  const have = new Set(listed.map((option) => option.value));
  const missing = selected.filter((id) => !have.has(id));
  if (missing.length === 0) {
    return listed;
  }
  const extras = await listProjectChoicesByIds(saved.uri, saved.db, missing);
  return [...extras, ...listed] as T[];
}

export async function withMissingBrands<T extends { value: string }>(
  saved: { uri: string; db: string },
  listed: T[],
  selected: readonly string[],
): Promise<T[]> {
  const have = new Set(listed.map((option) => option.value));
  const missing = selected.filter((id) => !have.has(id));
  if (missing.length === 0) {
    return listed;
  }
  const extras = await listBrandChoicesByIds(saved.uri, saved.db, missing);
  return [...extras, ...listed] as T[];
}

async function withMissingOrders(
  saved: { uri: string; db: string },
  listed: Array<{ value: string; label: { literal: string }; title: string }>,
  selected: readonly string[],
): Promise<Array<{ value: string; label: { literal: string }; title: string }>> {
  const have = new Set(listed.map((option) => option.value));
  const missing = selected.filter((id) => !have.has(id));
  if (missing.length === 0) {
    return listed;
  }
  const heads = await listOrderHeadsByIds(saved.uri, saved.db, missing);
  return [
    ...heads.map((row) => ({
      value: row.id,
      label: { literal: chooserLabel(row) },
      title: chooserTitle(row),
    })),
    ...listed,
  ];
}

export function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

/** 安装页上刚填的地址优先。输入框空着时，再用已经保存的连接。 */
export function connectionFromFormValues(
  values: Record<string, unknown> | undefined,
): { uri: string; db: string } | undefined {
  const uri = typeof values?.mongo_uri === "string" ? values.mongo_uri.trim() : "";
  if (!/^mongodb(\+srv)?:\/\//.test(uri)) {
    return undefined;
  }
  const named = typeof values?.mongo_db === "string" ? values.mongo_db.trim() : "";
  const db = named || databaseFromUri(uri);
  if (!db) {
    return undefined;
  }
  return { uri, db };
}

export function databaseFromUri(uri: string): string {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
