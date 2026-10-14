import type { PluginFailureCode, SendDmResult } from './types';

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll until finder returns a value or timeout. */
export async function waitFor<T>(
  finder: () => T | null | undefined,
  timeoutMs: number,
  intervalMs = 500,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = finder();
    if (value != null) return value;
    await sleep(intervalMs);
  }
  return null;
}

export function clickElement(el: HTMLElement): void {
  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  el.click();
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
}

export function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const h = raw.replace(/^@/, '').trim().toLowerCase();
  return h || null;
}

const CAPTCHA_PATTERNS =
  /captcha|verify\s+you|security\s+check|confirm\s+you.?re\s+human|人机验证|验证码/i;
const RATE_LIMIT_PATTERNS =
  /try\s+again\s+later|too\s+many|rate\s+limit|temporarily\s+blocked|请稍后再试|操作过于频繁/i;
const LOGIN_PATTERNS = /log\s*in|sign\s*up|session\s+expired|登录|请登录/i;

/** 根据当前 URL 与页面文案推断阻断原因（发送后或发送前均可调用）。 */
export function detectPageBlockers(href: string, bodyText: string): SendDmResult | null {
  if (/challenge|captcha|accounts\/login/i.test(href) || /\/login|\/signup/i.test(href)) {
    return { ok: false, code: 'LOGIN_EXPIRED', message: 'Login or challenge page', retryable: false };
  }
  const sample = bodyText.slice(0, 8000);
  if (CAPTCHA_PATTERNS.test(sample) || CAPTCHA_PATTERNS.test(href)) {
    return { ok: false, code: 'CAPTCHA', message: 'Captcha or security check detected', retryable: false };
  }
  if (RATE_LIMIT_PATTERNS.test(sample)) {
    return { ok: false, code: 'RATE_LIMITED', message: 'Rate limit message on page', retryable: true };
  }
  if (LOGIN_PATTERNS.test(sample) && sample.length < 2000) {
    return { ok: false, code: 'LOGIN_EXPIRED', message: 'Login prompt detected', retryable: false };
  }
  return null;
}

function composerContainsText(el: HTMLElement, text: string): boolean {
  const expected = text.trim();
  if (!expected) return false;
  const current = (el.innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  return current.includes(expected);
}

function clearContentEditable(el: HTMLElement): void {
  el.focus();
  const selection = window.getSelection();
  if (selection) {
    const range = document.createRange();
    range.selectNodeContents(el);
    selection.removeAllRanges();
    selection.addRange(range);
    document.execCommand('delete', false);
  }
  if ((el.textContent ?? '').trim()) {
    el.textContent = '';
    el.innerHTML = '';
  }
}

function pastePlainText(el: HTMLElement, text: string): boolean {
  try {
    const dataTransfer = new DataTransfer();
    dataTransfer.setData('text/plain', text);
    const event = new ClipboardEvent('paste', {
      bubbles: true,
      cancelable: true,
      clipboardData: dataTransfer,
    });
    el.dispatchEvent(event);
    return composerContainsText(el, text);
  } catch {
    return false;
  }
}

async function typeIntoEditable(el: HTMLElement, text: string): Promise<void> {
  el.focus();
  clearContentEditable(el);
  for (const char of text) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true, cancelable: true }));
    document.execCommand('insertText', false, char);
    el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    await sleep(16);
  }
}

function dispatchEditableInput(el: HTMLElement, text: string): void {
  el.dispatchEvent(
    new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertFromPaste',
      data: text,
    }),
  );
  el.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      inputType: 'insertFromPaste',
      data: text,
    }),
  );
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** TikTok / IG 等 contenteditable（含 Draft.js）输入框填字 */
export async function insertTextIntoEditable(el: HTMLElement, text: string): Promise<void> {
  el.focus();
  clickElement(el);

  if (el instanceof HTMLTextAreaElement) {
    el.value = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return;
  }
  if (el instanceof HTMLInputElement) {
    el.value = text;
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
    return;
  }

  clearContentEditable(el);

  // Draft.js / Lexical 优先走 paste，能正确隐藏「发送消息…」占位符
  pastePlainText(el, text);
  if (!composerContainsText(el, text)) {
    const inserted = document.execCommand('insertText', false, text);
    if (!inserted || !composerContainsText(el, text)) {
      await typeIntoEditable(el, text);
    }
  }

  if (!composerContainsText(el, text)) {
    el.textContent = text;
  }

  dispatchEditableInput(el, text);
}

/** 发送成功后清理输入框残留（TikTok Draft.js 常不自动清空） */
export function clearComposerDraft(composer: HTMLElement): void {
  if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
    composer.value = '';
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    composer.blur();
    return;
  }
  clearContentEditable(composer);
  dispatchEditableInput(composer, '');
  composer.blur();
}

export function isElementDisabled(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled')) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  if (el.classList.contains('disabled') || el.classList.contains('TUXButton--disabled')) return true;
  return false;
}

/** 在输入框按 Enter 发送（TikTok 等平台的兜底） */
export function submitComposerViaEnter(composer: HTMLElement): void {
  composer.focus();
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    composer.dispatchEvent(
      new KeyboardEvent(type, {
        key: 'Enter',
        code: 'Enter',
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      }),
    );
  }
}

export function composerStillHasText(composer: HTMLElement, body: string): boolean {
  const expected = body.trim();
  if (!expected) return false;
  const current =
    composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement
      ? composer.value.trim()
      : (composer.textContent ?? '').trim();
  return current.length > 0 && current === expected;
}

/** 发送点击后轮询：阻断 UI、限流文案、或正文中出现已发内容片段。 */
export async function verifySendOutcome(
  body: string,
  opts?: { timeoutMs?: number; getComposer?: () => HTMLElement | null },
): Promise<SendDmResult> {
  const timeoutMs = opts?.timeoutMs ?? 6000;
  const snippet = body.trim().slice(0, 80);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const blocked = detectPageBlockers(window.location.href, document.body.innerText);
    if (blocked) return blocked;

    if (snippet && document.body.innerText.includes(snippet)) {
      const threadUrl = window.location.href;
      return {
        ok: true,
        threadUrl: /direct|messages/i.test(threadUrl) ? threadUrl : undefined,
      };
    }

    const composer = opts?.getComposer?.() ?? null;
    if (composer && !composerStillHasText(composer, body)) {
      return {
        ok: true,
        threadUrl: /direct|messages/i.test(window.location.href) ? window.location.href : undefined,
      };
    }

    await sleep(350);
  }

  const blocked = detectPageBlockers(window.location.href, document.body.innerText);
  if (blocked) return blocked;

  return {
    ok: false,
    code: 'SELECTOR_BROKEN' as PluginFailureCode,
    message: 'Send not confirmed (no message bubble / composer still full)',
    retryable: true,
  };
}
