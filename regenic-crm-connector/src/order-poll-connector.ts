import type { ConnectorCursor, PollResult } from "@regenic/domain";
import {
  CrmApiError,
  DEFAULT_MAX_OPEN_ORDER_REVIEWS,
  type CrmClient,
  type CrmOrder,
  isPendingHumanOrder,
} from "./crm-client";
import { foldGoneIds, type HideThread } from "./list-fold";
import {
  OpenWindowLedger,
  openWindowStoreKey,
  uniqueIds,
} from "./open-window";
import { CRM_SOURCE, crmScopeOf, orderThreadId } from "./locators";
import { orderRecord } from "./records";
import {
  collectPendingReleases,
  finalizeOpenWindowPoll,
  reconcileSeenIds,
} from "./poll-reconcile";
import {
  parseSeenCursorState,
  revisionOf,
  selectOpenWindow,
  toPollResult,
} from "./reconcile";

export interface CrmOrderPollConnectorOptions {
  connector_id: string;
  org_id: string;
  max_open_order_reviews?: number;
  now?: () => string;
  hideThread?: HideThread;
  openWindowLedger?: OpenWindowLedger;
  findLocallyFinishedIds?: (ids: readonly string[]) => Promise<string[]>;
}

export class CrmOrderPollConnector {
  readonly source = CRM_SOURCE;
  private readonly maxOpen: number;
  private readonly now: () => string;

  constructor(
    private readonly client: CrmClient,
    private readonly options: CrmOrderPollConnectorOptions,
  ) {
    this.maxOpen = options.max_open_order_reviews ?? DEFAULT_MAX_OPEN_ORDER_REVIEWS;
    if (!Number.isInteger(this.maxOpen) || this.maxOpen < 1) {
      throw new Error("max_open_order_reviews must be a positive integer");
    }
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async poll(cursor: ConnectorCursor | null): Promise<PollResult> {
    const scope = crmScopeOf(this.client.hasToken);
    const storeKey = openWindowStoreKey(this.options.connector_id, scope, "order");
    const { seen } = parseSeenCursorState(cursor, scope);
    const pendingRelease = await collectPendingReleases({
      cursor,
      scope,
      storeKey,
      ledger: this.options.openWindowLedger,
    });
    const seenDrop = await reconcileSeenIds(Object.keys(seen), async (id) => {
      try {
        const order = await this.client.getOrder(id);
        if (!isPendingHumanOrder(order)) {
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
    let listed: CrmOrder[] = [];
    try {
      listed = await this.client.listPendingHumanOrders({
        page: 0,
        size: Math.max(this.maxOpen * 2, 100),
      });
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
      maxOpen: this.maxOpen,
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
      selectOpenWindow,
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
