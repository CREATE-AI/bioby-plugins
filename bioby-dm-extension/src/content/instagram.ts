import type { ContentMessage, ContentResponse, SendDmResult } from '../shared/types';
import selectors from '../selectors/instagram.json';
import {
  clickElement,
  detectPageBlockers,
  insertTextIntoEditable,
  normalizeHandle,
  sleep,
  verifySendOutcome,
  waitFor,
} from '../shared/dom-utils';
import { scanInstagramObservationReplies } from './reply-scan-instagram';

const IG_HOST = 'www.instagram.com';
const IG_INBOX_URL = 'https://www.instagram.com/direct/inbox/';

function queryFirst(selectorsList: string[]): Element | null {
  for (const sel of selectorsList) {
    if (sel.includes(':has-text')) continue;
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch {
      /* invalid selector */
    }
  }
  return findMessageButtonByAria();
}

function findMessageButtonByAria(): HTMLElement | null {
  const fromJson = queryFirst(selectors.profileMessageButton as string[]);
  if (fromJson instanceof HTMLElement) return fromJson;

  const directLink = document.querySelector('a[href*="/direct/t/"], a[href*="/direct/inbox"]');
  if (directLink instanceof HTMLElement) return directLink;

  const labels = ['Message', '发消息', '消息', 'Direct', '私信'];
  for (const label of labels) {
    const svg = document.querySelector(`svg[aria-label="${label}"]`);
    if (svg) {
      const btn = svg.closest('div[role="button"], button, a');
      if (btn instanceof HTMLElement) return btn;
    }
  }

  const clickable = Array.from(document.querySelectorAll('div[role="button"], button, a[role="button"]'));
  for (const btn of clickable) {
    const text = (btn.textContent ?? '').trim();
    const aria = btn.getAttribute('aria-label') ?? '';
    if (
      text === 'Message' ||
      text === '发消息' ||
      text === '消息' ||
      /message|发消息|私信/i.test(aria)
    ) {
      return btn as HTMLElement;
    }
  }
  return null;
}

function findComposer(): HTMLElement | null {
  const fromJson = queryFirst(selectors.composerTextarea as string[]);
  if (fromJson instanceof HTMLElement) return fromJson;
  const editable = document.querySelector('div[contenteditable="true"][role="textbox"]');
  return editable instanceof HTMLElement ? editable : null;
}

function findSendButton(): HTMLElement | null {
  const labels = ['Send', '发送'];
  for (const label of labels) {
    const buttons = Array.from(document.querySelectorAll('div[role="button"]'));
    for (const btn of buttons) {
      if ((btn.textContent?.trim() ?? '') === label) return btn as HTMLElement;
    }
  }
  return null;
}

export function detectLoggedInHandle(): string | null {
  const path = window.location.pathname;
  const ownProfile = path.match(/^\/([^/]+)\/?$/);
  if (ownProfile && ownProfile[1] && !['explore', 'direct', 'accounts', 'reels'].includes(ownProfile[1])) {
    return normalizeHandle(ownProfile[1]);
  }

  const navLinks = Array.from(document.querySelectorAll('a[href^="/"]'));
  for (const a of navLinks) {
    const href = a.getAttribute('href') ?? '';
    const m = href.match(/^\/([A-Za-z0-9._]+)\/$/);
    if (!m) continue;
    const candidate = m[1];
    if (['explore', 'direct', 'accounts', 'reels', 'p', 'stories'].includes(candidate)) continue;
    const img = a.querySelector('img[alt]');
    if (img) return normalizeHandle(candidate);
  }

  const meta = document.querySelector('meta[property="og:url"]')?.getAttribute('content') ?? '';
  const metaMatch = meta.match(/instagram\.com\/([^/?#]+)/);
  if (metaMatch) return normalizeHandle(metaMatch[1]);

  return null;
}

function profileUsernameFromUrl(profileUrl: string): string | null {
  try {
    const u = new URL(profileUrl);
    if (!u.hostname.includes(IG_HOST)) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    return parts[0] ? normalizeHandle(parts[0]) : null;
  } catch {
    return null;
  }
}

async function waitForComposer(timeoutMs: number): Promise<HTMLElement | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const c = findComposer();
    if (c) return c;
    await sleep(400);
  }
  return null;
}

async function sendDmOnCurrentPage(body: string, expectedHandle?: string): Promise<SendDmResult> {
  const blocked = detectPageBlockers(window.location.href, document.body.innerText);
  if (blocked) return blocked;

  const currentPathUser = profileUsernameFromUrl(window.location.href);
  if (expectedHandle && currentPathUser && currentPathUser !== normalizeHandle(expectedHandle)) {
    return {
      ok: false,
      code: 'ACCOUNT_MISMATCH',
      message: `Profile mismatch: on ${currentPathUser}, expected ${expectedHandle}`,
      retryable: true,
    };
  }

  const msgBtn = await waitFor(findMessageButtonByAria, 20000, 500);
  if (!msgBtn) {
    return { ok: false, code: 'NO_DM_ACCESS', message: 'Message button not found on profile', retryable: false };
  }
  clickElement(msgBtn);
  await sleep(1500);

  const composer = await waitForComposer(15000);
  if (!composer) {
    return { ok: false, code: 'SELECTOR_BROKEN', message: 'DM composer not found', retryable: false };
  }

  await insertTextIntoEditable(composer, body);
  await sleep(500);

  const sendBtn = findSendButton();
  if (!sendBtn) {
    return { ok: false, code: 'SELECTOR_BROKEN', message: 'Send button not found', retryable: false };
  }
  clickElement(sendBtn);

  const verified = await verifySendOutcome(body, { getComposer: findComposer });
  if (!verified.ok) return verified;

  const threadUrl =
    verified.threadUrl ??
    (window.location.href.includes('/direct/') ? window.location.href : undefined);
  return { ok: true, threadUrl };
}

async function navigateAndSend(profileUrl: string, body: string, expectedHandle?: string): Promise<SendDmResult> {
  if (!profileUrl) {
    return { ok: false, code: 'UNKNOWN', message: 'Missing profileUrl', retryable: false };
  }

  const targetUser = profileUsernameFromUrl(profileUrl);
  const onProfile =
    targetUser && window.location.pathname.toLowerCase().startsWith(`/${targetUser.toLowerCase()}`);

  if (!onProfile) {
    window.location.href = profileUrl;
    await sleep(3500);
  }

  return sendDmOnCurrentPage(body, expectedHandle ?? targetUser ?? undefined);
}

async function ensureInboxForScan(): Promise<void> {
  if (!window.location.pathname.includes('/direct/')) {
    window.location.href = IG_INBOX_URL;
    await sleep(3500);
  }
}

chrome.runtime.onMessage.addListener((message: ContentMessage, _sender, sendResponse) => {
  void (async () => {
    const msg = message;
    let response: ContentResponse;
    if (msg.type === 'PING') {
      response = { type: 'PONG' };
    } else if (msg.type === 'GET_LOGGED_IN_HANDLE') {
      response = { type: 'LOGGED_IN_HANDLE', handle: detectLoggedInHandle() };
    } else if (msg.type === 'SEND_DM') {
      try {
        const result = await navigateAndSend(msg.profileUrl, msg.body, msg.expectedHandle);
        response = { type: 'SEND_DM_RESULT', result };
      } catch (e) {
        const messageText = e instanceof Error ? e.message : String(e);
        response = {
          type: 'SEND_DM_RESULT',
          result: { ok: false, code: 'UNKNOWN', message: messageText, retryable: true },
        };
      }
    } else if (msg.type === 'SCAN_OBSERVATION_REPLIES') {
      await ensureInboxForScan();
      const replies = scanInstagramObservationReplies(msg.watches);
      response = { type: 'OBSERVATION_REPLY_SCAN', replies };
    } else {
      return;
    }
    sendResponse(response);
  })();
  return true;
});
