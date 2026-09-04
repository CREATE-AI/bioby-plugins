import type { ConnectorCursor, PollResult } from "@regenic/domain";
import {
  CrmApiError,
  DEFAULT_MAX_OPEN_TASKS,
  occupiesOpsWindow,
  type CrmClient,
  type CrmOpsTask,
  isEmailSubmitPending,
} from "./crm-client";
import { foldGoneIds, type HideThread } from "./list-fold";
import {
  OpenWindowLedger,
  openWindowStoreKey,
  uniqueIds,
} from "./open-window";
import { CRM_SOURCE, crmScopeOf, opsTaskThreadId } from "./locators";
import { opsTaskRecord } from "./records";
import {
  collectPendingReleases,
  finalizeOpenWindowPoll,
  reconcileSeenIds,
} from "./poll-reconcile";
import {
  CRM_STREAM_PACE,
  parseSeenCursorState,
  revisionOf,
  selectOpenWindow,
  toPollResult,
} from "./reconcile";

export { CRM_STREAM_PACE };

export interface CrmOpsPollConnectorOptions {
  connector_id: string;
  org_id: string;
  max_open_tasks?: number;
  now?: () => string;
  hideThread?: HideThread;
  openWindowLedger?: OpenWindowLedger;
  findLocallyFinishedIds?: (ids: readonly string[]) => Promise<string[]>;
}

export class CrmOpsPollConnector {
  readonly source = CRM_SOURCE;
  private readonly maxOpen: number;
  private readonly now: () => string;

  constructor(
    private readonly client: CrmClient,
    private readonly options: CrmOpsPollConnectorOptions,
  ) {
    this.maxOpen = options.max_open_tasks ?? DEFAULT_MAX_OPEN_TASKS;
    if (!Number.isInteger(this.maxOpen) || this.maxOpen < 1) {
      throw new Error("max_open_tasks must be a positive integer");
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async poll(cursor: ConnectorCursor | null): Promise<PollResult> {
    const scope = crmScopeOf(this.client.hasToken);
    const storeKey = openWindowStoreKey(this.options.connector_id, scope, "ops");
    const { seen } = parseSeenCursorState(cursor, scope);
    const pendingRelease = await collectPendingReleases({
      cursor,
      scope,
      storeKey,
      ledger: this.options.openWindowLedger,
    });
    const seenDrop = await reconcileSeenIds(Object.keys(seen), async (id) => {
      try {
        const task = await this.client.getOpsTask(id);
        if (!isEmailSubmitPending(task) || !occupiesOpsWindow(task)) {
          return "drop";
        }
        return "keep";
      } catch (error) {
        if (error instanceof CrmApiError && (error.status === 404 || error.status === 409)) {
          return "drop";
        }
        throw error;
      }
    });
    const localDrop =
      (await this.options.findLocallyFinishedIds?.(Object.keys(seen))) ?? [];
    const preDrop = uniqueIds([...pendingRelease, ...seenDrop, ...localDrop]);
    let listed: CrmOpsTask[] = [];
    try {
      listed = await this.client.listPendingOpsTasks({
        page: 0,
        size: Math.max(this.maxOpen * 2, 100),
      });
    } catch (error) {
      if (error instanceof CrmApiError && error.status === 401) {
        throw error;
      }
      // Keep reconciling seen slots when the fat list is slow or times out.
    }
    return finalizeOpenWindowPoll({
      cursor,
      scope,
      storeKey,
      seen,
      ledger: this.options.openWindowLedger,
      preDrop,
      listed,
      maxOpen: this.maxOpen,
      occupies: occupiesOpsWindow,
      skipOccupying: new Set(preDrop),
      confirmMaybeGone: (ids) => this.confirmGone(ids),
      toLiveItems: (live) =>
        live.map((task) => {
          const revision = revisionOf(task);
          return {
            id: task.id,
            revision,
            create: () => opsTaskRecord(task, "create", revision),
            revise: () => opsTaskRecord(task, "revise", revision),
          };
        }),
      foldThreadId: opsTaskThreadId,
      hideThread: this.options.hideThread,
      connectorId: this.options.connector_id,
      orgId: this.options.org_id,
      receivedAt: this.now(),
      selectOpenWindow,
      toPollResult,
    });
  }

  private async confirmGone(ids: string[]): Promise<string[]> {
    const fold: string[] = [];
    for (const id of ids) {
      try {
        const task = await this.client.getOpsTask(id);
        if (!isEmailSubmitPending(task) || !occupiesOpsWindow(task)) {
          fold.push(id);
        }
      } catch (error) {
        if (error instanceof CrmApiError && (error.status === 404 || error.status === 409)) {
          fold.push(id);
          continue;
        }
        throw error;
      }
    }
    return fold;
  }
}
