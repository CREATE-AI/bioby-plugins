/**
 * 在笔记详情页尝试点击「收藏」
 */
(function initCollectHelper() {
  if (window.__XHS_COLLECT_HELPER__) return;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function visible(el) {
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return rect.width > 0 && rect.height > 0
      && style.visibility !== 'hidden'
      && style.display !== 'none';
  }

  function textOf(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function findCollectButton() {
    const candidates = Array.from(document.querySelectorAll('button, div[role="button"], span, a'));
    // 已收藏
    for (const el of candidates) {
      const t = textOf(el);
      if (!visible(el)) continue;
      if (/^已收藏$/.test(t) || t.includes('已收藏')) {
        return { el, already: true };
      }
    }
    // 未收藏：精确「收藏」且不是「收藏夹」
    for (const el of candidates) {
      const t = textOf(el);
      if (!visible(el)) continue;
      if (t === '收藏' || /^收藏\s*\d/.test(t)) {
        return { el, already: false };
      }
    }
    // aria / title
    const byAttr = document.querySelector(
      '[aria-label*="收藏"], [title*="收藏"], [aria-label*="Collect"], [aria-label*="collect"]',
    );
    if (byAttr && visible(byAttr)) {
      const t = textOf(byAttr);
      return { el: byAttr, already: /已收藏|collected/i.test(t) };
    }
    return null;
  }

  async function collectCurrentNote() {
    await sleep(1200);
    // 等详情弹层/页面渲染
    for (let i = 0; i < 10; i += 1) {
      const found = findCollectButton();
      if (found) {
        if (found.already) {
          return { ok: true, already: true, message: '已收藏过' };
        }
        found.el.click();
        await sleep(800);
        const after = findCollectButton();
        return {
          ok: true,
          already: false,
          message: after?.already ? '收藏成功' : '已点击收藏',
        };
      }
      await sleep(400);
    }
    return { ok: false, message: '未找到收藏按钮（页面结构可能变化）' };
  }

  window.__XHS_COLLECT_HELPER__ = { collectCurrentNote, findCollectButton };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'COLLECT_CURRENT_NOTE') {
      collectCurrentNote()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, message: String(e) }));
      return true;
    }
    return false;
  });
})();
