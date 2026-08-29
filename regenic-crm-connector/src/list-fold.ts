import { foldThreadByPolicy, type ListSurfaceStore } from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";

export type HideThread = (threadId: string) => Promise<void>;

type ConversationPrefStore = Pick<
  ListSurfaceStore,
  "getConversationPref" | "putConversationPref"
>;

export class CrmListFoldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrmListFoldError";
  }
}

/**
 * Policy-fold a thread onto the Hidden list (`conversation_prefs.hidden`).
 * Tombstone is for retracting an event, not for leaving the shown list.
 * Missing authority is a setup failure: do not pretend the fold succeeded.
 */
export function hideThreadFromHost(
  host: Host,
  orgId: string,
  now: () => string,
): HideThread {
  return async (threadId) => {
    const store = conversationPrefStore(host);
    if (!store) {
      throw new CrmListFoldError(
        `cannot fold ${threadId}: host has no conversation pref store`,
      );
    }
    await foldThreadByPolicy(store, orgId, threadId, now());
  };
}

/**
 * Fold confirmed-gone ids. Only ids that actually folded may leave `seen`.
 * Setup errors fail the poll; a single transient write keeps that id for retry.
 */
export async function foldGoneIds(
  ids: string[],
  hide: HideThread | undefined,
  threadIdOf: (id: string) => string,
): Promise<string[]> {
  if (ids.length === 0) {
    return [];
  }
  if (!hide) {
    throw new CrmListFoldError(
      "hideThread is required to fold conversations that left the pending queue",
    );
  }
  const folded: string[] = [];
  for (const id of ids) {
    try {
      await hide(threadIdOf(id));
      folded.push(id);
    } catch (error) {
      if (error instanceof CrmListFoldError) {
        throw error;
      }
    }
  }
  return folded;
}

function conversationPrefStore(host: Host): ConversationPrefStore | undefined {
  try {
    const authority = host.get("authority") as Partial<ConversationPrefStore>;
    if (!authority.getConversationPref || !authority.putConversationPref) {
      return undefined;
    }
    return authority as ConversationPrefStore;
  } catch {
    return undefined;
  }
}
