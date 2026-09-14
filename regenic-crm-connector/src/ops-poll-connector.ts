import type { ConnectorCursor, PollResult } from "@regenic/domain";
import {
  CRM_LIST_PAGE_SIZE,
  CrmApiError,
  occupiesOpsWindow,
  type CrmClient,
  type CrmOpsTask,
  isEmailSubmitPending,
} from "./crm-client";
import { uniqueIds, type OpenWindowLedger, openWindowStoreKey } from "./open-window";
import { CRM_SOURCE, crmScopeOf, opsTaskThreadId } from "./locators";
import { opsTaskRecord } from "./records";
import { collectPendingReleases, finalizeOpenWindowPoll } from "./poll-reconcile";
import {
  CRM_STREAM_PACE,
  parseSeenCursorState,
  revisionOf,
  selectListedLive,
  toPollResult,
} from "./reconcile";
import type { HideThread } from "./list-fold";

export { CRM_STREAM_PACE };

export interface CrmOpsPollConnectorOptions {
  connector_id: string;
  org_id: string;
  now?: () => string;
  hideThread?: HideThread;
  openWindowLedger?: OpenWindowLedger;
}

export class CrmOpsPollConnector {
  readonly source = CRM_SOURCE;
  private readonly now: () => string;

  constructor(
    private readonly client: CrmClient,
    private readonly options: CrmOpsPollConnectorOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async poll(cursor: ConnectorCursor | null): Promise<PollResult> {
    const scope = crmScopeOf(this.client.hasToken);
    const storeKey = openWindowStoreKey(this.options.connector_id, scope, "ops");
    const { seen, listPage } = parseSeenCursorState(cursor, scope);
    const pendingRelease = await collectPendingReleases({
      cursor,
      scope,
      storeKey,
      ledger: this.options.openWindowLedger,
    });
    const preDrop = uniqueIds(pendingRelease);
    let listed: CrmOpsTask[] = [];
    let listOk = false;
    try {
      listed = await this.client.listPendingOpsTasks({
        page: listPage,
        size: CRM_LIST_PAGE_SIZE,
      });
      listOk = true;
    } catch (error) {
      if (error instanceof CrmApiError && error.status === 401) {
        throw error;
      }
    }
    return finalizeOpenWindowPoll({
      cursor,
      scope,
      storeKey,
      seen,
      ledger: this.options.openWindowLedger,
      preDrop,
      listed,
      listOk,
      listPage,
      pageSize: CRM_LIST_PAGE_SIZE,
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
      selectListedLive,
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
