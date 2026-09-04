import type { Host } from "@regenic/plugin-host";
import { isActiveWorkStatus, type WorkItem } from "@regenic/domain";

/** Drop open-window slots when every work item on the thread is inactive. */
export function locallyFinishedIds(
  items: readonly WorkItem[],
  ids: readonly string[],
  threadIdOf: (id: string) => string,
): string[] {
  if (ids.length === 0) {
    return [];
  }
  const byThread = new Map<string, WorkItem[]>();
  for (const item of items) {
    const related = byThread.get(item.thread_id);
    if (related) {
      related.push(item);
    } else {
      byThread.set(item.thread_id, [item]);
    }
  }
  const finished: string[] = [];
  for (const id of ids) {
    const related = byThread.get(threadIdOf(id));
    if (related && related.length > 0 && related.every((item) => !isActiveWorkStatus(item.status))) {
      finished.push(id);
    }
  }
  return finished;
}

export function createLocallyFinishedLookup(
  host: Host,
  orgId: string,
  threadIdOf: (id: string) => string,
): (ids: readonly string[]) => Promise<string[]> {
  let cachedItems: Promise<WorkItem[]> | null = null;
  return async (ids) => {
    if (ids.length === 0) {
      return [];
    }
    if (!cachedItems) {
      cachedItems = host.get("authority").listWorkItems(orgId);
    }
    const items = await cachedItems;
    return locallyFinishedIds(items, ids, threadIdOf);
  };
}
