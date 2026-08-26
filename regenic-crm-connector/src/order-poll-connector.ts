import type { ConnectorCursor, PollResult } from "@regenic/domain";
import {
  CrmApiError,
  DEFAULT_MAX_OPEN_ORDER_REVIEWS,
  type CrmClient,
  type CrmOrder,
  isPendingHumanOrder,
} from "./crm-client";
import { CRM_SOURCE, crmScopeOf } from "./locators";
import { orderRecord } from "./records";
import {
  formatSeenCursor,
  parseSeenCursor,
  reconcileRecords,
  revisionOf,
  toPollResult,
} from "./reconcile";

export interface CrmOrderPollConnectorOptions {
  connector_id: string;
  org_id: string;
  max_open_order_reviews?: number;
  now?: () => string;
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
    const live = listed.slice(0, this.maxOpen);
    const liveIds = new Set(live.map((order) => order.id));
    const disappeared = await this.confirmGone(
      Object.keys(seen).filter((id) => !liveIds.has(id)),
    );
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
      disappeared: disappeared.map((id) => ({
        id,
        tombstone: () =>
          orderRecord(tombstoneOrder(id, this.now()), "tombstone", seen[id]),
      })),
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

function tombstoneOrder(id: string, updatedAt: string): CrmOrder {
  return {
    id,
    internalReviewStatus: "CLOSED",
    updatedAt,
  };
}
