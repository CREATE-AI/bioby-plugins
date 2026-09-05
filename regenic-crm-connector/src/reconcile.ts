import { createHash } from "node:crypto";
import {
  INGEST_SCHEMA_VERSION,
  type ConnectorCursor,
  type IngestBatch,
  type IngestRecord,
  type PollResult,
} from "@regenic/domain";
import type { CrmScope } from "./locators";

export const CRM_STREAM_PACE = {
  idle_ms: 30_000,
  catch_up_pages: 1,
} as const;

export interface SeenCursor {
  v: 1 | 2 | 3;
  scope: CrmScope;
  seen: Record<string, string>;
  pendingRelease?: string[];
  listPage?: number;
}

export interface SeenCursorState {
  seen: Record<string, string>;
  pendingRelease: string[];
  listPage: number;
}

export interface LiveReconcileItem {
  id: string;
  revision: string;
  create(): IngestRecord;
  revise(): IngestRecord;
}

export function parseSeenCursorState(
  cursor: ConnectorCursor | null,
  scope: CrmScope,
): SeenCursorState {
  if (!cursor?.value) {
    return { seen: {}, pendingRelease: [], listPage: 0 };
  }
  try {
    const parsed = JSON.parse(cursor.value) as Partial<SeenCursor>;
    if (
      (parsed.v !== 1 && parsed.v !== 2 && parsed.v !== 3) ||
      parsed.scope !== scope ||
      !isObject(parsed.seen)
    ) {
      return { seen: {}, pendingRelease: [], listPage: 0 };
    }
    const seen: Record<string, string> = {};
    for (const [id, revision] of Object.entries(parsed.seen)) {
      if (typeof revision === "string" && revision.trim() && id.trim()) {
        seen[id] = revision;
      }
    }
    const pendingRelease = Array.isArray(parsed.pendingRelease)
      ? uniquePendingRelease(parsed.pendingRelease)
      : [];
    const listPage =
      typeof parsed.listPage === "number" && Number.isInteger(parsed.listPage) && parsed.listPage > 0
        ? parsed.listPage
        : 0;
    return { seen, pendingRelease, listPage };
  } catch {
    return { seen: {}, pendingRelease: [], listPage: 0 };
  }
}

export function parseSeenCursor(
  cursor: ConnectorCursor | null,
  scope: CrmScope,
): Record<string, string> {
  return parseSeenCursorState(cursor, scope).seen;
}

export function formatSeenCursor(
  scope: CrmScope,
  seen: Record<string, string>,
  pendingRelease: string[] = [],
  listPage = 0,
): string {
  const pending = uniquePendingRelease(pendingRelease);
  const page = listPage > 0 ? listPage : 0;
  const cursor: SeenCursor = {
    v: 3,
    scope,
    seen: sortKeys(seen),
    ...(pending.length > 0 ? { pendingRelease: pending } : {}),
    ...(page > 0 ? { listPage: page } : {}),
  };
  return JSON.stringify(cursor);
}

/** Ingest every occupying row on this page. seen is membership, not a run cap. */
export function selectListedLive<T extends { id: string }>(
  listed: T[],
  seen: Record<string, string>,
  occupies: (item: T) => boolean = () => true,
  skipOccupying: ReadonlySet<string> = new Set(),
): { live: T[]; maybeGone: string[]; releaseFromSeen: string[] } {
  const listedById = new Map<string, T>();
  for (const item of listed) {
    listedById.set(item.id, item);
  }
  const maybeGone: string[] = [];
  const releaseFromSeen: string[] = [];
  const live: T[] = [];
  const liveIds = new Set<string>();
  for (const item of listed) {
    if (skipOccupying.has(item.id) || !occupies(item)) {
      if (seen[item.id] !== undefined) {
        releaseFromSeen.push(item.id);
      }
      continue;
    }
    live.push(item);
    liveIds.add(item.id);
  }
  for (const id of Object.keys(seen)) {
    if (skipOccupying.has(id) || liveIds.has(id) || listedById.has(id)) {
      continue;
    }
    maybeGone.push(id);
  }
  return { live, maybeGone, releaseFromSeen };
}

export function reconcileRecords(input: {
  seen: Record<string, string>;
  live: LiveReconcileItem[];
  /** Confirmed off the pending queue. Fold via `hidden`, do not tombstone. */
  disappeared: Array<{ id: string }>;
}): { records: IngestRecord[]; nextSeen: Record<string, string> } {
  const records: IngestRecord[] = [];
  const gone = new Set(input.disappeared.map((item) => item.id));
  const nextSeen: Record<string, string> = {};

  for (const item of input.live) {
    const previous = input.seen[item.id];
    if (!previous) {
      records.push(item.create());
    } else if (previous !== item.revision) {
      records.push(item.revise());
    }
    nextSeen[item.id] = item.revision;
  }

  for (const [id, revision] of Object.entries(input.seen)) {
    if (!nextSeen[id] && !gone.has(id)) {
      nextSeen[id] = revision;
    }
  }

  return { records, nextSeen };
}

export function toPollResult(input: {
  connectorId: string;
  orgId: string;
  receivedAt: string;
  cursor: string | undefined;
  nextCursor: string;
  records: IngestRecord[];
}): PollResult {
  const batch: IngestBatch = {
    schema_version: INGEST_SCHEMA_VERSION,
    connector_id: input.connectorId,
    org_id: input.orgId,
    delivery_id: deliveryId(input.connectorId, input.cursor, input.nextCursor, input.records),
    received_at: input.receivedAt,
    next_cursor: input.nextCursor,
    records: input.records,
  };
  return { batch, next_cursor: input.nextCursor };
}

export function revisionOf(value: unknown): string {
  return createHash("sha256")
    .update(stableSerialize(value))
    .digest("hex")
    .slice(0, 32);
}

export function withOperation(
  record: IngestRecord,
  operation: IngestRecord["operation"],
  revisionId?: string,
): IngestRecord {
  return {
    ...record,
    operation,
    ...(revisionId ? { revision_id: revisionId } : {}),
  };
}

function deliveryId(
  connectorId: string,
  cursor: string | undefined,
  nextCursor: string,
  records: IngestRecord[],
): string {
  const identity = [
    connectorId,
    cursor ?? "initial",
    nextCursor,
    ...records.map((record) => `${record.operation}:${record.external_id}:${record.revision_id ?? ""}`),
  ].join("\u0000");
  const hash = createHash("sha256").update(identity).digest("hex");
  return `crm-poll:${connectorId}:${hash}`;
}

function sortKeys(seen: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(seen).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function uniquePendingRelease(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].sort();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
