import type { ContentMessage, ContentResponse, SendDmResult } from '../shared/types';
import selectors from '../selectors/tiktok.json';
import {
  clickElement,
  clearComposerDraft,
  detectPageBlockers,
  insertTextIntoEditable,
  isElementDisabled,
  normalizeHandle,
  sleep,
  submitComposerViaEnter,
  verifySendOutcome,
  waitFor,
} from '../shared/dom-utils';
import { scanTiktokObservationReplies } from './reply-scan-tiktok';
import { detectTikTokLoggedInHandle } from '../shared/tiktok-handle-detect';

const TT_HOST = 'tiktok.com';
const TT_MESSAGES_URL = 'https://www.tiktok.com/messages';

function queryFirst(selectorsList: string[]): Element | null {
  for (const sel of selectorsList) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch {
      /* invalid selector */
    }
  }
  return null;
}

function findMessageButton(): HTMLElement | null {
  const fromJson = queryFirst(selectors.profileMessageButton as string[]);
  if (fromJson instanceof HTMLElement) return fromJson;

  const messageLink = document.querySelector('a[href*="/messages"]');
  if (messageLink instanceof HTMLElement) return messageLink;

  const clickable = Array.from(
    document.querySelectorAll('button, a[role="button"], div[role="button"], a'),
  );
  for (const btn of clickable) {
    const text = (btn.textContent ?? '').trim();
    const aria = btn.getAttribute('aria-label') ?? '';
    const e2e = btn.getAttribute('data-e2e') ?? '';
    if (
      text === 'Message' ||
      text === '发消息' ||
      text === '消息' ||
      /message|发消息|私信/i.test(aria) ||
      /message/i.test(e2e)
    ) {
      return btn as HTMLElement;
    }
  }
  return null;
}

function resolveEditableTarget(el: HTMLElement): HTMLElement {
  if (el.isContentEditable) return el;
  const inner = el.querySelector('[contenteditable="true"]');
  return inner instanceof HTMLElement ? inner : el;
}

function findComposer(): HTMLElement | null {
  const fromJson = queryFirst(selectors.composerTextarea as string[]);
  if (fromJson instanceof HTMLElement) return resolveEditableTarget(fromJson);

  const draft = document.querySelector('.public-DraftEditor-content[contenteditable="true"]');
  if (draft instanceof HTMLElement) return draft;

  const roleBox = document.querySelector('div[contenteditable="true"][role="textbox"]');
  if (roleBox instanceof HTMLElement) return roleBox;

  const editable = document.querySelector('div[contenteditable="true"]');
  return editable instanceof HTMLElement ? editable : null;
}

function findSendButton(): HTMLElement | null {
  const fromJson = queryFirst(selectors.sendButton as string[]);
  if (fromJson instanceof HTMLElement && !isElementDisabled(fromJson)) return fromJson;

  const inputArea = document.querySelector('[data-e2e="message-input-area"]');
  if (inputArea) {
    const inArea = inputArea.querySelector(
      'button[data-e2e*="send"], button[aria-label*="Send"], button[aria-label*="发送"]',
    );
    if (inArea instanceof HTMLElement && !isElementDisabled(inArea)) return inArea;

    const areaButtons = Array.from(inputArea.querySelectorAll('button'));
    for (const btn of areaButtons) {
      if (!(btn instanceof HTMLElement) || isElementDisabled(btn)) continue;
      const aria = btn.getAttribute('aria-label') ?? '';
      const e2e = btn.getAttribute('data-e2e') ?? '';
      if (/send|发送|submit/i.test(aria) || /send/i.test(e2e)) return btn;
      // TikTok 常见：仅图标的圆形发送钮（在输入框右侧）
      if (btn.querySelector('svg') && areaButtons.length <= 3) return btn;
    }
  }

  const labels = ['Send', '发送', '发送消息'];
  const buttons = Array.from(document.querySelectorAll('button, div[role="button"]'));
  for (const btn of buttons) {
    if (!(btn instanceof HTMLElement) || isElementDisabled(btn)) continue;
    const text = btn.textContent?.trim() ?? '';
    const aria = btn.getAttribute('aria-label') ?? '';
    const e2e = btn.getAttribute('data-e2e') ?? '';
    if (labels.includes(text) || labels.some((l) => aria.includes(l))) return btn;
    if (/message-send|send-message/i.test(e2e)) return btn;
  }
  return null;
}

async function waitForEnabledSendButton(timeoutMs: number): Promise<HTMLElement | null> {
  return waitFor(() => findSendButton(), timeoutMs, 250);
}

async function submitMessage(composer: HTMLElement): Promise<void> {
  const sendBtn = await waitForEnabledSendButton(8000);
  if (sendBtn) {
    clickElement(sendBtn);
    await sleep(400);
    if (findComposer() && composerStillHasDraft(composer)) {
      clickElement(sendBtn);
    }
    return;
  }
  submitComposerViaEnter(composer);
}

function composerStillHasDraft(composer: HTMLElement): boolean {
  const text = (composer.innerText ?? composer.textContent ?? '').trim();
  return text.length > 0;
}

export function detectLoggedInHandle(): string | null {
  return detectTikTokLoggedInHandle();
}

function profileUsernameFromUrl(profileUrl: string): string | null {
  try {
    const u = new URL(profileUrl);
    if (!u.hostname.toLowerCase().includes(TT_HOST)) return null;
    const m = u.pathname.match(/@([^/]+)/);
    return m?.[1] ? normalizeHandle(m[1]) : null;
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

  const currentUser = profileUsernameFromUrl(window.location.href) ?? normalizeHandle(
    window.location.pathname.match(/@([^/]+)/)?.[1],
  );
  if (expectedHandle && currentUser && currentUser !== normalizeHandle(expectedHandle)) {
    return {
      ok: false,
      code: 'ACCOUNT_MISMATCH',
      message: `Profile mismatch: on ${currentUser}, expected ${expectedHandle}`,
      retryable: true,
    };
  }

  const msgBtn = await waitFor(findMessageButton, 20000, 500);
  if (!msgBtn) {
    return { ok: false, code: 'NO_DM_ACCESS', message: 'Message button not found on profile', retryable: false };
  }
  clickElement(msgBtn);
  await sleep(2000);

  const composer = await waitForComposer(18000);
  if (!composer) {
    return { ok: false, code: 'SELECTOR_BROKEN', message: 'TikTok DM composer not found', retryable: false };
  }

  clickElement(composer);
  await sleep(400);
  await insertTextIntoEditable(composer, body);
  await sleep(800);

  if (!composerStillHasDraft(composer)) {
    return {
      ok: false,
      code: 'SELECTOR_BROKEN',
      message: 'TikTok composer text not set (Draft.js may have rejected input)',
      retryable: true,
    };
  }

  await submitMessage(composer);

  const verified = await verifySendOutcome(body, { timeoutMs: 10000, getComposer: findComposer });
  if (!verified.ok) return verified;

  await sleep(400);
  const composerAfter = findComposer();
  if (composerAfter) clearComposerDraft(composerAfter);

  const threadUrl =
    verified.threadUrl ??
    (window.location.href.includes('/messages') ? window.location.href : undefined);
  return { ok: true, threadUrl };
}

async function navigateAndSend(profileUrl: string, body: string, expectedHandle?: string): Promise<SendDmResult> {
  if (!profileUrl) {
    return { ok: false, code: 'UNKNOWN', message: 'Missing profileUrl', retryable: false };
  }

  const targetUser = profileUsernameFromUrl(profileUrl);
  const onProfile =
    targetUser &&
    window.location.pathname.toLowerCase().includes(`/@${targetUser.toLowerCase()}`);

  if (!onProfile) {
    window.location.href = profileUrl;
    await sleep(4000);
  }

  return sendDmOnCurrentPage(body, expectedHandle ?? targetUser ?? undefined);
}

async function ensureMessagesForScan(): Promise<void> {
  if (!window.location.pathname.includes('/messages')) {
    window.location.href = TT_MESSAGES_URL;
    await sleep(4000);
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
      await ensureMessagesForScan();
      const replies = scanTiktokObservationReplies(msg.watches);
      response = { type: 'OBSERVATION_REPLY_SCAN', replies };
    } else {
      return;
    }
    sendResponse(response);
  })();
  return true;
});
