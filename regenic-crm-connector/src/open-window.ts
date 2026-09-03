/** Tracks ids that finished AI write-back and must leave max_open counting immediately. */
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

export function releaseOpsOpenWindow(installationId: string, taskId: string): void {
  opsLedgers.get(installationId)?.release(taskId);
}

export function releaseOrderOpenWindow(
  installationId: string,
  orderId: string,
): void {
  orderLedgers.get(installationId)?.release(orderId);
}

export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.filter((id) => id.trim()))];
}
