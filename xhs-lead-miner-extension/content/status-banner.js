/** 页面顶部状态条（全扩展唯一入口，避免主世界/隔离世界各建一条） */
(function initXhsLeadStatusBanner() {
  if (window.__XHS_LEAD_STATUS_BANNER__) return;
  window.__XHS_LEAD_STATUS_BANNER__ = true;

  const BANNER_ID = '__xhs_lead_status_banner__';
  const EVENT_NAME = 'xhs-lead-status-show';

  let banner = null;
  let hideTimer = null;

  function dedupeBanners() {
    const nodes = document.querySelectorAll(`#${BANNER_ID}`);
    nodes.forEach((el, index) => {
      if (index === 0) {
        banner = el;
      } else {
        el.remove();
      }
    });
  }

  function ensureBanner() {
    dedupeBanners();
    if (banner?.isConnected) return banner;

    const existing = document.getElementById(BANNER_ID);
    if (existing) {
      banner = existing;
      return banner;
    }

    banner = document.createElement('div');
    banner.id = BANNER_ID;
    banner.style.cssText = [
      'position:fixed',
      'top:10px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'background:rgba(20,20,20,.88)',
      'color:#fff',
      'padding:10px 18px',
      'border-radius:10px',
      'font-size:13px',
      'line-height:1.4',
      'max-width:min(92vw,520px)',
      'text-align:center',
      'box-shadow:0 4px 18px rgba(0,0,0,.25)',
      'pointer-events:none',
      'font-family:-apple-system,BlinkMacSystemFont,sans-serif',
    ].join(';');
    (document.documentElement || document.body).appendChild(banner);
    return banner;
  }

  function show(message, durationMs = 12000) {
    if (!message) return;
    const el = ensureBanner();
    el.textContent = message;
    el.style.display = 'block';
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (el) el.style.display = 'none';
    }, durationMs);
  }

  document.addEventListener(EVENT_NAME, (ev) => {
    const { message, durationMs } = ev.detail || {};
    show(message, durationMs);
  });

  window.__XHS_LEAD_STATUS__ = { show };
  window.__XHS_LEAD_STATUS_EVENT__ = EVENT_NAME;

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'SHOW_LEAD_STATUS') {
      show(message.message || '', message.durationMs || 12000);
    }
  });

  dedupeBanners();
})();
