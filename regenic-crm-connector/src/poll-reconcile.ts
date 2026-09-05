import type { ConnectorCursor, IngestRecord } from "@regenic/domain";
import {
  omitSeenIds,
  peekDurableOpenWindowReleases,
  takeDurableOpenWindowReleases,
  uniqueIds,
  type OpenWindowLedger,
} from "./open-window";
import {
  formatSeenCursor,
  parseSeenCursorState,
  type LiveReconcileItem,
  reconcileRecords,
} from "./reconcile";
import type { CrmScope } from "./locators";
import type { HideThread } from "./list-fold";
import { foldGoneIds } from "./list-fold";

export async function collectPendingReleases(input: {
  cursor: ConnectorCursor | null;
  scope: CrmScope;
  storeKey: string;
  ledger?: OpenWindowLedger;
}): Promise<string[]> {
  const state = parseSeenCursorState(input.cursor, input.scope);
  return uniqueIds([
    ...state.pendingRelease,
    ...Array.from(peekDurableOpenWindowReleases(input.storeKey)),
    ...Array.from(input.ledger?.peek() ?? []),
  ]);
}

export function nextListPage(page: number, listedLength: number, pageSize: number): number {
  return listedLength < pageSize ? 0 : page + 1;
}

function peekLiveReleases(storeKey: string, ledger?: OpenWindowLedger): string[] {
  return uniqueIds([
    ...Array.from(peekDurableOpenWindowReleases(storeKey)),
    ...Array.from(ledger?.peek() ?? []),
  ]);
}

export async function finalizeOpenWindowPoll<T extends { id: string }>(input: {
  cursor: ConnectorCursor | null;
  scope: CrmScope;
  storeKey: string;
  seen: Record<string, string>;
  ledger?: OpenWindowLedger;
  preDrop: string[];
  listed: T[];
  listOk: boolean;
  listPage: number;
  pageSize: number;
  occupies: (item: T) => boolean;
  skipOccupying: ReadonlySet<string>;
  confirmMaybeGone: (ids: string[]) => Promise<string[]>;
  toLiveItems: (live: T[]) => LiveReconcileItem[];
  foldThreadId: (id: string) => string;
  hideThread?: HideThread;
  connectorId: string;
  orgId: string;
  receivedAt: string;
  selectListedLive: typeof import("./reconcile").selectListedLive;
  toPollResult: typeof import("./reconcile").toPollResult;
}) {
  const drop = uniqueIds([...input.preDrop, ...peekLiveReleases(input.storeKey, input.ledger)]);
  const finish = async (nextSeen: Record<string, string>, records: IngestRecord[], page: number) => {
    const already = new Set(drop);
    const late = peekLiveReleases(input.storeKey, input.ledger).filter((id) => !already.has(id));
    const applied = uniqueIds([...drop, ...late]);
    const seenAfterLate = omitSeenIds(nextSeen, late);
    if (late.length > 0) {
      await foldGoneIds(late, input.hideThread, input.foldThreadId);
    }
    takeDurableOpenWindowReleases(input.storeKey);
    input.ledger?.drain();
    const stillPending = uniqueIds(
      applied.filter((id) => seenAfterLate[id] !== undefined),
    );
    const nextCursor = formatSeenCursor(input.scope, seenAfterLate, stillPending, page);
    return input.toPollResult({
      connectorId: input.connectorId,
      orgId: input.orgId,
      receivedAt: input.receivedAt,
      cursor: input.cursor?.value,
      nextCursor,
      records,
    });
  };

  if (!input.listOk) {
    const nextSeen = omitSeenIds(input.seen, drop);
    await foldGoneIds(drop, input.hideThread, input.foldThreadId);
    return finish(nextSeen, [], input.listPage);
  }

  const dropSet = new Set(drop);
  const listed = input.listed.filter((item) => !dropSet.has(item.id));
  const seenAfterPreDrop = omitSeenIds(input.seen, drop);
  const { live, maybeGone, releaseFromSeen } = input.selectListedLive(
    listed,
    seenAfterPreDrop,
    input.occupies,
    new Set([...input.skipOccupying, ...dropSet]),
  );
  const dropFromSeen = uniqueIds([...drop, ...releaseFromSeen]);
  const confirmedGone = await input.confirmMaybeGone(maybeGone);
  const disappeared = uniqueIds([...confirmedGone, ...dropFromSeen]);
  await foldGoneIds(disappeared, input.hideThread, input.foldThreadId);
  const reconciled = reconcileRecords({
    seen: input.seen,
    live: input.toLiveItems(live),
    disappeared: disappeared.map((id) => ({ id })),
  });
  return finish(
    reconciled.nextSeen,
    reconciled.records,
    nextListPage(input.listPage, input.listed.length, input.pageSize),
  );
}
