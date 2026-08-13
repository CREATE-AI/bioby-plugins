/** 自包含脚本：供 chrome.scripting.executeScript({ files }) 注入，不可 import 其它模块 */

function detectTikTokLoggedInHandle(): string | null {
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
      }
    }
  } catch {
    /* ignore */
  }

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

  for (const el of Array.from(document.querySelectorAll('a[href^="/@"]'))) {
    const link = el as HTMLAnchorElement;
    const rect = link.getBoundingClientRect();
    if (rect.width === 0) continue;
    if (rect.right > window.innerWidth - 220 && rect.top < 140) {
      const h = fromHref(link.href);
      if (h) return h;
    }
  }

  let sidebarHandle: string | null = null;
  for (const el of Array.from(document.querySelectorAll('a[href^="/@"]'))) {
    const link = el as HTMLAnchorElement;
    const rect = link.getBoundingClientRect();
    if (rect.width === 0 || rect.left > 140) continue;
    const h = fromHref(link.href);
    if (h) sidebarHandle = h;
  }
  if (sidebarHandle) return sidebarHandle;

  for (const root of Array.from(document.querySelectorAll('nav, aside, [data-e2e="nav-bar"]'))) {
    const links = Array.from(root.querySelectorAll('a[href^="/@"]'));
    for (let i = links.length - 1; i >= 0; i -= 1) {
      const h = fromHref((links[i] as HTMLAnchorElement).href);
      if (h) return h;
    }
  }

  return null;
}

detectTikTokLoggedInHandle();
