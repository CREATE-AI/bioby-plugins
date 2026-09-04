import type { ConnectorCursor } from "@regenic/domain";
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

export type SeenDisposition = "keep" | "drop";

export async function collectPendingReleases(input: {
  cursor: ConnectorCursor | null;
  scope: CrmScope;
  storeKey: string;
  ledger?: OpenWindowLedger;
}): Promise<string[]> {
  const state = parseSeenCursorState(input.cursor, input.scope);
  return uniqueIds([
    ...state.pendingRelease,
    ...takeDurableOpenWindowReleases(input.storeKey),
    ...(input.ledger?.drain() ?? []),
  ]);
}

export async function reconcileSeenIds(
  ids: readonly string[],
  inspect: (id: string) => Promise<SeenDisposition>,
): Promise<string[]> {
  const drop: string[] = [];
  await Promise.all(
    ids.map(async (id) => {
      if ((await inspect(id)) === "drop") {
        drop.push(id);
      }
    }),
  );
  return uniqueIds(drop);
}

export async function finalizeOpenWindowPoll<T extends { id: string }>(input: {
  cursor: ConnectorCursor | null;
  scope: CrmScope;
  storeKey: string;
  seen: Record<string, string>;
  ledger?: OpenWindowLedger;
  preDrop: string[];
  listed: T[];
  maxOpen: number;
  occupies: (item: T) => boolean;
  skipOccupying: ReadonlySet<string>;
  confirmMaybeGone: (ids: string[]) => Promise<string[]>;
  toLiveItems: (live: T[]) => LiveReconcileItem[];
  foldThreadId: (id: string) => string;
  hideThread?: HideThread;
  connectorId: string;
  orgId: string;
  receivedAt: string;
  selectOpenWindow: typeof import("./reconcile").selectOpenWindow;
  toPollResult: typeof import("./reconcile").toPollResult;
}) {
  const seenAfterPreDrop = omitSeenIds(input.seen, input.preDrop);
  const { live, maybeGone, releaseFromSeen } = input.selectOpenWindow(
    input.listed,
    seenAfterPreDrop,
    input.maxOpen,
    input.occupies,
    new Set([...input.skipOccupying, ...Array.from(input.ledger?.peek() ?? [])]),
  );
  const dropFromSeen = uniqueIds([...input.preDrop, ...releaseFromSeen]);
  const confirmedGone = await input.confirmMaybeGone(maybeGone);
  const disappeared = uniqueIds([...confirmedGone, ...dropFromSeen]);
  await foldGoneIds(disappeared, input.hideThread, input.foldThreadId);
  const reconciled = reconcileRecords({
    seen: input.seen,
    live: input.toLiveItems(live),
    disappeared: disappeared.map((id) => ({ id })),
  });
  const stillPending = uniqueIds([
    ...Array.from(peekDurableOpenWindowReleases(input.storeKey)),
    ...Array.from(input.ledger?.peek() ?? []),
  ]);
  const nextCursor = formatSeenCursor(input.scope, reconciled.nextSeen, stillPending);
  return input.toPollResult({
    connectorId: input.connectorId,
    orgId: input.orgId,
    receivedAt: input.receivedAt,
    cursor: input.cursor?.value,
    nextCursor,
    records: reconciled.records,
  });
}
