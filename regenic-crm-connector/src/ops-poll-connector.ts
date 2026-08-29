import type { ConnectorCursor, PollResult } from "@regenic/domain";
import {
  CrmApiError,
  DEFAULT_MAX_OPEN_TASKS,
  type CrmClient,
  type CrmOpsTask,
  isEmailSubmitPending,
} from "./crm-client";
import type { HideThread } from "./list-fold";
import { CRM_SOURCE, crmScopeOf, opsTaskThreadId } from "./locators";
import { opsTaskRecord } from "./records";
import {
  CRM_STREAM_PACE,
  formatSeenCursor,
  parseSeenCursor,
  reconcileRecords,
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
    const seen = parseSeenCursor(cursor, scope);
    let listed: CrmOpsTask[];
    try {
      listed = await this.client.listPendingOpsTasks();
    } catch (error) {
      if (error instanceof CrmApiError && error.status === 401) {
        throw error;
      }
      throw error;
    }
    const { live, maybeGone } = selectOpenWindow(listed, seen, this.maxOpen);
    const disappeared = await this.confirmGone(maybeGone);
    await this.hideGone(disappeared);
    const reconciled = reconcileRecords({
      seen,
      live: live.map((task) => {
        const revision = revisionOf(task);
        return {
          id: task.id,
          revision,
          create: () => opsTaskRecord(task, "create", revision),
          revise: () => opsTaskRecord(task, "revise", revision),
        };
      }),
      disappeared: disappeared.map((id) => ({ id })),
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
        const task = await this.client.getOpsTask(id);
        if (!isEmailSubmitPending(task)) {
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

  private async hideGone(ids: string[]): Promise<void> {
    const hide = this.options.hideThread;
    if (!hide) {
      return;
    }
    for (const id of ids) {
      await hide(opsTaskThreadId(id));
    }
  }
}
