/**
 * 隔离环境：通过 DOM 属性桥接调用主世界筛选（filter-main.js）
 */
(function initXhsSearchFilter() {
  if (window.__XHS_SEARCH_FILTER__) return;

  const CMD_ATTR = 'data-xhs-lead-filter-cmd';
  const RES_ATTR = 'data-xhs-lead-filter-res';
  let requestSeq = 0;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async function humanDelay(minMs, maxMs) {
    await sleep(randomBetween(minMs, maxMs));
  }

  async function ensureMainWorldReady() {
    for (let i = 0; i < 4; i += 1) {
      const ping = await callMainWorld('ping', {}, 2500);
      if (ping?.ok) return true;
      if (window.__XHS_INJECT_MAIN__?.ensureMainInjected) {
        await window.__XHS_INJECT_MAIN__.ensureMainInjected();
      }
      try {
        await chrome.runtime.sendMessage({ type: 'INJECT_FILTER_MAIN' });
      } catch {
        // ignore
      }
      await humanDelay(400, 700);
    }
    return false;
  }

  function callMainWorld(action, extra = {}, timeoutMs = 12000) {
    const requestId = `req_${Date.now()}_${requestSeq += 1}`;
    return new Promise((resolve) => {
      const root = document.documentElement;
      let done = false;

      const finish = (result) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        document.removeEventListener('xhs-lead-filter-result', onEvent);
        observer.disconnect();
        root.removeAttribute(RES_ATTR);
        resolve(result);
      };

      const onEvent = (ev) => {
        if (ev.detail?.requestId !== requestId) return;
        finish(ev.detail?.result || { ok: false, error: '无返回' });
      };

      const observer = new MutationObserver(() => {
        const raw = root.getAttribute(RES_ATTR);
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.requestId !== requestId) return;
          finish(parsed.result || { ok: false, error: '无返回' });
        } catch {
          finish({ ok: false, error: '主世界返回解析失败' });
        }
      });

      observer.observe(root, { attributes: true, attributeFilter: [RES_ATTR] });
      document.addEventListener('xhs-lead-filter-result', onEvent);

      const timer = setTimeout(() => {
        finish({ ok: false, error: '主世界筛选操作超时（请刷新扩展后重试）' });
      }, timeoutMs);

      root.setAttribute(CMD_ATTR, JSON.stringify({ action, requestId, ...extra }));
      document.dispatchEvent(new CustomEvent('xhs-lead-filter-action', {
        detail: { action, requestId, ...extra },
      }));
    });
  }

  function readFeedBridgeSnapshot() {
    try {
      const el = document.getElementById('__xhs_lead_feed_bridge__');
      if (!el?.textContent) return null;
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  }

  function verifyResultsFresh(maxAgeDays) {
    const days = Number(maxAgeDays);
    if (!days || days <= 0) return { ok: true, skipped: true };

    const bridge = readFeedBridgeSnapshot();
    const notes = Object.values(bridge?.byNoteId || {}).slice(0, 10);
    if (!notes.length) return { ok: null, reason: '无页面数据' };

    const maxMs = days * 24 * 60 * 60 * 1000;
    const graceMs = Math.min(24 * 60 * 60 * 1000, maxMs * 0.15);
    let withTime = 0;
    let tooOld = 0;

    for (const note of notes) {
      const ts = Date.parse(note.publishAt || '');
      if (!Number.isFinite(ts)) continue;
      withTime += 1;
      if (Date.now() - ts > maxMs + graceMs) tooOld += 1;
    }

    if (withTime === 0) return { ok: null, reason: '样本无时间' };
    return { ok: (tooOld / withTime) <= 0.34, withTime, tooOld };
  }

  function mapMaxAgeToPublishFilter(maxAgeDays) {
    const days = Number(maxAgeDays);
    if (!days || days <= 0) return null;
    if (days <= 1) return '一天内';
    if (days <= 7) return '一周内';
    if (days <= 183) return '半年内';
    return null;
  }

  async function closeNoteModalIfOpen() {
    document.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
    }));
    await humanDelay(300, 500);
    return true;
  }

  async function ensureSearchFilters(maxAgeDays = 7) {
    await closeNoteModalIfOpen();
    const days = Number(maxAgeDays) || 7;

    const ready = await ensureMainWorldReady();
    if (ready) {
      const applied = await callMainWorld('apply', { maxAgeDays: days }, 5000);
      if (applied?.ok) {
        return {
          ok: true,
          via: applied.via || 'plugin_only',
          maxAgeDays: days,
          message: applied.message || `插件按近 ${days} 天过滤`,
          mainWorld: applied,
        };
      }
    }

    return {
      ok: true,
      via: 'plugin_only',
      maxAgeDays: days,
      message: `插件按近 ${days} 天过滤（未使用小红书筛选）`,
    };
  }

  window.__XHS_SEARCH_FILTER__ = {
    ensureSearchFilters,
    mapMaxAgeToPublishFilter,
    verifyResultsFresh,
    closeNoteModalIfOpen,
    callMainWorld,
  };
})();
