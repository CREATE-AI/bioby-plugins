import { DEFAULT_CONFIG, STORAGE_KEYS } from '../lib/constants.js';
import { buildSearchUrl, humanDelay } from '../lib/human-behavior.js';
import { upsertLeads, getConfig, setConfig, setRunState, getRunState, getLeads, updateLeadReview } from '../lib/storage.js';
import { judgeLeadsWithAi, testAiConnection, chunkArray } from '../lib/ai-judge.js';
import { passesMaxAgeDays, filterLeadsByMaxAge, classifyLeadMaxAge } from '../lib/age-filter.js';
import { resolveLeadPublishAt } from '../lib/publish-time.js';

let activeTabId = null;
let stopRequested = false;
let queueRunning = false;
let keepAliveAlarm = 'xhs-lead-keepalive';

const STALE_RUN_MS = 10 * 60 * 1000;

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
      func: () => Boolean(window.__XHS_FILTER_PING__ && window.__XHS_APPLY_FILTER__),
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
      func: () => Boolean(window.__XHS_FILTER_PING__ && window.__XHS_APPLY_FILTER__),
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

async function applySearchFiltersOnTab(tabId, maxAgeDays = 7) {
  const days = Number(maxAgeDays) || 7;
  await focusTabForFilter(tabId);
  await ensureStateBridge(tabId);

  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: async (d) => {
        if (typeof window.__XHS_APPLY_FILTER__ === 'function') {
          return window.__XHS_APPLY_FILTER__(d);
        }
        return {
          ok: true,
          via: 'plugin_only',
          maxAgeDays: d,
          message: `插件按近 ${d} 天过滤`,
        };
      },
      args: [days],
    });
    return result || {
      ok: true,
      via: 'plugin_only',
      maxAgeDays: days,
    };
  } catch {
    return {
      ok: true,
      via: 'plugin_only',
      maxAgeDays: days,
      message: `插件按近 ${days} 天过滤`,
    };
  }
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
 */
async function enrichCandidatesWithDetail(candidates, config, keyword) {
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
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });

  try {
    for (let i = 0; i < limit; i += 1) {
      if (stopRequested) break;
      const item = candidates[i];
      if (!item?.noteUrl) continue;

      await touchRun({
        status: 'running',
        currentKeyword: keyword,
        lastProgress: {
          keyword,
          phase: 'detail_enrich',
          enrichIndex: i + 1,
          enrichTotal: limit,
          title: item.title,
        },
      });

      try {
        await chrome.tabs.update(tab.id, { url: item.noteUrl, active: true });
        await waitForTabComplete(tab.id, 25000);
        await humanDelay(delayMin, delayMax);
        await ensureNoteDetailHelper(tab.id);
        const res = await chrome.tabs.sendMessage(tab.id, { type: 'ENRICH_CURRENT_NOTE' });
        // 主世界再取一次小红书号（比 isolated DOM 更稳）
        const redMap = await extractRedIdMapFromTab(tab.id);
        const redFromPage = redMap.byNoteId?.[String(item.noteId || '')]
          || redMap.byAuthorId?.[String(item.authorId || '')]
          || '';
        if (res?.captcha) {
          stoppedByCaptcha = true;
          break;
        }
        if (res?.ok && (res.desc || res.publishAt || res.redId || redFromPage)) {
          // 仅当正文与标题不同时才覆盖（搜索卡用 title 占位 desc）
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

      await humanDelay(800, 1600);
    }
  } finally {
    try {
      await chrome.tabs.remove(tab.id);
    } catch {
      // ignore
    }
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
  const maxAge = config.maxAgeDays ?? 7;

  await touchRun({
    status: 'running',
    currentKeyword: keyword,
    lastProgress: { keyword, phase: 'search_filters', message: `正在打开搜索页（插件按近 ${maxAge} 天过滤）…` },
  });
  await notifyTabStatus(tabId, `线索助手：打开搜索页，按近 ${maxAge} 天过滤…`, 12000);

  // 每次都带筛选参数刷新
  await chrome.tabs.update(tabId, { url, active: true });
  await waitForTabComplete(tabId, 30000);
  await humanDelay(2500, 4000);
  await ensureContentScript(tabId);
  await waitForSearchPageReady(tabId);

  const searchFilters = await applySearchFiltersOnTab(tabId, maxAge);

  await touchRun({
    status: 'running',
    currentKeyword: keyword,
    lastProgress: {
      keyword,
      phase: 'search_filters_done',
      searchFilters,
      message: searchFilters.message || `插件按近 ${maxAge} 天过滤`,
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
        maxAgeDays: config.maxAgeDays ?? 7,
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

  if (Array.isArray(result.candidates)) {
    applyRedIdMap(result.candidates, redMap);
    const maxAgePre = config.maxAgeDays ?? 7;
    if (maxAgePre > 0) {
      result.candidates = filterLeadsByMaxAge(result.candidates, maxAgePre);
    }
  }

  if (result.needsAi && Array.isArray(result.candidates) && result.candidates.length) {
    // 限制单词 AI 候选，避免卡太久
    let capped = result.candidates.slice(0, config.maxCandidatesPerKeyword ?? 80);

    // 限速补采正文，提升「需求 vs 广告」判断
    const enrichResult = await enrichCandidatesWithDetail(capped, config, keyword);
    capped = enrichResult.candidates;
    const maxAge = config.maxAgeDays ?? 7;
    const beforeAgeFilter = capped.length;
    capped = filterLeadsByMaxAge(capped, maxAge);
    const ageFilteredOut = beforeAgeFilter - capped.length;
    if (enrichResult.stoppedByCaptcha) {
      await touchRun({
        status: 'running',
        currentKeyword: keyword,
        lastProgress: {
          keyword,
          phase: 'detail_enrich_stopped',
          message: '详情补采遇验证码已停止，继续用现有文案做 AI',
          enriched: enrichResult.enriched,
          ageFilteredOut,
        },
      });
    } else if (ageFilteredOut > 0) {
      await touchRun({
        status: 'running',
        currentKeyword: keyword,
        lastProgress: {
          keyword,
          phase: 'age_filtered',
          message: `详情补采后剔除 ${ageFilteredOut} 条超 ${maxAge} 天的笔记`,
          ageFilteredOut,
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
      maxAgeDays: config.maxAgeDays ?? 7,
    });
  }

  if (leads.length) {
    const maxAgeFinal = config.maxAgeDays ?? 7;
    if (maxAgeFinal > 0) {
      leads = filterLeadsByMaxAge(leads, maxAgeFinal);
    }
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
