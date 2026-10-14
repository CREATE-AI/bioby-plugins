/** 从已打开的 bioby-work 页面读取登录凭证（与 work `getAccessToken` 逻辑一致） */

export function isLikelyWorkUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    if (host.includes('instagram.com') || host.includes('tiktok.com')) return false;
    if (u.pathname.includes('/dashboard')) return true;
    if (host === 'localhost' && (u.port === '3001' || u.port === '3000')) return true;
    return false;
  } catch {
    return false;
  }
}

export function readTokenInPage(): string | null {
  const local = localStorage.getItem('accessToken')?.trim();
  if (local && local !== 'undefined' && local !== 'null') return local;

  const cookieToken = document.cookie
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith('auth-token=') || v.startsWith('token=') || v.startsWith('accessToken='))
    ?.split('=')[1];
  if (!cookieToken) return null;
  const decoded = decodeURIComponent(cookieToken).trim();
  return decoded && decoded !== 'undefined' && decoded !== 'null' ? decoded : null;
}

export async function readAccessTokenFromTab(tabId: number): Promise<string | null> {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func: readTokenInPage,
  });
  const token = result?.result;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export async function findWorkTab(preferredBaseUrl?: string): Promise<chrome.tabs.Tab | null> {
  const tabs = await chrome.tabs.query({});
  const candidates = tabs.filter((t) => t.id != null && t.url && isLikelyWorkUrl(t.url));

  const base = preferredBaseUrl?.trim().replace(/\/$/, '');
  if (base) {
    const preferred = candidates.find((t) => (t.url ?? '').startsWith(base));
    if (preferred) return preferred;
  }

  return candidates.find((t) => t.active) ?? candidates[0] ?? null;
}

export function defaultWorkOpenUrl(workBaseUrl?: string): string {
  const raw = workBaseUrl?.trim().replace(/\/$/, '');
  if (raw) return `${raw}/zh/dashboard`;
  return 'http://localhost:3001/zh/dashboard';
}
