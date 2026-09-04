import type { CrmScope } from "./locators";

/** Tracks ids that finished locally and must leave max_open counting immediately. */
export class OpenWindowLedger {
  private readonly released = new Set<string>();

  release(id: string): void {
    const trimmed = id.trim();
    if (trimmed) {
      this.released.add(trimmed);
    }
  }

  peek(): ReadonlySet<string> {
    return this.released;
  }

  drain(): string[] {
    const ids = [...this.released];
    this.released.clear();
    return ids;
  }
}

const opsLedgers = new Map<string, OpenWindowLedger>();
const orderLedgers = new Map<string, OpenWindowLedger>();
const durablePending = new Map<string, Set<string>>();

export function openWindowStoreKey(
  installationId: string,
  scope: CrmScope,
  queue: "ops" | "order",
): string {
  return `${installationId}:${queue}:${scope}`;
}

export function bindOpsOpenWindowLedger(
  installationId: string,
  ledger: OpenWindowLedger,
): void {
  opsLedgers.set(installationId, ledger);
}

export function bindOrderOpenWindowLedger(
  installationId: string,
  ledger: OpenWindowLedger,
): void {
  orderLedgers.set(installationId, ledger);
}

/** Remember a release until the next poll persists it into the connector cursor. */
export function rememberOpenWindowRelease(storeKey: string, id: string): void {
  const trimmed = id.trim();
  if (!trimmed) {
    return;
  }
  let pending = durablePending.get(storeKey);
  if (!pending) {
    pending = new Set();
    durablePending.set(storeKey, pending);
  }
  pending.add(trimmed);
}

export function peekDurableOpenWindowReleases(storeKey: string): ReadonlySet<string> {
  return durablePending.get(storeKey) ?? new Set<string>();
}

export function takeDurableOpenWindowReleases(storeKey: string): string[] {
  const pending = durablePending.get(storeKey);
  durablePending.delete(storeKey);
  return pending ? [...pending] : [];
}

export function releaseOpsOpenWindow(
  installationId: string,
  scope: CrmScope,
  taskId: string,
): void {
  opsLedgers.get(installationId)?.release(taskId);
  rememberOpenWindowRelease(openWindowStoreKey(installationId, scope, "ops"), taskId);
}

export function releaseOrderOpenWindow(
  installationId: string,
  scope: CrmScope,
  orderId: string,
): void {
  orderLedgers.get(installationId)?.release(orderId);
  rememberOpenWindowRelease(openWindowStoreKey(installationId, scope, "order"), orderId);
}

export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim()))];
}

export function omitSeenIds(
  seen: Record<string, string>,
  drop: readonly string[],
): Record<string, string> {
  if (drop.length === 0) {
    return seen;
  }
  const remove = new Set(drop);
  const next: Record<string, string> = {};
  for (const [id, revision] of Object.entries(seen)) {
    if (!remove.has(id)) {
      next[id] = revision;
    }
  }
  return next;
}
