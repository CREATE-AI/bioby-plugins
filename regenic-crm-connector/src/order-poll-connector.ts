import type { ConnectorCursor, PollResult } from "@regenic/domain";
import {
  CRM_LIST_PAGE_SIZE,
  CrmApiError,
  type CrmClient,
  type CrmOrder,
  isPendingHumanOrder,
} from "./crm-client";
import { uniqueIds, type OpenWindowLedger, openWindowStoreKey } from "./open-window";
import { CRM_SOURCE, crmScopeOf, orderThreadId } from "./locators";
import { orderRecord } from "./records";
import { collectPendingReleases, finalizeOpenWindowPoll } from "./poll-reconcile";
import {
  parseSeenCursorState,
  revisionOf,
  selectListedLive,
  toPollResult,
} from "./reconcile";
import type { HideThread } from "./list-fold";

export interface CrmOrderPollConnectorOptions {
  connector_id: string;
  org_id: string;
  now?: () => string;
  hideThread?: HideThread;
  openWindowLedger?: OpenWindowLedger;
}

export class CrmOrderPollConnector {
  readonly source = CRM_SOURCE;
  private readonly now: () => string;

  constructor(
    private readonly client: CrmClient,
    private readonly options: CrmOrderPollConnectorOptions,
  ) {
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async poll(cursor: ConnectorCursor | null): Promise<PollResult> {
    const scope = crmScopeOf(this.client.hasToken);
    const storeKey = openWindowStoreKey(this.options.connector_id, scope, "order");
    const { seen, listPage } = parseSeenCursorState(cursor, scope);
    const pendingRelease = await collectPendingReleases({
      cursor,
      scope,
      storeKey,
      ledger: this.options.openWindowLedger,
    });
    const preDrop = uniqueIds(pendingRelease);
    let listed: CrmOrder[] = [];
    let listOk = false;
    try {
      listed = await this.client.listPendingHumanOrders({
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
      occupies: () => true,
      skipOccupying: new Set(preDrop),
      confirmMaybeGone: (ids) => this.confirmGone(ids),
      toLiveItems: (live) =>
        live.map((order) => {
          const revision = revisionOf(order);
          return {
            id: order.id,
            revision,
            create: () => orderRecord(order, "create", revision),
            revise: () => orderRecord(order, "revise", revision),
          };
        }),
      foldThreadId: orderThreadId,
      hideThread: this.options.hideThread,
      connectorId: this.options.connector_id,
      orgId: this.options.org_id,
      receivedAt: this.now(),
      selectListedLive,
      toPollResult,
    });
  }

  private async confirmGone(ids: string[]): Promise<string[]> {
    const gone: string[] = [];
    for (const id of ids) {
      try {
        const order = await this.client.getOrder(id);
        if (!isPendingHumanOrder(order)) {
          gone.push(id);
        }
      } catch (error) {
        if (error instanceof CrmApiError && (error.status === 404 || error.status === 409)) {
          gone.push(id);
          continue;
        }
        throw error;
      }
    }
    return gone;
  }
}
