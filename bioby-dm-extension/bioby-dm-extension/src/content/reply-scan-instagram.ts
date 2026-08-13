import type { DetectedReply, ObservationWatch } from '../shared/types';
import { normalizeHandle } from '../shared/dom-utils';

/** Instagram Direct 收件箱页内扫描未读线程（需在 /direct/inbox 或已打开私信列表）。 */
export function scanInstagramObservationReplies(watches: ObservationWatch[]): DetectedReply[] {
  if (!watches.length) return [];

  const replies: DetectedReply[] = [];
  for (const watch of watches) {
    const handle = normalizeHandle(watch.influencerHandle);
    if (!handle) continue;

    const rows = Array.from(document.querySelectorAll('div[role="listitem"], div[role="row"], a[href*="/direct/t/"]'));
    for (const row of rows) {
      const el = row instanceof HTMLAnchorElement ? row.closest('div[role="listitem"], div[role="row"]') ?? row : row;
      const text = (el.textContent ?? '').toLowerCase();
      if (!text.includes(handle)) continue;

      const unread =
        el.querySelector('[aria-label*="Unread"], [aria-label*="未读"]') != null ||
        /unread/i.test(el.getAttribute('aria-label') ?? '');
      if (!unread) continue;

      const link =
        el instanceof HTMLAnchorElement && el.href.includes('/direct/t/')
          ? el
          : (el.querySelector('a[href*="/direct/t/"]') as HTMLAnchorElement | null);
      const snippet = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 240);
      replies.push({
        taskId: watch.taskId,
        snippet: snippet || `Unread thread from @${handle}`,
        threadUrl: link?.href,
      });
      break;
    }
  }
  return replies;
}
