import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ChannelDriverError,
  INGEST_SCHEMA_VERSION,
  type ConnectorInstallation,
  type IngestBatch,
  type IngestRecord,
  type VerifiedWebhook,
  type WebhookConnector,
  type WebhookRequest,
} from "@regenic/domain";
import { deliveryCursorKey, rememberDeliveryCursor, selectStoredCursor } from "./cursor-store";
import { PROJECT_SOURCE, SOURCE } from "./locators";
import type { DeliveryStore, OrderDoc, ProjectDoc, ProjectInfoDoc, ProjectStore } from "./model";
import { advanceProject, parseProjectCursor } from "./project-sync";
import { isEndedStatus } from "./status";
import { advanceDelivery, parseOrderCursor } from "./sync";

const runs = new Map<string, AbortController>();
const tokens = new Map<string, string>();
const wakes = new Map<string, () => void>();
const progressMemory = new Map<string, PushSnapshot>();
const threadCache = new Map<string, Set<string>>();

interface PushSnapshot {
  discoveredIds: string[];
  steadyIds: string[];
  running: boolean;
  messages: number;
  updatedAt: string;
}

export interface PushProgress {
  discovered: number;
  steady: number;
  running: boolean;
  messages: number;
  updated_at: string;
}

export function resetPushState(): void {
  for (const run of runs.values()) {
    run.abort();
  }
  runs.clear();
  tokens.clear();
  wakes.clear();
  progressMemory.clear();
  threadCache.clear();
}

export function isPushRunning(installationId: string): boolean {
  return runs.has(installationId);
}

export function stopPush(installationId: string): void {
  wakes.delete(installationId);
  runs.get(installationId)?.abort();
  runs.delete(installationId);
  notePushIdle(installationId);
}

export function markPushArmed(installationId: string): void {
  const path = armedPath(installationId);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "1");
}

/** True after Sync has been clicked once, until the connector is uninstalled. */
export function pushArmed(installationId: string): boolean {
  if (existsSync(armedPath(installationId))) {
    return true;
  }
  if (readPushProgress(installationId) != null) {
    return true;
  }
  return loadSeen(installationId).size > 0;
}

export function clearPushArmed(installationId: string): void {
  rmSync(armedPath(installationId), { force: true });
  rmSync(progressPath(installationId), { force: true });
  progressMemory.delete(installationId);
}

function armedPath(installationId: string): string {
  return join(homedir(), ".regenic", "crm-push", `${installationId}.armed`);
}

export function readPushProgress(installationId: string, source?: string): PushProgress | null {
  const snapshot = loadProgress(installationId);
  if (snapshot.updatedAt) {
    const discovered = new Set(snapshot.discoveredIds);
    const steady = source
      ? [...discovered].filter((id) => pushedIds(source).has(id)).length
      : snapshot.steadyIds.filter((id) => discovered.has(id)).length;
    return {
      discovered: discovered.size,
      steady,
      running: snapshot.running,
      messages: snapshot.messages,
      updated_at: snapshot.updatedAt,
    };
  }
  if (!source) {
    return null;
  }
  const seen = loadSeen(installationId);
  const pushed = pushedIds(source);
  const listed = seen.size > 0 ? [...seen] : [...pushed];
  if (listed.length === 0) {
    return null;
  }
  const steady = listed.filter((id) => pushed.has(id)).length;
  return {
    discovered: listed.length,
    steady,
    running: runs.has(installationId),
    messages: 0,
    updated_at: new Date().toISOString(),
  };
}

function notePushList(installationId: string, ids: string[], source: string): void {
  const discoveredIds = [...new Set(ids)];
  const alreadyPushed = pushedIds(source);
  saveProgress(installationId, {
    discoveredIds,
    steadyIds: discoveredIds.filter((id) => alreadyPushed.has(id)),
    running: true,
    messages: 0,
    updatedAt: new Date().toISOString(),
  });
}

function pushedIds(source: string): Set<string> {
  const path = process.env.REGENIC_DATABASE?.trim();
  if (!path) {
    return new Set();
  }
  const prefix = `${source}:`;
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 1_000, enableForeignKeyConstraints: false });
    const rows = database.prepare(
      "SELECT thread_id FROM thread_heads WHERE thread_id LIKE ?",
    ).all(`${prefix}%`) as Array<{ thread_id?: string }>;
    const ids = new Set(rows.flatMap((row) => {
      const id = row.thread_id?.startsWith(prefix) ? row.thread_id.slice(prefix.length) : "";
      return id ? [id] : [];
    }));
    threadCache.set(source, ids);
    return ids;
  } catch {
    return threadCache.get(source) ?? new Set();
  } finally {
    database?.close();
  }
}

function notePushMessages(installationId: string, count: number): void {
  if (count <= 0) {
    return;
  }
  const current = loadProgress(installationId);
  saveProgress(installationId, {
    ...current,
    messages: current.messages + count,
    updatedAt: new Date().toISOString(),
  });
}

function notePushIdle(installationId: string): void {
  if (runs.has(installationId)) {
    return;
  }
  const current = loadProgress(installationId);
  if (!current.updatedAt || !current.running) {
    return;
  }
  saveProgress(installationId, {
    ...current,
    running: false,
    updatedAt: new Date().toISOString(),
  });
}

function loadProgress(installationId: string): PushSnapshot {
  const cached = progressMemory.get(installationId);
  if (cached) {
    return cached;
  }
  try {
    const parsed = JSON.parse(readFileSync(progressPath(installationId), "utf8")) as Partial<PushSnapshot>;
    const snapshot: PushSnapshot = {
      discoveredIds: stringList(parsed.discoveredIds),
      steadyIds: stringList(parsed.steadyIds),
      running: parsed.running === true,
      messages: typeof parsed.messages === "number" && parsed.messages > 0 ? parsed.messages : 0,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
    progressMemory.set(installationId, snapshot);
    return snapshot;
  } catch {
    return { discoveredIds: [], steadyIds: [], running: false, messages: 0, updatedAt: "" };
  }
}

function saveProgress(installationId: string, snapshot: PushSnapshot): void {
  progressMemory.set(installationId, snapshot);
  const path = progressPath(installationId);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(snapshot));
  renameSync(tmp, path);
}

function progressPath(installationId: string): string {
  return join(homedir(), ".regenic", "crm-push", `${installationId}.progress.json`);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

/** If the loop is waiting for the next check, start that check now. */
export function kickPush(installationId: string): void {
  wakes.get(installationId)?.();
}

export function pushToken(installationId: string): string {
  let token = tokens.get(installationId);
  if (!token) {
    token = randomBytes(24).toString("hex");
    tokens.set(installationId, token);
  }
  return token;
}

export function pushRequestAccepted(
  installationId: string,
  headers: WebhookRequest["headers"],
): boolean {
  const expected = tokens.get(installationId);
  const provided = headerValue(headers, "x-crm-push-token");
  return Boolean(expected) && provided === expected;
}

export function bindPushWebhook(
  installation: ConnectorInstallation,
  source: string,
): WebhookConnector {
  pushToken(installation.id);
  return {
    source,
    source_mode: "webhook",
    async verifyWebhook(request) {
      if (!pushRequestAccepted(installation.id, request.headers)) {
        throw new ChannelDriverError("sync_failed", "推送校验失败");
      }
      return { body: request.body, verified_at: request.received_at };
    },
    async handleWebhook(webhook) {
      return batchFromBody(installation, webhook);
    },
  };
}

export function startDeliveryPush(input: {
  installation: ConnectorInstallation;
  intervalMs: number;
  concurrency: number;
  listHeads: () => Promise<Array<{ id: string; status?: string }>>;
  readOrder: (orderId: string) => Promise<{
    order: OrderDoc | null;
    project: ProjectDoc | null;
    store: DeliveryStore;
  }>;
  pageSize: number;
}): void {
  startLoop({
    installation: input.installation,
    intervalMs: input.intervalMs,
    concurrency: input.concurrency,
    source: SOURCE,
    list: input.listHeads,
    skip: (row) => skipEndedOrder(input.installation.id, row.id, row.status),
    pushOne: async (row, signal) => {
      await pushPages({
        installation: input.installation,
        signal,
        cursorKey: deliveryCursorKey(input.installation.id, row.id),
        parse: parseOrderCursor,
        advance: async (cursor) => {
          const loaded = await input.readOrder(row.id);
          return advanceDelivery({
            orderId: row.id,
            order: loaded.order,
            project: loaded.project,
            store: loaded.store,
            cursor,
            pageSize: input.pageSize,
            now: new Date().toISOString(),
          });
        },
      });
    },
  });
}

export function startProjectPush(input: {
  installation: ConnectorInstallation;
  intervalMs: number;
  concurrency: number;
  listHeads: () => Promise<Array<{ id: string }>>;
  readProject: (projectId: string) => Promise<{
    project: ProjectInfoDoc | null;
    store: ProjectStore;
  }>;
  pageSize: number;
}): void {
  startLoop({
    installation: input.installation,
    intervalMs: input.intervalMs,
    concurrency: input.concurrency,
    source: PROJECT_SOURCE,
    list: async () => (await input.listHeads()).map((row) => ({ id: row.id })),
    pushOne: async (row, signal) => {
      const key = `${input.installation.id}:project:${row.id}`;
      await pushPages({
        installation: input.installation,
        signal,
        cursorKey: key,
        parse: parseProjectCursor,
        advance: async (cursor) => {
          const loaded = await input.readProject(row.id);
          return advanceProject({
            projectId: row.id,
            project: loaded.project,
            store: loaded.store,
            cursor,
            pageSize: input.pageSize,
            now: new Date().toISOString(),
          });
        },
      });
    },
  });
}

/** 还没写过会话的放前面，已经写过的放后面。两拨共用一个并发上限，不一起跑。 */
export function splitPushLanes<T extends { id: string }>(
  rows: readonly T[],
  alreadyPushed: ReadonlySet<string>,
): { fresh: T[]; recheck: T[] } {
  const fresh: T[] = [];
  const recheck: T[] = [];
  for (const row of rows) {
    if (alreadyPushed.has(row.id)) {
      recheck.push(row);
    } else {
      fresh.push(row);
    }
  }
  return { fresh, recheck };
}

function startLoop(input: {
  installation: ConnectorInstallation;
  intervalMs: number;
  concurrency: number;
  source: string;
  list: () => Promise<Array<{ id: string; status?: string }>>;
  skip?: (row: { id: string; status?: string }) => boolean;
  pushOne: (row: { id: string; status?: string }, signal: AbortSignal) => Promise<void>;
}): void {
  if (runs.has(input.installation.id)) {
    return;
  }
  stopPush(input.installation.id);
  const abort = new AbortController();
  runs.set(input.installation.id, abort);
  const installationId = input.installation.id;
  void (async () => {
    await sleep(500, abort.signal, installationId);
    while (!abort.signal.aborted) {
      try {
        const heads = await input.list();
        notePushList(installationId, heads.map((row) => row.id), input.source);
        const current = new Set(heads.map((row) => row.id));
        const seen = loadSeen(installationId);
        const gone = [...seen].filter((id) => !current.has(id)).map((id) => ({ id }));
        const kept = new Set(current);
        const active = heads.filter((row) => !input.skip?.(row));
        const lanes = splitPushLanes(active, pushedIds(input.source));
        await runPushQueues({
          fresh: lanes.fresh,
          recheck: lanes.recheck,
          gone,
          concurrency: input.concurrency,
          signal: abort.signal,
          run: async (row) => {
            try {
              await input.pushOne(row, abort.signal);
            } catch (error) {
              if (!current.has(row.id)) {
                kept.add(row.id);
              }
              logPush(installationId, row.id, error);
            }
          },
        });
        saveSeen(installationId, [...kept]);
      } catch (error) {
        logPush(installationId, "", error);
      }
      notePushIdle(installationId);
      await sleep(input.intervalMs, abort.signal, installationId);
    }
  })();
}

async function pushPages<T>(input: {
  installation: ConnectorInstallation;
  signal: AbortSignal;
  cursorKey: string;
  parse: (raw: string | undefined) => T;
  advance: (cursor: T) => Promise<{ records: IngestRecord[]; cursor: T; hasMore: boolean }>;
}): Promise<void> {
  let raw = selectStoredCursor(input.cursorKey, undefined);
  while (!input.signal.aborted) {
    const advanced = await input.advance(input.parse(raw));
    if (advanced.records.length > 0) {
      const posted = await postBatch(input.installation, advanced.records, input.cursorKey, input.signal);
      if (!posted) {
        return;
      }
    }
    const next = JSON.stringify(advanced.cursor);
    rememberDeliveryCursor(input.cursorKey, next);
    raw = next;
    if (!advanced.hasMore) {
      return;
    }
  }
}

function skipEndedOrder(installationId: string, orderId: string, status: string | undefined): boolean {
  if (!isEndedStatus(status)) {
    return false;
  }
  const cursor = parseOrderCursor(selectStoredCursor(deliveryCursorKey(installationId, orderId), undefined));
  return cursor.ended === true && cursor.status === status;
}

async function postBatch(
  installation: ConnectorInstallation,
  records: IngestRecord[],
  cursorKey: string,
  signal: AbortSignal,
): Promise<boolean> {
  const port = process.env.PORT?.trim() || "4370";
  const batch = batchFor(installation, records, cursorKey);
  const response = await fetch(
    `http://127.0.0.1:${port}/v1/me/connectors/${encodeURIComponent(installation.id)}/webhook`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-crm-push-token": pushToken(installation.id),
      },
      body: JSON.stringify(batch),
      signal,
    },
  );
  if (!response.ok) {
    return false;
  }
  const body = await response.json() as {
    accepted_count?: number;
    duplicate_count?: number;
    quarantined_count?: number;
    last_run_status?: string;
  };
  const accepted = body.accepted_count ?? 0;
  const duplicate = body.duplicate_count ?? 0;
  const quarantined = body.quarantined_count ?? 0;
  const posted = pushBatchAdvances({
    status: body.last_run_status,
    accepted,
    duplicate,
    quarantined,
    sent: records.length,
  });
  if (posted) {
    notePushMessages(installation.id, accepted);
  }
  return posted;
}

/**
 * 这一页写完了就往下翻。有记录被隔离时也往下翻，否则同一页会一直重试。
 * 这次写入没完成，停在这一页，下一轮再试。
 */
export function pushBatchAdvances(input: {
  status: string | undefined;
  accepted: number;
  duplicate: number;
  quarantined: number;
  sent: number;
}): boolean {
  if (input.status !== "completed") {
    return false;
  }
  if (input.quarantined > 0) {
    return true;
  }
  return input.accepted + input.duplicate === input.sent;
}

function batchFor(
  installation: ConnectorInstallation,
  records: IngestRecord[],
  cursorKey: string,
): IngestBatch {
  const identity = [
    installation.id,
    cursorKey,
    ...records.map((record) => `${record.operation}:${record.external_id}:${record.revision_id ?? ""}`),
  ].join("\u0000");
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: installation.id,
    org_id: installation.org_id,
    delivery_id: `crm-push:${createHash("sha256").update(identity).digest("hex")}`,
    received_at: new Date().toISOString(),
    records,
  };
}

function batchFromBody(installation: ConnectorInstallation, webhook: VerifiedWebhook): IngestBatch {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(webhook.body));
  } catch {
    throw new ChannelDriverError("sync_failed", "推送内容不是 JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChannelDriverError("sync_failed", "推送内容不对");
  }
  const body = parsed as { delivery_id?: unknown; records?: unknown };
  if (typeof body.delivery_id !== "string" || !body.delivery_id || !Array.isArray(body.records)) {
    throw new ChannelDriverError("sync_failed", "推送内容不对");
  }
  return {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: installation.id,
    org_id: installation.org_id,
    delivery_id: body.delivery_id,
    received_at: webhook.verified_at,
    records: body.records as IngestRecord[],
  };
}

function headerValue(headers: WebhookRequest["headers"], name: string): string {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0]?.trim() ?? "";
  }
  return typeof value === "string" ? value.trim() : "";
}

/** 新订单、复查、已离开名单的订单共用一个并发上限，按这个顺序各跑完再跑下一拨。 */
export async function runPushQueues<T>(input: {
  fresh: readonly T[];
  recheck: readonly T[];
  gone: readonly T[];
  concurrency: number;
  signal: AbortSignal;
  run: (row: T) => Promise<void>;
}): Promise<void> {
  const width = Math.max(1, input.concurrency);
  await runPool(input.fresh, width, input.signal, input.run);
  await runPool(input.recheck, width, input.signal, input.run);
  await runPool(input.gone, width, input.signal, input.run);
}

async function runPool<T>(
  items: readonly T[],
  width: number,
  signal: AbortSignal,
  run: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0 || signal.aborted) {
    return;
  }
  let index = 0;
  const workers = Math.max(1, Math.min(width, items.length));
  await Promise.all(Array.from({ length: workers }, async () => {
    while (!signal.aborted) {
      const current = index;
      index += 1;
      if (current >= items.length) {
        return;
      }
      await run(items[current]!);
    }
  }));
}

function sleep(ms: number, signal: AbortSignal, installationId: string): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (wakes.get(installationId) === finish) {
        wakes.delete(installationId);
      }
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    signal.addEventListener("abort", finish);
    wakes.set(installationId, finish);
  });
}

function seenPath(installationId: string): string {
  return join(homedir(), ".regenic", "crm-push", `${installationId}.json`);
}

function loadSeen(installationId: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(seenPath(installationId), "utf8")) as unknown;
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function saveSeen(installationId: string, ids: string[]): void {
  const path = seenPath(installationId);
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(ids));
  renameSync(tmp, path);
}

function logPush(installationId: string, id: string, error: unknown): void {
  const message = error instanceof Error ? error.message : "推送失败";
  console.error(`[crm-push] ${installationId} ${id} ${message}`);
}
