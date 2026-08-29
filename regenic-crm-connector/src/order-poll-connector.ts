import type { ConnectorCursor, PollResult } from "@regenic/domain";
import {
  CrmApiError,
  DEFAULT_MAX_OPEN_ORDER_REVIEWS,
  type CrmClient,
  type CrmOrder,
  isPendingHumanOrder,
} from "./crm-client";
import { foldGoneIds, type HideThread } from "./list-fold";
import { CRM_SOURCE, crmScopeOf, orderThreadId } from "./locators";
import { orderRecord } from "./records";
import {
  formatSeenCursor,
  parseSeenCursor,
  reconcileRecords,
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
    const seen = parseSeenCursor(cursor, scope);
    const listed = await this.client.listPendingHumanOrders();
    const { live, maybeGone } = selectOpenWindow(listed, seen, this.maxOpen);
    const disappeared = await this.confirmGone(maybeGone);
    const folded = await foldGoneIds(disappeared, this.options.hideThread, orderThreadId);
    const reconciled = reconcileRecords({
      seen,
      live: live.map((order) => {
        const revision = revisionOf(order);
        return {
          id: order.id,
          revision,
          create: () => orderRecord(order, "create", revision),
          revise: () => orderRecord(order, "revise", revision),
        };
      }),
      disappeared: folded.map((id) => ({ id })),
    });
    const nextCursor = formatSeenCursor(scope, reconciled.nextSeen);
    return toPollResult({
      connectorId: this.options.connector_id,
      orgId: this.options.org_id,
      receivedAt: this.now(),
      cursor: cursor?.value,
      nextCursor,
      records: reconciled.records,
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
