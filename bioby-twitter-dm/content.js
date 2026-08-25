/**
 * x.com content script：填话术 / 半自动发送 / 会话抓取
 *
 * 只处理 background 经 tabs.sendMessage 发来的类型。
 * 侧栏/popup 的 runtime.sendMessage 会广播到本脚本；若 return true 却不 sendResponse，
 * Chrome 会报 “message channel closed before a response was received”。
 */
const CONTENT_MESSAGE_TYPES = new Set([
  'INJECT_DM_DRAFT',
  'AUTO_SEND_DM',
  'ENSURE_PASSCODE',
  'SCRAPE_INBOX_BATCH',
  'SCRAPE_CURRENT_THREAD'
]);

function isFromSidepanelOrPopup(sender) {
  return /\/(sidepanel|popup|options)\.html/i.test(String(sender?.url || ''));
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type || !CONTENT_MESSAGE_TYPES.has(msg.type)) return;
  if (isFromSidepanelOrPopup(sender)) return;

  let replied = false;
  const reply = (payload) => {
    if (replied) return;
    replied = true;
    try { sendResponse(payload); } catch (_) { /* channel already closed */ }
  };

  (async () => {
    try {
      if (msg.type === 'INJECT_DM_DRAFT') {
        const text = msg.text || '';
        if (text) await copyText(text);
        const filled = !!XDom.findComposer() && XDom.fillComposer(XDom.findComposer(), text);
        showToast(filled
          ? 'Bioby：话术已填入输入框'
          : 'Bioby：话术已复制，请打开私信后粘贴');
        reply({ ok: true, filled });
        return;
      }
      if (msg.type === 'AUTO_SEND_DM') {
        reply(await autoSendDm(msg));
        return;
      }
      if (msg.type === 'ENSURE_PASSCODE') {
        if (!msg.passcode) {
          reply({ ok: true, ping: true, gate: XDom.isPasscodeGate() });
          return;
        }
        const r = await XDom.tryUnlockPasscode(msg.passcode);
        reply({ ok: r.unlocked, ...r });
        return;
      }
      if (msg.type === 'SCRAPE_INBOX_BATCH') {
        reply(await scrapeInboxBatch(msg));
        return;
      }
      if (msg.type === 'SCRAPE_CURRENT_THREAD') {
        reply({
          ok: true,
          screenName: guessCurrentScreenName(),
          messages: XDom.scrapeVisibleMessages()
        });
      }
    } catch (e) {
      reply({ ok: false, reason: 'SEND_FAILED', error: e.message || String(e) });
    }
  })();
  return true;
});

function blockFromGate(gate) {
  if (!gate) return null;
  XDom.dismissSendBlockGate?.(gate);
  return {
    ok: false,
    reason: gate.reason,
    error: gate.error
  };
}

async function autoSendDm(msg) {
  const text = msg.text || '';
  const passcode = msg.passcode || '1234';
  if (!text) return { ok: false, reason: 'SEND_FAILED', error: '话术为空' };

  if (XDom.isPasscodeGate()) {
    const unlock = await XDom.tryUnlockPasscode(passcode);
    if (!unlock.unlocked) {
      return { ok: false, reason: 'SEND_FAILED', error: unlock.error || '需要先解锁 X 聊天 passcode' };
    }
    await XDom.sleep(1000);
  }

  // 已在私信页则直接发
  if (XDom.findComposer()) {
    const blocked = blockFromGate(XDom.detectSendBlockGate?.());
    if (blocked) return blocked;
    const sent = await XDom.sendComposer(text);
    if (sent.ok) showToast('Bioby：私信已确认发送');
    else showToast(`Bioby：${sent.error || '发送未成功'}`);
    return sent;
  }

  const msgBtn = await XDom.waitFor(() => XDom.findMessageButton(), { timeout: 12000 });
  if (!msgBtn) {
    const blocked = blockFromGate(XDom.detectSendBlockGate?.());
    if (blocked) return blocked;
    if (XDom.detectDmRejected?.()) {
      return blockFromGate(XDom.detectDmRejected());
    }
    return {
      ok: false,
      reason: 'DM_REJECTED',
      error: '找不到 Message 按钮（对方可能关闭私信或拒收）'
    };
  }
  XDom.click(msgBtn);
  await XDom.sleep(1500);

  let blocked = blockFromGate(XDom.detectSendBlockGate?.());
  if (blocked) return blocked;

  // 等 composer 或拦截弹窗
  const ready = await XDom.waitFor(() => {
    const gate = XDom.detectSendBlockGate?.();
    if (gate) return { kind: 'gate', gate };
    if (XDom.findComposer()) return { kind: 'composer' };
    return null;
  }, { timeout: 20000, interval: 300 });

  if (ready?.kind === 'gate') {
    return blockFromGate(ready.gate);
  }
  if (ready?.kind !== 'composer') {
    blocked = blockFromGate(XDom.detectSendBlockGate?.());
    if (blocked) return blocked;
    return {
      ok: false,
      reason: 'DM_REJECTED',
      error: '找不到私信输入框（可能对方关闭私信或需 Premium）'
    };
  }

  if (XDom.isPasscodeGate()) {
    const unlock = await XDom.tryUnlockPasscode(passcode);
    if (!unlock.unlocked) {
      return { ok: false, reason: 'SEND_FAILED', error: unlock.error || '进入私信前需要解锁 passcode' };
    }
    await XDom.sleep(1000);
  }

  blocked = blockFromGate(XDom.detectSendBlockGate?.());
  if (blocked) return blocked;

  const sent = await XDom.sendComposer(text);
  if (sent.ok) showToast('Bioby：私信已确认发送');
  else showToast(`Bioby：${sent.error || '发送未成功'}`);
  return sent;
}

async function scrapeInboxBatch(msg) {
  const maxConversations = Math.min(Math.max(Number(msg.maxConversations) || 10, 1), 30);
  const passcode = msg.passcode || '1234';

  if (XDom.isPasscodeGate()) {
    const unlock = await XDom.tryUnlockPasscode(passcode);
    if (!unlock.unlocked) {
      return { ok: false, error: unlock.error || '请先解锁 X 聊天' };
    }
    await XDom.sleep(600);
  }

  // 若还不在 inbox，点一下 Messages；已在 /i/chat 则不必整页重载
  if (!/\/i\/chat/i.test(location.pathname) && !/\/messages/i.test(location.pathname)) {
    const nav = document.querySelector('[data-testid="AppTabBar_DirectMessage_Link"]');
    if (nav) {
      XDom.click(nav);
      await XDom.sleep(800);
    }
  }

  // 轻量滚动，加载侧栏列表（最多 2 次）
  const inboxScroller = document.querySelector('[data-testid="dm-inbox-panel"]')
    || document.querySelector('[data-testid="DmScrollerContainer"]');
  for (let i = 0; i < 2; i++) {
    if (inboxScroller) inboxScroller.scrollTop = inboxScroller.scrollHeight;
    await XDom.sleep(200);
  }

  let entries = XDom.listConversationEntries(maxConversations);
  if (!entries.length) {
    const nav = document.querySelector('[data-testid="AppTabBar_DirectMessage_Link"]');
    if (nav) {
      XDom.click(nav);
      await XDom.sleep(1000);
      entries = XDom.listConversationEntries(maxConversations);
    }
  }

  // 先固定 href 列表，避免 DOM 刷新导致索引错位
  const targets = entries.map((e) => ({ href: e.href, path: e.path, preview: e.preview }));
  const threads = [];
  const total = targets.length;

  reportSyncProgress('scrape', 0, total);

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const opened = await XDom.openConversationByHref(t.href, { timeout: 9000 });
    if (!opened.ok) {
      threads.push({ screenName: null, messages: [], error: opened.error, preview: t.preview });
      reportSyncProgress('scrape', i + 1, total);
      continue;
    }
    if (XDom.isPasscodeGate()) {
      await XDom.tryUnlockPasscode(passcode);
      await XDom.sleep(500);
    }
    // 等 handle 出现（新版头像区 @xxx）
    await XDom.waitFor(() => XDom.parseScreenNameFromOpenConversation(), { timeout: 3500, interval: 120 });
    const screenName = XDom.parseScreenNameFromOpenConversation()
      || guessCurrentScreenName();
    const scraped = await XDom.scrapeConversationMessagesWithRetry({ attempts: 12, scrollWait: 220 });
    const previewMsgs = XDom.parsePreviewMessages(t.preview);
    let messages = scraped.length ? scraped : XDom.mergeMessageLists(scraped, previewMsgs);
    if (!messages.length) {
      await XDom.sleep(600);
      const retry = await XDom.scrapeConversationMessagesWithRetry({ attempts: 8, scrollWait: 280 });
      messages = retry.length ? retry : XDom.mergeMessageLists(retry, previewMsgs);
    }
    threads.push({
      screenName,
      messages,
      chatPath: t.path,
      preview: t.preview
    });
    reportSyncProgress('scrape', i + 1, total);
  }

  return { ok: true, threads, count: threads.length };
}

function reportSyncProgress(phase, current, total) {
  chrome.runtime.sendMessage({
    type: 'SYNC_PROGRESS',
    phase,
    current,
    total
  }).catch(() => {});
}

function guessCurrentScreenName() {
  const fromPanel = XDom.parseScreenNameFromOpenConversation?.();
  if (fromPanel) return fromPanel;

  const title = document.title || '';
  const m1 = title.match(/@([A-Za-z0-9_]{1,15})/);
  if (m1) return m1[1].toLowerCase();
  const href = location.href;
  const m2 = href.match(/messages\/([A-Za-z0-9_]{1,15})/i);
  if (m2) return m2[1].toLowerCase();
  const header = document.querySelector('[data-testid="DmActivityContainer"]')
    || document.querySelector('main');
  if (header) {
    const t = header.innerText || '';
    const m3 = t.match(/@([A-Za-z0-9_]{1,15})/);
    if (m3) return m3[1].toLowerCase();
  }
  return null;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function showToast(message) {
  const id = 'bioby-twitter-dm-toast';
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.style.cssText = [
      'position:fixed',
      'z-index:2147483647',
      'left:50%',
      'bottom:24px',
      'transform:translateX(-50%)',
      'background:#15202b',
      'color:#e7e9ea',
      'border:1px solid #1d9bf0',
      'border-radius:999px',
      'padding:10px 16px',
      'font:13px/1.4 system-ui,sans-serif',
      'box-shadow:0 8px 24px rgba(0,0,0,.35)',
      'max-width:90vw',
      'pointer-events:none'
    ].join(';');
    document.documentElement.appendChild(el);
  }
  el.textContent = message;
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => el.remove(), 4500);
}
