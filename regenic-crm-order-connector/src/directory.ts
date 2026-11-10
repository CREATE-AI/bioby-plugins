import type { SyncDirectoryMember, SyncDirectoryPage } from "@regenic/domain";
import { RESTART_WAIT_MS, streamKey, threadId } from "./locators";
import type { OpenOrderHead } from "./model";

export interface DirectoryCursor {
  v: 1;
  afterId: string | null;
  seen: string[];
  emitted: string[];
  scanDone: boolean;
}

export interface DirectoryMemory {
  previousIds: string[] | null;
  endWritten: Set<string>;
  startedAt: number;
}

export function freshDirectoryMemory(now = Date.now()): DirectoryMemory {
  return { previousIds: null, endWritten: new Set(), startedAt: now };
}

let memory = freshDirectoryMemory();

export function directoryMemory(): DirectoryMemory {
  return memory;
}

export function resetDirectoryMemory(now = Date.now()): void {
  memory = freshDirectoryMemory(now);
}

export function markDeliveryEndWritten(orderId: string): void {
  memory.endWritten.add(orderId);
}

export function parseDirectoryCursor(raw: string | null): DirectoryCursor {
  if (!raw) {
    return { v: 1, afterId: null, seen: [], emitted: [], scanDone: false };
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DirectoryCursor>;
    if (parsed.v !== 1 || !Array.isArray(parsed.seen) || !Array.isArray(parsed.emitted)) {
      return { v: 1, afterId: null, seen: [], emitted: [], scanDone: false };
    }
    return {
      v: 1,
      afterId: typeof parsed.afterId === "string" ? parsed.afterId : null,
      seen: parsed.seen.filter((id) => typeof id === "string"),
      emitted: parsed.emitted.filter((id) => typeof id === "string"),
      scanDone: parsed.scanDone === true,
    };
  } catch {
    return { v: 1, afterId: null, seen: [], emitted: [], scanDone: false };
  }
}

export interface DirectoryHead {
  id: string;
}

export async function listDirectoryPage<T extends DirectoryHead = OpenOrderHead>(input: {
  cursor: string | null;
  concurrency: number;
  now: number;
  memory?: DirectoryMemory;
  restartWaitMs?: number;
  listOpenIds: (afterId: string | null, limit: number) => Promise<T[]>;
  /** 默认是订单会话。项目会话传自己的 stream_key、名字和 kind。 */
  member?: (id: string) => { stream_key: string; thread_id: string };
  labelOf?: (row: T) => string;
  kind?: string;
  /** 掉出名单的会话里，哪些要先写结束再放手。默认全部都要。 */
  needsEnd?: (missing: string[]) => Promise<string[]>;
}): Promise<SyncDirectoryPage> {
  const state = input.memory ?? memory;
  const waitMs = input.restartWaitMs ?? RESTART_WAIT_MS;
  const opening = input.cursor == null;
  const cursor = parseDirectoryCursor(input.cursor);
  const limit = Math.max(1, input.concurrency);
  const labels = new Map<string, string>();
  const labelOf = input.labelOf ?? ((row: T) => headLabel(row as unknown as OpenOrderHead));
  const member = input.member ?? ((id: string) => ({ stream_key: streamKey(id), thread_id: threadId(id) }));

  if (!cursor.scanDone) {
    const page = await input.listOpenIds(cursor.afterId, limit);
    for (const row of page) {
      if (!cursor.seen.includes(row.id)) {
        cursor.seen.push(row.id);
      }
      labels.set(row.id, labelOf(row));
    }
    const last = page[page.length - 1];
    cursor.afterId = last ? last.id : cursor.afterId;
    cursor.scanDone = page.length < limit;
  }

  const members: SyncDirectoryMember[] = [];
  for (const id of cursor.seen) {
    if (cursor.emitted.includes(id)) {
      continue;
    }
    if (members.length >= limit) {
      break;
    }
    cursor.emitted.push(id);
    members.push({
      ...member(id),
      label: labels.get(id) || id,
      kind: input.kind ?? "order",
    });
  }

  const pendingEmit = cursor.seen.some((id) => !cursor.emitted.includes(id));
  const missing =
    state.previousIds == null
      ? []
      : state.previousIds.filter((id) => !cursor.seen.includes(id));
  const restartReady = state.previousIds != null || input.now - state.startedAt >= waitMs;
  const ready = cursor.scanDone && !pendingEmit && restartReady &&
    await endsWritten(missing.filter((id) => !state.endWritten.has(id)), input.needsEnd);
  const complete = ready && !opening;
  if (complete) {
    state.previousIds = [...cursor.seen];
  }
  return {
    members,
    ...(complete ? {} : { next_cursor: JSON.stringify(cursor) }),
    complete,
  };
}

async function endsWritten(
  waiting: string[],
  needsEnd: ((missing: string[]) => Promise<string[]>) | undefined,
): Promise<boolean> {
  if (waiting.length === 0) {
    return true;
  }
  if (!needsEnd) {
    return false;
  }
  return (await needsEnd(waiting)).length === 0;
}

export function pageSelectedHeads<T extends DirectoryHead>(
  heads: T[],
  afterId: string | null,
  limit: number,
): T[] {
  if (limit <= 0) {
    return [];
  }
  const start = afterId ? heads.findIndex((row) => row.id === afterId) + 1 : 0;
  if (afterId && start <= 0) {
    return [];
  }
  return heads.slice(start, start + limit);
}

function headLabel(row: OpenOrderHead): string {
  const nick = row.nickname?.trim();
  const project = row.projectName?.trim();
  if (nick && project) {
    return `${nick} · ${project}`;
  }
  return nick || project || row.id;
}
