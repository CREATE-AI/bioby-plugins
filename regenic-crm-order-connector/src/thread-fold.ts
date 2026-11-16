import { randomUUID } from "node:crypto";
import { deliveryCursorKey, rememberDeliveryCursor, selectStoredCursor } from "./cursor-store";
import { threadId } from "./locators";
import { isEndedStatus } from "./status";
import { parseOrderCursor } from "./sync";

export interface ThreadVisibility {
  found: boolean;
  hidden: boolean;
  version: number;
}

export interface ThreadFoldClient {
  read(threadId: string): Promise<ThreadVisibility>;
  write(threadId: string, hidden: boolean, version: number): Promise<"ok" | "conflict" | "failed">;
}

let client: ThreadFoldClient | undefined;

export function setThreadFoldClient(next?: ThreadFoldClient): void {
  client = next;
}

function foldClient(): ThreadFoldClient {
  return client ?? httpThreadFoldClient;
}

/**
 * 已结束的交付订单移到不显示。只移一次，人再拖回显示就留在那里。
 * 交付状态重新打开时，再移回显示。
 */
export async function settleEndedThread(
  installationId: string,
  orderId: string,
  status: string | undefined,
): Promise<void> {
  try {
    const key = deliveryCursorKey(installationId, orderId);
    const cursor = parseOrderCursor(selectStoredCursor(key, undefined));
    const id = threadId(orderId);
    if (isEndedStatus(status) && cursor.ended === true && cursor.status === status) {
      if (cursor.folded) {
        return;
      }
      if (!(await hideThread(id))) {
        return;
      }
      cursor.folded = true;
      rememberDeliveryCursor(key, JSON.stringify(cursor));
      return;
    }
    if (!isEndedStatus(status) && cursor.folded) {
      if (!(await showThread(id))) {
        return;
      }
      cursor.folded = false;
      rememberDeliveryCursor(key, JSON.stringify(cursor));
    }
  } catch {
    // 这一轮没改成，下一轮再试。
  }
}

async function hideThread(id: string): Promise<boolean> {
  return setHidden(id, true);
}

async function showThread(id: string): Promise<boolean> {
  return setHidden(id, false);
}

async function setHidden(id: string, hidden: boolean): Promise<boolean> {
  const current = await foldClient().read(id);
  if (!current.found) {
    return false;
  }
  if (current.hidden === hidden) {
    return true;
  }
  let result = await foldClient().write(id, hidden, current.version);
  if (result === "conflict") {
    const again = await foldClient().read(id);
    if (!again.found) {
      return false;
    }
    if (again.hidden === hidden) {
      return true;
    }
    result = await foldClient().write(id, hidden, again.version);
  }
  return result === "ok";
}

const httpThreadFoldClient: ThreadFoldClient = {
  async read(id) {
    const response = await fetch(
      `${kernelBase()}/v1/me/inbox?thread_id=${encodeURIComponent(id)}&limit=1`,
      { signal: AbortSignal.timeout(8000) },
    );
    if (!response.ok) {
      await response.text().catch(() => "");
      return { found: false, hidden: false, version: 0 };
    }
    const body = await response.json() as unknown;
    const item = Array.isArray(body) ? body[0] : undefined;
    if (!item || typeof item !== "object") {
      return { found: false, hidden: false, version: 0 };
    }
    const row = item as { hidden?: unknown; visibility_version?: unknown };
    const version = row.visibility_version;
    return {
      found: true,
      hidden: row.hidden === true,
      version: typeof version === "number" && Number.isSafeInteger(version) && version >= 0
        ? version
        : 0,
    };
  },
  async write(id, hidden, version) {
    const response = await fetch(`${kernelBase()}/v1/me/conversations/prefs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        thread_id: id,
        hidden,
        expected_visibility_version: version,
        command_id: randomUUID(),
        issued_at: new Date().toISOString(),
      }),
      signal: AbortSignal.timeout(8000),
    });
    await response.text().catch(() => "");
    if (response.ok) {
      return "ok";
    }
    if (response.status === 409) {
      return "conflict";
    }
    return "failed";
  },
};

function kernelBase(): string {
  const port = process.env.PORT?.trim() || "4370";
  return `http://127.0.0.1:${port}`;
}
