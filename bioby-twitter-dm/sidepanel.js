const viewMain = document.getElementById('viewMain');
const viewSettings = document.getElementById('viewSettings');
const listEl = document.getElementById('list');
const bannerEl = document.getElementById('banner');
const templateSelect = document.getElementById('templateSelect');
const captureLead = document.getElementById('captureLead');
const captureText = document.getElementById('captureText');
const settingsStatus = document.getElementById('settingsStatus');
const loginInfo = document.getElementById('loginInfo');
const crmUserLabel = document.getElementById('crmUserLabel');

const BIG_ACCOUNT = 'admin';

const API_ENV = {
  test: 'https://lmdxqolvnkyj.sealosbja.site',
  local: 'http://localhost:8081'
};

let cfg = {
  apiEnv: 'test',
  apiBase: '',
  campaignId: '',
  campaignName: '',
  businessAccount: '',
  pluginRole: 'small',
  smallStatusFilter: 'pending',
  smallQueue: 'pending',
  bigStatusFilter: 'PLUGIN_CONTACTED',
  username: '',
  password: '',
  token: '',
  displayName: '',
  xPasscode: '1234',
  bulkSendCount: 10,
  bulkSendIntervalSec: 12,
  syncMaxConversations: 10
};
let templates = [];
let templateDraft = { kind: 'intro', savedBody: '', editorBody: '' };
let templateUiMode = 'idle';
let leads = [];
let captureLeads = [];
let busy = false;
let bulkAbort = false;
let syncProgressTimer = null;
let syncProgressActive = false;
const SYNC_PROGRESS_KEY = 'syncProgress';
const SYNC_BUTTON_TEXT = '同步全部对话并抽报价';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function showBanner(text, kind) {
  bannerEl.textContent = text || '';
  bannerEl.className = 'banner' + (text ? '' : ' hidden') + (kind ? ` ${kind}` : '');
}

function formatExtError(e) {
  const msg = e?.message || String(e || '');
  if (/message channel closed|asynchronous response|receiving end does not exist/i.test(msg)) {
    return '与 X 页面通信中断，请确认已打开并停留在 x.com 后重试';
  }
  return msg;
}

function showSettingsStatus(text, kind) {
  settingsStatus.textContent = text || '';
  settingsStatus.className = 'banner' + (text ? '' : ' hidden') + (kind ? ` ${kind}` : '');
}

function authHeader() {
  const t = (cfg.token || '').trim();
  if (!t) return '';
  return t.toLowerCase().startsWith('bearer ') ? t : `Bearer ${t}`;
}

function updateCrmLabel() {
  if (cfg.token) {
    crmUserLabel.textContent = `CRM：${cfg.displayName || cfg.username || '已登录'}`;
  } else {
    crmUserLabel.textContent = '未登录 CRM';
  }
}

function fillExtVersion() {
  const version = chrome.runtime?.getManifest?.()?.version || '';
  const label = version ? `v${version}` : '';
  document.querySelectorAll('[data-ext-version]').forEach((el) => {
    el.textContent = label;
  });
}

function resolveApiBase(env) {
  return API_ENV[env === 'local' ? 'local' : 'test'];
}

function inferApiEnv(apiBase) {
  const base = String(apiBase || '').toLowerCase();
  if (base.includes('localhost') || base.includes('127.0.0.1')) return 'local';
  if (base.includes('lmdxqolvnkyj.sealosbja.site')) return 'test';
  return 'test';
}

function normalizeApiEnvCfg() {
  if (cfg.apiEnv !== 'local' && cfg.apiEnv !== 'test') {
    cfg.apiEnv = inferApiEnv(cfg.apiBase);
  }
  cfg.apiBase = resolveApiBase(cfg.apiEnv);
}

function readSettingsApiEnv() {
  const active = document.querySelector('#apiEnvSeg .seg-btn.active');
  const env = active?.dataset?.apiEnv;
  return env === 'local' ? 'local' : 'test';
}

function applySettingsApiEnvUi() {
  const env = cfg.apiEnv === 'local' ? 'local' : 'test';
  document.querySelectorAll('#apiEnvSeg .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.apiEnv === env);
  });
}

function updateCampaignPickerUi() {
  const nameEl = document.getElementById('campaignName');
  const hintEl = document.getElementById('campaignSelectedHint');
  const idEl = document.getElementById('campaignId');
  if (!nameEl || !hintEl || !idEl) return;
  const loggedIn = Boolean(cfg.token);
  nameEl.disabled = !loggedIn;
  idEl.value = cfg.campaignId || '';
  if (cfg.campaignName || cfg.campaignId) {
    nameEl.value = cfg.campaignName || cfg.campaignId;
  }
  if (!loggedIn) {
    hintEl.textContent = '登录后可搜索并选择活动。';
  } else if (cfg.campaignId) {
    hintEl.textContent = `已选活动：${cfg.campaignName || cfg.campaignId}`;
  } else {
    hintEl.textContent = '输入关键字筛选活动，点击一条完成选择。';
  }
}

function hideCampaignSuggest() {
  const list = document.getElementById('campaignSuggest');
  if (list) {
    list.classList.add('hidden');
    list.innerHTML = '';
  }
}

async function ensureCampaignNameFromId() {
  if (!cfg.token || !cfg.campaignId || cfg.campaignName) return;
  try {
    const data = await api(`/api/campaigns/${encodeURIComponent(cfg.campaignId)}`);
    const name = data?.projectName || data?.brandName || '';
    if (name) {
      await persistCfg({ campaignName: name });
    }
  } catch (_) {
    // ignore: 旧 ID 回填失败时仍可手动搜索
  }
}

let campaignSearchTimer = null;
async function searchCampaigns(q) {
  if (!cfg.token) return [];
  const query = (q || '').trim();
  const path = `/api/twitter/plugin/campaigns${query ? `?q=${encodeURIComponent(query)}` : ''}`;
  const data = await api(path);
  return Array.isArray(data) ? data : [];
}

function renderCampaignSuggest(items, emptyText) {
  const list = document.getElementById('campaignSuggest');
  if (!list) return;
  list.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyText || '无匹配活动';
    list.appendChild(li);
  } else {
    for (const item of items) {
      const li = document.createElement('li');
      li.dataset.id = item.id || '';
      li.dataset.name = item.name || '';
      const title = document.createElement('span');
      title.textContent = item.name || item.id || '';
      li.appendChild(title);
      if (item.brandName && item.brandName !== item.name) {
        const sub = document.createElement('span');
        sub.className = 'sub';
        sub.textContent = item.brandName;
        li.appendChild(sub);
      }
      list.appendChild(li);
    }
  }
  list.classList.remove('hidden');
}

async function onCampaignNameInput() {
  const nameEl = document.getElementById('campaignName');
  if (!nameEl || nameEl.disabled) return;
  clearTimeout(campaignSearchTimer);
  campaignSearchTimer = setTimeout(async () => {
    try {
      const items = await searchCampaigns(nameEl.value);
      renderCampaignSuggest(items);
    } catch (e) {
      renderCampaignSuggest([], e.message || '搜索失败');
    }
  }, 250);
}

async function selectCampaign(id, name) {
  if (!id) return;
  hideCampaignSuggest();
  await persistCfg({ campaignId: id, campaignName: name || id });
  updateCampaignPickerUi();
  showSettingsStatus(`已选择活动：${name || id}`, 'ok');
}

async function loadCfg() {
  cfg = await chrome.storage.local.get({
    apiEnv: '',
    apiBase: 'http://localhost:8081',
    campaignId: '',
    campaignName: '',
    businessAccount: '',
    pluginRole: 'small',
    smallStatusFilter: '',
    smallQueue: 'pending',
    bigStatusFilter: 'PLUGIN_CONTACTED',
    username: '',
    password: '',
    token: '',
    displayName: '',
    xPasscode: '1234',
    bulkSendCount: 10,
    bulkSendIntervalSec: 12,
    syncMaxConversations: 10
  });
  if (!cfg.token) {
    const legacy = await chrome.storage.sync.get({ apiBase: '', campaignId: '', token: '' });
    if (legacy.token) {
      cfg.apiBase = legacy.apiBase || cfg.apiBase;
      cfg.campaignId = legacy.campaignId || cfg.campaignId;
      cfg.token = legacy.token;
      await chrome.storage.local.set({
        apiBase: cfg.apiBase,
        campaignId: cfg.campaignId,
        token: cfg.token
      });
    }
  }
  if (!cfg.xPasscode) cfg.xPasscode = '1234';
  normalizeApiEnvCfg();
  normalizeRoleCfg();
  normalizeSmallFilter();
  if (!cfg.bigStatusFilter) cfg.bigStatusFilter = 'PLUGIN_CONTACTED';
  cfg.syncMaxConversations = Math.min(Math.max(Number(cfg.syncMaxConversations) || 10, 1), 30);
  updateCrmLabel();
}

async function persistCfg(partial) {
  cfg = { ...cfg, ...partial };
  if (!cfg.xPasscode) cfg.xPasscode = '1234';
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'apiEnv')) {
    normalizeApiEnvCfg();
  } else if (partial && Object.prototype.hasOwnProperty.call(partial, 'apiBase') && !partial.apiEnv) {
    cfg.apiEnv = inferApiEnv(cfg.apiBase);
    normalizeApiEnvCfg();
  } else {
    normalizeApiEnvCfg();
  }
  normalizeRoleCfg();
  normalizeSmallFilter();
  if (!cfg.bigStatusFilter) cfg.bigStatusFilter = 'PLUGIN_CONTACTED';
  await chrome.storage.local.set({
    apiEnv: cfg.apiEnv || 'test',
    apiBase: cfg.apiBase || '',
    campaignId: cfg.campaignId || '',
    campaignName: cfg.campaignName || '',
    businessAccount: cfg.businessAccount || '',
    pluginRole: cfg.pluginRole || 'small',
    smallStatusFilter: cfg.smallStatusFilter || 'pending',
    smallQueue: cfg.smallQueue || 'pending',
    bigStatusFilter: cfg.bigStatusFilter || 'PLUGIN_CONTACTED',
    username: cfg.username || '',
    password: cfg.password || '',
    token: cfg.token || '',
    displayName: cfg.displayName || '',
    xPasscode: cfg.xPasscode || '1234',
    bulkSendCount: cfg.bulkSendCount ?? 10,
    bulkSendIntervalSec: cfg.bulkSendIntervalSec ?? 12,
    syncMaxConversations: Math.min(Math.max(Number(cfg.syncMaxConversations) || 10, 1), 30)
  });
  updateCrmLabel();
}

function normalizeRoleCfg() {
  if (cfg.pluginRole !== 'big') cfg.pluginRole = 'small';
  if (isAdminId(cfg.businessAccount)) cfg.businessAccount = '';
}

function isAdminId(v) {
  return String(v || '').trim().toLowerCase() === BIG_ACCOUNT;
}

function rememberSmallBusinessAccount(raw) {
  const v = String(raw || '').trim();
  if (v && !isAdminId(v)) cfg.businessAccount = v;
}

function storedSmallBusinessAccount() {
  const v = String(cfg.businessAccount || '').trim();
  return isAdminId(v) ? '' : v;
}

function isBigRole() {
  return cfg.pluginRole === 'big';
}

function normalizeSmallFilter() {
  const allowed = ['pending', 'contacted', 'replied', 'skipped', 'failed', 'all'];
  if (!allowed.includes(cfg.smallStatusFilter)) {
    cfg.smallStatusFilter = cfg.smallQueue === 'handoff' ? 'contacted' : 'pending';
  }
  cfg.smallQueue = cfg.smallStatusFilter === 'pending' ? 'pending' : 'handoff';
}

function smallFilterLabel(filter) {
  return ({
    pending: '符合-待建联',
    contacted: '已私信',
    replied: '已回复',
    skipped: '跳过',
    failed: '失败',
    all: '全部'
  })[filter] || '符合-待建联';
}

function leadStatus(lead) {
  return String(lead?.contactStatus || '').toUpperCase();
}

function processStatusOf(lead) {
  return String(lead?.processStatus || '').toUpperCase();
}

function processStatusHint(lead) {
  const ps = processStatusOf(lead);
  if (ps === 'QUOTED') return ' · 已标已报价';
  if (ps === 'MATCH') return ' · 已标符合';
  if (ps === 'NOT_MATCH') return ' · 已标不符合';
  return '';
}

function judgementActions(lead) {
  if (leadStatus(lead) !== 'REPLIED') return '';
  const ps = processStatusOf(lead);
  const quotedCls = ps === 'QUOTED' ? 'ok' : 'accent';
  const notCls = ps === 'NOT_MATCH' ? 'err' : 'accent';
  return `
        <button type="button" class="${quotedCls}" data-act="quoted">已报价</button>
        <button type="button" class="${notCls}" data-act="notmatch">不符合</button>`;
}

function isFailedStatus(status) {
  return String(status || '').toUpperCase().startsWith('SEND_FAILED');
}

function canHandoffStatus(status) {
  const st = String(status || '').toUpperCase();
  return st === 'PLUGIN_CONTACTED' || st === 'REPLIED';
}

function applySmallLeadsFilter(list) {
  if (isBigRole() || cfg.smallStatusFilter !== 'failed') return list;
  return (list || []).filter((lead) => isFailedStatus(leadStatus(lead)));
}

function effectiveBusinessAccount() {
  return isBigRole() ? BIG_ACCOUNT : (cfg.businessAccount || '');
}

function readSettingsRole() {
  const active = document.querySelector('#pluginRoleSeg .seg-btn.active');
  const role = active?.dataset.pluginRole === 'big' ? 'big' : 'small';
  const inputVal = document.getElementById('businessAccount')?.value.trim() || '';
  rememberSmallBusinessAccount(inputVal);
  return { pluginRole: role, businessAccount: storedSmallBusinessAccount() };
}

function applySettingsRoleUi() {
  const role = cfg.pluginRole === 'big' ? 'big' : 'small';
  document.querySelectorAll('#pluginRoleSeg .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.pluginRole === role);
  });
  const bizEl = document.getElementById('businessAccount');
  if (!bizEl) return;
  if (role === 'big') {
    bizEl.value = BIG_ACCOUNT;
    bizEl.readOnly = true;
  } else {
    bizEl.readOnly = false;
    bizEl.value = storedSmallBusinessAccount();
  }
}

function leadsQuery(extra = {}) {
  const q = new URLSearchParams();
  if (extra.status) q.set('status', extra.status);
  if (extra.ownership) q.set('ownership', extra.ownership);
  const biz = effectiveBusinessAccount();
  if (biz) q.set('businessAccount', biz);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** 主列表当前视图查询参数 */
function mainListQuery() {
  if (isBigRole()) {
    const q = { ownership: 'received' };
    if (cfg.bigStatusFilter && cfg.bigStatusFilter !== 'ALL') {
      q.status = cfg.bigStatusFilter;
    }
    return q;
  }
  switch (cfg.smallStatusFilter) {
    case 'contacted':
      return { status: 'PLUGIN_CONTACTED', ownership: 'owned' };
    case 'replied':
      return { status: 'REPLIED', ownership: 'owned' };
    case 'skipped':
      return { status: 'SKIPPED', ownership: 'owned' };
    case 'failed':
      return { ownership: 'owned' };
    case 'all':
      return {};
    default:
      return { status: 'PENDING_PLUGIN' };
  }
}

/** 收录下拉：小号放宽；系统数据库只收录已移交线索 */
function captureListQuery() {
  if (isBigRole()) {
    return { ownership: 'received' };
  }
  return {};
}

function currentViewLabel() {
  const biz = effectiveBusinessAccount() || '（未设个人ID）';
  if (isBigRole()) {
    const st = cfg.bigStatusFilter === 'ALL' ? '全部状态' : cfg.bigStatusFilter;
    return `当前：系统数据库 · ${biz} · ${st}`;
  }
  const q = smallFilterLabel(cfg.smallStatusFilter);
  return `当前：小号 · ${biz} · ${q}`;
}

function emptyListHint() {
  if (isBigRole()) {
    return '暂无已转入系统数据库的线索。<br/>请让小号先「转入系统数据库」。';
  }
  return `暂无「${smallFilterLabel(cfg.smallStatusFilter)}」线索。<br/>已转入系统数据库的不会出现在小号。`;
}

const TWITTER_RESERVED_HANDLES = new Set([
  'i', 'home', 'search', 'intent', 'settings', 'explore', 'compose',
  'messages', 'notifications', 'hashtag'
]);

function leadSearchInputEl() {
  return document.getElementById('leadSearchInput');
}

function currentLeadSearchQuery() {
  return String(leadSearchInputEl()?.value || '').trim();
}

function clearLeadSearch() {
  const el = leadSearchInputEl();
  if (el) el.value = '';
}

function extractTwitterHandle(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const url = s.match(
    /(?:https?:\/\/)?(?:www\.)?(?:x\.com|twitter\.com)\/(?:#!\/)?@?([A-Za-z0-9_]{1,15})(?:[/?#]|$)/i
  );
  if (url) {
    const handle = url[1];
    if (TWITTER_RESERVED_HANDLES.has(handle.toLowerCase())) return '';
    return handle.toLowerCase();
  }
  const at = s.match(/^@([A-Za-z0-9_]{1,15})$/);
  return at ? at[1].toLowerCase() : '';
}

function leadMatchesSearch(lead, query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return true;
  const nick = String(lead.nickname || '').toLowerCase();
  const screen = String(lead.screenName || '').replace(/^@/, '').toLowerCase();
  const url = String(lead.profileUrl || '').toLowerCase();
  if (nick.includes(q) || screen.includes(q) || url.includes(q)) return true;
  const handle = extractTwitterHandle(query);
  if (handle && (screen === handle || url.includes(`/${handle}`))) return true;
  return false;
}

function visibleLeads() {
  const q = currentLeadSearchQuery();
  if (!q) return leads;
  return leads.filter((l) => leadMatchesSearch(l, q));
}

function visibleCaptureLeads() {
  const pool = captureLeads.length ? captureLeads : leads;
  const q = currentLeadSearchQuery();
  if (!q) return pool;
  return pool.filter((l) => leadMatchesSearch(l, q));
}

function listCountText() {
  const total = leads.length;
  const q = currentLeadSearchQuery();
  if (!q) return `${total} 条`;
  return `${visibleLeads().length}/${total} 条`;
}

function updateModeUi() {
  const hint = document.getElementById('modeHint');
  if (hint) hint.textContent = currentViewLabel();

  const smallRow = document.getElementById('smallQueueRow');
  const bigRow = document.getElementById('bigStatusRow');
  const bulk = document.getElementById('bulkSendSection');
  const isSmall = !isBigRole();
  if (smallRow) smallRow.classList.toggle('hidden', !isSmall);
  if (bigRow) bigRow.classList.toggle('hidden', isSmall);
  if (bulk) {
    bulk.classList.toggle('hidden', !(isSmall && cfg.smallStatusFilter === 'pending'));
  }

  const smallSel = document.getElementById('smallStatusFilter');
  if (smallSel && smallSel.value !== cfg.smallStatusFilter) {
    smallSel.value = cfg.smallStatusFilter || 'pending';
  }

  const bigSel = document.getElementById('bigStatusFilter');
  if (bigSel && bigSel.value !== cfg.bigStatusFilter) {
    bigSel.value = cfg.bigStatusFilter || 'PLUGIN_CONTACTED';
  }
}

async function switchToHandoffQueueAndRefresh(bannerText) {
  cfg.pluginRole = 'small';
  cfg.smallStatusFilter = 'contacted';
  clearLeadSearch();
  await persistCfg({ pluginRole: 'small', smallStatusFilter: 'contacted' });
  updateModeUi();
  await refresh({ keepBanner: true });
  showBanner(bannerText || '已进入「已私信」，可转入系统数据库', 'ok');
}

function fillBulkSendForm() {
  const countEl = document.getElementById('bulkCount');
  const intervalEl = document.getElementById('bulkInterval');
  const syncCountEl = document.getElementById('syncCount');
  if (countEl) countEl.value = String(cfg.bulkSendCount ?? 10);
  if (intervalEl) intervalEl.value = String(cfg.bulkSendIntervalSec ?? 12);
  if (syncCountEl) syncCountEl.value = String(cfg.syncMaxConversations ?? 10);
}

function readBulkSendForm() {
  const count = Math.min(Math.max(parseInt(document.getElementById('bulkCount')?.value, 10) || 10, 1), 50);
  const intervalSec = Math.min(Math.max(parseInt(document.getElementById('bulkInterval')?.value, 10) || 12, 3), 120);
  return { count, intervalSec };
}

function readSyncForm() {
  const maxConversations = Math.min(Math.max(parseInt(document.getElementById('syncCount')?.value, 10) || 10, 1), 30);
  const syncCountEl = document.getElementById('syncCount');
  if (syncCountEl) syncCountEl.value = String(maxConversations);
  return { maxConversations };
}

function setBulkSendUiRunning(running) {
  const sendBtn = document.getElementById('bulkSendBtn');
  const stopBtn = document.getElementById('bulkStopBtn');
  if (sendBtn) sendBtn.disabled = running;
  if (stopBtn) stopBtn.classList.toggle('hidden', !running);
}

function setSyncUiRunning(running) {
  const syncBtn = document.getElementById('syncInboxBtn');
  const syncCountEl = document.getElementById('syncCount');
  if (syncBtn) {
    syncBtn.disabled = running;
    syncBtn.textContent = running ? '同步中…' : SYNC_BUTTON_TEXT;
  }
  if (syncCountEl) syncCountEl.disabled = running;
}

async function clearSyncProgress() {
  try {
    await chrome.runtime.sendMessage({ type: 'CLEAR_SYNC_PROGRESS' });
  } catch (_) { /* ignore */ }
}

function renderSyncProgress(progress) {
  if (!syncProgressActive || !progress) return;
  const current = Math.max(Number(progress.current) || 0, 0);
  const total = Math.max(Number(progress.total) || 0, 0);
  if (progress.phase === 'capture') {
    showBanner(`当前正在同步中 · 匹配落库 ${current}/${total || current}`, 'ok');
    return;
  }
  showBanner(`当前正在同步中 · 抓取会话 ${current}/${total || current}`, 'ok');
}

function startSyncProgressPolling() {
  stopSyncProgressPolling();
  syncProgressActive = true;
  syncProgressTimer = setInterval(async () => {
    if (!syncProgressActive) return;
    try {
      const stored = await chrome.storage.session.get({ [SYNC_PROGRESS_KEY]: null });
      renderSyncProgress(stored[SYNC_PROGRESS_KEY]);
    } catch (_) { /* ignore */ }
  }, 400);
}

function stopSyncProgressPolling() {
  syncProgressActive = false;
  if (syncProgressTimer) {
    clearInterval(syncProgressTimer);
    syncProgressTimer = null;
  }
}

function removeLeadFromList(leadId) {
  leads = leads.filter((l) => l.leadId !== leadId);
  renderList();
}

async function applySendResult(lead, result, text) {
  // 仅 ok:true（插件已确认 OUT 气泡）才标成功，杜绝假成功
  if (result?.ok && result?.reason !== 'SEND_FAILED') {
    await patchLeadStatus(lead, 'PLUGIN_CONTACTED', 'extension:autosend');
    try { await captureOutMessage(lead, text); } catch (_) { /* ignore */ }
    return 'success';
  }
  const reason = result?.reason || 'SEND_FAILED';
  if (reason === 'PREMIUM_REQUIRED') {
    await patchLeadStatus(lead, 'SEND_FAILED_PREMIUM', 'extension:premium_required');
    return 'premium';
  }
  if (reason === 'RATE_LIMIT') {
    await patchLeadStatus(lead, 'SEND_FAILED_RATE_LIMIT', 'extension:rate_limit');
    return 'rate_limit';
  }
  if (reason === 'DM_REJECTED') {
    await patchLeadStatus(lead, 'SEND_FAILED_DM_REJECTED', 'extension:dm_rejected');
    return 'rejected';
  }
  const err = (result?.error || 'unknown').slice(0, 80);
  await patchLeadStatus(lead, 'SEND_FAILED', `extension:send_failed:${err}`);
  return 'failed';
}

async function sendDmToLead(lead, text) {
  return chrome.runtime.sendMessage({
    type: 'AUTO_SEND_DM',
    profileUrl: lead.profileUrl,
    screenName: lead.screenName,
    text,
    passcode: cfg.xPasscode || '1234',
    leadId: lead.leadId,
    closeTab: true
  });
}

function fillSettingsForm() {
  applySettingsApiEnvUi();
  updateCampaignPickerUi();
  const bizEl = document.getElementById('businessAccount');
  if (bizEl) bizEl.value = isBigRole() ? BIG_ACCOUNT : storedSmallBusinessAccount();
  applySettingsRoleUi();
  document.getElementById('username').value = cfg.username || '';
  document.getElementById('password').value = cfg.password || '';
  document.getElementById('xPasscode').value = cfg.xPasscode || '1234';
  if (cfg.token && cfg.username) {
    loginInfo.textContent = `已登录：${cfg.displayName || cfg.username}`;
    loginInfo.classList.remove('hidden');
  } else if (cfg.token) {
    loginInfo.textContent = '已登录（Token 有效）';
    loginInfo.classList.remove('hidden');
  } else {
    loginInfo.classList.add('hidden');
  }
}

function showMain() {
  viewSettings.classList.add('hidden');
  viewMain.classList.remove('hidden');
}

async function showSettings() {
  viewMain.classList.add('hidden');
  viewSettings.classList.remove('hidden');
  fillSettingsForm();
  showSettingsStatus('');
  hideCampaignSuggest();
  if (cfg.token) {
    await ensureCampaignNameFromId();
    updateCampaignPickerUi();
  }
}

async function api(path, options = {}) {
  const url = `${cfg.apiBase}${path}`;
  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (!options.skipAuth) headers.Authorization = authHeader();
  const res = await fetch(url, { ...options, headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) {
    const unauthorized = res.status === 401
      || /token|未登录|unauthorized|认证/i.test(String(body.message || ''));
    if (unauthorized && !options.skipAuth && !options.skipRelogin) {
      const ok = await silentRelogin();
      if (ok) {
        return api(path, { ...options, skipRelogin: true });
      }
    }
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  return body.data;
}

let silentReloginInFlight = null;

async function silentRelogin() {
  if (!cfg.username || !cfg.password) return false;
  if (silentReloginInFlight) return silentReloginInFlight;
  silentReloginInFlight = (async () => {
    try {
      const data = await api('/api/user/login', {
        method: 'POST',
        skipAuth: true,
        skipRelogin: true,
        body: JSON.stringify({
          loginType: 'USERNAME_PASSWORD',
          username: cfg.username,
          password: cfg.password
        })
      });
      if (!data?.accessToken) return false;
      await persistCfg({
        token: data.accessToken,
        displayName: data.nickname || data.username || cfg.username
      });
      return true;
    } catch {
      return false;
    } finally {
      silentReloginInFlight = null;
    }
  })();
  return silentReloginInFlight;
}

async function loginAndSave() {
  const apiEnv = readSettingsApiEnv();
  const apiBase = resolveApiBase(apiEnv);
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const xPasscode = document.getElementById('xPasscode').value.trim() || '1234';
  if (!username || !password) {
    showSettingsStatus('请填写账号和密码', 'err');
    return;
  }
  showSettingsStatus('登录中…');
  try {
    cfg.apiEnv = apiEnv;
    cfg.apiBase = apiBase;
    const data = await api('/api/user/login', {
      method: 'POST',
      skipAuth: true,
      body: JSON.stringify({
        loginType: 'USERNAME_PASSWORD',
        username,
        password
      })
    });
    if (!data?.accessToken) throw new Error('登录成功但未返回 accessToken');
    await persistCfg({
      apiEnv,
      apiBase,
      ...readSettingsRole(),
      username,
      password,
      token: data.accessToken,
      displayName: data.nickname || data.username || username,
      xPasscode
    });
    fillSettingsForm();
    await ensureCampaignNameFromId();
    updateCampaignPickerUi();
    const tip = cfg.campaignId
      ? '登录成功，Token 已保存'
      : '登录成功。请搜索并选择活动名称';
    showSettingsStatus(tip, 'ok');
  } catch (e) {
    showSettingsStatus(e.message || String(e), 'err');
  }
}

async function testConnection() {
  await loadCfg();
  const apiEnv = readSettingsApiEnv();
  const apiBase = resolveApiBase(apiEnv);
  const campaignId = document.getElementById('campaignId').value.trim() || cfg.campaignId;
  const xPasscode = document.getElementById('xPasscode').value.trim() || cfg.xPasscode || '1234';
  if (!cfg.token) {
    showSettingsStatus('请先登录 CRM', 'err');
    return;
  }
  if (!campaignId) {
    showSettingsStatus('请先选择活动', 'err');
    return;
  }
  cfg.apiEnv = apiEnv;
  cfg.apiBase = apiBase;
  showSettingsStatus('测试中…');
  try {
    const roleCfg = readSettingsRole();
    await persistCfg({
      apiEnv,
      apiBase,
      campaignId,
      campaignName: cfg.campaignName || '',
      xPasscode,
      ...roleCfg
    });
    const q = isBigRole()
      ? leadsQuery({ status: 'PLUGIN_CONTACTED', ownership: 'received' })
      : leadsQuery({ status: 'PENDING_PLUGIN' });
    const data = await api(
      `/api/campaigns/${encodeURIComponent(campaignId)}/twitter-plugin/leads${q}`
    );
    const n = Array.isArray(data) ? data.length : 0;
    showSettingsStatus(
      isBigRole()
        ? `连接成功，已移交线索 ${n} 条`
        : `连接成功，PENDING_PLUGIN ${n} 条`,
      'ok'
    );
  } catch (e) {
    showSettingsStatus(e.message || String(e), 'err');
  }
}

async function logout() {
  await persistCfg({ token: '', displayName: '' });
  hideCampaignSuggest();
  fillSettingsForm();
  showSettingsStatus('已退出登录', 'ok');
}

function renderTemplate(body, lead) {
  const nick = lead.nickname || lead.screenName || 'there';
  return (body || '').replaceAll('{{nickname}}', nick);
}

function fmtNum(n) {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function selectedTemplateBody() {
  return templateDraft.savedBody || '';
}

function templateKindOf(t) {
  if (t && t.kind) return t.kind;
  if (t && t.id === 'dm_followup_short') return 'followup';
  return 'intro';
}

function isTemplateDirty() {
  return String(templateDraft.editorBody || '') !== String(templateDraft.savedBody || '');
}

function loadTemplateDraftFromSelect() {
  const t = templates.find((x) => x.id === templateSelect.value);
  const body = t ? (t.body || '') : '';
  templateDraft.kind = templateKindOf(t);
  templateDraft.savedBody = body;
  templateDraft.editorBody = body;
}

function applyTemplateUiMode() {
  const wrap = document.getElementById('templateBodyWrap');
  const preview = document.getElementById('templatePreview');
  const editor = document.getElementById('templateEditor');
  const saveRow = document.getElementById('templateSaveRow');
  const viewBtn = document.getElementById('templateViewBtn');
  const editBtn = document.getElementById('templateEditBtn');
  const collapseBtn = document.getElementById('templateCollapseBtn');
  const hasTemplate = Boolean(templateSelect?.value);
  if (viewBtn) viewBtn.disabled = !hasTemplate;
  if (editBtn) editBtn.disabled = !hasTemplate;

  const showBody = templateUiMode === 'view' || templateUiMode === 'edit';
  wrap?.classList.toggle('hidden', !showBody);
  collapseBtn?.classList.toggle('hidden', !showBody);
  preview?.classList.toggle('hidden', templateUiMode !== 'view');
  editor?.classList.toggle('hidden', templateUiMode !== 'edit');
  saveRow?.classList.toggle('hidden', templateUiMode !== 'edit');
  viewBtn?.classList.toggle('active', templateUiMode === 'view');
  editBtn?.classList.toggle('active', templateUiMode === 'edit');

  if (templateUiMode === 'view' && preview) {
    preview.textContent = templateDraft.savedBody || '（空）';
  }
  if (templateUiMode === 'edit' && editor) {
    editor.value = templateDraft.editorBody || '';
  }
  updateTemplateSaveUi();
}

function resetTemplateUi() {
  templateUiMode = 'idle';
  loadTemplateDraftFromSelect();
  applyTemplateUiMode();
}

function onTemplateSelectChange() {
  if (templateUiMode === 'edit' && isTemplateDirty()) {
    const prev = templates.find((t) => templateKindOf(t) === templateDraft.kind);
    if (prev && templateSelect) templateSelect.value = prev.id;
    showBanner('请先保存话术再切换模板', 'err');
    return;
  }
  loadTemplateDraftFromSelect();
  applyTemplateUiMode();
}

function enterTemplateView() {
  if (templateUiMode === 'edit' && isTemplateDirty()) {
    showBanner('请先保存或取消编辑', 'err');
    return;
  }
  templateDraft.editorBody = templateDraft.savedBody;
  templateUiMode = 'view';
  applyTemplateUiMode();
}

function enterTemplateEdit() {
  if (!templateSelect?.value) {
    showBanner('请先选择话术模板', 'err');
    return;
  }
  if (templateUiMode !== 'edit') {
    templateDraft.editorBody = templateDraft.savedBody;
  }
  templateUiMode = 'edit';
  applyTemplateUiMode();
  document.getElementById('templateEditor')?.focus();
}

function cancelTemplateEdit() {
  templateDraft.editorBody = templateDraft.savedBody;
  templateUiMode = 'idle';
  applyTemplateUiMode();
}

function collapseTemplate() {
  if (templateUiMode === 'edit' && isTemplateDirty()) {
    showBanner('请先保存或取消编辑', 'err');
    return;
  }
  cancelTemplateEdit();
}

function updateTemplateSaveUi() {
  const dirty = isTemplateDirty();
  const saveBtn = document.getElementById('templateSaveBtn');
  const hint = document.getElementById('templateDirtyHint');
  if (saveBtn) saveBtn.disabled = !dirty;
  if (hint) hint.classList.toggle('hidden', !dirty);
}

function requireSavedTemplate() {
  if (isTemplateDirty()) {
    showBanner('请先保存话术再发送', 'err');
    return false;
  }
  if (!String(templateDraft.savedBody || '').trim()) {
    showBanner('请先选择话术模板', 'err');
    return false;
  }
  return true;
}

async function saveCurrentTemplate() {
  const kind = templateDraft.kind || 'intro';
  const body = String(templateDraft.editorBody || '').trim();
  if (!body) {
    showBanner('话术不能为空', 'err');
    return;
  }
  if (!cfg.campaignId) {
    showBanner('请先选择活动', 'err');
    return;
  }
  try {
    const saved = await api(
      `/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/templates/${encodeURIComponent(kind)}`,
      { method: 'PUT', body: JSON.stringify({ body }) }
    );
    const nextBody = (saved && saved.body) || body;
    templateDraft.savedBody = nextBody;
    templateDraft.editorBody = nextBody;
    const idx = templates.findIndex((x) => templateKindOf(x) === kind || x.id === templateSelect.value);
    if (idx >= 0) templates[idx] = { ...templates[idx], ...saved, body: nextBody, kind };
    templateUiMode = 'view';
    applyTemplateUiMode();
    showBanner('话术已保存', 'ok');
  } catch (e) {
    showBanner(e.message || '保存失败', 'err');
  }
}

function renderCaptureLeads() {
  captureLead.innerHTML = '';
  const pool = visibleCaptureLeads();
  if (!pool.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（无可收录线索）';
    captureLead.appendChild(opt);
    return;
  }
  for (const lead of pool) {
    const opt = document.createElement('option');
    opt.value = lead.leadId;
    const label = lead.screenName ? `@${lead.screenName}` : (lead.nickname || lead.leadId);
    opt.textContent = `${label} · ${lead.contactStatus || ''}`;
    captureLead.appendChild(opt);
  }
}

function smallCardActions(lead) {
  const st = leadStatus(lead);
  const openCopy = `
        <button type="button" class="accent" data-act="open">打开主页</button>
        <button type="button" class="accent" data-act="copy">复制话术</button>`;
  if (st === 'PENDING_PLUGIN' || cfg.smallStatusFilter === 'pending') {
    return `
        <button type="button" class="ok" data-act="autosend">发送私信</button>
        ${openCopy}
        <button type="button" class="warn" data-act="contacted">标已私信</button>
        <button type="button" class="warn" data-act="skip">跳过</button>
        <button type="button" class="err" data-act="fail">发送失败</button>`;
  }
  if (canHandoffStatus(st)) {
    return `
        ${st === 'REPLIED' ? judgementActions(lead) : ''}
        <button type="button" class="ok" data-act="handoff">转入系统数据库</button>
        ${openCopy}`;
  }
  return openCopy;
}

function renderList() {
  updateModeUi();
  if (!leads.length) {
    listEl.innerHTML = `<div class="empty">${emptyListHint()}</div>`;
    renderCaptureLeads();
    return;
  }
  const shown = visibleLeads();
  if (!shown.length) {
    listEl.innerHTML = '<div class="empty">当前状态下没有匹配的达人</div>';
    renderCaptureLeads();
    return;
  }
  listEl.innerHTML = '';
  const isBig = isBigRole();
  for (const lead of shown) {
    const card = document.createElement('div');
    card.className = 'card';
    const handle = lead.screenName ? `@${lead.screenName}` : '';
    const ownerHint = lead.ownerBusinessAccount
      ? `<div class="meta">归属 ${escapeHtml(lead.ownerBusinessAccount)} · ${escapeHtml(lead.contactStatus || '')}</div>`
      : `<div class="meta">状态 ${escapeHtml(lead.contactStatus || '—')}</div>`;
    const actionsHtml = isBig
      ? `
        ${judgementActions(lead)}
        <button type="button" class="accent" data-act="open">打开主页</button>
        <button type="button" class="accent" data-act="copy">复制话术</button>
      `
      : smallCardActions(lead);
    card.innerHTML = `
      <div class="name">${escapeHtml(lead.nickname || handle || lead.leadId)}</div>
      <div class="handle">${escapeHtml(handle)}</div>
      <div class="meta">粉丝 ${fmtNum(lead.follower)} · 均播 ${fmtNum(lead.avgView)}</div>
      ${ownerHint.replace('</div>', `${processStatusHint(lead)}</div>`)}
      ${lead.bio ? `<div class="bio">${escapeHtml(lead.bio)}</div>` : ''}
      <div class="actions">${actionsHtml}</div>
    `;
    card.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => onAction(btn.dataset.act, lead));
    });
    listEl.appendChild(card);
  }
  renderCaptureLeads();
}

async function patchProcessStatus(lead, processStatus) {
  const data = await api(
    `/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads/${encodeURIComponent(lead.leadId)}/process-status`,
    {
      method: 'PATCH',
      body: JSON.stringify({ processStatus })
    }
  );
  if (data && data.processStatus) {
    lead.processStatus = data.processStatus;
  } else {
    lead.processStatus = processStatus;
  }
}

async function patchLeadStatus(lead, contactStatus, note) {
  await api(
    `/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads/${encodeURIComponent(lead.leadId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        contactStatus,
        note,
        businessAccount: effectiveBusinessAccount() || undefined
      })
    }
  );
}

async function captureOutMessage(lead, text) {
  if (!text) return;
  await api(
    `/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/dm/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        leadId: lead.leadId,
        source: 'manual',
        direction: 'OUT',
        text,
        extractQuote: false,
        businessAccount: effectiveBusinessAccount() || undefined,
        pluginCaptureId: `ext-${lead.leadId}-${hashText(text)}-out`
      })
    }
  );
}

async function handoffLead(lead) {
  const from = effectiveBusinessAccount();
  if (!from) {
    showBanner('请先在设置填写「个人ID」', 'err');
    return;
  }
  await api(
    `/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads/${encodeURIComponent(lead.leadId)}/handoff`,
    {
      method: 'POST',
      body: JSON.stringify({
        fromBusinessAccount: from,
        toBusinessAccount: BIG_ACCOUNT,
        note: 'extension:handoff'
      })
    }
  );
  showBanner(`已转交 ${lead.screenName || lead.leadId} → ${BIG_ACCOUNT}`, 'ok');
}

async function onAction(act, lead) {
  if (busy) {
    showBanner('请等待当前操作完成', 'err');
    return;
  }
  try {
    if (act === 'open') {
      const text = renderTemplate(selectedTemplateBody(), lead);
      await chrome.runtime.sendMessage({
        type: 'OPEN_PROFILE',
        profileUrl: lead.profileUrl,
        screenName: lead.screenName,
        draftText: text,
        leadId: lead.leadId
      });
      showBanner(`已打开 ${lead.screenName || ''}`, 'ok');
      return;
    }
    if (act === 'copy') {
      await navigator.clipboard.writeText(renderTemplate(selectedTemplateBody(), lead));
      showBanner('话术已复制', 'ok');
      return;
    }
    if (act === 'autosend') {
      if (!requireSavedTemplate()) return;
      busy = true;
      const text = renderTemplate(selectedTemplateBody(), lead);
      if (!text) {
        showBanner('请先选择话术模板', 'err');
        busy = false;
        return;
      }
      if (!lead.screenName && !lead.profileUrl) {
        showBanner('线索缺少 screenName / profileUrl', 'err');
        busy = false;
        return;
      }
      showBanner(`正在发送给 @${lead.screenName || ''}…`);
      const result = await sendDmToLead(lead, text);
      const outcome = await applySendResult(lead, result, text);
      removeLeadFromList(lead.leadId);
      busy = false;
      const sn = lead.screenName || '';
      if (outcome === 'success') {
        await switchToHandoffQueueAndRefresh(`已确认发送 @${sn} · 已进入「已私信」，可转入系统数据库`);
      } else if (outcome === 'premium') {
        showBanner(`@${sn} 需 Premium，已标记 SEND_FAILED_PREMIUM`, 'err');
      } else if (outcome === 'rate_limit') {
        showBanner(`@${sn} 日额度不足，已标记 SEND_FAILED_RATE_LIMIT`, 'err');
      } else if (outcome === 'rejected') {
        showBanner(`@${sn} 拒收私信，已标记 SEND_FAILED_DM_REJECTED`, 'err');
      } else {
        showBanner(result?.error || `发送失败，已标记 SEND_FAILED`, 'err');
      }
      return;
    }

    if (act === 'handoff') {
      if (!canHandoffStatus(lead.contactStatus)) {
        showBanner('跳过 / 失败 / 待建联线索不转入系统数据库', 'err');
        return;
      }
      await handoffLead(lead);
      leads = leads.filter((l) => l.leadId !== lead.leadId);
      renderList();
      return;
    }

    if (act === 'quoted' || act === 'notmatch') {
      if (leadStatus(lead) !== 'REPLIED') {
        showBanner('仅已回复线索可标已报价/不符合', 'err');
        return;
      }
      const processStatus = act === 'quoted' ? 'QUOTED' : 'NOT_MATCH';
      await patchProcessStatus(lead, processStatus);
      const inList = leads.find((l) => l.leadId === lead.leadId);
      if (inList) inList.processStatus = lead.processStatus;
      renderList();
      showBanner(processStatus === 'QUOTED' ? '已标为已报价，可在绑定项提报' : '已标为不符合', 'ok');
      return;
    }

    const statusMap = {
      contacted: 'PLUGIN_CONTACTED',
      skip: 'SKIPPED',
      fail: 'SEND_FAILED'
    };
    const contactStatus = statusMap[act];
    if (!contactStatus) return;
    await patchLeadStatus(lead, contactStatus, `extension:${act}`);
    if (act === 'contacted') {
      try {
        await captureOutMessage(lead, renderTemplate(selectedTemplateBody(), lead));
      } catch (_) { /* ignore */ }
      removeLeadFromList(lead.leadId);
      await switchToHandoffQueueAndRefresh(`已标已私信 · 进入「已私信」，可转入系统数据库`);
      return;
    }
    leads = leads.filter((l) => l.leadId !== lead.leadId);
    renderList();
    showBanner(`已回写 ${contactStatus}`, 'ok');
  } catch (e) {
    busy = false;
    showBanner(formatExtError(e), 'err');
  }
}

async function bulkSendAll() {
  if (busy) {
    showBanner('请等待当前操作完成', 'err');
    return;
  }
  if (isBigRole() || cfg.smallStatusFilter !== 'pending') {
    showBanner('批量发送仅在「小号 · 待建联」可用', 'err');
    return;
  }
  await loadCfg();
  if (!cfg.token || !cfg.campaignId) {
    showBanner('请先登录 CRM 并选择活动', 'err');
    return;
  }
  const templateBody = selectedTemplateBody();
  if (!requireSavedTemplate()) {
    return;
  }
  if (!templateBody) {
    showBanner('请先选择话术模板', 'err');
    return;
  }
  const { count, intervalSec } = readBulkSendForm();
  await persistCfg({ bulkSendCount: count, bulkSendIntervalSec: intervalSec });

  const queue = visibleLeads().filter((l) => l.screenName || l.profileUrl).slice(0, count);
  if (!queue.length) {
    showBanner(
      currentLeadSearchQuery() ? '当前筛选下没有可发送的线索' : '没有可发送的 PENDING_PLUGIN 线索',
      'err'
    );
    return;
  }

  bulkAbort = false;
  busy = true;
  setBulkSendUiRunning(true);

  let success = 0;
  let premium = 0;
  let rateLimit = 0;
  let rejected = 0;
  let failed = 0;

  try {
    for (let i = 0; i < queue.length; i++) {
      if (bulkAbort) break;
      const lead = queue[i];
      const text = renderTemplate(templateBody, lead);
      showBanner(`一键发送 ${i + 1}/${queue.length}：@${lead.screenName || lead.nickname || ''}…`);
      const result = await sendDmToLead(lead, text);
      const outcome = await applySendResult(lead, result, text);
      removeLeadFromList(lead.leadId);
      if (outcome === 'success') success += 1;
      else if (outcome === 'premium') premium += 1;
      else if (outcome === 'rate_limit') rateLimit += 1;
      else if (outcome === 'rejected') rejected += 1;
      else failed += 1;

      if (i < queue.length - 1 && !bulkAbort) {
        const jitter = 0.7 + Math.random() * 0.6;
        await sleep(intervalSec * 1000 * jitter);
      }
    }

    if (success > 0) {
      await switchToHandoffQueueAndRefresh(
        `批量完成：成功 ${success}，Premium ${premium}，额度 ${rateLimit}，拒收 ${rejected}，其它失败 ${failed} · 已进入「已私信」`
      );
    } else {
      await refresh({ keepBanner: true });
      const stopped = bulkAbort ? '（已停止）' : '';
      const totalFail = premium + rateLimit + rejected + failed;
      showBanner(
        `批量完成${stopped}：成功 ${success}，Premium ${premium}，额度 ${rateLimit}，拒收 ${rejected}，其它失败 ${failed}`,
        totalFail && !success ? 'err' : 'ok'
      );
    }
  } catch (e) {
    showBanner(formatExtError(e), 'err');
  } finally {
    bulkAbort = false;
    busy = false;
    setBulkSendUiRunning(false);
  }
}

async function refresh(options = {}) {
  const keepBanner = !!options.keepBanner;
  if (!keepBanner) showBanner('加载中…');
  try {
    await loadCfg();
    updateModeUi();
    if (!cfg.apiBase || !cfg.campaignId || !cfg.token) {
      showBanner('请先在设置中用账号密码登录', 'err');
      listEl.innerHTML = '<div class="empty">打开右上角 ⚙ 完成 CRM 登录</div>';
      return;
    }
    if (isBigRole() && !effectiveBusinessAccount()) {
      showBanner('系统数据库角色身份为 admin，请重新保存设置', 'err');
      leads = [];
      captureLeads = [];
      renderList();
      return;
    }
    if (!isBigRole() && cfg.smallStatusFilter !== 'pending' && cfg.smallStatusFilter !== 'all' && !cfg.businessAccount) {
      showBanner('该状态列表需要「个人ID」', 'err');
      leads = [];
      captureLeads = [];
      renderList();
      return;
    }
    const [leadData, tplData, allPluginLeads] = await Promise.all([
      api(`/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads${leadsQuery(mainListQuery())}`),
      api(`/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/templates`),
      api(`/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads${leadsQuery(captureListQuery())}`)
    ]);
    leads = applySmallLeadsFilter(Array.isArray(leadData) ? leadData : []);
    captureLeads = Array.isArray(allPluginLeads) ? allPluginLeads : leads;
    templates = Array.isArray(tplData) ? tplData : [];
    templateSelect.innerHTML = '';
    for (const t of templates) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name || t.id;
      templateSelect.appendChild(opt);
    }
    if (!templates.length) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '（无模板）';
      templateSelect.appendChild(opt);
    }
    resetTemplateUi();
    renderList();
    fillBulkSendForm();
    if (!keepBanner) {
      showBanner(`${currentViewLabel()} · ${listCountText()}`, 'ok');
    }
  } catch (e) {
    const msg = e.message || String(e);
    showBanner(/401|未登录|token|过期|认证|授权/i.test(msg)
      ? '登录已失效，请到设置重新登录'
      : msg, 'err');
    listEl.innerHTML = '<div class="empty">加载失败</div>';
  }
}

async function syncInboxAndQuotes() {
  if (busy) {
    showBanner('当前正在同步中，请稍候');
    return;
  }
  await loadCfg();
  if (!cfg.token || !cfg.campaignId) {
    showBanner('请先登录 CRM 并选择活动', 'err');
    return;
  }
  const { maxConversations } = readSyncForm();
  await persistCfg({ syncMaxConversations: maxConversations });
  busy = true;
  setSyncUiRunning(true);
  syncProgressActive = true;
  showBanner('当前正在同步中…', 'ok');
  startSyncProgressPolling();
  const SYNC_SCRAPE_TIMEOUT_MS = 180000;
  try {
    const scraped = await Promise.race([
      chrome.runtime.sendMessage({
        type: 'SYNC_INBOX',
        passcode: cfg.xPasscode || '1234',
        maxConversations
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('抓取超时（3分钟）。请确认已打开 x.com 私信页后重试')), SYNC_SCRAPE_TIMEOUT_MS);
      })
    ]);
    if (!scraped?.ok) {
      throw new Error(scraped?.error || '抓取失败');
    }
    const threads = scraped.threads || [];
    renderSyncProgress({ phase: 'capture', current: 0, total: threads.length });
    const leadByScreen = new Map();
    const addLeadAlias = (key, lead) => {
      const k = String(key || '').toLowerCase().replace(/^@/, '').trim();
      if (!k || leadByScreen.has(k)) return;
      leadByScreen.set(k, lead);
    };
    const indexLead = (l) => {
      if (!l) return;
      addLeadAlias(l.screenName, l);
      addLeadAlias(l.nickname, l);
      const url = String(l.profileUrl || '');
      const um = url.match(/(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})/i);
      if (um) addLeadAlias(um[1], l);
    };
    // 同步必须用活动下全部 PLUGIN_DM 线索，不能用「已私信」主列表（REPLIED 会被丢掉）
    let syncLeads = [];
    try {
      const all = await api(
        `/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads${leadsQuery({})}`
      );
      if (Array.isArray(all)) {
        syncLeads = all;
        captureLeads = all;
      }
    } catch (e) {
      console.warn('[Bioby sync] load all leads failed', e);
    }
    if (!syncLeads.length) {
      syncLeads = (captureLeads && captureLeads.length) ? captureLeads : (leads || []);
    }
    for (const l of syncLeads) {
      indexLead(l);
    }

    let msgCount = 0;
    let quoteCount = 0;
    let skippedDup = 0;
    let reboundCount = 0;
    let matchedThreads = 0;
    let anchorMatched = 0;
    const unmatched = [];

    for (let ti = 0; ti < threads.length; ti++) {
      const th = threads[ti];
      renderSyncProgress({ phase: 'capture', current: ti + 1, total: threads.length });
      const sn = (th.screenName || '').toLowerCase().replace(/^@/, '');
      const currentLead = sn ? leadByScreen.get(sn) : null;
      const messages = sortThreadMessages(th.messages || []);
      if (!messages.length) {
        unmatched.push(currentLead ? `${sn}(未抓到气泡)` : `${sn || '(unknown)'}(无气泡)`);
        continue;
      }

      let lastAnchor = null;
      let threadHadCapture = false;

      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m.text) continue;
        const direction = m.direction === 'OUT' ? 'OUT' : 'IN';
        try {
          if (direction === 'OUT') {
            let campaignIdForCapture = cfg.campaignId;
            let leadForCapture = currentLead;
            if (!leadForCapture) {
              const resolved = await resolveThreadAnchor(sn, [m]);
              if (resolved?.matched && resolved.leadId && resolved.campaignId) {
                leadForCapture = {
                  leadId: resolved.leadId,
                  campaignId: resolved.campaignId,
                  influencerId: resolved.influencerId,
                  screenName: resolved.screenName || sn
                };
                campaignIdForCapture = resolved.campaignId;
                anchorMatched += 1;
              }
            }
            if (!leadForCapture) {
              continue;
            }
            const result = await postDmCapture({
              campaignId: campaignIdForCapture,
              leadId: leadForCapture.leadId,
              message: m,
              source: 'sync',
              extractQuote: false
            });
            threadHadCapture = true;
            if (result?.action === 'skipped') skippedDup += 1;
            else if (result?.action === 'rebound') reboundCount += 1;
            else msgCount += 1;
            if (result?.campaignId && result?.leadId) {
              lastAnchor = { campaignId: result.campaignId, leadId: result.leadId };
            }
            if (result?.quoteExtracted) quoteCount += 1;
          } else {
            if (!lastAnchor) {
              continue;
            }
            const result = await postDmCapture({
              campaignId: lastAnchor.campaignId,
              leadId: lastAnchor.leadId,
              message: m,
              source: 'sync',
              extractQuote: true
            });
            threadHadCapture = true;
            if (result?.action === 'skipped') skippedDup += 1;
            else if (result?.action === 'rebound') reboundCount += 1;
            else msgCount += 1;
            if (result?.quoteExtracted) quoteCount += 1;
          }
        } catch (e) {
          console.warn('[Bioby sync] capture failed', sn, direction, m.text?.slice(0, 40), e);
        }
      }

      if (threadHadCapture) matchedThreads += 1;
      else if (currentLead) unmatched.push(`${sn}(收录失败)`);
      else unmatched.push(`${sn || '(unknown)'}(无线索)`);
    }

    const matchLabel = anchorMatched
      ? `匹配 ${matchedThreads}（锚点 ${anchorMatched}）`
      : `匹配 ${matchedThreads}`;
    const syncSummary =
      `同步完成：会话 ${threads.length}，${matchLabel}，消息 ${msgCount}，报价 ${quoteCount}`
      + (skippedDup ? `，跳过重复 ${skippedDup}` : '')
      + (reboundCount ? `，改绑 ${reboundCount}` : '')
      + (unmatched.length ? `；未匹配 ${unmatched.slice(0, 8).join(', ')}` : '');
    // refresh 会改横幅为 PENDING 条数，故先刷列表再恢复同步结果
    await refresh({ keepBanner: true });
    showBanner(syncSummary, 'ok');
  } catch (e) {
    showBanner(formatExtError(e), 'err');
  } finally {
    stopSyncProgressPolling();
    await clearSyncProgress();
    setSyncUiRunning(false);
    busy = false;
  }
}

function hashText(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i);
  return String(h >>> 0);
}

function sortThreadMessages(messages) {
  const list = (messages || []).filter((m) => m && m.text).map((m, i) => ({ ...m, domIndex: m.domIndex ?? i }));
  list.sort((a, b) => {
    const at = a.sentAt ? Date.parse(a.sentAt) : NaN;
    const bt = b.sentAt ? Date.parse(b.sentAt) : NaN;
    const aOk = !Number.isNaN(at);
    const bOk = !Number.isNaN(bt);
    if (aOk && bOk && at !== bt) return at - bt;
    if (aOk && !bOk) return -1;
    if (!aOk && bOk) return 1;
    return (a.domIndex ?? 0) - (b.domIndex ?? 0);
  });
  return list;
}

function pluginCaptureIdFor(message, leadId, direction) {
  if (message?.xMessageId) return `sync-${message.xMessageId}`;
  return `sync-${leadId || 'na'}-${hashText(message?.text)}-${String(direction || 'in').toLowerCase()}`;
}

async function resolveThreadAnchor(screenName, messages) {
  if (!screenName) return null;
  try {
    return await api('/api/twitter-plugin/dm/resolve-thread', {
      method: 'POST',
      body: JSON.stringify({
        screenName,
        preferCampaignId: cfg.campaignId,
        businessAccount: effectiveBusinessAccount() || undefined,
        messages: (messages || []).filter((m) => m && m.text).slice(0, 3).map((m) => ({
          direction: m.direction === 'OUT' ? 'OUT' : 'IN',
          text: m.text,
          sentAt: m.sentAt || undefined
        }))
      })
    });
  } catch (e) {
    console.warn('[Bioby sync] resolve-thread failed', screenName, e);
    return null;
  }
}

async function postDmCapture({ campaignId, leadId, message, source, extractQuote }) {
  const direction = message.direction === 'OUT' ? 'OUT' : 'IN';
  return api(
    `/api/campaigns/${encodeURIComponent(campaignId)}/twitter-plugin/dm/messages`,
    {
      method: 'POST',
      body: JSON.stringify({
        leadId,
        source: source || 'sync',
        direction,
        text: message.text,
        sentAt: message.sentAt || undefined,
        xMessageId: message.xMessageId || undefined,
        extractQuote: extractQuote !== false && direction === 'IN',
        businessAccount: effectiveBusinessAccount() || undefined,
        pluginCaptureId: pluginCaptureIdFor(message, leadId, direction)
      })
    }
  );
}

document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('openSettings').addEventListener('click', async () => {
  await loadCfg();
  await showSettings();
});

document.getElementById('apiEnvSeg')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-api-env]');
  if (!btn) return;
  const env = btn.dataset.apiEnv === 'local' ? 'local' : 'test';
  const prev = cfg.apiEnv === 'local' ? 'local' : 'test';
  document.querySelectorAll('#apiEnvSeg .seg-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.apiEnv === env);
  });
  if (env === prev) return;
  const hadToken = Boolean(cfg.token);
  await persistCfg({
    apiEnv: env,
    apiBase: resolveApiBase(env),
    token: '',
    displayName: ''
  });
  fillSettingsForm();
  hideCampaignSuggest();
  showSettingsStatus(
    hadToken
      ? '已切换连接环境，请重新登录（Token 不能跨环境使用）'
      : `已切换到${env === 'local' ? '本地环境' : '测试服务器'}`,
    hadToken ? 'err' : 'ok'
  );
});

document.getElementById('campaignName')?.addEventListener('input', onCampaignNameInput);
document.getElementById('campaignName')?.addEventListener('focus', onCampaignNameInput);
document.getElementById('campaignSuggest')?.addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  selectCampaign(li.dataset.id, li.dataset.name || li.dataset.id);
});
document.addEventListener('click', (e) => {
  const picker = document.querySelector('.campaign-picker');
  if (picker && !picker.contains(e.target)) hideCampaignSuggest();
});

document.getElementById('templateSelect')?.addEventListener('change', onTemplateSelectChange);
document.getElementById('templateViewBtn')?.addEventListener('click', enterTemplateView);
document.getElementById('templateEditBtn')?.addEventListener('click', enterTemplateEdit);
document.getElementById('templateCollapseBtn')?.addEventListener('click', collapseTemplate);
document.getElementById('templateCancelBtn')?.addEventListener('click', cancelTemplateEdit);
document.getElementById('templateEditor')?.addEventListener('input', (e) => {
  templateDraft.editorBody = e.target.value || '';
  updateTemplateSaveUi();
});
document.getElementById('templateSaveBtn')?.addEventListener('click', saveCurrentTemplate);

document.getElementById('pluginRoleSeg')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-plugin-role]');
  if (!btn) return;
  const role = btn.dataset.pluginRole;
  if (role !== 'small' && role !== 'big') return;
  rememberSmallBusinessAccount(document.getElementById('businessAccount')?.value);
  cfg.pluginRole = role;
  applySettingsRoleUi();
  persistCfg({ pluginRole: role, businessAccount: storedSmallBusinessAccount() });
});

document.getElementById('leadSearchInput')?.addEventListener('input', () => {
  renderList();
  if (!busy && bannerEl.classList.contains('ok')) {
    showBanner(`${currentViewLabel()} · ${listCountText()}`, 'ok');
  }
});
document.getElementById('leadSearchInput')?.addEventListener('search', () => {
  renderList();
  if (!busy && bannerEl.classList.contains('ok')) {
    showBanner(`${currentViewLabel()} · ${listCountText()}`, 'ok');
  }
});

document.getElementById('smallStatusFilter')?.addEventListener('change', async (e) => {
  if (busy) return;
  const v = e.target.value || 'pending';
  clearLeadSearch();
  await persistCfg({ smallStatusFilter: v });
  updateModeUi();
  await refresh();
});

document.getElementById('bigStatusFilter')?.addEventListener('change', async (e) => {
  if (busy) return;
  const v = e.target.value || 'PLUGIN_CONTACTED';
  clearLeadSearch();
  await persistCfg({ bigStatusFilter: v });
  updateModeUi();
  await refresh();
});

document.getElementById('backToMain').addEventListener('click', () => {
  const xPasscode = document.getElementById('xPasscode').value.trim() || '1234';
  const campaignId = document.getElementById('campaignId').value.trim() || cfg.campaignId;
  const apiEnv = readSettingsApiEnv();
  persistCfg({
    xPasscode,
    campaignId,
    campaignName: cfg.campaignName || '',
    apiEnv,
    apiBase: resolveApiBase(apiEnv),
    ...readSettingsRole()
  }).then(() => {
    hideCampaignSuggest();
    showMain();
    updateModeUi();
    refresh();
  });
});
document.getElementById('loginSave').addEventListener('click', loginAndSave);
document.getElementById('testConn').addEventListener('click', testConnection);
document.getElementById('logout').addEventListener('click', logout);
document.getElementById('syncInboxBtn').addEventListener('click', syncInboxAndQuotes);
document.getElementById('bulkSendBtn').addEventListener('click', bulkSendAll);
document.getElementById('bulkStopBtn').addEventListener('click', () => {
  bulkAbort = true;
  showBanner('正在停止，当前条发送完成后退出…');
});

document.getElementById('captureBtn').addEventListener('click', async () => {
  const leadId = captureLead.value;
  const text = (captureText.value || '').trim();
  const direction = document.getElementById('captureDirection').value || 'IN';
  if (!leadId || !text) {
    showBanner('请选择线索并粘贴 DM 原文', 'err');
    return;
  }
  try {
    await loadCfg();
    const result = await api(
      `/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/dm/messages`,
      {
        method: 'POST',
        body: JSON.stringify({
          leadId,
          source: 'manual',
          direction,
          text,
          extractQuote: direction === 'IN',
          businessAccount: effectiveBusinessAccount() || undefined,
          pluginCaptureId: `ext-${leadId}-${hashText(text)}-${direction.toLowerCase()}`
        })
      }
    );
    captureText.value = '';
    showBanner(
      `已收录${result?.quoteExtracted ? ` · 报价 ${result.quoteSummary || ''}` : ''}`,
      'ok'
    );
  } catch (e) {
    showBanner(e.message || String(e), 'err');
  }
});

(async () => {
  fillExtVersion();
  await loadCfg();
  fillBulkSendForm();
  updateModeUi();
  if (!cfg.token || !cfg.campaignId) {
    await showSettings();
  } else {
    showMain();
    refresh();
  }
})();
