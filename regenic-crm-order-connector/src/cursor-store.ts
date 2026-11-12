import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseOrderCursor } from "./sync";

/**
 * 内核把 live / history 两份进度分开存。历史拉完后，复查仍可能交回较早的那份。
 * 进程内存重启就丢，所以较新的一份写在本机。
 */
const cursorAhead = new Map<string, { seq: number; raw: string }>();

let cursorDir = join(homedir(), ".regenic", "crm-delivery-cursors");

export function setDeliveryCursorDir(dir: string): void {
  cursorDir = dir;
}

export function resetDeliveryCursorMemory(): void {
  cursorAhead.clear();
}

export function deliveryCursorKey(installationId: string, orderId: string): string {
  return `${installationId}:${orderId}`;
}

/** 历史页只推进 history 游标，live 游标会停在更早的一页。取序号更大的那份。 */
export function selectStoredCursor(key: string, raw: string | undefined): string | undefined {
  const remembered = loadAhead(key);
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
  const remembered = loadAhead(key);
  if (remembered && seq < remembered.seq) {
    return;
  }
  if (remembered && remembered.seq === seq && remembered.raw === raw) {
    return;
  }
  const next = { seq, raw };
  cursorAhead.set(key, next);
  try {
    writeCursorFile(key, next);
  } catch {
    // 这次进程里仍用内存里的进度。
  }
}

/**
 * 历史进度比复查进度更远时，记下历史那份。
 * streamKey 形如 crm-delivery:订单id。
 */
export function rememberFurtherHistory(input: {
  installationId: string;
  streamKey: string;
  streamPrefix: string;
  liveCursor?: string | null;
  historyCursor?: string | null;
}): void {
  const history = input.historyCursor?.trim();
  if (!history || !input.streamKey.startsWith(input.streamPrefix)) {
    return;
  }
  const orderId = input.streamKey.slice(input.streamPrefix.length);
  if (!orderId || cursorSeq(history) <= cursorSeq(input.liveCursor ?? undefined)) {
    return;
  }
  rememberDeliveryCursor(deliveryCursorKey(input.installationId, orderId), history);
}

function loadAhead(key: string): { seq: number; raw: string } | undefined {
  const cached = cursorAhead.get(key);
  if (cached) {
    return cached;
  }
  const stored = readCursorFile(key);
  if (stored) {
    cursorAhead.set(key, stored);
  }
  return stored;
}

function cursorSeq(raw: string | undefined): number {
  const seq = parseOrderCursor(raw).seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : 0;
}

function cursorPath(key: string): string {
  const name = createHash("sha256").update(key).digest("hex");
  return join(cursorDir, `${name}.json`);
}

function readCursorFile(key: string): { seq: number; raw: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(cursorPath(key), "utf8")) as { seq?: unknown; raw?: unknown };
    if (typeof parsed.raw !== "string" || typeof parsed.seq !== "number" || !Number.isFinite(parsed.seq)) {
      return undefined;
    }
    return { seq: parsed.seq, raw: parsed.raw };
  } catch {
    return undefined;
  }
}

function writeCursorFile(key: string, value: { seq: number; raw: string }): void {
  mkdirSync(cursorDir, { recursive: true });
  const path = cursorPath(key);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}
