export type DmPlatform = 'instagram' | 'tiktok';

export const PLATFORM_HOME: Record<DmPlatform, string> = {
  instagram: 'https://www.instagram.com/',
  tiktok: 'https://www.tiktok.com/',
};

/** 回复侦测时打开的收件箱地址 */
export const PLATFORM_INBOX_URL: Record<DmPlatform, string> = {
  instagram: 'https://www.instagram.com/direct/inbox/',
  tiktok: 'https://www.tiktok.com/messages',
};

export const PLATFORM_TAB_QUERY: Record<DmPlatform, string> = {
  instagram: 'https://www.instagram.com/*',
  tiktok: 'https://www.tiktok.com/*',
};

export const PLATFORM_TAB_QUERY_ALL: Record<DmPlatform, string[]> = {
  instagram: ['https://www.instagram.com/*'],
  tiktok: ['https://www.tiktok.com/*', 'https://tiktok.com/*'],
};

export function normalizeDmPlatform(raw: string | null | undefined): DmPlatform | null {
  const p = (raw ?? '').trim().toLowerCase();
  if (p === 'instagram' || p === 'ig') return 'instagram';
  if (p === 'tiktok' || p === 'tt') return 'tiktok';
  return null;
}

export function inferPlatformFromProfileUrl(profileUrl: string | null | undefined): DmPlatform | null {
  if (!profileUrl?.trim()) return null;
  try {
    const host = new URL(profileUrl.trim()).hostname.toLowerCase();
    if (host.includes('tiktok')) return 'tiktok';
    if (host.includes('instagram')) return 'instagram';
  } catch {
    /* ignore */
  }
  return null;
}

export function platformFromOutreachChannel(channel: string | null | undefined): DmPlatform | null {
  const c = (channel ?? '').trim().toUpperCase();
  if (c === 'TIKTOK_DM') return 'tiktok';
  if (c === 'IG_DM') return 'instagram';
  return null;
}

export function resolveTaskPlatform(
  task: { profileUrl?: string; platform?: string; outreachChannel?: string },
  settingsPlatform: DmPlatform,
): DmPlatform {
  return (
    normalizeDmPlatform(task.platform) ??
    platformFromOutreachChannel(task.outreachChannel) ??
    inferPlatformFromProfileUrl(task.profileUrl) ??
    settingsPlatform
  );
}
