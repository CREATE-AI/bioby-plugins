import type { DetectedReply, ObservationWatch } from '../shared/types';
import { normalizeHandle } from '../shared/dom-utils';

/** TikTok 私信列表页扫描未读（需在 /messages 相关路由）。 */
export function scanTiktokObservationReplies(watches: ObservationWatch[]): DetectedReply[] {
  if (!watches.length) return [];

  const replies: DetectedReply[] = [];
  for (const watch of watches) {
    const handle = normalizeHandle(watch.influencerHandle);
    if (!handle) continue;

    const items = Array.from(
      document.querySelectorAll('[data-e2e="chat-list-item"], a[href*="/messages"], div[role="listitem"]'),
    );
    for (const item of items) {
      const text = (item.textContent ?? '').toLowerCase();
      if (!text.includes(handle) && !text.includes(`@${handle}`)) continue;

      const badge = item.querySelector('[class*="Badge"], [class*="badge"], [data-e2e*="unread"]');
      const aria = item.getAttribute('aria-label') ?? '';
      const unread = badge != null || /unread|未读/i.test(aria) || /unread|未读/i.test(text);
      if (!unread) continue;

      const link = item.closest('a[href*="message"]') as HTMLAnchorElement | null;
      const snippet = (item.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
      replies.push({
        taskId: watch.taskId,
        snippet: snippet || `Unread TikTok thread @${handle}`,
        threadUrl: link?.href ?? (window.location.href.includes('/messages') ? window.location.href : undefined),
      });
      break;
    }
  }
  return replies;
}
