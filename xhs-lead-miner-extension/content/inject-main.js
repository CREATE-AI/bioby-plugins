/**
 * 隔离环境：检测主世界脚本是否就绪，未就绪则请求 background 用 scripting API 注入
 * （script 标签注入会被小红书 CSP 拦截，不可用）
 */
(function initXhsInjectMain() {
  if (window.__XHS_INJECT_MAIN__) return;
  window.__XHS_INJECT_MAIN__ = true;

  const CMD_ATTR = 'data-xhs-lead-filter-cmd';
  const RES_ATTR = 'data-xhs-lead-filter-res';

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function pingMainViaDom() {
    return new Promise((resolve) => {
      const requestId = `ping_${Date.now()}`;
      const timer = setTimeout(() => {
        document.removeEventListener('xhs-lead-filter-result', onResult);
        resolve(false);
      }, 2000);

      function onResult(ev) {
        if (ev.detail?.requestId !== requestId) return;
        clearTimeout(timer);
        document.removeEventListener('xhs-lead-filter-result', onResult);
        resolve(Boolean(ev.detail?.result?.ok));
      }

      document.addEventListener('xhs-lead-filter-result', onResult);
      try {
        const root = document.documentElement;
        root.setAttribute(CMD_ATTR, JSON.stringify({ action: 'ping', requestId }));
        document.dispatchEvent(new CustomEvent('xhs-lead-filter-action', {
          detail: { action: 'ping', requestId },
        }));
      } catch {
        clearTimeout(timer);
        document.removeEventListener('xhs-lead-filter-result', onResult);
        resolve(false);
      }
    });
  }

  async function requestBackgroundInject() {
    try {
      await chrome.runtime.sendMessage({ type: 'INJECT_FILTER_MAIN' });
      return true;
    } catch {
      return false;
    }
  }

  async function ensureMainInjected() {
    if (await pingMainViaDom()) return true;
    await requestBackgroundInject();
    await sleep(900);
    if (await pingMainViaDom()) return true;
    await sleep(600);
    return pingMainViaDom();
  }

  ensureMainInjected();

  let lastHref = location.href;
  setInterval(async () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      await ensureMainInjected();
      return;
    }
    const ready = document.documentElement?.getAttribute('data-xhs-filter-ready');
    if (!ready) await ensureMainInjected();
  }, 2500);

  window.__XHS_INJECT_MAIN__ = { ensureMainInjected, pingMainViaDom };
})();
