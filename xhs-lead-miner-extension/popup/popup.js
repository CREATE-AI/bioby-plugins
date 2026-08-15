import { DEFAULT_CONFIG, DAILY_KEYWORD_MATRIX, DEFAULT_EXCLUDE_KEYWORDS } from '../lib/constants.js';
import { getConfig, setConfig, getLeads, clearLeads, getRunState } from '../lib/storage.js';
import { downloadReachHtml, normalizeLeadAuthor, resolvePublishDisplay, displayRedId } from '../lib/export.js';
import {
  getSharedFilterPreset,
  loadSavedFilterPreset,
  mountFilterPresetCopy,
  mountFilterSaveHint,
  resetSharedFilterPreset,
  saveSharedFilterPreset,
} from '../lib/filter-preset-ui.js';
import { initLab } from '../lab/lab.js';

const els = {
  useAiFilter: document.getElementById('useAiFilter'),
  aiApiKey: document.getElementById('aiApiKey'),
  aiApiBaseUrl: document.getElementById('aiApiBaseUrl'),
  aiModel: document.getElementById('aiModel'),
  aiMinConfidence: document.getElementById('aiMinConfidence'),
  aiPrefilterMode: document.getElementById('aiPrefilterMode'),
  aiApiBaseUrlVisible: document.getElementById('aiApiBaseUrlVisible'),
  aiModelVisible: document.getElementById('aiModelVisible'),
  autoCollect: document.getElementById('autoCollect'),
  testAiBtn: document.getElementById('testAiBtn'),
  aiTestResult: document.getElementById('aiTestResult'),
  keywords: document.getElementById('keywords'),
  excludeKeywords: document.getElementById('excludeKeywords'),
  maxScrollRounds: document.getElementById('maxScrollRounds'),
  maxCandidatesPerKeyword: document.getElementById('maxCandidatesPerKeyword'),
  targetLeadCount: document.getElementById('targetLeadCount'),
  targetCollectedCount: document.getElementById('targetCollectedCount'),
  startBtn: document.getElementById('startBtn'),
  stopBtn: document.getElementById('stopBtn'),
  resetBtn: document.getElementById('resetBtn'),
  collectBtn: document.getElementById('collectBtn'),
  copyProfilesBtn: document.getElementById('copyProfilesBtn'),
  openNextProfileBtn: document.getElementById('openNextProfileBtn'),
  autoCollectVisible: document.getElementById('autoCollectVisible'),
  enrichNoteDetail: document.getElementById('enrichNoteDetail'),
  detailEnrichLimit: document.getElementById('detailEnrichLimit'),
  exportBtn: document.getElementById('exportBtn'),
  clearBtn: document.getElementById('clearBtn'),
  statusText: document.getElementById('statusText'),
  progressText: document.getElementById('progressText'),
  leadCount: document.getElementById('leadCount'),
  leadPreview: document.getElementById('leadPreview'),
};

let activeTab = 'qualified';
let cachedLeads = [];
const REACH_CURSOR_KEY = 'xhs_reach_cursor';

(function showLoadedVersion() {
  const el = document.getElementById('extVersion');
  if (!el) return;
  try {
    el.textContent = `v${chrome.runtime.getManifest().version}`;
  } catch {
    el.textContent = 'v?';
  }
})();

function linesToArray(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function syncHiddenAiFields() {
  const base = (els.aiApiBaseUrlVisible?.value || '').trim() || DEFAULT_CONFIG.aiApiBaseUrl;
  const model = (els.aiModelVisible?.value || '').trim() || DEFAULT_CONFIG.aiModel;
  els.aiApiBaseUrl.value = base;
  els.aiModel.value = model;
}

function normalizeReviewStatus(lead) {
  if (lead.reviewStatus === 'qualified'
    || lead.reviewStatus === 'rejected'
    || lead.reviewStatus === 'pending') {
    return lead.reviewStatus;
  }
  if (String(lead.matchedSignals || '').includes('backfill=1')
    || String(lead.filterReason || '').includes('补量')
    || String(lead.filterReason || '').includes('待人工')) {
    return 'pending';
  }
  // 无明确状态时：AI 高分才视为符合，避免把待确认算进符合
  if (lead.reviewSource === 'ai' && (lead.aiConfidence ?? 0) >= 0.45) return 'qualified';
  if (lead.leadScore >= 45 && lead.filterMode === 'ai' && !lead.aiReason) return 'qualified';
  return 'pending';
}

function readFormConfig() {
  syncHiddenAiFields();
  const targetCollected = Number(els.targetCollectedCount?.value)
    || DEFAULT_CONFIG.targetCollectedCount;
  if (els.targetLeadCount) els.targetLeadCount.value = String(targetCollected);
  const autoCollect = Boolean(els.autoCollectVisible?.checked);
  if (els.autoCollect) els.autoCollect.checked = autoCollect;
  return {
    ...DEFAULT_CONFIG,
    dailyCapacityMode: true,
    useAiFilter: true,
    autoCollect,
    enrichNoteDetail: els.enrichNoteDetail ? els.enrichNoteDetail.checked : true,
    detailEnrichLimit: Number(els.detailEnrichLimit?.value) || DEFAULT_CONFIG.detailEnrichLimit,
    aiApiKey: els.aiApiKey.value.trim(),
    aiApiBaseUrl: els.aiApiBaseUrl.value.trim() || DEFAULT_CONFIG.aiApiBaseUrl,
    aiModel: els.aiModel.value.trim() || DEFAULT_CONFIG.aiModel,
    aiMinConfidence: Number(els.aiMinConfidence.value) || DEFAULT_CONFIG.aiMinConfidence,
    aiPrefilterMode: els.aiPrefilterMode.value || 'safe',
    keywords: linesToArray(els.keywords.value),
    excludeKeywords: linesToArray(els.excludeKeywords?.value),
    maxScrollRounds: Number(els.maxScrollRounds?.value) || DEFAULT_CONFIG.maxScrollRounds,
    maxAgeDays: 0,
    maxCandidatesPerKeyword:
      Number(els.maxCandidatesPerKeyword?.value) || DEFAULT_CONFIG.maxCandidatesPerKeyword,
    targetCollectedCount: targetCollected,
    targetLeadCount: targetCollected,
    sortByTime: true,
    xhsFilterPreset: getSharedFilterPreset(),
  };
}

function fillForm(config) {
  els.aiApiKey.value = config.aiApiKey || '';
  const base = DEFAULT_CONFIG.aiApiBaseUrl;
  const model = DEFAULT_CONFIG.aiModel;
  const savedBase = config.aiApiBaseUrl || base;
  const savedModel = config.aiModel || model;
  els.aiApiBaseUrl.value = /deepseek/i.test(savedBase) ? savedBase : base;
  els.aiModel.value = /deepseek/i.test(savedModel) ? savedModel : model;
  if (els.aiApiBaseUrlVisible) els.aiApiBaseUrlVisible.value = els.aiApiBaseUrl.value;
  if (els.aiModelVisible) els.aiModelVisible.value = els.aiModel.value;
  els.aiMinConfidence.value = config.aiMinConfidence ?? DEFAULT_CONFIG.aiMinConfidence;
  els.aiPrefilterMode.value = config.aiPrefilterMode || 'safe';
  const autoCollect = config.autoCollect === true;
  if (els.autoCollect) els.autoCollect.checked = autoCollect;
  if (els.autoCollectVisible) els.autoCollectVisible.checked = autoCollect;
  if (els.enrichNoteDetail) {
    els.enrichNoteDetail.checked = config.enrichNoteDetail !== false;
  }
  if (els.detailEnrichLimit) {
    els.detailEnrichLimit.value = config.detailEnrichLimit ?? DEFAULT_CONFIG.detailEnrichLimit;
  }

  const kws = config.keywords?.length
    ? config.keywords
    : DAILY_KEYWORD_MATRIX;
  els.keywords.value = kws.join('\n');

  if (els.excludeKeywords) {
    els.excludeKeywords.value = (config.excludeKeywords || []).join('\n');
  }
  if (els.maxScrollRounds) {
    els.maxScrollRounds.value = config.maxScrollRounds || DEFAULT_CONFIG.maxScrollRounds;
  }
  if (els.maxCandidatesPerKeyword) {
    els.maxCandidatesPerKeyword.value =
      config.maxCandidatesPerKeyword || DEFAULT_CONFIG.maxCandidatesPerKeyword;
  }
  const target = config.targetCollectedCount
    ?? config.targetLeadCount
    ?? DEFAULT_CONFIG.targetCollectedCount;
  if (els.targetCollectedCount) els.targetCollectedCount.value = target;
  if (els.targetLeadCount) els.targetLeadCount.value = target;
}

function reviewLabel(status) {
  if (status === 'qualified') return '<span class="badge-qualified">符合</span>';
  if (status === 'rejected') return '<span class="badge-rejected">不符合</span>';
  return '<span class="badge-pending">待确认</span>';
}

function filteredLeads(leads) {
  let list = activeTab === 'all'
    ? leads
    : leads.filter((l) => normalizeReviewStatus(l) === activeTab);
  // 展示时再按发帖时间新→旧排一次，避免旧缓存顺序
  return [...list].sort((a, b) => {
    const ta = Date.parse(a.publishAt || '') || 0;
    const tb = Date.parse(b.publishAt || '') || 0;
    if (tb !== ta) return tb - ta;
    const ca = Date.parse(a.crawledAt || '') || 0;
    const cb = Date.parse(b.crawledAt || '') || 0;
    return cb - ca;
  });
}

function formatRunStats(stats, target) {
  const s = stats || {};
  return `扫描 ${s.scanned || 0} · 送AI ${s.toAi || 0} · 符合 ${s.qualified || 0}/${target}`;
}

function authorProfileUrl(lead) {
  const normalized = normalizeLeadAuthor(lead);
  if (normalized.authorUrl) return normalized.authorUrl;
  if (normalized.authorId) return `https://www.xiaohongshu.com/user/profile/${normalized.authorId}`;
  return '';
}

function authorKey(lead) {
  const normalized = normalizeLeadAuthor(lead);
  return normalized.authorId || normalized.authorUrl || lead.noteId || '';
}

function shortAuthorId(authorId) {
  const id = String(authorId || '');
  if (id.length <= 12) return id;
  return `${id.slice(0, 6)}…${id.slice(-4)}`;
}

/** 「符合」且可触达；同一作者只保留最新一条，避免连开同一主页 */
function qualifiedUniqueAuthors(leads) {
  const sorted = [...(leads || [])]
    .filter((l) => normalizeReviewStatus(l) === 'qualified')
    .filter((l) => Boolean(authorProfileUrl(l) || l.noteUrl))
    .sort((a, b) => {
      const ta = Date.parse(a.publishAt || '') || 0;
      const tb = Date.parse(b.publishAt || '') || 0;
      if (tb !== ta) return tb - ta;
      return (Date.parse(b.crawledAt || '') || 0) - (Date.parse(a.crawledAt || '') || 0);
    });
  const seen = new Set();
  const unique = [];
  for (const lead of sorted) {
    const key = authorKey(lead);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(lead);
  }
  return unique;
}

function listFingerprint(list) {
  return list.map((l) => authorKey(l)).join('|');
}

async function loadReachCursor() {
  const result = await chrome.storage.local.get(REACH_CURSOR_KEY);
  return result[REACH_CURSOR_KEY] || { index: 0, fingerprint: '' };
}

async function saveReachCursor(cursor) {
  await chrome.storage.local.set({ [REACH_CURSOR_KEY]: cursor });
}

async function copyText(text) {
  if (!text) throw new Error('无可复制内容');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

function renderLeads(leads, runState = null) {
  cachedLeads = leads;
  const qualified = leads.filter((l) => normalizeReviewStatus(l) === 'qualified').length;
  const pending = leads.filter((l) => normalizeReviewStatus(l) === 'pending').length;
  const rejected = leads.filter((l) => normalizeReviewStatus(l) === 'rejected').length;

  const target = runState?.targetCollectedCount
    || runState?.lastProgress?.targetCollectedCount
    || Number(els.targetCollectedCount?.value)
    || 15;
  const stats = runState?.runStats || runState?.lastProgress?.runStats;
  if (stats && (runState?.status === 'running' || runState?.lastProgress?.phase === 'done')) {
    els.leadCount.textContent = formatRunStats(stats, target);
  } else {
    els.leadCount.textContent = `库内：符合 ${qualified} · 待确认 ${pending} · 不符合 ${rejected}`;
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.tab === activeTab);
  });

  const list = filteredLeads(leads).slice(0, 30);
  if (!list.length) {
    els.leadPreview.innerHTML = '<li class="lead-meta">当前分类暂无线索</li>';
    return;
  }

  els.leadPreview.innerHTML = list.map((lead) => {
    const status = normalizeReviewStatus(lead);
    const normalized = normalizeLeadAuthor(lead);
    const profile = authorProfileUrl(normalized);
    const name = normalized.authorName || '未知作者';
    const idHint = displayRedId(normalized) || normalized.authorId
      ? ` · <code class="author-id">${shortAuthorId(displayRedId(normalized) || normalized.authorId)}</code>`
      : '';
    return `
    <li data-note-id="${lead.noteId}">
      <div><strong>${lead.leadScore ?? '-'}</strong>
        · ${reviewLabel(status)}
        · ${lead.title || '（无标题）'}</div>
      <div class="lead-meta">
        <span class="author-name">${name}</span>${idHint}
        · ${resolvePublishDisplay(lead) || '时间未知'} · ${lead.matchedKeyword || '-'}
      </div>
      <div class="lead-meta">${lead.aiReason || lead.filterReason || '（无判定理由）'}</div>
      <div class="lead-actions">
        ${profile ? `<a class="btn-reach" href="${profile}" target="_blank" rel="noreferrer">开主页私信</a>` : ''}
        ${profile ? `<button type="button" class="btn-ok" data-copy="profile" data-url="${profile}">复制主页</button>` : ''}
        ${normalized.authorId || displayRedId(normalized) ? `<button type="button" class="ghost-mini" data-copy="id" data-id="${displayRedId(normalized) || normalized.authorId}">复制小红书号</button>` : ''}
        <button type="button" class="ghost-mini" data-copy="name" data-name="${name.replace(/"/g, '&quot;')}">复制昵称</button>
        <a href="${lead.noteUrl}" target="_blank" rel="noreferrer">看帖</a>
        <button type="button" class="btn-ok" data-action="qualified" data-id="${lead.noteId}">标符合</button>
        <button type="button" class="btn-no" data-action="rejected" data-id="${lead.noteId}">不符合</button>
      </div>
    </li>`;
  }).join('');
}

async function setReview(noteId, reviewStatus) {
  const response = await chrome.runtime.sendMessage({
    type: 'UPDATE_LEAD_REVIEW',
    payload: { noteId, reviewStatus },
  });
  if (response?.ok && response.leads) {
    renderLeads(response.leads, await getRunState());
  } else {
    await refreshState();
  }
}

els.leadPreview.addEventListener('click', async (event) => {
  const copyBtn = event.target.closest('button[data-copy]');
  if (copyBtn) {
    try {
      if (copyBtn.dataset.copy === 'profile') {
        await copyText(copyBtn.dataset.url || '');
        copyBtn.textContent = '已复制';
      } else if (copyBtn.dataset.copy === 'id') {
        await copyText(copyBtn.dataset.id || '');
        copyBtn.textContent = '已复制';
      } else if (copyBtn.dataset.copy === 'name') {
        await copyText(copyBtn.dataset.name || '');
        copyBtn.textContent = '已复制';
      }
      setTimeout(() => {
        if (copyBtn.dataset.copy === 'profile') copyBtn.textContent = '复制主页';
        if (copyBtn.dataset.copy === 'id') copyBtn.textContent = '复制用户ID';
        if (copyBtn.dataset.copy === 'name') copyBtn.textContent = '复制昵称';
      }, 1200);
    } catch (e) {
      alert(String(e?.message || e));
    }
    return;
  }
  const btn = event.target.closest('button[data-action]');
  if (!btn) return;
  btn.disabled = true;
  await setReview(btn.dataset.id, btn.dataset.action);
});

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    renderLeads(cachedLeads);
  });
});

async function refreshState() {
  const [leads, state] = await Promise.all([getLeads(), getRunState()]);
  renderLeads(leads, state);

  const target = state.targetCollectedCount
    || state.lastProgress?.targetCollectedCount
    || Number(els.targetCollectedCount?.value)
    || 15;
  const stats = state.runStats || state.lastProgress?.runStats || {};

  if (state.status === 'running') {
    const kwProgress = `${state.doneKeywords?.length || 0}/${state.totalKeywords || '?'}`;
    const got = state.acceptedThisRun
      ?? state.lastProgress?.leadCount
      ?? 0;
    els.statusText.textContent = `状态：采集中 符合 ${got}/${target} · 词 ${kwProgress}`;
    const p = state.lastProgress || {};
    if (p.phase === 'collecting') {
      els.progressText.textContent = `正在收藏 ${p.collectIndex || 0}/${p.collectTotal || '?'}`;
    } else if (p.phase === 'detail_enrich') {
      els.progressText.textContent = `详情补采（点卡） ${p.enrichIndex || 0}/${p.enrichTotal || '?'} · ${state.currentKeyword || ''}`;
    } else if (p.phase === 'detail_enrich_stopped') {
      els.progressText.textContent = p.message || '详情补采遇验证码已停止';
    } else if (p.phase === 'search_filters_done') {
      els.progressText.textContent = p.message || '筛选完成，开始滚动采集…';
    } else if (p.phase === 'search_filters' && p.message) {
      els.progressText.textContent = p.message;
    } else if (p.phase === 'search_filters_warning' && p.warning) {
      els.progressText.textContent = `⚠ ${p.warning}`;
    } else if (p.phase === 'ai_judging') {
      els.progressText.textContent = `AI判定 ${p.judged || 0}/${p.totalCandidates || '?'} · ${state.currentKeyword || ''}`;
    } else if (p.phase === 'search_filters' || p.phase === 'sort_newest') {
      els.progressText.textContent = p.message || '正在点平台筛选…';
    } else if (p.phase === 'reading') {
      els.progressText.textContent = p.message || `正在读取首屏卡片 · ${state.currentKeyword || ''}`;
    } else if (p.phase === 'scrolling') {
      els.progressText.textContent = p.message || `正在滚动采集 · ${state.currentKeyword || ''}`;
    } else {
      els.progressText.textContent = formatRunStats(stats, target);
    }
    els.startBtn.disabled = true;
    els.stopBtn.disabled = false;
    if (els.collectBtn) els.collectBtn.disabled = true;
    if (els.copyProfilesBtn) els.copyProfilesBtn.disabled = true;
    if (els.openNextProfileBtn) els.openNextProfileBtn.disabled = true;
  } else if (state.status === 'error') {
    els.statusText.textContent = `状态：出错 - ${state.error || '未知错误'}`;
    els.progressText.textContent = '可点「重置状态」后重试';
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    if (els.collectBtn) els.collectBtn.disabled = false;
    if (els.copyProfilesBtn) els.copyProfilesBtn.disabled = false;
    if (els.openNextProfileBtn) els.openNextProfileBtn.disabled = false;
  } else if (state.lastProgress?.phase === 'done') {
    const summary = state.lastProgress.summary
      || formatRunStats(stats, target);
    const met = state.lastProgress.metTarget ? '已达标' : '未满目标';
    els.statusText.textContent = `状态：本轮结束 · ${met}`;
    els.progressText.textContent = summary;
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    if (els.collectBtn) els.collectBtn.disabled = false;
    if (els.copyProfilesBtn) els.copyProfilesBtn.disabled = false;
    if (els.openNextProfileBtn) els.openNextProfileBtn.disabled = false;
  } else {
    els.statusText.textContent = '状态：待命';
    els.progressText.textContent = `目标：筛出 ${target} 条「符合」后，开主页私信对接`;
    els.startBtn.disabled = false;
    els.stopBtn.disabled = true;
    if (els.collectBtn) els.collectBtn.disabled = false;
    if (els.copyProfilesBtn) els.copyProfilesBtn.disabled = false;
    if (els.openNextProfileBtn) els.openNextProfileBtn.disabled = false;
  }
}

els.testAiBtn.addEventListener('click', async () => {
  const config = readFormConfig();
  if (!config.aiApiKey) {
    els.aiTestResult.textContent = '请先填写 API Key';
    return;
  }
  els.aiTestResult.textContent = '测试中…';
  await setConfig(config);
  const response = await chrome.runtime.sendMessage({
    type: 'TEST_AI',
    payload: {
      apiKey: config.aiApiKey,
      apiBaseUrl: config.aiApiBaseUrl,
      model: config.aiModel,
    },
  });
  els.aiTestResult.textContent = response?.ok
    ? '连接成功（deepseek-v4-flash）'
    : `失败：${response?.error || '未知错误'}`;
});

els.startBtn.addEventListener('click', async () => {
  const config = readFormConfig();
  if (!config.aiApiKey) {
    alert('请填写 DeepSeek API Key');
    return;
  }
  if (!config.keywords.length) {
    alert('请至少填一个关键词（可多行）');
    return;
  }
  await saveSharedFilterPreset();
  await setConfig(config);
  try {
    await chrome.permissions.request({ origins: ['https://api.deepseek.com/*'] });
  } catch {
    // ignore
  }

  const response = await chrome.runtime.sendMessage({
    type: 'START_RUN',
    payload: { keywords: config.keywords, config },
  });
  if (!response?.ok) {
    alert(response?.error || '启动失败');
    return;
  }
  await refreshState();
});

els.stopBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'STOP_RUN' });
  await refreshState();
});

els.resetBtn.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: 'RESET_RUN',
    payload: { reason: '用户点击重置状态' },
  });
  els.startBtn.disabled = false;
  els.stopBtn.disabled = true;
  await refreshState();
});

function formatNewestTestResult(res) {
  if (!res) {
    return [
      '原因：后台没有返回结果',
      '说明：多半是旧版还在模拟点击死循环。请打开 chrome://extensions/ 点「重新加载」。',
    ].join('\n');
  }
  const reason = res.reason || res.error || res.message || '（未提供原因）';
  const lines = [
    `${res.ok ? '结果：成功' : '结果：失败'}`,
    `原因：${reason}`,
    `方式：${res.via || '未知'}`,
  ];
  if (res.newestActive != null) lines.push(`最新已选中：${res.newestActive ? '是' : '否'}`);
  if (res.weekActive != null) lines.push(`一周内已选中：${res.weekActive ? '是' : '否'}`);
  if (res.weekClicked != null) lines.push(`已点一周内：${res.weekClicked ? '是' : '否'}`);
  if (res.debug) {
    const d = typeof res.debug === 'string' ? res.debug : JSON.stringify(res.debug);
    if (d.length < 400) lines.push(`调试：${d}`);
  }
  return lines.join('\n');
}

mountFilterPresetCopy(document.getElementById('collectFilterCopy'));
mountFilterPresetCopy(document.getElementById('labFilterCopy'));
mountFilterSaveHint(document.getElementById('collectFilterSaveHint'));
mountFilterSaveHint(document.getElementById('labFilterSaveHint'));

document.getElementById('collectFilterResetBtn')?.addEventListener('click', () => {
  resetSharedFilterPreset();
});
document.getElementById('collectFilterSaveBtn')?.addEventListener('click', async () => {
  await saveSharedFilterPreset();
});

initLab();

document.querySelectorAll('.view-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    const view = btn.dataset.view;
    document.querySelectorAll('.view-tab').forEach((b) => {
      b.classList.toggle('active', b === btn);
    });
    document.getElementById('viewCollect')?.classList.toggle('active', view === 'collect');
    document.getElementById('viewLab')?.classList.toggle('active', view === 'lab');
  });
});

els.copyProfilesBtn?.addEventListener('click', async () => {
  const list = qualifiedUniqueAuthors(cachedLeads.length ? cachedLeads : await getLeads())
    .map(normalizeLeadAuthor)
    .filter((l) => l.authorId || l.authorUrl);
  const lines = list.map((l) => {
    const id = displayRedId(l) || l.authorId || '';
    const profile = l.authorUrl || authorProfileUrl(l);
    return `${id}\t${profile}\t${l.authorName || '未知'}\t${l.title || ''}\t${l.noteUrl || ''}`;
  }).filter((line) => line.includes('http'));
  if (!lines.length) {
    alert('没有可复制的小红书号/主页（缺作者主页时请先点「看帖」）。');
    return;
  }
  await copyText(`小红书号\t主页\t昵称\t标题\t帖子\n${lines.join('\n')}`);
  alert(`已复制 ${lines.length} 位作者（优先小红书号，没有则用主页ID），可粘贴到表格。`);
});

els.openNextProfileBtn?.addEventListener('click', async () => {
  const leads = cachedLeads.length ? cachedLeads : await getLeads();
  const list = qualifiedUniqueAuthors(leads);
  if (!list.length) {
    alert('没有可打开的「符合」主页。');
    return;
  }

  // 弹窗一点「开标签」就会关闭，内存序号会丢；进度必须落盘
  const fingerprint = listFingerprint(list);
  let cursor = await loadReachCursor();
  if (cursor.fingerprint !== fingerprint) {
    cursor = { index: 0, fingerprint };
  }
  if (cursor.index >= list.length) {
    cursor.index = 0;
  }

  const lead = list[cursor.index];
  const url = authorProfileUrl(lead) || lead.noteUrl;
  const openedAt = cursor.index + 1;
  cursor.index += 1;
  await saveReachCursor(cursor);

  els.progressText.textContent =
    `下一条将开第 ${Math.min(cursor.index + 1, list.length)}/${list.length} 位`
    + ` · 本次打开：${lead.authorName || '未知'}（${openedAt}/${list.length}）`;

  // 先写盘再开页，避免弹窗销毁导致序号没存上
  await chrome.tabs.create({ url, active: true });
});

els.collectBtn.addEventListener('click', async () => {
  const leads = await getLeads();
  const pending = leads.filter(
    (l) => !l.collected && normalizeReviewStatus(l) === 'qualified',
  );
  if (!pending.length) {
    alert('没有「符合」且未收藏的线索。\n可先在「待确认」里标为符合。');
    return;
  }
  if (!confirm(`将对 ${pending.length} 条「符合」线索补收藏，继续？`)) return;

  els.collectBtn.disabled = true;
  const response = await chrome.runtime.sendMessage({
    type: 'COLLECT_LEADS',
    payload: { leads: pending },
  });
  if (!response?.ok && response?.error) {
    alert(response.error);
  } else {
    alert(response.message
      || `收藏完成：成功 ${response.collected || 0}，失败 ${response.failed || 0}`);
  }
  await refreshState();
});

els.exportBtn.addEventListener('click', async () => {
  const leads = await getLeads();
  if (!leads.length) {
    alert('暂无线索可导出');
    return;
  }
  const qualified = leads.filter((l) => normalizeReviewStatus(l) === 'qualified');
  const pending = leads.filter((l) => normalizeReviewStatus(l) === 'pending');
  const rejected = leads.filter((l) => normalizeReviewStatus(l) === 'rejected');
  // 从不导出「不符合」（含 AI / 人工判定）
  const exportable = [...qualified, ...pending];

  if (!exportable.length) {
    alert(`没有可导出的线索（不符合 ${rejected.length} 条已自动排除）`);
    return;
  }

  const choice = confirm(
    `导出 HTML 预览（自动排除不符合 ${rejected.length} 条）\n`
    + `可导出：符合 ${qualified.length} · 待确认 ${pending.length}\n\n`
    + `确定 = 只导出「符合」(${qualified.length} 条)\n`
    + `取消 = 导出「符合 + 待确认」(${exportable.length} 条)`,
  );
  const toExport = choice ? qualified : exportable;
  if (!toExport.length) {
    alert('没有可导出的线索');
    return;
  }
  const stamp = new Date().toISOString().slice(0, 10);
  downloadReachHtml(toExport, `xhs-reach-preview-${stamp}.html`);
});

els.clearBtn.addEventListener('click', async () => {
  if (!confirm('确认清空已采集线索？')) return;
  await clearLeads();
  await refreshState();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'RUN_FINISHED') refreshState();
});

(async function init() {
  await loadSavedFilterPreset();
  const saved = (await getConfig()) || {};
  // 首次升级到日产模式：覆盖旧短词库与旧目标
  const needMigrate = saved.dailyCapacityMode !== true;
  const needExcludePreset = saved.excludePresetVersion !== 1;
  const needReachMode = saved.reachModeVersion !== 1;
  const needDisablePluginAge = saved.maxAgePresetVersion !== 2;
  const migrated = {
    ...DEFAULT_CONFIG,
    ...saved,
    aiApiBaseUrl: DEFAULT_CONFIG.aiApiBaseUrl,
    aiModel: DEFAULT_CONFIG.aiModel,
    ...(needMigrate ? {
      dailyCapacityMode: true,
      keywords: DAILY_KEYWORD_MATRIX,
      targetCollectedCount: 15,
      targetLeadCount: 15,
      maxScrollRounds: DEFAULT_CONFIG.maxScrollRounds,
      maxCandidatesPerKeyword: DEFAULT_CONFIG.maxCandidatesPerKeyword,
    } : {}),
    ...(needExcludePreset ? {
      excludeKeywords: DEFAULT_EXCLUDE_KEYWORDS,
      excludePresetVersion: 1,
    } : {}),
    ...(needReachMode ? {
      autoCollect: false,
      reachModeVersion: 1,
    } : {}),
    ...(needDisablePluginAge ? {
      maxAgeDays: 0,
      maxAgePresetVersion: 2,
    } : {}),
  };
  fillForm(migrated);
  const merged = readFormConfig();
  await setConfig({
    ...merged,
    aiApiKey: els.aiApiKey.value.trim(),
    dailyCapacityMode: true,
    excludePresetVersion: 1,
    reachModeVersion: 1,
    maxAgePresetVersion: 2,
    maxAgeDays: 0,
  });
  try {
    await chrome.runtime.sendMessage({ type: 'GET_RUN_STATE' });
  } catch {
    // ignore
  }
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.includes('xiaohongshu.com')) {
      await chrome.runtime.sendMessage({ type: 'INJECT_FILTER_MAIN' });
    }
  } catch {
    // ignore
  }
  await refreshState();
  setInterval(refreshState, 2000);
})();
