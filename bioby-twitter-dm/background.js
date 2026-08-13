chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const SYNC_PROGRESS_KEY = 'syncProgress';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'SYNC_PROGRESS') {
    chrome.storage.session.set({
      [SYNC_PROGRESS_KEY]: {
        phase: msg.phase || 'scrape',
        current: Number(msg.current) || 0,
        total: Number(msg.total) || 0,
        updatedAt: Date.now()
      }
    }).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'CLEAR_SYNC_PROGRESS') {
    chrome.storage.session.remove(SYNC_PROGRESS_KEY).catch(() => {});
    sendResponse({ ok: true });
    return false;
  }

  if (msg.type === 'OPEN_PROFILE') {
    (async () => {
      try {
        const url = resolveProfileUrl(msg.profileUrl, msg.screenName);
        if (!url) {
          sendResponse({ ok: false, error: '缺少 profileUrl / screenName' });
          return;
        }
        const tab = await chrome.tabs.create({ url, active: true });
        await waitTabComplete(tab.id);
        try {
          await ensureContentReady(tab.id);
          await chrome.tabs.sendMessage(tab.id, {
            type: 'INJECT_DM_DRAFT',
            text: msg.draftText || '',
            leadId: msg.leadId
          });
        } catch (_) { /* ignore */ }
        sendResponse({ ok: true, tabId: tab.id });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'AUTO_SEND_DM') {
    (async () => {
      try {
        const url = resolveProfileUrl(msg.profileUrl, msg.screenName);
        if (!url) {
          sendResponse({ ok: false, error: '缺少 profileUrl / screenName' });
          return;
        }
        const passcode = msg.passcode || '1234';
        const tab = await chrome.tabs.create({ url, active: true });
        await waitTabComplete(tab.id);
        await ensureContentReady(tab.id);

        // passcode gate may redirect
        await chrome.tabs.sendMessage(tab.id, { type: 'ENSURE_PASSCODE', passcode }).catch(() => ({}));
        await sleep(500);

        const result = await chrome.tabs.sendMessage(tab.id, {
          type: 'AUTO_SEND_DM',
          text: msg.text || '',
          passcode,
          leadId: msg.leadId
        });

        if (result && result.ok && msg.closeTab !== false) {
          // 给 toast「私信已确认发送」约 1s 观察时间
          await sleep(1200);
          try { await chrome.tabs.remove(tab.id); } catch (_) { /* ignore */ }
        }
        sendResponse(result || { ok: false, error: '无响应' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg.type === 'SYNC_INBOX') {
    (async () => {
      try {
        const passcode = msg.passcode || '1234';
        const maxConversations = Math.min(Math.max(Number(msg.maxConversations) || 10, 1), 30);
        await chrome.storage.session.set({
          [SYNC_PROGRESS_KEY]: {
            phase: 'scrape',
            current: 0,
            total: maxConversations,
            updatedAt: Date.now()
          }
        }).catch(() => {});
        let tab = await findXTab();
        const inboxUrl = 'https://x.com/i/chat';
        if (!tab) {
          tab = await chrome.tabs.create({ url: inboxUrl, active: true });
          await waitTabComplete(tab.id);
        } else {
          // 已在 /i/chat 则不强制刷新，避免整页重载拖慢同步
          const alreadyInbox = tab.url && /x\.com\/i\/chat/i.test(tab.url);
          if (!alreadyInbox) {
            await chrome.tabs.update(tab.id, { url: inboxUrl, active: true });
            await waitTabComplete(tab.id);
          } else {
            await chrome.tabs.update(tab.id, { active: true });
            await sleep(300);
          }
        }
        await ensureContentReady(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: 'ENSURE_PASSCODE', passcode }).catch(() => ({}));
        await sleep(300);
        const scraped = await chrome.tabs.sendMessage(tab.id, {
          type: 'SCRAPE_INBOX_BATCH',
          passcode,
          maxConversations
        });
        sendResponse(scraped || { ok: false, error: '抓取无响应' });
      } catch (e) {
        sendResponse({ ok: false, error: e.message || String(e) });
      } finally {
        chrome.storage.session.remove(SYNC_PROGRESS_KEY).catch(() => {});
      }
    })();
    return true;
  }

  return false;
});

function resolveProfileUrl(profileUrl, screenName) {
  if (profileUrl && /^https?:\/\//i.test(profileUrl)) {
    return profileUrl.replace('twitter.com', 'x.com');
  }
  if (screenName) {
    return `https://x.com/${String(screenName).replace(/^@/, '')}`;
  }
  return null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function waitTabComplete(tabId) {
  return new Promise((resolve) => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 900);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((t) => {
      if (t.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(resolve, 900);
      }
    }).catch(() => resolve());
  });
}

async function ensureContentReady(tabId) {
  for (let i = 0; i < 8; i++) {
    try {
      // ping：空 passcode 不会误提交解锁表单
      await chrome.tabs.sendMessage(tabId, { type: 'ENSURE_PASSCODE', passcode: '' });
      return true;
    } catch (_) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['xDom.js', 'content.js']
        });
      } catch (_) { /* ignore */ }
      await sleep(400);
    }
  }
  return false;
}

async function findXTab() {
  const tabs = await chrome.tabs.query({ url: ['https://x.com/*', 'https://twitter.com/*'] });
  return tabs[0] || null;
}
