import { foldThreadByPolicy, type ListSurfaceStore } from "@regenic/domain";
import type { Host } from "@regenic/plugin-host";

export type HideThread = (threadId: string) => Promise<void>;

type ConversationPrefStore = Pick<
  ListSurfaceStore,
  "getConversationPref" | "putConversationPref"
>;

/**
 * Policy-fold a thread onto the Hidden list (`conversation_prefs.hidden`).
 * Tombstone is for retracting an event, not for leaving the shown list.
 */
export function hideThreadFromHost(
  host: Host,
  orgId: string,
  now: () => string,
): HideThread {
  return async (threadId) => {
    const store = conversationPrefStore(host);
    if (!store) {
      return;
    }
    await foldThreadByPolicy(store, orgId, threadId, now());
  };
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
