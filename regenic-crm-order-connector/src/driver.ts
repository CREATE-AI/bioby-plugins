import {
  ChannelDriverError,
  INGEST_SCHEMA_VERSION,
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
  listDirectoryPage,
  markDeliveryEndWritten,
  pageSelectedHeads,
} from "./directory";
import { deliveryLocaleTables } from "./locales";
import {
  CONNECTOR_TYPE,
  DEFAULT_CONCURRENCY,
  DEFAULT_RECENT,
  DEFAULT_REFRESH_MS,
  PAGE_SIZE,
  SOURCE,
  streamKey,
  subjectCatalog as deliverySubjectCatalog,
  threadId,
} from "./locators";
import { listChooserHeads, mongoStore } from "./mongo-store";
import type { OpenOrderHead } from "./model";
import { advanceDelivery, parseOrderCursor } from "./sync";

export const crmDeliverySyncDriver: ChannelDriver = {
  connector_type: CONNECTOR_TYPE,
  source: SOURCE,

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
          const key = mode === "pick"
            ? `pick:${orderIdsOf(installation.config).join(",")}`
            : mode === "recent"
              ? `recent:${recentOf(installation.config)}`
              : "all";
          return await listDirectoryPage({
            cursor,
            concurrency: concurrencyOf(installation),
            now: Date.now(),
            listOpenIds: async (afterId, limit) => {
              if (mode === "all") {
                return store.listOpenIds(afterId, limit);
              }
              if (!selected || selectedKey !== key || !afterId) {
                selectedKey = key;
                selected = mode === "pick"
                  ? await store.listHeadsByIds(orderIdsOf(installation.config))
                  : await store.listRecentHeads(recentOf(installation.config));
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
            const cursorKey = `${installation.id}:${orderId}`;
            const selected = selectStoredCursor(cursorKey, cursor?.value);
            const advanced = await advanceDelivery({
              orderId,
              order,
              project,
              store,
              cursor: parseOrderCursor(selected),
              pageSize: PAGE_SIZE,
              now,
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
      title: "catalog.title",
      channel_label: "catalog.channelLabel",
      description: "catalog.description",
      credential_hint: "catalog.credentialHint",
      singleton: true,
      fields: [
        {
          key: "mongo_uri",
          label: "field.mongoUri",
          required: true,
          secret: true,
          placeholder: "field.mongoUri.placeholder",
        },
        {
          key: "mongo_db",
          label: "field.mongoDb",
          required: false,
          placeholder: "field.mongoDb.placeholder",
        },
        {
          key: "refresh_interval_ms",
          label: "field.refresh",
          required: false,
          default: String(DEFAULT_REFRESH_MS),
        },
        {
          key: "sync_concurrency",
          label: "field.concurrency",
          required: false,
          default: String(DEFAULT_CONCURRENCY),
        },
        {
          key: "selection",
          label: "field.selection",
          required: true,
          default: "all",
          options: [
            { value: "pick", label: "option.selection.pick" },
            { value: "recent", label: "option.selection.recent" },
            { value: "all", label: "option.selection.all" },
          ],
        },
        {
          key: "order_ids",
          label: "field.orderIds",
          required: true,
          multiple: true,
          placeholder: "field.orderIds.placeholder",
          option_labels_key: "order_names",
          visible_when: { field: "selection", value: "pick" },
        },
        {
          key: "recent_limit",
          label: "field.recentLimit",
          required: false,
          default: String(DEFAULT_RECENT),
          placeholder: "field.recentLimit.placeholder",
          visible_when: { field: "selection", value: "recent" },
        },
      ],
      install_confirm: {
        when: { field: "selection", value: "all" },
        warning: "confirm.all.warning",
        ack: "confirm.all.ack",
      },
    };
  },

  async listCatalogFieldOptions({ installation, host }) {
    if (!installation || !host) {
      return { order_ids: [] };
    }
    try {
      const store = await openStore(installation, host);
      const heads = await listChooserHeads(store);
      return {
        order_ids: heads.map((row) => ({
          value: row.id,
          label: { literal: chooserLabel(row) },
          title: chooserTitle(row),
        })),
      };
    } catch {
      return { order_ids: [] };
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

export function installConfig(config: Record<string, unknown>): Record<string, JsonValue> {
  const uri = stringOf(config.mongo_uri);
  if (!uri || !/^mongodb(\+srv)?:\/\//.test(uri)) {
    throw new ChannelDriverError("invalid_config", "MongoDB 连接串不对");
  }
  const db = stringOf(config.mongo_db) || databaseFromUri(uri);
  const selection = selectionOf(config);
  const stored: Record<string, JsonValue> = {
    mongo_uri: uri,
    ...(db ? { mongo_db: db } : {}),
    refresh_interval_ms: boundedInt(config.refresh_interval_ms, DEFAULT_REFRESH_MS, 5_000, 3_600_000),
    sync_concurrency: boundedInt(config.sync_concurrency, DEFAULT_CONCURRENCY, 1, 20),
    selection,
  };
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

async function openStore(installation: ConnectorInstallation, host: ConnectorHost) {
  const uri = await readUri(installation, host);
  const db = stringOf(installation.config.mongo_db) || databaseFromUri(uri);
  if (!db) {
    throw new ChannelDriverError("invalid_config", "没有库名");
  }
  return mongoStore(uri, db);
}

async function readUri(
  installation: ConnectorInstallation,
  host: ConnectorHost,
): Promise<string> {
  const stored = await host.secrets.read(CONNECTOR_TYPE, installation.id, "mongo_uri");
  const uri = stored?.trim() || stringOf(installation.config.mongo_uri);
  if (!uri) {
    throw new ChannelDriverError("missing_credentials", "没有 MongoDB 连接串");
  }
  return uri;
}

function pollResult(input: {
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

const cursorAhead = new Map<string, { seq: number; raw: string }>();

export function resetDeliveryCursorMemory(): void {
  cursorAhead.clear();
}

/** 历史页只推进 history 游标，live 游标会停在更早的一页。取序号更大的那份。 */
export function selectStoredCursor(key: string, raw: string | undefined): string | undefined {
  const remembered = cursorAhead.get(key);
  if (!remembered) {
    return raw;
  }
  if (remembered.seq > cursorSeq(raw)) {
    return remembered.raw;
  }
  return raw;
}

export function rememberDeliveryCursor(key: string, raw: string): void {
  const seq = cursorSeq(raw);
  const remembered = cursorAhead.get(key);
  if (!remembered || seq >= remembered.seq) {
    cursorAhead.set(key, { seq, raw });
  }
}

function cursorSeq(raw: string | undefined): number {
  const seq = parseOrderCursor(raw).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : 0;
}

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

function asSyncError(error: unknown): ChannelDriverError {
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
  return boundedInt(installation.config.sync_concurrency, DEFAULT_CONCURRENCY, 1, 20);
}

export function selectionOf(config: Record<string, unknown>): "all" | "recent" | "pick" {
  const value = stringOf(config.selection);
  if (value === "recent" || value === "pick") {
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

function chooserLabel(row: OpenOrderHead): string {
  const nick = row.nickname?.trim();
  const project = row.projectName?.trim();
  const name = nick && project ? `${nick} · ${project}` : nick || project || row.id;
  const link = row.bloggerLink?.trim().replace(/^https?:\/\//, "");
  if (!link) {
    return name;
  }
  const shown = link.length > 48 ? `${link.slice(0, 45)}…` : link;
  return `${name} · ${shown}`;
}

function chooserTitle(row: OpenOrderHead): string {
  return [row.nickname, row.projectName, row.bloggerLink].filter((item) => item?.trim()).join(" ");
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function databaseFromUri(uri: string): string {
  const match = uri.match(/^mongodb(?:\+srv)?:\/\/[^/]+\/([^?]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : "";
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
