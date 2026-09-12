/** 在 TikTok 页面上下文内检测当前登录账号（content script 与 executeScript 共用） */

export function detectTikTokLoggedInHandle(): string | null {
  const norm = (raw: string | null | undefined): string | null => {
    if (!raw) return null;
    const h = raw.replace(/^@/, '').trim().toLowerCase();
    if (!h || h === 'login' || h === 'signup') return null;
    return h;
  };

  const fromHref = (href: string | null | undefined): string | null => {
    if (!href) return null;
    const m = href.match(/@([^/?#]+)/);
    return m?.[1] ? norm(m[1]) : null;
  };

  // 1. 页面内嵌 JSON（登录用户，不是正在浏览的达人主页）
  try {
    const script = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
    if (script?.textContent?.trim()) {
      const data = JSON.parse(script.textContent) as Record<string, unknown>;
      const scope = (data.__DEFAULT_SCOPE__ ?? data.DEFAULT_SCOPE) as Record<string, unknown> | undefined;
      if (scope) {
        for (const [key, val] of Object.entries(scope)) {
          if (!key.includes('app-context')) continue;
          const user = (val as Record<string, unknown>)?.user as Record<string, unknown> | undefined;
          const id = user?.uniqueId ?? user?.unique_id;
          if (typeof id === 'string' && id.trim()) return norm(id);
        }
        const direct = scope['webapp.app-context'] as Record<string, unknown> | undefined;
        const user = direct?.user as Record<string, unknown> | undefined;
        const id = user?.uniqueId ?? user?.unique_id;
        if (typeof id === 'string' && id.trim()) return norm(id);
      }
    }
  } catch {
    /* ignore */
  }

  // 2. 左侧导航「我的」头像链接（最可靠）
  const navSelectors = [
    'a[data-e2e="nav-profile"]',
    'a[data-e2e="profile-icon"]',
    'a[href^="/@"][data-e2e*="profile"]',
  ];
  for (const sel of navSelectors) {
    const el = document.querySelector(sel) as HTMLAnchorElement | null;
    const h = fromHref(el?.href ?? el?.getAttribute('href'));
    if (h) return h;
  }

  // 3. 右上角头像（登录用户，与正在浏览的达人主页无关）
  for (const el of Array.from(document.querySelectorAll('a[href^="/@"]'))) {
    const link = el as HTMLAnchorElement;
    const rect = link.getBoundingClientRect();
    if (rect.width === 0) continue;
    if (rect.right > window.innerWidth - 220 && rect.top < 140) {
      const h = fromHref(link.href);
      if (h) return h;
    }
  }

  // 4. 左侧窄栏（x < 140px）里的 /@ 链接，取最下方一个
  let sidebarHandle: string | null = null;
  for (const el of Array.from(document.querySelectorAll('a[href^="/@"]'))) {
    const link = el as HTMLAnchorElement;
    const rect = link.getBoundingClientRect();
    if (rect.width === 0 || rect.left > 140) continue;
    const h = fromHref(link.href);
    if (h) sidebarHandle = h;
  }
  if (sidebarHandle) return sidebarHandle;

  // 5. aside / nav 内最后一个 /@
  for (const root of Array.from(document.querySelectorAll('nav, aside, [data-e2e="nav-bar"]'))) {
    const links = Array.from(root.querySelectorAll('a[href^="/@"]'));
    for (let i = links.length - 1; i >= 0; i -= 1) {
      const h = fromHref((links[i] as HTMLAnchorElement).href);
      if (h) return h;
    }
  }

  return null;
}
