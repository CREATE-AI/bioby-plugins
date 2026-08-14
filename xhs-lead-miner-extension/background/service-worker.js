import { DEFAULT_CONFIG, STORAGE_KEYS, XHS_FILTER_GROUPS, DEFAULT_XHS_FILTER_PRESET } from '../lib/constants.js';
import { buildSearchUrl, humanDelay } from '../lib/human-behavior.js';
import { upsertLeads, getConfig, setConfig, setRunState, getRunState, getLeads, updateLeadReview } from '../lib/storage.js';
import { judgeLeadsWithAi, testAiConnection, chunkArray } from '../lib/ai-judge.js';
import { classifyLeadMaxAge } from '../lib/age-filter.js';
import { resolveLeadPublishAt } from '../lib/publish-time.js';

let activeTabId = null;
let stopRequested = false;
let queueRunning = false;
let keepAliveAlarm = 'xhs-lead-keepalive';

const STALE_RUN_MS = 10 * 60 * 1000;

async function enableRightSidePanel() {
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {
    // 旧版 Chrome 无 sidePanel
  }
}

enableRightSidePanel();
chrome.runtime.onInstalled.addListener(enableRightSidePanel);
chrome.runtime.onStartup.addListener(enableRightSidePanel);

chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (tab?.windowId) {
      await chrome.sidePanel.open({ windowId: tab.windowId });
    } else if (tab?.id) {
      await chrome.sidePanel.open({ tabId: tab.id });
    }
  } catch {
    // ignore
  }
});

/** 在页面主世界读取 __INITIAL_STATE__ 中的小红书号映射（isolated 世界读不到） */
async function extractRedIdMapFromTab(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const unwrap = (v) => {
          if (v && typeof v === 'object' && ('value' in v || '_value' in v)) {
            return v.value !== undefined ? v.value : v._value;
          }
          return v;
        };
        const pickRed = (user) => {
          const u = unwrap(user) || {};
          const red = u.red_id || u.redId || u.redID || u.xhs_id || u.xhsId || '';
          const s = String(red || '').trim();
          if (!s || /^[a-f0-9]{24}$/i.test(s)) return '';
          return s.slice(0, 64);
        };
        const byNoteId = {};
        const byAuthorId = {};
        try {
          const state = unwrap(window.__INITIAL_STATE__);
          if (!state) return { byNoteId, byAuthorId };
          const lists = [];
          const a = unwrap(state.search?.feeds);
          const b = unwrap(state.feed?.feeds);
          if (a) lists.push(a);
          if (b) lists.push(b);
          const noteMap = unwrap(state.note?.noteDetailMap) || {};
          for (const key of Object.keys(noteMap)) {
            const entry = unwrap(noteMap[key]) || {};
            const note = unwrap(entry.note) || unwrap(entry) || {};
            const user = unwrap(note.user) || {};
            const red = pickRed(user);
            const noteId = note.note_id || note.noteId || note.id || key;
            const authorId = user.user_id || user.userid || user.userId || user.id || '';
            if (red && noteId) byNoteId[String(noteId)] = red;
            if (red && authorId) byAuthorId[String(authorId)] = red;
          }
          for (const list of lists) {
            const arr = Array.isArray(list) ? list : [];
            for (const item of arr) {
              const card = unwrap(item?.note_card) || unwrap(item?.noteCard) || unwrap(item) || {};
              const noteId = card.note_id || card.noteId || card.id || item?.id || '';
              const user = unwrap(card.user) || unwrap(item?.user) || {};
              const authorId = user.user_id || user.userid || user.userId || user.id || '';
              const red = pickRed(user);
              if (!red) continue;
              if (noteId) byNoteId[String(noteId)] = red;
              if (authorId) byAuthorId[String(authorId)] = red;
            }
          }
          const userPage = unwrap(state.user?.userPageData) || {};
          const basic = unwrap(userPage.basicInfo) || userPage;
          const pageRed = pickRed(basic) || pickRed(userPage);
          const pageUid = basic.user_id || basic.userid || basic.userId || '';
          if (pageRed && pageUid) byAuthorId[String(pageUid)] = pageRed;
        } catch {
          // ignore
        }
        return { byNoteId, byAuthorId };
      },
    });
    return result || { byNoteId: {}, byAuthorId: {} };
  } catch {
    return { byNoteId: {}, byAuthorId: {} };
  }
}

function applyRedIdMap(items, map) {
  if (!Array.isArray(items) || !map) return items;
  const byNoteId = map.byNoteId || {};
  const byAuthorId = map.byAuthorId || {};
  for (const item of items) {
    if (!item || item.redId) continue;
    const red = byNoteId[String(item.noteId || '')]
      || byAuthorId[String(item.authorId || '')]
      || '';
    if (red) item.redId = red;
  }
  return items;
}

function isRunStale(state) {
  if (!state || (state.status !== 'running' && state.status !== 'stopping')) {
    return false;
  }
  if (!queueRunning) return true;
  const stamp = Date.parse(state.updatedAt || state.startedAt || '') || 0;
  if (!stamp) return false;
  return Date.now() - stamp > STALE_RUN_MS;
}

async function forceIdle(reason = '已重置为空闲') {
  stopRequested = true;
  queueRunning = false;
  activeTabId = null;
  try {
    await chrome.alarms.clear(keepAliveAlarm);
  } catch {
    // ignore
  }
  try {
    await chrome.action.setBadgeText({ text: '' });
  } catch {
    // ignore
  }
  await setRunState({
    status: 'idle',
    finishedAt: new Date().toISOString(),
    currentKeyword: null,
    error: null,
    resetReason: reason,
    lastProgress: { phase: 'idle', reason },
    updatedAt: new Date().toISOString(),
  });
}

async function notifyTabStatus(tabId, message, durationMs = 12000) {
  if (!tabId || !message) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'SHOW_LEAD_STATUS',
      message,
      durationMs,
    });
  } catch {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content/status-banner.js'],
      });
      await chrome.tabs.sendMessage(tabId, {
        type: 'SHOW_LEAD_STATUS',
        message,
        durationMs,
      });
    } catch {
      // ignore
    }
  }
}

async function touchRun(patch = {}) {
  const prev = await getRunState();
  await setRunState({
    ...prev,
    ...patch,
    status: patch.status || prev.status || 'running',
    updatedAt: new Date().toISOString(),
  });
  const msg = patch.lastProgress?.message
    || (patch.lastProgress?.phase === 'search_filters' ? '正在应用搜索筛选…' : '')
    || (patch.lastProgress?.phase === 'search_filters_done' ? '筛选完成，准备滚动' : '')
    || (patch.lastProgress?.phase === 'scrolling' ? '正在滚动采集…' : '');
  if (msg && activeTabId) {
    notifyTabStatus(activeTabId, `线索助手：${msg.replace(/^线索助手：/, '')}`).catch(() => {});
  }
}

async function startKeepAlive() {
  try {
    await chrome.alarms.create(keepAliveAlarm, { periodInMinutes: 0.4 });
  } catch {
    // ignore
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== keepAliveAlarm) return;
  if (!queueRunning) return;
  touchRun({ keepalive: Date.now() }).catch(() => {});
});

function normalizeUrlForCompare(href) {
  try {
    const u = new URL(href);
    u.hash = '';
    return `${u.origin}${u.pathname}?${u.searchParams.toString()}`;
  } catch {
    return String(href || '');
  }
}

async function focusTabForFilter(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    await chrome.tabs.update(tabId, { active: true });
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        window.scrollTo({ top: 0, behavior: 'auto' });
        document.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true,
        }));
      },
    });
  } catch {
    // ignore
  }
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return tab;
    } catch {
      throw new Error('标签页已关闭');
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('页面加载超时');
}

async function pingContentScript(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
    return Boolean(response?.ok);
  } catch {
    return false;
  }
}

async function ensureStateBridge(tabId) {
  if (!tabId) return false;
  try {
    const [{ result: already }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => Boolean(
        window.__XHS_FILTER_PING__
        && window.__XHS_APPLY_FILTER__
        && window.__XHS_APPLY_NEWEST__
        && window.__XHS_WAIT_PANEL__
        && window.__XHS_BEGIN_WAIT_PANEL__
        && window.__XHS_TAKE_WAIT_PANEL__
      ),
    });
    if (already) return true;
  } catch {
    // continue to inject
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['content/state-bridge.js', 'content/filter-main.js'],
    });
    await new Promise((r) => setTimeout(r, 600));
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => Boolean(
        window.__XHS_FILTER_PING__
        && window.__XHS_APPLY_FILTER__
        && window.__XHS_APPLY_NEWEST__
        && window.__XHS_WAIT_PANEL__
        && window.__XHS_BEGIN_WAIT_PANEL__
        && window.__XHS_TAKE_WAIT_PANEL__
      ),
    });
    return Boolean(result);
  } catch {
    return false;
  }
}

/** 等待搜索页「筛选」按钮出现（页面跳转后 Vue 渲染需要时间） */
async function waitForSearchPageReady(tabId, timeoutMs = 25000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          const norm = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, '').trim();
          let hasFilter = false;
          let cardCount = 0;
          for (const el of document.querySelectorAll('button, span, div, a')) {
            const r = el.getBoundingClientRect();
            if (r.width < 4 || r.height < 4) continue;
            if (norm(el) === '筛选') hasFilter = true;
          }
          cardCount = document.querySelectorAll(
            'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/search_result/"]',
          ).length;
          return { hasFilter, cardCount, ready: hasFilter && cardCount >= 2 };
        },
      });
      if (result?.ready) return true;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

/**
 * 在后台主世界直接调用 __XHS_APPLY_FILTER__（与 Console 手动测试同一路径）
 */
async function readFilterUiStateOnTab(tabId, maxAgeDays = 7) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (d) => {
        if (typeof window.__XHS_READ_FILTER_STATE__ === 'function') {
          return window.__XHS_READ_FILTER_STATE__(d);
        }
        return { match: false, error: 'no reader' };
      },
      args: [maxAgeDays],
    });
    return result || { match: false };
  } catch {
    return { match: false };
  }
}

function isXhsSearchResultUrl(url) {
  return /xiaohongshu\.com\/search_result/i.test(String(url || ''));
}

async function findXhsSearchTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (isXhsSearchResultUrl(active?.url)) return { tab: active };

  const inWindow = await chrome.tabs.query({
    currentWindow: true,
    url: ['https://www.xiaohongshu.com/search_result*'],
  });
  if (inWindow[0]) return { tab: inWindow[0] };

  const anySearch = await chrome.tabs.query({
    url: ['https://www.xiaohongshu.com/search_result*'],
  });
  if (anySearch[0]) return { tab: anySearch[0] };

  if (active?.url?.includes('xiaohongshu.com')) {
    return { error: '当前是小红书页面，但不是搜索结果页。请先搜一个关键词，再点「筛选最新」。' };
  }
  return { error: '请先打开小红书搜索结果页，再点「筛选最新」。' };
}

async function applyNewestSortOnTab(tabId) {
  await ensureStateBridge(tabId);
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async () => {
        if (typeof window.__XHS_APPLY_NEWEST__ === 'function') {
          return window.__XHS_APPLY_NEWEST__();
        }
        return { ok: false, error: '筛选脚本未注入，请刷新小红书页面后重试' };
      },
    });
    return result || { ok: false, error: '页面无返回' };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}

async function applyNewestByUrlNav(tabId, tabUrl) {
  const u = new URL(tabUrl);
  u.searchParams.set('sort', 'time_descending');
  await chrome.tabs.update(tabId, { url: u.toString(), active: true });
  await waitForTabComplete(tabId, 30000);
  await humanDelay(1800, 2800);
  await ensureStateBridge(tabId);
  await waitForSearchPageReady(tabId, 15000);

  const ui = await readFilterUiStateOnTab(tabId, 7);
  const tab = await chrome.tabs.get(tabId);
  let urlSort = false;
  try {
    urlSort = new URL(tab.url).searchParams.get('sort') === 'time_descending';
  } catch {
    urlSort = false;
  }
  const ok = ui?.state?.sort === '最新' || urlSort;
  return {
    ok,
    via: 'url_nav',
    state: ui?.state || null,
    urlSort,
    message: ok
      ? '页面点击失败，已用 URL sort=time_descending 刷新'
      : '点击和 URL 都未能确认「最新」',
    error: ok ? undefined : '点击和 URL 都未能确认「最新」',
  };
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function debuggerTarget(tabId) {
  return { tabId };
}

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.detach(debuggerTarget(tabId));
  } catch {
    // 未附着
  }
  await chrome.debugger.attach(debuggerTarget(tabId), '1.3');
}

async function detachDebugger(tabId) {
  try {
    await chrome.debugger.detach(debuggerTarget(tabId));
  } catch {
    // ignore
  }
}

async function cdpSend(tabId, method, params) {
  return chrome.debugger.sendCommand(debuggerTarget(tabId), method, params);
}

async function cdpMove(tabId, x, y) {
  await cdpSend(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Math.round(x),
    y: Math.round(y),
    pointerType: 'mouse',
  });
}

async function cdpClickAt(tabId, x, y) {
  const px = Math.round(x);
  const py = Math.round(y);
  await cdpMove(tabId, px, py);
  await new Promise((r) => setTimeout(r, 120));
  await cdpSend(tabId, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: px,
    y: py,
    button: 'left',
    buttons: 1,
    clickCount: 1,
    pointerType: 'mouse',
  });
  await new Promise((r) => setTimeout(r, 40));
  await cdpSend(tabId, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: px,
    y: py,
    button: 'left',
    buttons: 0,
    clickCount: 1,
    pointerType: 'mouse',
  });
}

async function cdpSlideTo(tabId, fromX, fromY, toX, toY, onStep) {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = Math.hypot(dx, dy) || 1;
  const steps = Math.max(6, Math.min(18, Math.round(dist / 16)));
  let x = fromX;
  let y = fromY;
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps;
    x = fromX + dx * t;
    y = fromY + dy * t;
    onStep?.(x, y);
    await cdpMove(tabId, x, y);
    await new Promise((r) => setTimeout(r, 40));
  }
  return { x, y };
}

async function keepMouseOnRight(tabId, x, y, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await cdpMove(tabId, x, y);
    await new Promise((r) => setTimeout(r, 90));
  }
}

function compactFilterDebug(debug) {
  if (!debug || typeof debug !== 'object') return debug || null;
  const filter = debug.filter;
  return {
    version: debug.version,
    drawerOpen: debug.drawerOpen,
    newestActive: debug.newestActive,
    weekActive: debug.weekActive,
    hasNewest: Boolean(debug.newest),
    hasPanel: Boolean(debug.panel),
    filterXY: filter ? { x: Math.round(filter.x), y: Math.round(filter.y) } : null,
    filterClass: debug.filterClass,
    nested: debug.debug || undefined,
  };
}

async function probeFilter(tabId) {
  await ensureStateBridge(tabId);
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      if (typeof window.__XHS_PROBE_FILTER__ === 'function') {
        return window.__XHS_PROBE_FILTER__();
      }
      return { error: '探测脚本未注入，请刷新小红书搜索页后再试' };
    },
  });
  return result || { error: '页面无探测结果' };
}

async function testSortNewest() {
  const found = await findXhsSearchTab();
  if (!found.tab) {
    return {
      ok: false,
      via: 'no_tab',
      reason: found.error || '没有找到小红书搜索结果页',
      error: found.error || '没有找到小红书搜索结果页',
    };
  }
  return applyPlatformNewestFilterOnTab(found.tab.id);
}

async function applyPlatformNewestFilterOnTab(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // ignore
  }
  await ensureStateBridge(tabId);

  try {
    await attachDebugger(tabId);
  } catch (error) {
    return {
      ok: false,
      via: 'debugger',
      reason: `无法模拟真实鼠标：${error?.message || error}。请关掉该页的 F12，重新加载扩展后再试。`,
      error: String(error?.message || error),
    };
  }

  try {
    let probe = await probeFilter(tabId);
    if (probe?.error) {
      return { ok: false, via: 'probe', reason: probe.error, error: probe.error };
    }
    if (!probe?.filter) {
      return {
        ok: false,
        via: 'no_filter_btn',
        reason: '右侧没找到「筛选」按钮。请停在搜索结果页（全部/图文那一行的右边）。',
        debug: probe?.debug,
      };
    }

    const stayX = probe.filter.x;
    const stayY = probe.filter.y;
    const alreadyOpen = Boolean(probe.drawerOpen && probe.newest);

    /**
     * 已验证：第一次点击不能取消。
     * 只悬停再点一次会失败。第一次点击会激活筛选热区（抽屉常会闪一下），
     * 鼠标继续停在按钮上时再点第二次，抽屉才会保持打开。
     */
    if (!alreadyOpen) {
      await cdpMove(tabId, stayX, stayY);
      await new Promise((r) => setTimeout(r, 300));
      await cdpClickAt(tabId, stayX, stayY);
    }

    let holding = true;
    const holdMouse = (async () => {
      while (holding) {
        try {
          await cdpMove(tabId, stayX, stayY);
        } catch {
          break;
        }
        await new Promise((r) => setTimeout(r, 120));
      }
    })();

    const waitPanel = async (timeoutMs) => {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: async (ms) => {
          if (typeof window.__XHS_WAIT_PANEL__ !== 'function') {
            return { error: '等待脚本未注入，请刷新小红书页面' };
          }
          const hit = await window.__XHS_WAIT_PANEL__(ms);
          if (!hit?.newest) {
            const d = hit?.debug || {};
            return {
              error: `已点「筛选」，但抽屉没保持打开。debug=${JSON.stringify(d)}`,
              debug: d,
            };
          }
          return { ok: true, ...hit };
        },
        args: [timeoutMs],
      });
      return result;
    };

    let dynamic = null;
    try {
      dynamic = await waitPanel(900);
      if (!dynamic?.ok) {
        await cdpClickAt(tabId, stayX, stayY);
        dynamic = await waitPanel(3500);
      }
    } finally {
      holding = false;
      await holdMouse;
    }

    if (!dynamic?.ok || !dynamic?.newest) {
      return {
        ok: false,
        via: 'no_newest',
        reason: dynamic?.error
          || '点了两次「筛选」，抽屉仍没保持打开。',
        debug: dynamic?.debug,
      };
    }

    await new Promise((r) => setTimeout(r, 180));
    await cdpMove(tabId, dynamic.newest.x, dynamic.newest.y);
    await new Promise((r) => setTimeout(r, 200));
    await cdpClickAt(tabId, dynamic.newest.x, dynamic.newest.y);
    await keepMouseOnRight(tabId, dynamic.newest.x, dynamic.newest.y, 280);

    // 点完「最新」立刻点「一周内」，用抽屉刚打开时记下的坐标，不要先 probe（抽屉一收就丢）。
    let week = dynamic.week;
    if (!week) {
      probe = await probeFilter(tabId);
      week = probe?.week;
    }
    let weekClicked = false;
    if (!week) {
      return {
        ok: false,
        clicked: true,
        via: 'no_week',
        reason: '已点「最新」，但没找到「一周内」坐标。',
        newestActive: Boolean((await probeFilter(tabId))?.newestActive),
        weekActive: false,
        weekClicked: false,
      };
    }
    await new Promise((r) => setTimeout(r, 150));
    await cdpMove(tabId, week.x, week.y);
    await new Promise((r) => setTimeout(r, 180));
    await cdpClickAt(tabId, week.x, week.y);
    await keepMouseOnRight(tabId, week.x, week.y, 280);
    weekClicked = true;

    // 抽屉靠悬停撑着：鼠标移出筛选区域就会收，不用点「收起」。
    const leaveX = dynamic.panel
      ? Math.max(80, dynamic.panel.left - 80)
      : Math.max(80, stayX - 220);
    const leaveY = (dynamic.panel?.top || stayY) + 180;
    await cdpSlideTo(tabId, week.x, week.y, leaveX, leaveY);
    await new Promise((r) => setTimeout(r, 400));

    probe = await probeFilter(tabId);
    const drawerClosed = !probe?.drawerOpen;
    return {
      ok: weekClicked,
      clicked: true,
      via: 'cdp_click',
      reason: `已点「最新」和「一周内」，鼠标已移出筛选区。抽屉${drawerClosed ? '已收' : '仍开着'}。`,
      message: drawerClosed ? '最新 + 一周内已选中，筛选已收起' : '已点最新和一周内并移开鼠标，请看筛选是否收起',
      newestActive: Boolean(probe?.newestActive) || weekClicked,
      weekActive: Boolean(probe?.weekActive) || weekClicked,
      weekClicked,
      drawerOpen: Boolean(probe?.drawerOpen),
      filterClass: probe?.filterClass,
    };
  } finally {
    await detachDebugger(tabId);
  }
}

async function applySearchFiltersOnTab(tabId, maxAgeDays = 7) {
  const days = Number(maxAgeDays) || 7;
  await focusTabForFilter(tabId);
  await ensureStateBridge(tabId);

  const ui = await applyPlatformNewestFilterOnTab(tabId);
  const applied = Boolean(ui?.clicked || ui?.newestActive || ui?.weekActive);
  if (applied) {
    const fresh = await waitForFilterResultsFresh(tabId, days, 12000);
    return {
      ok: true,
      via: ui.via || 'cdp_click',
      maxAgeDays: days,
      newestActive: Boolean(ui.newestActive),
      weekActive: Boolean(ui.weekActive),
      fresh,
      message: `已点筛选「最新」${ui.weekActive ? ' + 「一周内」' : ''}，开始采集`,
      ui,
    };
  }

  return {
    ok: true,
    via: 'plugin_only',
    maxAgeDays: days,
    newestActive: false,
    weekActive: false,
    warning: ui?.reason || ui?.error,
    message: '平台筛选未稳住，将不按发帖时间丢帖，继续采集',
    ui,
  };
}

/** 筛选点击后等待结果刷新，并抽样校验时间 */
async function waitForFilterResultsFresh(tabId, maxAgeDays, timeoutMs = 18000) {
  const days = Number(maxAgeDays) || 7;
  const start = Date.now();
  let last = { fresh: null, withTime: 0, tooOld: 0 };

  while (Date.now() - start < timeoutMs) {
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: (d) => {
          const maxMs = d * 24 * 60 * 60 * 1000;
          const graceMs = Math.min(24 * 60 * 60 * 1000, maxMs * 0.15);
          let withTime = 0;
          let tooOld = 0;
          try {
            const el = document.getElementById('__xhs_lead_feed_bridge__');
            if (el?.textContent) {
              const bridge = JSON.parse(el.textContent);
              const notes = Object.values(bridge?.byNoteId || {}).slice(0, 12);
              for (const note of notes) {
                const ts = Date.parse(note.publishAt || '');
                if (!Number.isFinite(ts)) continue;
                withTime += 1;
                if (Date.now() - ts > maxMs + graceMs) tooOld += 1;
              }
            }
          } catch {
            // ignore
          }
          const fresh = withTime >= 2 ? (tooOld / withTime) <= 0.34 : null;
          return { withTime, tooOld, fresh, settled: fresh !== null };
        },
        args: [days],
      });
      last = result || last;
      if (result?.settled) return result;
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 700));
  }

  return { ...last, settled: false, timeout: true };
}

async function ensureContentScript(tabId) {
  await ensureStateBridge(tabId);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const ready = await pingContentScript(tabId);
    if (ready) return;
    await new Promise((r) => setTimeout(r, 400));
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: [
      'content/inject-main.js',
      'content/status-banner.js',
      'content/time-parse.js',
      'content/extractor.js',
      'content/lead-filter.js',
      'content/search-filter.js',
      'content/content.js',
      'content/collect-helper.js',
      'content/note-detail.js',
    ],
  });
  await new Promise((r) => setTimeout(r, 500));
}

async function ensureCollectHelper(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'COLLECT_CURRENT_NOTE' });
    // 如果助手未加载，会失败；先注入再点
    if (res) return;
  } catch {
    // inject
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/collect-helper.js'],
  });
  await new Promise((r) => setTimeout(r, 400));
}

async function ensureNoteDetailHelper(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content/time-parse.js', 'content/note-detail.js'],
  });
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * 对 AI 候选限速补采笔记正文（控风控：限量 + 间隔 + 验证码停）
 * 在搜索页用真实鼠标点封面打开详情层，不再新开 explore 标签。
 */
async function enrichCandidatesWithDetail(candidates, config, keyword, searchTabId) {
  if (config.enrichNoteDetail === false) {
    return { candidates, enriched: 0, stoppedByCaptcha: false };
  }
  const limit = Math.min(
    Number(config.detailEnrichLimit) || 25,
    candidates.length,
  );
  if (limit <= 0) return { candidates, enriched: 0, stoppedByCaptcha: false };

  const delayMin = config.detailDelayMinMs || 2500;
  const delayMax = config.detailDelayMaxMs || 5000;
  let enriched = 0;
  let stoppedByCaptcha = false;

  let tabId = searchTabId;
  if (!tabId) {
    const found = await findXhsSearchTab();
    tabId = found.tab?.id;
  }
  if (!tabId) {
    return { candidates, enriched: 0, stoppedByCaptcha: false };
  }

  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.windowId) await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // ignore
  }

  try {
    await attachDebugger(tabId);
  } catch (error) {
    await touchRun({
      status: 'running',
      currentKeyword: keyword,
      lastProgress: {
        keyword,
        phase: 'detail_enrich_stopped',
        message: `无法模拟鼠标点详情：${error?.message || error}。请关掉该页 F12 后重试`,
      },
    });
    return { candidates, enriched: 0, stoppedByCaptcha: false };
  }

  try {
    for (let i = 0; i < limit; i += 1) {
      if (stopRequested) break;
      const item = candidates[i];
      const noteId = item?.noteId
        || String(item?.noteUrl || '').match(/[a-f0-9]{24}/i)?.[0]
        || '';
      if (!noteId) continue;

      await touchRun({
        status: 'running',
        currentKeyword: keyword,
        lastProgress: {
          keyword,
          phase: 'detail_enrich',
          enrichIndex: i + 1,
          enrichTotal: limit,
          title: item.title,
          via: 'mouse_click',
        },
      });

      try {
        const clicked = await clickSearchCardForNote(tabId, noteId);
        if (!clicked?.ok) continue;

        const overlay = await waitForNoteOverlay(tabId, 4500);
        if (!overlay?.hasOverlay && !overlay?.hasDesc && !overlay?.isExplore) {
          await closeNoteOverlayOnTab(tabId);
          continue;
        }

        await humanDelay(delayMin, delayMax);
        await ensureNoteDetailHelper(tabId);
        const res = await chrome.tabs.sendMessage(tabId, { type: 'ENRICH_CURRENT_NOTE' });
        const redMap = await extractRedIdMapFromTab(tabId);
        const redFromPage = redMap.byNoteId?.[String(item.noteId || '')]
          || redMap.byAuthorId?.[String(item.authorId || '')]
          || '';
        if (res?.captcha) {
          stoppedByCaptcha = true;
          break;
        }
        if (res?.ok && (res.desc || res.publishAt || res.redId || redFromPage)) {
          if (res.desc && res.desc.trim() && res.desc.trim() !== String(item.title || '').trim()) {
            item.desc = res.desc;
          }
          item.detailEnriched = true;
          if (res.publishAt || res.publishTimeText) {
            const resolved = resolveLeadPublishAt({
              publishAt: res.publishAt || item.publishAt,
              publishTimeText: res.publishTimeText || item.publishTimeText,
            });
            if (resolved.publishAt) {
              item.publishAt = resolved.publishAt;
              if (res.publishTimeText) item.publishTimeText = res.publishTimeText;
            }
          }
          if (res.redId || redFromPage) item.redId = res.redId || redFromPage;
          if (Array.isArray(res.imageUrls) && res.imageUrls.length && !item.coverImageUrl) {
            item.coverImageUrl = res.imageUrls[0];
          }
          enriched += 1;
        }
      } catch {
        // 单条失败不阻断
      }

      await closeNoteOverlayOnTab(tabId);
      await humanDelay(800, 1600);
    }
  } finally {
    try {
      await closeNoteOverlayOnTab(tabId);
    } catch {
      // ignore
    }
    await detachDebugger(tabId);
  }

  return { candidates, enriched, stoppedByCaptcha };
}

function toAcceptedLeads(candidates, judgedRows, keyword, options = {}) {
  const {
    minConfidence = 0.45,
    softConfidence = 0.35,
    preferCount = null,
    maxAgeDays = 0,
  } = options;

  const judgedMap = new Map(
    (judgedRows || []).map((row) => [String(row.noteId), row]),
  );
  const crawledAt = new Date().toISOString();
  const primary = [];
  const soft = [];
  const nowMs = Date.now();

  function passesAgeGate(item) {
    return classifyLeadMaxAge(item, maxAgeDays, nowMs) === 'ok';
  }

  /** AI 理由里明确判为非线索（含高置信度 false 的说明） */
  function hasRejectHint(reason) {
    return /教程|渠道|去哪找|别再|培训|求职|招聘|干货|攻略|服务商|自推|供给|卖课|机构|不是我们|不是客户|不符合|非客户|非线索|噪音|无关|同行|招客|内容号|盘点|方法论/.test(reason || '');
  }

  for (const item of candidates) {
    const judged = judgedMap.get(String(item.noteId));
    if (!judged) continue;

    const confidence = judged.confidence ?? 0;
    const rawIsLead = judged.rawIsLead ?? judged.isLead;
    const reason = judged.reason || '';
    const rejectHint = hasRejectHint(reason);

    // 入库前二次年龄校验
    if (!passesAgeGate(item)) {
      continue;
    }

    const base = {
      ...item,
      matchedKeyword: keyword,
      leadScore: Math.round(confidence * 100),
      leadTier: confidence >= 0.8 ? 'high' : confidence >= 0.5 ? 'medium' : 'low',
      filterReason: reason || 'AI 判定为有效线索',
      mustHavePath: 'ai',
      matchedSignals: `ai_confidence:${confidence}`,
      filterMode: 'ai',
      aiConfidence: confidence,
      aiReason: reason,
      collected: false,
      crawledAt,
    };

    // 供给广告即使 AI 漏判，也不进待确认/符合
    const titleBlob = `${item.title || ''} ${item.desc || ''}`;
    if (/(网红|红人|达人|出海|跨境).{0,8}(营销|投放|代投|推广).{0,12}就找|网红营销就找|就找我们|找我们合作|承接品牌|欢迎品牌方|承接出海|承接投放/.test(titleBlob)) {
      continue;
    }

    // AI 明确判非线索：直接丢弃，不进待确认
    if (!rawIsLead || rejectHint) {
      continue;
    }

    if (confidence >= minConfidence) {
      primary.push({
        ...base,
        reviewStatus: 'qualified',
        reviewSource: 'ai',
      });
      continue;
    }

    // 待确认：仅「AI 倾向是线索，但置信度偏低」的边界情况
    if (confidence >= softConfidence && confidence < minConfidence) {
      soft.push({
        ...base,
        filterReason: `${reason || '边缘线索'}（待人工确认）`,
        matchedSignals: `ai_confidence:${confidence};backfill=1`,
        reviewStatus: 'pending',
        reviewSource: 'ai_soft',
      });
    }
  }

  primary.sort((a, b) => {
    const ta = Date.parse(a.publishAt || '') || 0;
    const tb = Date.parse(b.publishAt || '') || 0;
    if (tb !== ta) return tb - ta;
    return b.aiConfidence - a.aiConfidence;
  });
  soft.sort((a, b) => {
    const ta = Date.parse(a.publishAt || '') || 0;
    const tb = Date.parse(b.publishAt || '') || 0;
    if (tb !== ta) return tb - ta;
    return b.aiConfidence - a.aiConfidence;
  });

  if (!preferCount || primary.length >= preferCount) return primary;
  return primary.concat(soft.slice(0, preferCount - primary.length));
}

async function judgeCandidatesInBackground(candidates, keyword, config) {
  const batchSize = Math.min(config.aiBatchSize ?? 6, 6);
  const chunks = chunkArray(candidates, batchSize);
  const allResults = [];
  let done = 0;

  for (const chunk of chunks) {
    if (stopRequested) break;

    await touchRun({
      status: 'running',
      currentKeyword: keyword,
      lastProgress: {
        keyword,
        phase: 'ai_judging',
        pendingAi: candidates.length - done,
        totalCandidates: candidates.length,
        judged: done,
        filterMode: 'ai',
      },
    });

    try {
      const { results } = await judgeLeadsWithAi({
        items: chunk,
        keyword,
        apiKey: config.aiApiKey,
        apiBaseUrl: config.aiApiBaseUrl || DEFAULT_CONFIG.aiApiBaseUrl,
        model: config.aiModel || DEFAULT_CONFIG.aiModel,
        minConfidence: config.aiMinConfidence ?? 0.45,
        timeoutMs: 35000,
      });
      allResults.push(...results);
    } catch (error) {
      for (const item of chunk) {
        allResults.push({
          noteId: item.noteId,
          isLead: false,
          rawIsLead: false,
          confidence: 0,
          reason: `AI 批次失败: ${String(error?.message || error).slice(0, 120)}`,
        });
      }
    }

    done += chunk.length;
    await new Promise((r) => setTimeout(r, 250));
  }

  return allResults;
}

/**
 * 打开笔记并点击收藏；结果写回 leads.collected
 */
async function collectLeads(leads, config) {
  // 只收藏人工/AI 标记为「符合」且未收藏的
  const list = (leads || []).filter(
    (l) => l.noteUrl && !l.collected && l.reviewStatus === 'qualified',
  );
  if (!list.length) {
    return { ok: true, collected: 0, failed: 0, results: [], message: '没有「符合」且未收藏的线索' };
  }

  const results = [];
  let collected = 0;
  let failed = 0;
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });

  try {
    for (let i = 0; i < list.length; i += 1) {
      if (stopRequested) break;
      const lead = list[i];

      await touchRun({
        status: 'running',
        lastProgress: {
          phase: 'collecting',
          collectIndex: i + 1,
          collectTotal: list.length,
          noteId: lead.noteId,
          title: lead.title,
        },
      });

      try {
        await chrome.tabs.update(tab.id, { url: lead.noteUrl, active: true });
        await waitForTabComplete(tab.id, 25000);
        await humanDelay(config.collectDelayMinMs || 2500, config.collectDelayMaxMs || 4500);
        await ensureCollectHelper(tab.id);

        const res = await chrome.tabs.sendMessage(tab.id, { type: 'COLLECT_CURRENT_NOTE' });
        if (res?.ok) {
          collected += 1;
          lead.collected = true;
          lead.collectMessage = res.message || '已收藏';
          results.push({ noteId: lead.noteId, ok: true, message: lead.collectMessage });
        } else {
          failed += 1;
          lead.collectMessage = res?.message || '收藏失败';
          results.push({ noteId: lead.noteId, ok: false, message: lead.collectMessage });
        }
      } catch (error) {
        failed += 1;
        lead.collectMessage = String(error?.message || error);
        results.push({ noteId: lead.noteId, ok: false, message: lead.collectMessage });
      }

      await upsertLeads([lead]);
      await humanDelay(1200, 2200);
    }
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // ignore
    }
  }

  return { ok: true, collected, failed, results };
}

async function crawlKeyword(tabId, keyword, config, stillNeedForTarget, skipNoteIds = []) {
  const url = buildSearchUrl(keyword);

  await touchRun({
    status: 'running',
    currentKeyword: keyword,
    lastProgress: { keyword, phase: 'search_filters', message: `正在打开搜索页，点筛选「最新 + 一周内」…` },
  });
  await notifyTabStatus(tabId, `线索助手：打开搜索页，点筛选「最新 + 一周内」…`, 12000);

  // 每次都带筛选参数刷新
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForTabComplete(tabId, 30000);
  await humanDelay(2500, 4000);
  await ensureContentScript(tabId);
  await waitForSearchPageReady(tabId);

  const searchFilters = await applySearchFiltersOnTab(tabId, 7);
  await notifyTabStatus(
    tabId,
    searchFilters.message || '线索助手：已处理搜索筛选',
    8000,
  );

  await touchRun({
    status: 'running',
    currentKeyword: keyword,
    lastProgress: {
      keyword,
      phase: 'search_filters_done',
      searchFilters,
      message: searchFilters.message || '筛选完成，准备滚动',
    },
  });

  await humanDelay(1200, 2000);

  await touchRun({
    status: 'running',
    currentKeyword: keyword,
    lastProgress: { keyword, phase: 'scrolling' },
  });

  // 给内容脚本加总超时，避免无限等待导致“卡死”
  const crawlTimeoutMs = Math.min(
    180000,
    20000 + (config.maxScrollRounds || 12) * ((config.scrollDelayMaxMs || 4000) + 2000),
  );

  const result = await Promise.race([
    chrome.tabs.sendMessage(tabId, {
      type: 'START_CRAWL',
      payload: {
        ...config,
        keyword,
        skipNoteIds,
        maxCandidatesPerKeyword: config.maxCandidatesPerKeyword ?? 100,
        maxAgeDays: 0,
        maxScrollRounds: Math.min(config.maxScrollRounds ?? 15, 20),
        searchFilters,
        skipSearchFilters: true,
      },
    }),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`关键词「${keyword}」滚动采集超时`)), crawlTimeoutMs);
    }),
  ]);

  if (!result?.ok) {
    throw new Error(result?.error || `关键词「${keyword}」采集失败`);
  }

  if (result.filterWarning) {
    await touchRun({
      status: 'running',
      currentKeyword: keyword,
      lastProgress: {
        keyword,
        phase: 'search_filters_warning',
        warning: result.filterWarning,
        searchFilters: result.filterStats?.searchFilters || searchFilters,
      },
    });
  }

  // 搜索页主世界补小红书号
  const redMap = await extractRedIdMapFromTab(tabId);
  let leads = applyRedIdMap(result.leads || [], redMap);
  if (Array.isArray(result.candidates)) {
    applyRedIdMap(result.candidates, redMap);
  }

  if (result.needsAi && Array.isArray(result.candidates) && result.candidates.length) {
    // 限制单词 AI 候选，避免卡太久
    let capped = result.candidates.slice(0, config.maxCandidatesPerKeyword ?? 80);

    // 限速补采正文，提升「需求 vs 广告」判断
    const enrichResult = await enrichCandidatesWithDetail(capped, config, keyword, tabId);
    capped = enrichResult.candidates;
    if (enrichResult.stoppedByCaptcha) {
      await touchRun({
        status: 'running',
        currentKeyword: keyword,
        lastProgress: {
          keyword,
          phase: 'detail_enrich_stopped',
          message: '详情补采遇验证码已停止，继续用现有文案做 AI',
          enriched: enrichResult.enriched,
        },
      });
    }

    const judged = await judgeCandidatesInBackground(capped, keyword, config);
    const preferCount = Math.max(
      config.minLeadsPerKeyword ?? 3,
      stillNeedForTarget || 0,
    );
    leads = toAcceptedLeads(capped, judged, keyword, {
      minConfidence: config.aiMinConfidence ?? 0.45,
      softConfidence: config.aiSoftConfidence ?? 0.35,
      preferCount,
      maxAgeDays: 0,
    });
  }

  if (leads.length) {
    await upsertLeads(leads);
  }

  return {
    ...result,
    leads,
    filterStats: {
      ...(result.filterStats || {}),
      toAi: result.candidates?.length || 0,
    },
  };
}

function shuffleKeywords(keywords) {
  const list = [...keywords];
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

/** 按日期轮转起点，再轻度打乱，避免相邻两天总从同一批词开始 */
function orderKeywordsForDailyRun(keywords) {
  if (!keywords?.length) return [];
  const day = Math.floor(Date.now() / 86400000);
  const offset = day % keywords.length;
  const rotated = keywords.slice(offset).concat(keywords.slice(0, offset));
  // 只打乱前半，保证每天起点不同且不全随机失控
  const mid = Math.ceil(rotated.length / 2);
  return shuffleKeywords(rotated.slice(0, mid)).concat(rotated.slice(mid));
}

async function runQueue(keywords, config) {
  stopRequested = false;
  queueRunning = true;
  await startKeepAlive();

  // 商用标准：默认以「符合」条数为完成目标；开启自动收藏时以收藏成功数为准
  const targetCollected = config.targetCollectedCount
    ?? config.targetLeadCount
    ?? 15;
  const autoCollect = config.autoCollect === true;

  // 库内已有笔记：本轮跳过，避免相邻两次搜到同一批
  const existingLeadsAtStart = await getLeads();
  const skipNoteIds = existingLeadsAtStart.map((l) => String(l.noteId)).filter(Boolean);
  const skipSet = new Set(skipNoteIds);

  let qualifiedThisRun = 0;
  let collectedOkThisRun = 0;
  let collectFailedThisRun = 0;
  const seenQualifiedIds = new Set();
  const runStats = {
    scanned: 0,
    toAi: 0,
    qualified: 0,
    collected: 0,
    collectFailed: 0,
    keywordsDone: 0,
    knownSkipped: skipNoteIds.length,
  };

  function progressCount() {
    return autoCollect ? collectedOkThisRun : qualifiedThisRun;
  }

  function stillNeedCount() {
    return Math.max(0, targetCollected - progressCount());
  }

  function metTarget() {
    return progressCount() >= targetCollected;
  }

  const orderedKeywords = orderKeywordsForDailyRun(keywords);

  const runState = {
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    currentKeyword: null,
    doneKeywords: [],
    totalKeywords: orderedKeywords.length,
    targetCollectedCount: targetCollected,
    targetLeadCount: targetCollected,
    acceptedThisRun: 0,
    collectedThisRun: 0,
    runStats,
    error: null,
    filterMode: config.useAiFilter ? 'ai' : 'rules',
  };
  await setRunState(runState);

  const tab = await chrome.tabs.create({
    url: buildSearchUrl(orderedKeywords[0]),
    active: true,
  });
  activeTabId = tab.id;
  try {
    await chrome.action.setBadgeText({ text: '采' });
    await chrome.action.setBadgeBackgroundColor({ color: '#e5445d' });
  } catch {
    // ignore
  }

  try {
    for (const keyword of orderedKeywords) {
      if (stopRequested) break;
      if (metTarget()) break;

      const stillNeed = stillNeedCount();
      runState.currentKeyword = keyword;
      await touchRun({
        ...runState,
        status: 'running',
        acceptedThisRun: qualifiedThisRun,
        collectedThisRun: collectedOkThisRun,
        runStats: { ...runStats },
        lastProgress: {
          keyword,
          phase: 'search_filters',
          filterMode: runState.filterMode,
          leadCount: qualifiedThisRun,
          collectedCount: collectedOkThisRun,
          targetCollectedCount: targetCollected,
          targetLeadCount: targetCollected,
          runStats: { ...runStats },
        },
      });

      let crawled;
      try {
        crawled = await crawlKeyword(
          activeTabId,
          keyword,
          config,
          stillNeed,
          [...skipSet],
        );
      } catch (error) {
        await touchRun({
          status: 'running',
          lastProgress: {
            phase: 'keyword_error',
            keyword,
            error: String(error?.message || error),
            leadCount: qualifiedThisRun,
            collectedCount: collectedOkThisRun,
            targetCollectedCount: targetCollected,
            runStats: { ...runStats },
          },
        });
        runState.doneKeywords.push(keyword);
        runStats.keywordsDone += 1;
        continue;
      }

      const crawlStats = crawled.filterStats || {};
      runStats.scanned += crawlStats.scanned || 0;
      runStats.toAi += crawlStats.toAi || crawled.candidates?.length || 0;
      runStats.knownSkipped = (runStats.knownSkipped || 0) + (crawlStats.knownSkipped || 0);

      const newLeads = crawled.leads || [];
      // 已收藏过的笔记本轮跳过，避免重复点收藏
      const existingLeads = await getLeads();
      const alreadyCollectedIds = new Set(
        existingLeads.filter((l) => l.collected).map((l) => String(l.noteId)),
      );
      // 「符合」按 noteId 去重计数（同一帖命中多个词只算 1）
      const qualifiedNew = [];
      for (const lead of newLeads) {
        if (lead.reviewStatus !== 'qualified') continue;
        const id = String(lead.noteId);
        if (alreadyCollectedIds.has(id) || seenQualifiedIds.has(id) || skipSet.has(id)) continue;
        seenQualifiedIds.add(id);
        skipSet.add(id); // 本轮后续词也跳过
        qualifiedNew.push(lead);
      }
      qualifiedThisRun = seenQualifiedIds.size;
      runStats.qualified = qualifiedThisRun;
      runState.doneKeywords.push(keyword);
      runStats.keywordsDone += 1;
      runState.acceptedThisRun = qualifiedThisRun;
      runState.collectedThisRun = collectedOkThisRun;

      // 可选：符合后尝试收藏（默认关闭，易触发扫码）
      if (autoCollect && qualifiedNew.length && !stopRequested) {
        const needMore = targetCollected - collectedOkThisRun;
        const toCollect = qualifiedNew.slice(0, Math.max(needMore, 0));
        const collectResult = await collectLeads(toCollect, config);
        collectedOkThisRun += collectResult.collected || 0;
        collectFailedThisRun += collectResult.failed || 0;
        runStats.collected = collectedOkThisRun;
        runStats.collectFailed = collectFailedThisRun;
      }

      runState.collectedThisRun = collectedOkThisRun;
      await touchRun({
        ...runState,
        status: 'running',
        currentKeyword: null,
        doneKeywords: [...runState.doneKeywords],
        acceptedThisRun: qualifiedThisRun,
        collectedThisRun: collectedOkThisRun,
        runStats: { ...runStats },
        lastProgress: {
          phase: 'keyword_done',
          keyword,
          leadCount: qualifiedThisRun,
          collectedCount: collectedOkThisRun,
          targetCollectedCount: targetCollected,
          targetLeadCount: targetCollected,
          filterMode: runState.filterMode,
          runStats: { ...runStats },
        },
      });

      if (metTarget()) break;
      if (!stopRequested) {
        await humanDelay(config.keywordDelayMinMs, config.keywordDelayMaxMs);
      }
    }

    const doneMet = metTarget();
    const summaryCore = autoCollect
      ? `扫描${runStats.scanned} · 跳过旧帖${runStats.knownSkipped || 0} · 符合${runStats.qualified} · 已收藏${runStats.collected}/${targetCollected}`
      : `扫描${runStats.scanned} · 跳过旧帖${runStats.knownSkipped || 0} · 符合${runStats.qualified}/${targetCollected}（请开主页私信）`;
    await setRunState({
      ...runState,
      status: 'idle',
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      currentKeyword: null,
      acceptedThisRun: qualifiedThisRun,
      collectedThisRun: collectedOkThisRun,
      runStats: { ...runStats },
      lastProgress: {
        phase: 'done',
        leadCount: qualifiedThisRun,
        collectedCount: collectedOkThisRun,
        targetCollectedCount: targetCollected,
        targetLeadCount: targetCollected,
        metTarget: doneMet,
        runStats: { ...runStats },
        summary: `${summaryCore}${doneMet ? '（达标）' : '（未满）'}`,
      },
    });
  } catch (error) {
    await setRunState({
      ...runState,
      status: 'error',
      error: String(error),
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      acceptedThisRun: qualifiedThisRun,
      collectedThisRun: collectedOkThisRun,
      runStats: { ...runStats },
    });
    throw error;
  } finally {
    activeTabId = null;
    stopRequested = false;
    queueRunning = false;
    try {
      await chrome.alarms.clear(keepAliveAlarm);
    } catch {
      // ignore
    }
  }
}

const labState = {
  tabId: null,
  attached: false,
  holding: false,
  holdLoop: null,
  holdX: 0,
  holdY: 0,
  stayX: 0,
  stayY: 0,
  dynamic: null,
  cards: [],
  lastCard: null,
  detailTabId: null,
  detailVia: null,
  searchUrl: null,
};

function labSessionText() {
  if (!labState.tabId && !labState.detailTabId) return '会话：未开始';
  const bits = [];
  if (labState.tabId) bits.push(`tab=${labState.tabId}`);
  if (labState.attached) bits.push('已接管鼠标');
  if (labState.holding) bits.push('正在悬停筛选区');
  if (labState.dynamic?.newest) bits.push('已拿到最新坐标');
  if (labState.dynamic?.week) bits.push('已拿到一周内坐标');
  if (labState.cards?.length) bits.push(`卡片${labState.cards.length}张`);
  if (labState.detailVia === 'click') bits.push('详情=鼠标点卡');
  if (labState.detailVia === 'url' && labState.detailTabId) bits.push(`详情tab=${labState.detailTabId}`);
  return `会话：${bits.join(' · ') || '未开始'}`;
}

async function labStopHold() {
  labState.holding = false;
  if (labState.holdLoop) {
    try { await labState.holdLoop; } catch { /* ignore */ }
    labState.holdLoop = null;
  }
}

function labStartHold(tabId, x, y) {
  labState.holdX = x;
  labState.holdY = y;
  if (labState.holding) return;
  labState.holding = true;
  labState.holdLoop = (async () => {
    while (labState.holding && labState.tabId === tabId) {
      try {
        await cdpMove(tabId, labState.holdX, labState.holdY);
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 120));
    }
  })();
}

async function cdpKeyEscape(tabId) {
  await cdpSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
  await new Promise((r) => setTimeout(r, 40));
  await cdpSend(tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Escape',
    code: 'Escape',
    windowsVirtualKeyCode: 27,
    nativeVirtualKeyCode: 27,
  });
}

async function probeFirstNoteCard(tabId, preferredNoteId = '') {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (wantId) => {
      const NOTE_RE = /\/(?:explore|discovery\/item|search_result\/[^/]+)\/([a-f0-9]{24})/i;
      const parseId = (href) => {
        const m = String(href || '').match(NOTE_RE);
        return m?.[1] || '';
      };
      const vis = (r) => r.width >= 48 && r.height >= 48
        && r.bottom > 90 && r.top < window.innerHeight - 24
        && r.left >= 0 && r.right <= window.innerWidth + 8;
      const cardRoot = (anchor) => {
        let node = anchor;
        for (let i = 0; i < 8 && node; i += 1) {
          if (node.querySelector?.('a[href*="/user/profile/"]')) return node;
          node = node.parentElement;
        }
        return anchor.parentElement || anchor;
      };
      const pickTarget = (anchor, allowOffscreen) => {
        const okRect = (r, minH = 48) => {
          if (!r || r.width < 48 || r.height < minH) return false;
          return allowOffscreen || vis(r);
        };
        const card = cardRoot(anchor);
        const img = card.querySelector?.('img');
        const ir = img?.getBoundingClientRect?.();
        if (okRect(ir, 80)) return { el: img, rect: ir, via: 'cover' };
        const ar = anchor.getBoundingClientRect();
        if (okRect(ar, 80)) return { el: anchor, rect: ar, via: 'link' };
        const cr = card.getBoundingClientRect();
        if (okRect(cr)) return { el: card, rect: cr, via: 'card' };
        return null;
      };
      const toHit = (item, noteId, href, title) => {
        const r = item.el.getBoundingClientRect();
        return {
          ok: true,
          noteId,
          href,
          title: String(title || '').replace(/\s+/g, ' ').trim().slice(0, 80),
          via: item.via,
          x: r.left + r.width / 2,
          y: r.top + Math.min(r.height * 0.32, 90),
          rect: {
            left: Math.round(r.left),
            top: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
        };
      };

      const anchors = Array.from(document.querySelectorAll(
        'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/search_result/"]',
      ));
      const seen = new Set();
      const candidates = [];
      for (const anchor of anchors) {
        const href = anchor.href || anchor.getAttribute('href') || '';
        if (/\/user\/profile\//i.test(href)) continue;
        const noteId = parseId(href);
        if (!noteId || seen.has(noteId)) continue;
        seen.add(noteId);
        const allowOffscreen = Boolean(wantId) && noteId === wantId;
        const item = pickTarget(anchor, allowOffscreen);
        if (!item) continue;
        const title = (anchor.innerText || item.el?.alt || '').slice(0, 80);
        candidates.push({ noteId, href, title, item });
      }
      if (!candidates.length) {
        return { ok: false, error: '视口里没找到可点的笔记封面' };
      }
      const preferred = wantId
        ? candidates.find((c) => c.noteId === wantId)
        : null;
      if (wantId && !preferred) {
        return { ok: false, error: '页面 DOM 里没有这张笔记卡', wantId, candidateCount: candidates.length };
      }
      const picked = preferred || candidates[0];
      try {
        picked.item.el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'auto' });
      } catch {
        // ignore
      }
      const hit = toHit(picked.item, picked.noteId, picked.href, picked.title);
      return { ...hit, preferredHit: Boolean(preferred), candidateCount: candidates.length };
    },
    args: [preferredNoteId || ''],
  });
  return result || { ok: false, error: '页面无探测结果' };
}

async function probeNoteOverlay(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      const pick = (el) => (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
      const desc = document.querySelector(
        '#detail-desc, [id*="detail-desc"], [class*="note-text"], [class*="desc"]',
      );
      const descText = pick(desc).slice(0, 160);
      const overlay = document.querySelector(
        '[class*="note-detail"], [class*="note-container"], [class*="noteContainer"], [class*="close-circle"]',
      );
      let close = null;
      for (const el of document.querySelectorAll(
        '[class*="close"], [class*="Close"], [aria-label*="关闭"], [aria-label*="close"]',
      )) {
        const r = el.getBoundingClientRect();
        if (r.width < 10 || r.height < 10 || r.width > 72 || r.height > 72) continue;
        if (r.left > window.innerWidth * 0.5) continue;
        if (r.top < 8 || r.top > window.innerHeight * 0.7) continue;
        close = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        break;
      }
      return {
        url: location.href,
        path: location.pathname,
        hasDesc: descText.length >= 8,
        descPreview: descText,
        hasOverlay: Boolean(overlay || (desc && descText.length >= 8)),
        isExplore: /\/(?:explore|discovery\/item)\//i.test(location.pathname),
        close,
      };
    },
  });
  return result || { hasOverlay: false };
}

async function waitForNoteOverlay(tabId, timeoutMs = 4500) {
  const start = Date.now();
  let last = { hasOverlay: false };
  while (Date.now() - start < timeoutMs) {
    last = await probeNoteOverlay(tabId);
    if (last?.hasOverlay || last?.hasDesc || last?.isExplore) return last;
    await new Promise((r) => setTimeout(r, 280));
  }
  return last;
}

async function closeNoteOverlayOnTab(tabId) {
  const isOpen = (overlay) => Boolean(overlay?.hasOverlay || overlay?.hasDesc);

  try {
    let overlay = await probeNoteOverlay(tabId);
    if (!isOpen(overlay) && !overlay?.isExplore) return;

    if (overlay?.close) {
      await cdpClickAt(tabId, overlay.close.x, overlay.close.y);
    } else {
      await cdpKeyEscape(tabId);
    }
    await new Promise((r) => setTimeout(r, 500));

    overlay = await probeNoteOverlay(tabId);
    if (isOpen(overlay)) {
      await cdpKeyEscape(tabId);
      await new Promise((r) => setTimeout(r, 400));
    }

    overlay = await probeNoteOverlay(tabId);
    if (isOpen(overlay)) {
      await cdpClickAt(tabId, 36, 240);
      await new Promise((r) => setTimeout(r, 400));
    }

    const start = Date.now();
    while (Date.now() - start < 2500) {
      overlay = await probeNoteOverlay(tabId);
      if (!isOpen(overlay)) return;
      await new Promise((r) => setTimeout(r, 250));
    }
  } catch {
    // ignore
  }
}

async function clickSearchCardForNote(tabId, noteId) {
  const tryProbe = () => probeFirstNoteCard(tabId, noteId);

  let probe = await tryProbe();
  if (noteId && !probe?.ok) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => window.scrollTo({ top: 0, behavior: 'auto' }),
    });
    await new Promise((r) => setTimeout(r, 700));
    probe = await tryProbe();
  }
  if (!probe?.ok) {
    return { ok: false, error: probe?.error || '搜索页没找到这张笔记卡' };
  }
  await new Promise((r) => setTimeout(r, 280));
  const again = await probeFirstNoteCard(tabId, probe.noteId);
  if (again?.ok) probe = again;
  await cdpMove(tabId, probe.x, probe.y);
  await new Promise((r) => setTimeout(r, 180));
  await cdpClickAt(tabId, probe.x, probe.y);
  return { ok: true, ...probe };
}

async function labCloseDetailTab() {
  const via = labState.detailVia;
  const searchTabId = labState.tabId;
  const extraTabId = labState.detailTabId;
  labState.detailVia = null;
  labState.detailTabId = null;

  if (via === 'click' && searchTabId) {
    await closeNoteOverlayOnTab(searchTabId);
    return;
  }

  if (!extraTabId || extraTabId === searchTabId) return;
  try {
    await chrome.tabs.remove(extraTabId);
  } catch {
    // ignore
  }
}

async function labEndSession() {
  await labStopHold();
  await labCloseDetailTab();
  if (labState.attached && labState.tabId) {
    await detachDebugger(labState.tabId);
  }
  labState.tabId = null;
  labState.attached = false;
  labState.dynamic = null;
  labState.stayX = 0;
  labState.stayY = 0;
  labState.cards = [];
  labState.lastCard = null;
  labState.detailVia = null;
  labState.searchUrl = null;
}

function isXhsNoteDetailUrl(url) {
  return /xiaohongshu\.com\/(?:explore|discovery\/item)\//i.test(String(url || ''));
}

async function labResolveDetailTabId() {
  if (labState.detailVia === 'click' && labState.tabId) {
    return labState.tabId;
  }
  if (labState.detailTabId) {
    try {
      const tab = await chrome.tabs.get(labState.detailTabId);
      if (tab?.id && isXhsNoteDetailUrl(tab.url)) return tab.id;
    } catch {
      labState.detailTabId = null;
    }
  }
  const detailTabs = await chrome.tabs.query({
    url: [
      'https://www.xiaohongshu.com/explore/*',
      'https://www.xiaohongshu.com/discovery/item/*',
    ],
  });
  if (detailTabs[0]?.id) {
    labState.detailTabId = detailTabs[0].id;
    return detailTabs[0].id;
  }
  return null;
}

function pickLabCard(cards) {
  return (cards || []).find((c) => c?.noteId || c?.noteUrl) || null;
}

function labCardNoteUrl(card) {
  if (!card) return '';
  if (card.noteUrl) return card.noteUrl;
  if (card.noteId) return `https://www.xiaohongshu.com/explore/${card.noteId}`;
  return '';
}

async function labEnsureSession() {
  const found = await findXhsSearchTab();
  if (!found.tab) {
    return { ok: false, error: found.error || '请先打开小红书搜索结果页' };
  }
  const tabId = found.tab.id;
  if (labState.tabId && labState.tabId !== tabId) {
    await labEndSession();
  }
  labState.tabId = tabId;
  try {
    if (found.tab.windowId) await chrome.windows.update(found.tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    // ignore
  }
  await ensureStateBridge(tabId);
  await ensureContentScript(tabId);
  if (!labState.attached) {
    try {
      await attachDebugger(tabId);
      labState.attached = true;
    } catch (error) {
      return {
        ok: false,
        error: `无法模拟真实鼠标：${error?.message || error}。请关掉该页的 F12 后再试。`,
      };
    }
  }
  return { ok: true, tabId, url: found.tab.url };
}

async function labWaitPanel(tabId, timeoutMs) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (ms) => {
      if (typeof window.__XHS_WAIT_PANEL__ !== 'function') {
        return { error: '等待脚本未注入，请刷新小红书页面' };
      }
      const hit = await window.__XHS_WAIT_PANEL__(ms);
      if (!hit?.newest) {
        return { error: '抽屉没打开', debug: hit?.debug || {} };
      }
      return { ok: true, ...hit };
    },
    args: [timeoutMs],
  });
  return result;
}

async function labLoadCardsFromSearch() {
  if (labState.cards?.length) {
    return { ok: true, cards: labState.cards, reused: true };
  }
  const ready = await labEnsureSession();
  if (!ready.ok) return ready;
  await ensureContentScript(labState.tabId);
  const res = await chrome.tabs.sendMessage(labState.tabId, { type: 'TEST_EXTRACT_CARDS' });
  labState.cards = Array.isArray(res?.cards) ? res.cards : [];
  labState.lastCard = pickLabCard(labState.cards);
  return {
    ok: Boolean(res?.ok) && labState.cards.length > 0,
    count: labState.cards.length,
    cards: labState.cards,
    error: labState.cards.length ? undefined : '搜索页没有读到卡片，请先点步骤 6',
  };
}

async function runLabDetailStep(step) {
  if (step === 'openNoteDetail') {
    const loaded = await labLoadCardsFromSearch();
    if (!loaded.ok) {
      return { ...loaded, session: labSessionText() };
    }
    const card = pickLabCard(loaded.cards);
    const noteUrl = labCardNoteUrl(card);
    if (!noteUrl) {
      return { ok: false, error: '卡片没有笔记链接，请先点步骤 6 再试', session: labSessionText() };
    }
    labState.lastCard = card;
    labState.detailVia = 'url';

    if (labState.detailTabId) {
      try {
        await chrome.tabs.update(labState.detailTabId, { url: noteUrl, active: true });
      } catch {
        labState.detailTabId = null;
      }
    }
    if (!labState.detailTabId) {
      const tab = await chrome.tabs.create({ url: noteUrl, active: true });
      labState.detailTabId = tab.id;
    }
    await waitForTabComplete(labState.detailTabId, 25000);
    await humanDelay(900, 1400);
    return {
      ok: true,
      message: `已打开详情：${card.title || card.noteId}`,
      card: {
        title: card.title || '',
        authorName: card.authorName || '',
        noteId: card.noteId || '',
        noteUrl,
        publishTimeText: card.publishTimeText || '',
        publishAt: card.publishAt || '',
        redId: card.redId || '',
      },
      session: labSessionText(),
    };
  }

  const detailTabId = await labResolveDetailTabId();
  if (!detailTabId) {
    return {
      ok: false,
      error: '还没有详情页。请先点步骤 7，或手动打开一条笔记再点 8',
      session: labSessionText(),
    };
  }

  try {
    await chrome.tabs.update(detailTabId, { active: true });
  } catch {
    // ignore
  }
  await waitForTabComplete(detailTabId, 25000);
  await humanDelay(800, 1200);
  await ensureNoteDetailHelper(detailTabId);

  let res;
  try {
    res = await chrome.tabs.sendMessage(detailTabId, { type: 'ENRICH_CURRENT_NOTE' });
  } catch (error) {
    return {
      ok: false,
      error: `详情页脚本无响应：${error?.message || error}`,
      session: labSessionText(),
    };
  }

  const card = labState.lastCard || {};
  const redMap = await extractRedIdMapFromTab(detailTabId);
  const redFromPage = redMap.byNoteId?.[String(card.noteId || '')]
    || redMap.byAuthorId?.[String(card.authorId || '')]
    || '';
  const redId = res?.redId || redFromPage || '';

  if (res?.captcha) {
    return {
      ok: false,
      captcha: true,
      message: res.message || '检测到登录/验证码，已停止详情补采',
      session: labSessionText(),
    };
  }

  const desc = res?.desc || '';
  const title = card.title || '';
  const descSameAsTitle = Boolean(desc && title && desc.trim() === title.trim());
  return {
    ok: Boolean(res?.ok && (desc || res.publishAt || redId)),
    message: res?.ok
      ? `详情已读：正文 ${desc.length} 字${descSameAsTitle ? '（与标题相同，正式采集不会覆盖）' : ''}`
      : (res?.message || '未解析到笔记正文'),
    before: {
      title,
      desc: card.desc || '',
      publishTimeText: card.publishTimeText || '',
      publishAt: card.publishAt || '',
      redId: card.redId || '',
    },
    after: {
      desc,
      descSameAsTitle,
      imageCount: Array.isArray(res?.imageUrls) ? res.imageUrls.length : 0,
      publishTimeText: res?.publishTimeText || '',
      publishAt: res?.publishAt || '',
      redId,
    },
    session: labSessionText(),
  };
}

function normalizeLabFilterPreset(raw) {
  const preset = { ...DEFAULT_XHS_FILTER_PRESET, ...(raw || {}) };
  for (const group of XHS_FILTER_GROUPS) {
    if (!group.labels.includes(preset[group.key])) {
      preset[group.key] = DEFAULT_XHS_FILTER_PRESET[group.key];
    }
  }
  return preset;
}

async function labEnsureDrawerOpen(tabId) {
  const probe = await probeFilter(tabId);
  if (!probe?.filter) {
    return { ok: false, error: '没找到「筛选」按钮', debug: probe };
  }
  labState.stayX = probe.filter.x;
  labState.stayY = probe.filter.y;
  const alreadyOpen = Boolean(probe.drawerOpen && probe.newest);
  labStartHold(tabId, labState.stayX, labState.stayY);
  if (!alreadyOpen) {
    await cdpMove(tabId, labState.stayX, labState.stayY);
    await new Promise((r) => setTimeout(r, 300));
    await cdpClickAt(tabId, labState.stayX, labState.stayY);
  }
  let dynamic = await labWaitPanel(tabId, 900);
  if (!dynamic?.ok) {
    await cdpClickAt(tabId, labState.stayX, labState.stayY);
    dynamic = await labWaitPanel(tabId, 3500);
  }
  labState.dynamic = dynamic;
  if (!dynamic?.ok || !dynamic?.newest) {
    return { ok: false, error: dynamic?.error || '抽屉没保持打开', dynamic };
  }
  return { ok: true, dynamic };
}

async function runLabStep(step, payload = {}) {
  if (step === 'endSession') {
    await labEndSession();
    return { ok: true, message: '会话已结束', session: labSessionText() };
  }

  if (step === 'closeNoteDetail') {
    const had = Boolean(labState.detailTabId) || labState.detailVia === 'click';
    const via = labState.detailVia;
    await labCloseDetailTab();
    if (labState.tabId) {
      try {
        await chrome.tabs.update(labState.tabId, { active: true });
      } catch {
        // ignore
      }
    }
    return {
      ok: true,
      message: had
        ? (via === 'click' ? '已关掉详情层，回到搜索' : '已关掉详情页，回到搜索')
        : '没有打开中的详情',
      session: labSessionText(),
    };
  }

  if (step === 'openSearch') {
    const keyword = payload.keyword || '美区influencer';
    const url = buildSearchUrl(keyword);
    let tabId = labState.tabId;
    if (tabId) {
      await chrome.tabs.update(tabId, { url, active: true });
    } else {
      const tab = await chrome.tabs.create({ url, active: true });
      tabId = tab.id;
    }
    await waitForTabComplete(tabId, 30000);
    await humanDelay(1200, 1800);
    const ready = await labEnsureSession();
    if (!ready.ok) return { ...ready, session: labSessionText() };
    return { ok: true, message: `已打开搜索：${keyword}`, url, session: labSessionText() };
  }

  if (step === 'openNoteDetail' || step === 'enrichNoteDetail') {
    return runLabDetailStep(step);
  }

  const ready = await labEnsureSession();
  if (!ready.ok) return { ...ready, session: labSessionText() };
  const tabId = labState.tabId;

  if (step === 'clickNoteDetail') {
    await labStopHold();
    try {
      const tab = await chrome.tabs.get(tabId);
      labState.searchUrl = tab?.url || labState.searchUrl;
    } catch {
      // ignore
    }
    if (labState.detailVia === 'url' && labState.detailTabId) {
      try { await chrome.tabs.remove(labState.detailTabId); } catch { /* ignore */ }
      labState.detailTabId = null;
    }

    const alreadyOpen = await probeNoteOverlay(tabId);
    if (alreadyOpen?.hasOverlay || alreadyOpen?.isExplore) {
      labState.detailVia = 'click';
      return {
        ok: true,
        message: '详情层已经开着，直接点 8 读取即可',
        overlay: alreadyOpen,
        session: labSessionText(),
      };
    }

    const preferredId = labState.lastCard?.noteId || '';
    let probe = await probeFirstNoteCard(tabId, preferredId);
    if (!probe?.ok) {
      return { ok: false, error: probe?.error || '没找到可点的笔记封面', session: labSessionText() };
    }
    await new Promise((r) => setTimeout(r, 350));
    const again = await probeFirstNoteCard(tabId, probe.noteId);
    if (again?.ok) probe = again;

    await cdpMove(tabId, probe.x, probe.y);
    await new Promise((r) => setTimeout(r, 220));
    await cdpClickAt(tabId, probe.x, probe.y);
    await new Promise((r) => setTimeout(r, 1600));

    const overlay = await probeNoteOverlay(tabId);
    labState.detailVia = 'click';
    labState.lastCard = {
      ...(labState.lastCard || {}),
      noteId: probe.noteId,
      noteUrl: probe.href || labCardNoteUrl({ noteId: probe.noteId }),
      title: probe.title || labState.lastCard?.title || '',
    };

    const opened = Boolean(overlay?.hasOverlay || overlay?.hasDesc || overlay?.isExplore);
    return {
      ok: true,
      message: opened
        ? '已用鼠标点封面，搜索页上像是弹出了详情'
        : '已用鼠标点封面。请看搜索页有没有弹出详情层（主采集还不会走这条）',
      via: 'mouse_click',
      probe: {
        noteId: probe.noteId,
        title: probe.title,
        clickVia: probe.via,
        x: Math.round(probe.x),
        y: Math.round(probe.y),
        preferredHit: probe.preferredHit,
      },
      overlay,
      session: labSessionText(),
    };
  }

  if (step === 'openFilter') {
    const opened = await labEnsureDrawerOpen(tabId);
    return {
      ...opened,
      message: opened.ok ? '筛选抽屉已打开，鼠标停在「筛选」上' : opened.error,
      session: labSessionText(),
    };
  }

  if (step === 'applyPresetFilters') {
    const preset = normalizeLabFilterPreset(payload.preset);
    const opened = await labEnsureDrawerOpen(tabId);
    if (!opened.ok) {
      return { ...opened, preset, session: labSessionText() };
    }

    const chips = opened.dynamic?.presetChips || {};
    const toClick = [];
    for (const group of XHS_FILTER_GROUPS) {
      const want = preset[group.key];
      const chip = chips?.[group.key]?.[want];
      if (!chip) {
        toClick.push({ group: group.key, label: want, skip: true, error: '打开时没记到坐标' });
        continue;
      }
      if (chip.active) {
        toClick.push({ group: group.key, label: want, skip: true, already: true });
        continue;
      }
      toClick.push({ group: group.key, label: want, chip });
    }

    await labStopHold();
    let lastX = labState.stayX;
    let lastY = labState.stayY;
    const clicks = [];
    for (const item of toClick) {
      if (item.skip) {
        clicks.push({
          group: item.group,
          label: item.label,
          ok: Boolean(item.already),
          already: item.already,
          error: item.error,
        });
        continue;
      }
      const chip = item.chip;
      await cdpMove(tabId, chip.x, chip.y);
      await new Promise((r) => setTimeout(r, 180));
      await cdpClickAt(tabId, chip.x, chip.y);
      await keepMouseOnRight(tabId, chip.x, chip.y, 280);
      lastX = chip.x;
      lastY = chip.y;
      clicks.push({ group: item.group, label: item.label, ok: true, clicked: true });
    }

    const leaveX = opened.dynamic?.panel
      ? Math.max(80, opened.dynamic.panel.left - 80)
      : Math.max(80, (labState.stayX || 400) - 220);
    const leaveY = (opened.dynamic?.panel?.top || labState.stayY || 160) + 180;
    await cdpSlideTo(tabId, lastX, lastY, leaveX, leaveY);
    await new Promise((r) => setTimeout(r, 400));

    const failed = clicks.filter((c) => !c.ok && !c.already);
    return {
      ok: failed.length === 0,
      message: failed.length
        ? `已按打开时记下的坐标点完，${failed.length} 项没坐标`
        : '已按打开时记下的坐标点完筛选，鼠标已移出',
      preset,
      clicks,
      session: labSessionText(),
    };
  }

  if (step === 'clickNewest') {
    let newest = labState.dynamic?.newest;
    if (!newest) {
      const probe = await probeFilter(tabId);
      newest = probe?.newest;
      labState.dynamic = { ...(labState.dynamic || {}), ...probe };
    }
    if (!newest) {
      return { ok: false, error: '没有「最新」坐标，请先点步骤 1', session: labSessionText() };
    }
    labStartHold(tabId, newest.x, newest.y);
    await new Promise((r) => setTimeout(r, 180));
    await cdpClickAt(tabId, newest.x, newest.y);
    labState.holdX = newest.x;
    labState.holdY = newest.y;
    await new Promise((r) => setTimeout(r, 280));
    const probe = await probeFilter(tabId);
    return {
      ok: true,
      message: probe?.newestActive ? '「最新」已变红' : '已点「最新」，请看是否变红',
      newestActive: Boolean(probe?.newestActive),
      drawerOpen: Boolean(probe?.drawerOpen),
      session: labSessionText(),
    };
  }

  if (step === 'clickWeek') {
    let week = labState.dynamic?.week;
    if (!week) {
      const probe = await probeFilter(tabId);
      week = probe?.week;
      labState.dynamic = { ...(labState.dynamic || {}), ...probe };
    }
    if (!week) {
      return { ok: false, error: '没有「一周内」坐标，请先点步骤 1 和 2', session: labSessionText() };
    }
    labStartHold(tabId, week.x, week.y);
    await new Promise((r) => setTimeout(r, 150));
    await cdpClickAt(tabId, week.x, week.y);
    labState.holdX = week.x;
    labState.holdY = week.y;
    await new Promise((r) => setTimeout(r, 280));
    const probe = await probeFilter(tabId);
    return {
      ok: true,
      message: probe?.weekActive ? '「一周内」已变红' : '已点「一周内」，请看是否变红',
      weekActive: Boolean(probe?.weekActive),
      newestActive: Boolean(probe?.newestActive),
      drawerOpen: Boolean(probe?.drawerOpen),
      session: labSessionText(),
    };
  }

  if (step === 'leaveFilter') {
    const fromX = labState.holdX || labState.stayX;
    const fromY = labState.holdY || labState.stayY;
    const leaveX = labState.dynamic?.panel
      ? Math.max(80, labState.dynamic.panel.left - 80)
      : Math.max(80, (labState.stayX || 400) - 220);
    const leaveY = (labState.dynamic?.panel?.top || labState.stayY || 160) + 180;
    await labStopHold();
    await cdpSlideTo(tabId, fromX, fromY, leaveX, leaveY);
    await new Promise((r) => setTimeout(r, 400));
    const probe = await probeFilter(tabId);
    return {
      ok: true,
      message: probe?.drawerOpen ? '鼠标已移出，但抽屉仍开着' : '鼠标已移出，抽屉已收',
      drawerOpen: Boolean(probe?.drawerOpen),
      session: labSessionText(),
    };
  }

  if (step === 'scrollOnce') {
    await ensureContentScript(tabId);
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'TEST_SCROLL_ONCE' });
      return { ok: Boolean(res?.ok), ...res, session: labSessionText() };
    } catch (error) {
      return { ok: false, error: String(error?.message || error), session: labSessionText() };
    }
  }

  if (step === 'extractCards') {
    await ensureContentScript(tabId);
    try {
      const res = await chrome.tabs.sendMessage(tabId, { type: 'TEST_EXTRACT_CARDS' });
      labState.cards = Array.isArray(res?.cards) ? res.cards : [];
      labState.lastCard = pickLabCard(labState.cards);
      return { ok: Boolean(res?.ok), ...res, session: labSessionText() };
    } catch (error) {
      return { ok: false, error: String(error?.message || error), session: labSessionText() };
    }
  }

  return { ok: false, error: `未知步骤：${step}`, session: labSessionText() };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    if (message.type === 'INJECT_FILTER_MAIN') {
      let tabId = _sender?.tab?.id;
      if (!tabId) {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        tabId = tab?.id;
      }
      const ok = tabId ? await ensureStateBridge(tabId) : false;
      sendResponse({ ok, tabId });
      return;
    }

    if (message.type === 'START_RUN') {
      const config = {
        ...DEFAULT_CONFIG,
        ...(message.payload?.config || (await getConfig()) || {}),
      };
      // 强制默认 DeepSeek，除非用户改了
      if (!config.aiApiBaseUrl) config.aiApiBaseUrl = DEFAULT_CONFIG.aiApiBaseUrl;
      if (!config.aiModel) config.aiModel = DEFAULT_CONFIG.aiModel;

      // 日产模式：默认不开自动收藏；目标以「符合」为准（收藏仅可选）
      config.dailyCapacityMode = true;
      config.autoCollect = config.autoCollect === true;
      config.maxAgeDays = 0;
      config.targetCollectedCount = Number(config.targetCollectedCount)
        || Number(config.targetLeadCount)
        || DEFAULT_CONFIG.targetCollectedCount;
      config.targetLeadCount = config.targetCollectedCount;

      const keywords = (message.payload?.keywords || config.keywords || [])
        .map((k) => k.trim())
        .filter(Boolean);

      if (!keywords.length) {
        sendResponse({ ok: false, error: '请至少配置一个关键词' });
        return;
      }

      if (config.useAiFilter && !config.aiApiKey?.trim()) {
        sendResponse({ ok: false, error: '请填写你的 DeepSeek API Key' });
        return;
      }

      const current = await getRunState();
      if (current.status === 'running' || current.status === 'stopping') {
        if (isRunStale(current) || !queueRunning) {
          await forceIdle('检测到卡住的旧任务，已自动重置');
        } else {
          sendResponse({ ok: false, error: '任务正在运行中，请先点停止或「重置状态」' });
          return;
        }
      }

      await setConfig(config);
      runQueue(keywords, config)
        .then(() => chrome.runtime.sendMessage({ type: 'RUN_FINISHED' }).catch(() => {}))
        .catch(() => chrome.runtime.sendMessage({ type: 'RUN_FINISHED' }).catch(() => {}));

      sendResponse({ ok: true, targetCollectedCount: config.targetCollectedCount });
      return;
    }

    if (message.type === 'STOP_RUN') {
      stopRequested = true;
      if (activeTabId) {
        try {
          await chrome.tabs.sendMessage(activeTabId, { type: 'STOP_CRAWL' });
        } catch {
          // ignore
        }
      }
      await forceIdle('用户停止');
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'RESET_RUN') {
      if (activeTabId) {
        try {
          await chrome.tabs.sendMessage(activeTabId, { type: 'STOP_CRAWL' });
        } catch {
          // ignore
        }
      }
      await forceIdle(message.payload?.reason || '手动重置状态');
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'GET_RUN_STATE') {
      let state = await getRunState();
      if (isRunStale(state)) {
        await forceIdle('打开弹窗时发现状态已过期，已自动重置');
        state = await getRunState();
      }
      sendResponse({ ok: true, state, queueRunning });
      return;
    }

    if (message.type === 'UPDATE_LEAD_REVIEW') {
      const { noteId, reviewStatus } = message.payload || {};
      if (!noteId || !['qualified', 'rejected', 'pending'].includes(reviewStatus)) {
        sendResponse({ ok: false, error: '参数无效' });
        return;
      }
      const leads = await updateLeadReview(noteId, reviewStatus);
      sendResponse({ ok: true, leads });
      return;
    }

    if (message.type === 'COLLECT_LEADS') {
      try {
        const config = (await getConfig()) || DEFAULT_CONFIG;
        const all = message.payload?.leads || (await getLeads());
        const pending = all.filter(
          (l) => !l.collected && l.reviewStatus === 'qualified',
        );
        if (!pending.length) {
          sendResponse({
            ok: true,
            collected: 0,
            failed: 0,
            message: '没有「符合」且未收藏的线索。请先把线索标成「符合」。',
          });
          return;
        }
        stopRequested = false;
        queueRunning = true;
        await startKeepAlive();
        await touchRun({ status: 'running', lastProgress: { phase: 'collecting' } });
        const result = await collectLeads(pending, { ...DEFAULT_CONFIG, ...config });
        await forceIdle('收藏完成');
        sendResponse(result);
      } catch (error) {
        await forceIdle('收藏出错');
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
      return;
    }

    if (message.type === 'TEST_SORT_NEWEST') {
      try {
        const result = await withTimeout(
          testSortNewest(),
          28000,
          '测试超时（28秒）。请到 chrome://extensions 重新加载扩展后再试',
        );
        sendResponse(result);
      } catch (error) {
        sendResponse({
          ok: false,
          via: 'timeout',
          reason: String(error?.message || error),
          error: String(error?.message || error),
        });
      }
      return;
    }

    if (message.type === 'TEST_LAB_STEP') {
      try {
        const result = await withTimeout(
          runLabStep(message.payload?.step, message.payload || {}),
          40000,
          '测试步骤超时（40秒）',
        );
        sendResponse(result);
      } catch (error) {
        sendResponse({
          ok: false,
          error: String(error?.message || error),
          session: labSessionText(),
        });
      }
      return;
    }

    if (message.type === 'TEST_AI') {
      try {
        await testAiConnection({
          apiKey: message.payload?.apiKey,
          apiBaseUrl: message.payload?.apiBaseUrl || DEFAULT_CONFIG.aiApiBaseUrl,
          model: message.payload?.model || DEFAULT_CONFIG.aiModel,
        });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: String(error?.message || error) });
      }
      return;
    }

    sendResponse({
      ok: false,
      error: `unknown message: ${message?.type || '(empty)'}。请重新加载扩展`,
    });
  })().catch((error) => {
    sendResponse({ ok: false, error: String(error?.message || error) });
  });

  return true;
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== 'CRAWL_PROGRESS') return;
  chrome.storage.local.get(STORAGE_KEYS.RUN_STATE).then((result) => {
    const prev = result[STORAGE_KEYS.RUN_STATE] || {};
    chrome.storage.local.set({
      [STORAGE_KEYS.RUN_STATE]: {
        ...prev,
        lastProgress: message.payload,
        updatedAt: new Date().toISOString(),
      },
    });
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab?.url?.includes('xiaohongshu.com')) return;
  ensureStateBridge(tabId).catch(() => {});
});

chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId && source.tabId === labState.tabId) {
    labState.attached = false;
    labState.holding = false;
  }
});
