/**
 * X / Twitter DOM helpers（改版时优先改这里）
 */
const XDom = (() => {
  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async function waitFor(predicate, { timeout = 12000, interval = 300 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const v = predicate();
      if (v) return v;
      await sleep(interval);
    }
    return null;
  }

  function click(el) {
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    if (typeof el.click === 'function') el.click();
    return true;
  }

  function isPasscodeGate() {
    const t = (document.body && document.body.innerText) || '';
    return /Enter Passcode|encryption keys|recover your encryption|忘记通行码|解锁码/i.test(t)
      || /\/i\/chat\/pin/i.test(location.pathname);
  }

  function pageText() {
    return (document.body && document.body.innerText) || '';
  }

  function findButtonByLabel(patterns) {
    const buttons = [...document.querySelectorAll('button, [role="button"], a')];
    return buttons.find((b) => {
      const label = `${b.getAttribute('aria-label') || ''} ${b.innerText || ''}`.trim();
      return patterns.some((re) => re.test(label));
    }) || null;
  }

  /**
   * 图2：需 Premium/认证才能向未互关用户发私信。
   * 必须以正文关键词区分，勿单独用 Upgrade（额度弹窗也有）。
   */
  function detectPremiumDmGate() {
    const t = pageText();
    const premiumText = /Get verified to message|Only verified users can send Direct Message|Get verified to continue/i.test(t)
      || /订阅.*(才能|方可).*私信|认证.*(才能|方可).*私信|只有认证用户才能/i.test(t);
    if (!premiumText) return null;
    return { detected: true, reason: 'PREMIUM_REQUIRED', error: '对方要求 Premium/认证账号才能私信' };
  }

  /** 图1：日私信请求额度不足 */
  function detectRateLimitDmGate() {
    const t = pageText();
    const rateText = /daily message request limit|Send more message requests with Premium|hit your daily message/i.test(t)
      || /每日.*(私信|消息).*(上限|额度|限制)|私信请求.*上限|额度不足/i.test(t);
    if (!rateText) return null;
    return { detected: true, reason: 'RATE_LIMIT', error: '当前账号日私信额度不足' };
  }

  /** 对方拒收 / 关闭私信 */
  function detectDmRejected() {
    const t = pageText();
    if (/You can.t message this account|can.?t send a message|doesn.?t accept message|This account doesn.?t accept|对方关闭了私信|无法向该用户发送私信|不能给此账号发私信/i.test(t)) {
      return { detected: true, reason: 'DM_REJECTED', error: '对方拒收或关闭私信' };
    }
    return null;
  }

  function dismissByLabels(patterns) {
    const btn = findButtonByLabel(patterns);
    if (btn) {
      click(btn);
      return true;
    }
    const close = document.querySelector('[aria-label="Close"], [data-testid="app-bar-close"], [aria-label="关闭"]');
    if (close) {
      click(close);
      return true;
    }
    return false;
  }

  /** 关闭 Premium 弹窗：优先 No thanks */
  function dismissPremiumDmGate() {
    return dismissByLabels([/^No thanks$/i, /不用了|暂不需要|不用谢谢/i, /no thanks/i]);
  }

  /** 关闭额度弹窗：优先 Not Now */
  function dismissRateLimitDmGate() {
    return dismissByLabels([/^Not Now$/i, /稍后再说|暂不|以后再说/i, /not now/i]);
  }

  /** 统一探测当前拦截门（额度优先于 Premium，因二者都可能出现 Upgrade） */
  function detectSendBlockGate() {
    return detectRateLimitDmGate() || detectPremiumDmGate() || detectDmRejected();
  }

  function dismissSendBlockGate(gate) {
    if (!gate) return false;
    if (gate.reason === 'RATE_LIMIT') return dismissRateLimitDmGate();
    if (gate.reason === 'PREMIUM_REQUIRED') return dismissPremiumDmGate();
    return dismissByLabels([/^Not Now$/i, /^No thanks$/i, /关闭/i]);
  }

  /** 对话区是否出现 Failed 发送失败标记 */
  function hasFailedSendMarker() {
    const scope = document.querySelector('[data-testid="dm-conversation-panel"]')
      || document.querySelector('[data-testid="dm-message-list"]')
      || document;
    const nodes = [...scope.querySelectorAll('span, div, button')].slice(0, 200);
    return nodes.some((el) => {
      const t = (el.innerText || '').trim();
      return /^(Failed|发送失败|未能发送)$/i.test(t);
    });
  }

  /** 是否存在与话术匹配的 OUT 气泡（用于确认真正发出） */
  function hasOutgoingMessageMatching(text) {
    if (!text) return false;
    const needle = String(text).replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!needle) return false;
    const messages = scrapeVisibleMessages();
    return messages.some((m) => {
      if (m.direction !== 'OUT') return false;
      const body = String(m.text || '').replace(/\s+/g, ' ').trim();
      return body.includes(needle) || needle.includes(body.slice(0, 40));
    });
  }

  function findPasscodeInput() {
    return (
      document.querySelector('input[type="password"]')
      || document.querySelector('input[autocomplete="one-time-code"]')
      || document.querySelector('input[inputmode="numeric"]')
      || document.querySelector('input[type="text"]')
    );
  }

  function findPasscodeSubmit() {
    const buttons = [...document.querySelectorAll('button, [role="button"]')];
    return buttons.find((b) => {
      const label = `${b.getAttribute('aria-label') || ''} ${b.innerText || ''}`.toLowerCase();
      return /unlock|continue|confirm|submit|下一步|确认|解锁|继续/.test(label)
        || b.getAttribute('data-testid') === 'confirmationSheetConfirm';
    }) || buttons.find((b) => !b.disabled);
  }

  async function tryUnlockPasscode(passcode) {
    if (!passcode || !isPasscodeGate()) return { unlocked: !isPasscodeGate(), attempted: false };
    const input = await waitFor(() => findPasscodeInput(), { timeout: 5000 });
    if (!input) return { unlocked: false, attempted: true, error: '找不到 passcode 输入框' };
    input.focus();
    input.value = '';
    document.execCommand('insertText', false, String(passcode));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(200);
    const submit = findPasscodeSubmit();
    if (submit) click(submit);
    else input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await sleep(1500);
    const still = isPasscodeGate();
    return { unlocked: !still, attempted: true, error: still ? 'passcode 未通过（请确认设置中的解锁码）' : null };
  }

  function findMessageButton() {
    const candidates = [
      ...document.querySelectorAll('[data-testid="sendDMFromProfile"]'),
      ...document.querySelectorAll('a[href*="/messages"]'),
      ...document.querySelectorAll('[aria-label]'),
      ...document.querySelectorAll('button, [role="button"]')
    ];
    for (const el of candidates) {
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const text = (el.innerText || '').toLowerCase();
      const testid = el.getAttribute('data-testid') || '';
      if (testid === 'sendDMFromProfile') return el;
      if (/message|dm|私信|发私信|訊息/.test(`${aria} ${text}`)) {
        // 排除导航栏 Messages
        if (testid === 'AppTabBar_DirectMessage_Link') continue;
        return el;
      }
    }
    return null;
  }

  function findComposer() {
    // 新版 /i/chat：textarea#dm-composer-textarea，placeholder 常为 Message / Unencrypted message
    const modern = document.querySelector('[data-testid="dm-composer-textarea"]')
      || document.querySelector('textarea[placeholder*="essage" i]')
      || document.querySelector('textarea[placeholder*="Unencrypted" i]')
      || document.querySelector('textarea[aria-label*="essage" i]');
    if (modern) return modern;

    // 经典 DM UI
    return (
      document.querySelector('[data-testid="dmComposerTextInput"]')
      || document.querySelector('[data-testid="dmComposerTextInputRichTextInputContainer"] [contenteditable="true"]')
      || document.querySelector('[role="textbox"][contenteditable="true"][data-testid]')
      || [...document.querySelectorAll('[role="textbox"][contenteditable="true"]')]
        .find((el) => {
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const ph = `${el.getAttribute('aria-placeholder') || ''} ${el.getAttribute('data-placeholder') || ''}`.toLowerCase();
          return /message|dm|私信|chat|unencrypted/.test(`${aria} ${ph}`)
            || el.closest('[data-testid*="dm"]')
            || el.closest('[data-testid*="composer"]');
        })
      || document.querySelector('[data-testid="dm-composer-input-container"] [contenteditable="true"]')
      || document.querySelector('[data-testid="dm-composer-form"] [contenteditable="true"]')
      || document.querySelector('[role="textbox"][contenteditable="true"]')
    );
  }

  function findSendButton() {
    return (
      document.querySelector('[data-testid="dmComposerSendButton"]')
      || document.querySelector('[data-testid="dm-composer-send-button"]')
      || document.querySelector('button[data-testid*="send" i]')
      || [...document.querySelectorAll('button, [role="button"]')].find((b) => {
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const testid = (b.getAttribute('data-testid') || '').toLowerCase();
        return testid.includes('send') && testid.includes('composer')
          || /^send$|发送|傳送|send message/.test(aria);
      })
    );
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function fillComposer(el, text) {
    if (!el || !text) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      setNativeValue(el, text);
      // React/受控组件再补一次 InputEvent
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      return true;
    }
    if (el.isContentEditable) {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      return true;
    }
    if ('value' in el) {
      setNativeValue(el, text);
      return true;
    }
    return false;
  }

  function pressEnterToSend(el) {
    if (!el) return;
    const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
    el.dispatchEvent(new KeyboardEvent('keydown', opts));
    el.dispatchEvent(new KeyboardEvent('keypress', opts));
    el.dispatchEvent(new KeyboardEvent('keyup', opts));
    // 部分实现要在 form 上 submit
    const form = el.closest('form') || document.querySelector('[data-testid="dm-composer-form"]');
    if (form && typeof form.requestSubmit === 'function') {
      try { form.requestSubmit(); } catch (_) { /* ignore */ }
    }
  }

  async function sendComposer(text) {
    const composer = await waitFor(() => findComposer(), { timeout: 20000 });
    if (!composer) {
      return {
        ok: false,
        reason: 'SEND_FAILED',
        error: '找不到私信输入框（新版应为 Unencrypted message / dm-composer-textarea；请确认当前页已打开对话）'
      };
    }
    fillComposer(composer, text);
    await sleep(500);
    const sendBtn = findSendButton();
    if (sendBtn && !sendBtn.disabled) {
      click(sendBtn);
    } else {
      // 新版 /i/chat 常无独立 Send 按钮，回车发送
      pressEnterToSend(composer);
    }

    // 发送后校验：弹窗 / Failed / OUT 气泡，杜绝假成功
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const gate = detectSendBlockGate();
      if (gate) {
        dismissSendBlockGate(gate);
        return {
          ok: false,
          reason: gate.reason,
          error: gate.error
        };
      }
      if (hasFailedSendMarker()) {
        return {
          ok: false,
          reason: 'SEND_FAILED',
          error: '消息发送失败(Failed)'
        };
      }
      if (hasOutgoingMessageMatching(text) && !hasFailedSendMarker()) {
        return { ok: true, reason: 'SENT_OK', via: sendBtn ? 'button' : 'enter' };
      }
      await sleep(300);
    }

    const lateGate = detectSendBlockGate();
    if (lateGate) {
      dismissSendBlockGate(lateGate);
      return { ok: false, reason: lateGate.reason, error: lateGate.error };
    }
    if (hasFailedSendMarker()) {
      return { ok: false, reason: 'SEND_FAILED', error: '消息发送失败(Failed)' };
    }
    if (hasOutgoingMessageMatching(text)) {
      return { ok: true, reason: 'SENT_OK', via: sendBtn ? 'button' : 'enter' };
    }
    return {
      ok: false,
      reason: 'SEND_FAILED',
      error: '未能确认发送成功（未见 OUT 气泡或出现拦截）'
    };
  }

  function chatHrefFromItem(el) {
    if (!el) return null;
    const a = el.matches?.('a[href*="/i/chat/"]')
      ? el
      : (el.querySelector?.('a[href*="/i/chat/"]') || el.closest?.('a[href*="/i/chat/"]'));
    if (a) {
      const href = a.getAttribute('href') || a.href || '';
      if (/\/i\/chat\//i.test(href)) return href;
    }
    const href = el.href || el.getAttribute?.('href') || '';
    return /\/i\/chat\//i.test(href) ? href : null;
  }

  function normalizeChatPath(href) {
    if (!href) return null;
    try {
      const u = new URL(href, location.origin);
      return u.pathname.replace(/\/+$/, '');
    } catch (_) {
      const m = String(href).match(/(\/i\/chat\/[^?#]+)/i);
      return m ? m[1].replace(/\/+$/, '') : null;
    }
  }

  /**
   * 返回可点击的会话入口（优先内层 a，外层 div 点击不会跳转）
   */
  function listConversationItems() {
    // 新版 /i/chat：侧栏 dm-conversation-item → 内层 a[href=/i/chat/...]
    const modernRows = [...document.querySelectorAll('[data-testid^="dm-conversation-item-"]')];
    if (modernRows.length) {
      const out = [];
      const seen = new Set();
      for (const row of modernRows) {
        const a = row.querySelector('a[href*="/i/chat/"]') || row;
        const href = chatHrefFromItem(a) || chatHrefFromItem(row);
        const key = normalizeChatPath(href) || (row.innerText || '').slice(0, 40);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(a);
      }
      return out;
    }

    const items = [
      ...document.querySelectorAll('a[href*="/i/chat/"]'),
      ...document.querySelectorAll('[data-testid="conversation"]'),
      ...document.querySelectorAll('a[href*="/messages/"]'),
      ...document.querySelectorAll('[data-testid="cellInnerDiv"] a[role="link"]')
    ];
    const seen = new Set();
    const out = [];
    for (const el of items) {
      const href = el.href || el.getAttribute('href') || '';
      const key = normalizeChatPath(href) || el.innerText;
      if (!key || seen.has(key)) continue;
      if (!/messages|i\/chat/i.test(href) && !el.closest('[data-testid="conversation"]')) continue;
      // 排除侧栏以外的导航噪音（当前打开对话里的 profile 链接等）
      if (/\/i\/chat\//i.test(href) && !el.closest('[data-testid="dm-inbox-panel"]')
        && !el.closest('[data-testid^="dm-conversation-item-"]')
        && document.querySelector('[data-testid="dm-inbox-panel"]')) {
        continue;
      }
      seen.add(key);
      out.push(el);
    }
    return out;
  }

  function listConversationEntries(max = 30) {
    return listConversationItems().slice(0, max).map((el) => ({
      el,
      href: chatHrefFromItem(el),
      path: normalizeChatPath(chatHrefFromItem(el)),
      preview: (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5)
    })).filter((e) => e.href);
  }

  async function openConversationByHref(href, { timeout = 8000 } = {}) {
    const targetPath = normalizeChatPath(href);
    if (!targetPath) return { ok: false, error: 'invalid chat href' };
    const current = normalizeChatPath(location.pathname);
    if (current !== targetPath) {
      const abs = href.startsWith('http') ? href : `${location.origin}${href.startsWith('/') ? '' : '/'}${href}`;
      // 优先点同 href 的 a（保留 SPA），否则 location 跳转
      const link = document.querySelector(`a[href="${href}"], a[href="${targetPath}"]`)
        || [...document.querySelectorAll('a[href*="/i/chat/"]')]
          .find((a) => normalizeChatPath(a.getAttribute('href')) === targetPath);
      if (link) click(link);
      else location.assign(abs);
    }
    const opened = await waitFor(() => normalizeChatPath(location.pathname) === targetPath, {
      timeout,
      interval: 150
    });
    if (!opened) return { ok: false, error: `未能打开会话 ${targetPath}` };
    // 等消息区或头像 handle 出现
    await waitFor(
      () => document.querySelector('[data-testid="dm-message-list"]')
        || document.querySelector('[data-testid^="message-text-"]')
        || document.querySelector('[data-testid^="message-"]')
        || document.querySelector('[data-testid="messageEntry"]')
        || parseScreenNameFromOpenConversation(),
      { timeout: Math.min(timeout, 6000), interval: 150 }
    );
    await sleep(200);
    return { ok: true, path: targetPath };
  }

  function parseScreenNameFromConversation(el) {
    const href = el.href || el.getAttribute('href') || '';
    const m = href.match(/messages\/([^/?#]+)/i) || href.match(/i\/chat\/([^/?#]+)/i);
    if (m) {
      // sometimes id not screen name
      const part = decodeURIComponent(m[1]);
      if (/^[A-Za-z0-9_]{1,15}$/.test(part)) return part.toLowerCase();
    }
    const text = (el.innerText || '').split('\n').map((s) => s.trim()).filter(Boolean);
    for (const line of text) {
      const at = line.match(/@([A-Za-z0-9_]{1,15})/);
      if (at) return at[1].toLowerCase();
    }
    return null;
  }

  function stripMessageTimestamps(text) {
    return String(text || '')
      .replace(/\n?(Today|Yesterday|今天|昨天)\s*$/i, '')
      .replace(/\n?\d{1,2}:\d{2}\s*(AM|PM)?(\s*\n?\d{1,2}:\d{2}\s*(AM|PM)?)*\s*$/i, '')
      .trim();
  }

  function messageListRoot() {
    return document.querySelector('[data-testid="dm-message-list"]')
      || document.querySelector('[data-testid="dm-conversation-panel"]')
      || document.querySelector('[data-testid="dm-conversation-content"]')
      || document.querySelector('main');
  }

  /** 会话列表宽度（几何启发只用这个，避免落到偏宽的 main） */
  function messageListBoundsEl() {
    return document.querySelector('[data-testid="dm-message-list"]')
      || document.querySelector('[data-testid="dm-message-scroller"]')
      || document.querySelector('[data-testid="dm-conversation-panel"]');
  }

  function messageScrollerEl() {
    return document.querySelector('[data-testid="dm-message-scroller"]')
      || document.querySelector('[data-testid="dm-message-list"]')
      || document.querySelector('[data-testid="DmActivityContainer"]');
  }

  /**
   * 解析气泡行：优先 message-{uuid}（排除 message-text-*），否则 messageEntry。
   * 短消息正文常在 message-text-*，方向必须绑在外层气泡行上。
   */
  function resolveBubbleRow(node) {
    if (!node || !node.closest) return node;
    const textHost = node.closest('[data-testid^="message-text-"]');
    const fromText = textHost
      ? (() => {
        const id = textHost.getAttribute('data-testid') || '';
        const uuid = id.slice('message-text-'.length);
        if (uuid) {
          const row = document.querySelector(`[data-testid="message-${uuid}"]`);
          if (row) return row;
        }
        let p = textHost.parentElement;
        for (let i = 0; i < 4 && p; i += 1) {
          const tid = p.getAttribute?.('data-testid') || '';
          if (tid.startsWith('message-') && !tid.startsWith('message-text-')) return p;
          p = p.parentElement;
        }
        return textHost.parentElement || textHost;
      })()
      : null;
    if (fromText) return fromText;

    const modern = node.closest('[data-testid^="message-"]');
    if (modern) {
      const tid = modern.getAttribute('data-testid') || '';
      if (!tid.startsWith('message-text-')) return modern;
    }
    return node.closest('[data-testid="messageEntry"]')
      || node.closest('[role="row"]')
      || node;
  }

  /**
   * 方向：只看气泡行自身 class（旧版策略）。
   * 不向上扫多层：气泡内部时间戳也有 justify-end，会把 IN 误判成 OUT。
   * 几何启发仅作弱兜底，且必须基于 dm-message-list 宽度、阈值偏右。
   */
  function inferMessageDirection(node) {
    if (!node) return 'IN';
    const row = resolveBubbleRow(node);
    const selfCls = String(row?.className || '');
    const aria = String(row?.getAttribute?.('aria-label') || '');
    if (
      /justify-end|dm-message-outgoing|outgoing|message-outgoing/i.test(selfCls)
      || /You sent|已发送|你发送/i.test(aria)
    ) {
      return 'OUT';
    }
    if (/justify-start|dm-message-incoming|incoming|message-incoming/i.test(selfCls)) {
      return 'IN';
    }

    // 弱兜底：仅看气泡行相对消息列表的位置（≥58% 靠右才算 OUT）
    const conv = messageListBoundsEl();
    if (conv && row?.getBoundingClientRect) {
      const cr = conv.getBoundingClientRect();
      const br = row.getBoundingClientRect();
      if (br.width > 0 && cr.width > 120 && br.left > cr.left + cr.width * 0.58) {
        return 'OUT';
      }
    }
    return 'IN';
  }

  function isNoiseMessageText(text) {
    if (!text) return true;
    const t = text.trim();
    if (!t) return true;
    if (/^@[A-Za-z0-9_]{1,15}$/.test(t)) return true;
    if (/^(\d{1,2}:\d{2}(\s*(AM|PM))?|Yesterday|Today|今天|昨天)$/i.test(t)) return true;
    if (/^(\d{1,2}:\d{2}|Yesterday|Today|今天|昨天)/i.test(t) && t.length < 24) return true;
    if (/^(Failed|发送失败|未能发送)$/i.test(t)) return true;
    if (/^\d+(\.\d+)?[KMB]?\s*Followers?$/i.test(t)) return true;
    return false;
  }

  function extractXMessageId(row, textEl) {
    const fromTid = (el) => {
      const id = el?.getAttribute?.('data-testid') || '';
      if (id.startsWith('message-text-')) return id.slice('message-text-'.length);
      if (id.startsWith('message-') && !id.startsWith('message-text-') && id !== 'messageEntry') {
        return id.slice('message-'.length);
      }
      return '';
    };
    return fromTid(row) || fromTid(textEl) || '';
  }

  function normalizeMachineTime(raw) {
    const value = String(raw || '').trim();
    if (!value) return null;
    if (/^\d{10,13}$/.test(value)) {
      const ms = value.length <= 10 ? Number(value) * 1000 : Number(value);
      const date = new Date(ms);
      return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }
    // 只接收带日期的机器时间；不把孤立的 “3:40 AM” 猜成今天。
    if (!/[T/]|\d{4}|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec/i.test(value)) {
      return null;
    }
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? null : new Date(ms).toISOString();
  }

  function extractSentAt(row) {
    if (!row) return null;
    let el = row;
    for (let i = 0; i < 8 && el; i += 1) {
      const candidates = [];
      const collect = (node) => {
        if (!node?.getAttribute) return;
        candidates.push(
          node.getAttribute('datetime'),
          node.getAttribute('data-time'),
          node.getAttribute('data-timestamp'),
          node.getAttribute('data-created-at'),
          node.getAttribute('title'),
          node.getAttribute('aria-label')
        );
      };
      collect(el);
      for (const node of el.querySelectorAll?.(
        'time, [datetime], [data-time], [data-timestamp], [data-created-at]'
      ) || []) {
        collect(node);
      }
      for (const candidate of candidates) {
        const normalized = normalizeMachineTime(candidate);
        if (normalized) return normalized;
      }
      el = el.parentElement;
    }
    return null;
  }

  function messageIdentityKey(m, fallbackIndex) {
    if (m?.xMessageId) return `id:${m.xMessageId}`;
    return `dom:${fallbackIndex}:${m?.direction || ''}:${m?.text || ''}`;
  }

  function pushScrapedMessage(messages, node, textEl, domIndex) {
    const text = stripMessageTimestamps((textEl?.innerText || textEl?.textContent || '').trim());
    if (isNoiseMessageText(text)) return;
    const row = resolveBubbleRow(node || textEl);
    messages.push({
      direction: inferMessageDirection(row),
      text: text.slice(0, 2000),
      xMessageId: extractXMessageId(row, textEl) || undefined,
      sentAt: extractSentAt(row) || undefined,
      domIndex: domIndex ?? messages.length
    });
  }

  function scrapeVisibleMessages() {
    const messages = [];
    const root = messageListRoot() || document;
    const seenId = new Set();

    const pushOnce = (node, textEl) => {
      const before = messages.length;
      pushScrapedMessage(messages, node, textEl, before);
      if (messages.length === before) return;
      const added = messages[messages.length - 1];
      const key = messageIdentityKey(added, added.domIndex);
      if (seenId.has(key)) {
        messages.pop();
        return;
      }
      seenId.add(key);
    };

    const textNodes = [...root.querySelectorAll('[data-testid^="message-text-"]')];
    for (const textEl of textNodes) {
      const row = resolveBubbleRow(textEl);
      pushOnce(row, textEl);
    }

    const modernNodes = [...root.querySelectorAll('[data-testid^="message-"]')]
      .filter((el) => {
        const id = el.getAttribute('data-testid') || '';
        return id.startsWith('message-') && !id.startsWith('message-text-');
      });
    for (const node of modernNodes) {
      const testId = node.getAttribute('data-testid') || '';
      const uuid = testId.slice('message-'.length);
      const textEl = root.querySelector(`[data-testid="message-text-${uuid}"]`)
        || node.querySelector('[data-testid^="message-text-"]');
      pushOnce(node, textEl || node);
    }

    const classicNodes = [
      ...root.querySelectorAll('[data-testid="messageEntry"]'),
      ...root.querySelectorAll('[data-testid="tweet"]')
    ];
    for (const node of classicNodes) {
      const textEl = node.querySelector('[data-testid="tweetText"]')
        || node.querySelector('[data-testid="messageEntry"] span')
        || node;
      pushOnce(node, textEl);
    }

    return sortMessagesBySentAt(messages);
  }

  function sentAtMs(m) {
    if (!m?.sentAt) return null;
    const t = Date.parse(m.sentAt);
    return Number.isNaN(t) ? null : t;
  }

  function sortMessagesBySentAt(messages) {
    const list = [...(messages || [])];
    list.sort((a, b) => {
      const at = sentAtMs(a);
      const bt = sentAtMs(b);
      if (at != null && bt != null && at !== bt) return at - bt;
      if (at != null && bt == null) return -1;
      if (at == null && bt != null) return 1;
      return (a.domIndex ?? 0) - (b.domIndex ?? 0);
    });
    return list;
  }

  function mergeByIdentity(primary, secondary) {
    const out = [];
    const seen = new Set();
    for (const m of [...(primary || []), ...(secondary || [])]) {
      if (!m?.text) continue;
      const key = messageIdentityKey(m, out.length);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
    return sortMessagesBySentAt(out);
  }

  function parsePreviewMessages(preview) {
    if (!preview || !preview.length) return [];
    const out = [];
    for (const line of preview) {
      const t = String(line || '').trim();
      if (!t) continue;
      const you = t.match(/^You:\s*(.+)$/i) || t.match(/^你[:：]\s*(.+)$/);
      if (you && you[1]) {
        const body = stripMessageTimestamps(you[1].trim());
        if (!isNoiseMessageText(body)) {
          out.push({ direction: 'OUT', text: body.slice(0, 2000), fromPreview: true });
        }
      }
    }
    return out;
  }

  function mergeMessageLists(primary, secondary) {
    return mergeByIdentity(primary, secondary);
  }

  /** 向上滚动加载历史后按 sentAt 升序返回 */
  async function scrapeConversationMessagesWithRetry({ attempts = 12, scrollWait = 220 } = {}) {
    const scroller = messageScrollerEl();
    const byKey = new Map();
    const harvest = () => {
      const batch = scrapeVisibleMessages();
      for (const m of batch) {
        const key = messageIdentityKey(m, byKey.size);
        const prev = byKey.get(key);
        if (!prev) {
          byKey.set(key, m);
        } else if (!prev.sentAt && m.sentAt) {
          byKey.set(key, m);
        }
      }
    };

    harvest();
    let prevCount = byKey.size;
    let stagnant = 0;
    for (let i = 0; i < attempts; i += 1) {
      if (scroller) {
        scroller.scrollTop = 0;
        await sleep(scrollWait);
      } else {
        await sleep(scrollWait);
      }
      harvest();
      if (byKey.size <= prevCount) {
        stagnant += 1;
        if (stagnant >= 3) break;
      } else {
        stagnant = 0;
        prevCount = byKey.size;
      }
    }
    return sortMessagesBySentAt([...byKey.values()]);
  }

  function parseScreenNameFromOpenConversation() {
    const panel = document.querySelector('[data-testid="dm-conversation-panel"]')
      || document.querySelector('[data-testid="dm-conversation-content"]')
      || document;
    const header = panel.querySelector('[data-testid="dm-conversation-header"]')
      || panel.querySelector('[data-testid="conversationHeader"]')
      || panel.querySelector('header')
      || null;

    const fromHeader = screenNameFromScope(header || panel, true);
    if (fromHeader) return fromHeader;
    return screenNameFromScope(panel, true);
  }

  function screenNameFromScope(root, skipMessageList) {
    if (!root) return null;
    const links = [...root.querySelectorAll('a[href]')];
    for (const a of links) {
      if (skipMessageList && a.closest('[data-testid="dm-message-list"]')) continue;
      const href = a.getAttribute('href') || '';
      const m = href.match(/(?:x\.com|twitter\.com)\/([A-Za-z0-9_]{1,15})(?:[\/?#]|$)/i)
        || href.match(/^\/([A-Za-z0-9_]{1,15})(?:[\/?#]|$)/);
      if (!m) continue;
      const sn = m[1];
      if (/^(i|home|messages|search|settings|compose|explore|intent|share)$/i.test(sn)) continue;
      return sn.toLowerCase();
    }
    const nodes = [...root.querySelectorAll('span, a, div')];
    for (const el of nodes) {
      if (skipMessageList && el.closest('[data-testid="dm-message-list"]')) continue;
      const t = (el.innerText || '').trim();
      if (/^@[A-Za-z0-9_]{1,15}$/.test(t)) return t.slice(1).toLowerCase();
    }
    return null;
  }

  return {
    sleep,
    waitFor,
    click,
    isPasscodeGate,
    detectPremiumDmGate,
    detectRateLimitDmGate,
    detectDmRejected,
    detectSendBlockGate,
    dismissPremiumDmGate,
    dismissRateLimitDmGate,
    dismissSendBlockGate,
    hasFailedSendMarker,
    hasOutgoingMessageMatching,
    tryUnlockPasscode,
    findMessageButton,
    findComposer,
    fillComposer,
    sendComposer,
    listConversationItems,
    listConversationEntries,
    chatHrefFromItem,
    openConversationByHref,
    parseScreenNameFromConversation,
    parseScreenNameFromOpenConversation,
    scrapeVisibleMessages,
    scrapeConversationMessagesWithRetry,
    parsePreviewMessages,
    mergeMessageLists
  };
})();
