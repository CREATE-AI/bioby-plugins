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
  v: 1;
  scope: CrmScope;
  seen: Record<string, string>;
}

export interface LiveReconcileItem {
  id: string;
  revision: string;
  create(): IngestRecord;
  revise(): IngestRecord;
}

export function parseSeenCursor(
  cursor: ConnectorCursor | null,
  scope: CrmScope,
): Record<string, string> {
  if (!cursor?.value) {
    return {};
  }
  try {
    const parsed = JSON.parse(cursor.value) as Partial<SeenCursor>;
    if (parsed.v !== 1 || parsed.scope !== scope || !isObject(parsed.seen)) {
      return {};
    }
    const seen: Record<string, string> = {};
    for (const [id, revision] of Object.entries(parsed.seen)) {
      if (typeof revision === "string" && revision.trim() && id.trim()) {
        seen[id] = revision;
      }
    }
    return seen;
  } catch {
    return {};
  }
}

export function formatSeenCursor(
  scope: CrmScope,
  seen: Record<string, string>,
): string {
  const cursor: SeenCursor = { v: 1, scope, seen: sortKeys(seen) };
  return JSON.stringify(cursor);
}

export function selectOpenWindow<T extends { id: string }>(
  listed: T[],
  seen: Record<string, string>,
  maxOpen: number,
): { live: T[]; maybeGone: string[] } {
  const listedById = new Map<string, T>();
  for (const item of listed) {
    listedById.set(item.id, item);
  }
  const maybeGone: string[] = [];
  const stillOpen: T[] = [];
  for (const id of Object.keys(seen)) {
    const item = listedById.get(id);
    if (item) {
      stillOpen.push(item);
    } else {
      maybeGone.push(id);
    }
  }
  const room = Math.max(0, maxOpen - stillOpen.length);
  const newcomers: T[] = [];
  for (const item of listed) {
    if (seen[item.id] !== undefined) {
      continue;
    }
    if (newcomers.length >= room) {
      break;
    }
    newcomers.push(item);
  }
  return { live: [...stillOpen, ...newcomers], maybeGone };
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
