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

let cfg = {
  apiBase: '',
  campaignId: '',
  businessAccount: '',
  handoffTarget: '',
  workMode: 'small',
  smallQueue: 'pending',
  bigStatusFilter: 'PLUGIN_CONTACTED',
  username: '',
  token: '',
  displayName: '',
  xPasscode: '1234',
  bulkSendCount: 10,
  bulkSendIntervalSec: 12,
  syncMaxConversations: 10
};
let templates = [];
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

async function loadCfg() {
  cfg = await chrome.storage.local.get({
    apiBase: 'http://localhost:8080',
    campaignId: '',
    businessAccount: '',
    handoffTarget: '',
    workMode: 'small',
    smallQueue: 'pending',
    bigStatusFilter: 'PLUGIN_CONTACTED',
    username: '',
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
  if (cfg.workMode !== 'big') cfg.workMode = 'small';
  if (cfg.smallQueue !== 'handoff') cfg.smallQueue = 'pending';
  if (!cfg.bigStatusFilter) cfg.bigStatusFilter = 'PLUGIN_CONTACTED';
  cfg.syncMaxConversations = Math.min(Math.max(Number(cfg.syncMaxConversations) || 10, 1), 30);
  cfg.apiBase = (cfg.apiBase || '').replace(/\/$/, '');
  updateCrmLabel();
}

async function persistCfg(partial) {
  cfg = { ...cfg, ...partial };
  if (!cfg.xPasscode) cfg.xPasscode = '1234';
  if (cfg.workMode !== 'big') cfg.workMode = 'small';
  if (cfg.smallQueue !== 'handoff') cfg.smallQueue = 'pending';
  if (!cfg.bigStatusFilter) cfg.bigStatusFilter = 'PLUGIN_CONTACTED';
  await chrome.storage.local.set({
    apiBase: cfg.apiBase || '',
    campaignId: cfg.campaignId || '',
    businessAccount: cfg.businessAccount || '',
    handoffTarget: cfg.handoffTarget || '',
    workMode: cfg.workMode || 'small',
    smallQueue: cfg.smallQueue || 'pending',
    bigStatusFilter: cfg.bigStatusFilter || 'PLUGIN_CONTACTED',
    username: cfg.username || '',
    token: cfg.token || '',
    displayName: cfg.displayName || '',
    xPasscode: cfg.xPasscode || '1234',
    bulkSendCount: cfg.bulkSendCount ?? 10,
    bulkSendIntervalSec: cfg.bulkSendIntervalSec ?? 12,
    syncMaxConversations: Math.min(Math.max(Number(cfg.syncMaxConversations) || 10, 1), 30)
  });
  updateCrmLabel();
}

function leadsQuery(extra = {}) {
  const q = new URLSearchParams();
  if (extra.status) q.set('status', extra.status);
  if (extra.ownership) q.set('ownership', extra.ownership);
  if (cfg.businessAccount) q.set('businessAccount', cfg.businessAccount);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** 主列表当前视图查询参数 */
function mainListQuery() {
  if (cfg.workMode === 'big') {
    const q = { ownership: 'owned' };
    if (cfg.bigStatusFilter && cfg.bigStatusFilter !== 'ALL') {
      q.status = cfg.bigStatusFilter;
    }
    return q;
  }
  if (cfg.smallQueue === 'handoff') {
    return { status: 'PLUGIN_CONTACTED', ownership: 'owned' };
  }
  return { status: 'PENDING_PLUGIN' };
}

/** 收录下拉：小号放宽；大号 owned 全量便于收录 */
function captureListQuery() {
  if (cfg.workMode === 'big') {
    return { ownership: 'owned' };
  }
  return {};
}

function currentViewLabel() {
  const biz = cfg.businessAccount || '（未设商务号）';
  if (cfg.workMode === 'big') {
    const st = cfg.bigStatusFilter === 'ALL' ? '全部状态' : cfg.bigStatusFilter;
    return `当前：大号 · ${biz} · ${st}`;
  }
  const q = cfg.smallQueue === 'handoff' ? '待移交' : '待建联';
  return `当前：小号 · ${biz} · ${q}`;
}

function emptyListHint() {
  if (cfg.workMode === 'big') {
    return '暂无大号 owned 线索。<br/>确认已移交且「当前商务号」为大号标识。';
  }
  if (cfg.smallQueue === 'handoff') {
    return '暂无已私信待移交线索。<br/>发送成功或「标已私信」后会出现在此。';
  }
  return '暂无 PENDING_PLUGIN 线索。<br/>确认活动已搜号落库。';
}

function updateModeUi() {
  const hint = document.getElementById('modeHint');
  if (hint) hint.textContent = currentViewLabel();

  document.querySelectorAll('#workModeSeg .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.workMode === cfg.workMode);
  });
  document.querySelectorAll('#smallQueueSeg .seg-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.smallQueue === cfg.smallQueue);
  });

  const smallRow = document.getElementById('smallQueueRow');
  const bigRow = document.getElementById('bigStatusRow');
  const bulk = document.getElementById('bulkSendSection');
  const isSmall = cfg.workMode !== 'big';
  if (smallRow) smallRow.classList.toggle('hidden', !isSmall);
  if (bigRow) bigRow.classList.toggle('hidden', isSmall);
  if (bulk) {
    bulk.classList.toggle('hidden', !(isSmall && cfg.smallQueue === 'pending'));
  }

  const bigSel = document.getElementById('bigStatusFilter');
  if (bigSel && bigSel.value !== cfg.bigStatusFilter) {
    bigSel.value = cfg.bigStatusFilter || 'PLUGIN_CONTACTED';
  }
}

async function switchToHandoffQueueAndRefresh(bannerText) {
  cfg.workMode = 'small';
  cfg.smallQueue = 'handoff';
  await persistCfg({ workMode: 'small', smallQueue: 'handoff' });
  updateModeUi();
  await refresh({ keepBanner: true });
  showBanner(bannerText || '已进入「待移交」，可转交大号', 'ok');
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
  document.getElementById('apiBase').value = cfg.apiBase || '';
  document.getElementById('campaignId').value = cfg.campaignId || '';
  const bizEl = document.getElementById('businessAccount');
  if (bizEl) bizEl.value = cfg.businessAccount || '';
  const handoffEl = document.getElementById('handoffTarget');
  if (handoffEl) handoffEl.value = cfg.handoffTarget || '';
  document.getElementById('username').value = cfg.username || '';
  document.getElementById('password').value = '';
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

function showSettings() {
  viewMain.classList.add('hidden');
  viewSettings.classList.remove('hidden');
  fillSettingsForm();
  showSettingsStatus('');
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
    throw new Error(body.message || `HTTP ${res.status}`);
  }
  return body.data;
}

async function loginAndSave() {
  const apiBase = document.getElementById('apiBase').value.trim().replace(/\/$/, '');
  const campaignId = document.getElementById('campaignId').value.trim();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const xPasscode = document.getElementById('xPasscode').value.trim() || '1234';
  if (!apiBase || !campaignId) {
    showSettingsStatus('请填写 API Base 与 Campaign ID', 'err');
    return;
  }
  if (!username || !password) {
    showSettingsStatus('请填写账号和密码', 'err');
    return;
  }
  showSettingsStatus('登录中…');
  try {
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
      apiBase,
      campaignId,
      businessAccount: document.getElementById('businessAccount')?.value.trim() || '',
      handoffTarget: document.getElementById('handoffTarget')?.value.trim() || '',
      username,
      token: data.accessToken,
      displayName: data.nickname || data.username || username,
      xPasscode
    });
    document.getElementById('password').value = '';
    fillSettingsForm();
    showSettingsStatus('登录成功，Token 已保存', 'ok');
  } catch (e) {
    showSettingsStatus(e.message || String(e), 'err');
  }
}

async function testConnection() {
  await loadCfg();
  const apiBase = document.getElementById('apiBase').value.trim().replace(/\/$/, '') || cfg.apiBase;
  const campaignId = document.getElementById('campaignId').value.trim() || cfg.campaignId;
  const xPasscode = document.getElementById('xPasscode').value.trim() || cfg.xPasscode || '1234';
  if (!apiBase || !campaignId || !cfg.token) {
    showSettingsStatus('请先登录并填写 API / Campaign', 'err');
    return;
  }
  cfg.apiBase = apiBase;
  showSettingsStatus('测试中…');
  try {
    const data = await api(
      `/api/campaigns/${encodeURIComponent(campaignId)}/twitter-plugin/leads${leadsQuery({ status: 'PENDING_PLUGIN' })}`
    );
    await persistCfg({
      apiBase,
      campaignId,
      xPasscode,
      businessAccount: document.getElementById('businessAccount')?.value.trim() || cfg.businessAccount || '',
      handoffTarget: document.getElementById('handoffTarget')?.value.trim() || cfg.handoffTarget || ''
    });
    showSettingsStatus(`连接成功，PENDING_PLUGIN ${Array.isArray(data) ? data.length : 0} 条`, 'ok');
  } catch (e) {
    showSettingsStatus(e.message || String(e), 'err');
  }
}

async function logout() {
  await persistCfg({ token: '', displayName: '' });
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
  const id = templateSelect.value;
  const t = templates.find((x) => x.id === id);
  return t ? t.body : '';
}

function renderCaptureLeads() {
  captureLead.innerHTML = '';
  const pool = captureLeads.length ? captureLeads : leads;
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

function renderList() {
  updateModeUi();
  if (!leads.length) {
    listEl.innerHTML = `<div class="empty">${emptyListHint()}</div>`;
    renderCaptureLeads();
    return;
  }
  listEl.innerHTML = '';
  const isBig = cfg.workMode === 'big';
  const isHandoff = !isBig && cfg.smallQueue === 'handoff';
  for (const lead of leads) {
    const card = document.createElement('div');
    card.className = 'card';
    const handle = lead.screenName ? `@${lead.screenName}` : '';
    const ownerHint = lead.ownerBusinessAccount
      ? `<div class="meta">归属 ${escapeHtml(lead.ownerBusinessAccount)} · ${escapeHtml(lead.contactStatus || '')}</div>`
      : `<div class="meta">状态 ${escapeHtml(lead.contactStatus || '—')}</div>`;
    let actionsHtml = '';
    if (isBig) {
      actionsHtml = `
        <button type="button" class="accent" data-act="open">打开主页</button>
        <button type="button" class="accent" data-act="copy">复制话术</button>
      `;
    } else if (isHandoff) {
      actionsHtml = `
        <button type="button" class="ok" data-act="handoff">转交大号</button>
        <button type="button" class="accent" data-act="open">打开主页</button>
        <button type="button" class="accent" data-act="copy">复制话术</button>
      `;
    } else {
      actionsHtml = `
        <button type="button" class="ok" data-act="autosend">发送私信</button>
        <button type="button" class="accent" data-act="open">打开主页</button>
        <button type="button" class="accent" data-act="copy">复制话术</button>
        <button type="button" class="warn" data-act="contacted">标已私信</button>
        <button type="button" class="accent" data-act="handoff">转交大号</button>
        <button type="button" class="warn" data-act="skip">跳过</button>
        <button type="button" class="err" data-act="fail">发送失败</button>
      `;
    }
    card.innerHTML = `
      <div class="name">${escapeHtml(lead.nickname || handle || lead.leadId)}</div>
      <div class="handle">${escapeHtml(handle)}</div>
      <div class="meta">粉丝 ${fmtNum(lead.follower)} · 均播 ${fmtNum(lead.avgView)}</div>
      ${ownerHint}
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

async function patchLeadStatus(lead, contactStatus, note) {
  await api(
    `/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads/${encodeURIComponent(lead.leadId)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({
        contactStatus,
        note,
        businessAccount: cfg.businessAccount || undefined
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
        direction: 'OUT',
        text,
        extractQuote: false,
        businessAccount: cfg.businessAccount || undefined,
        pluginCaptureId: `ext-${lead.leadId}-${hashText(text)}-out`
      })
    }
  );
}

async function handoffLead(lead) {
  const to = (cfg.handoffTarget || '').trim()
    || window.prompt('请输入转交目标商务号（大号标识）', '')
    || '';
  if (!to) {
    showBanner('未填写转交目标商务号', 'err');
    return;
  }
  await api(
    `/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads/${encodeURIComponent(lead.leadId)}/handoff`,
    {
      method: 'POST',
      body: JSON.stringify({
        fromBusinessAccount: cfg.businessAccount || undefined,
        toBusinessAccount: to,
        note: 'extension:handoff'
      })
    }
  );
  showBanner(`已转交 ${lead.screenName || lead.leadId} → ${to}`, 'ok');
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
        await switchToHandoffQueueAndRefresh(`已确认发送 @${sn} · 已进入待移交，可转交大号`);
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
      await handoffLead(lead);
      leads = leads.filter((l) => l.leadId !== lead.leadId);
      renderList();
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
      await switchToHandoffQueueAndRefresh(`已标已私信 · 进入待移交，可转交大号`);
      return;
    }
    leads = leads.filter((l) => l.leadId !== lead.leadId);
    renderList();
    showBanner(`已回写 ${contactStatus}`, 'ok');
  } catch (e) {
    busy = false;
    showBanner(e.message || String(e), 'err');
  }
}

async function bulkSendAll() {
  if (busy) {
    showBanner('请等待当前操作完成', 'err');
    return;
  }
  if (cfg.workMode !== 'small' || cfg.smallQueue !== 'pending') {
    showBanner('批量发送仅在「小号 · 待建联」可用', 'err');
    return;
  }
  await loadCfg();
  if (!cfg.token || !cfg.campaignId) {
    showBanner('请先登录 CRM 并填写 Campaign ID', 'err');
    return;
  }
  const templateBody = selectedTemplateBody();
  if (!templateBody) {
    showBanner('请先选择话术模板', 'err');
    return;
  }
  const { count, intervalSec } = readBulkSendForm();
  await persistCfg({ bulkSendCount: count, bulkSendIntervalSec: intervalSec });

  const queue = leads.filter((l) => l.screenName || l.profileUrl).slice(0, count);
  if (!queue.length) {
    showBanner('没有可发送的 PENDING_PLUGIN 线索', 'err');
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
        `批量完成：成功 ${success}，Premium ${premium}，额度 ${rateLimit}，拒收 ${rejected}，其它失败 ${failed} · 已进入待移交`
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
    showBanner(e.message || String(e), 'err');
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
    if (cfg.workMode === 'big' && !cfg.businessAccount) {
      showBanner('大号模式请先在设置填写「当前商务号标识」', 'err');
      leads = [];
      captureLeads = [];
      renderList();
      return;
    }
    if (cfg.workMode === 'small' && cfg.smallQueue === 'handoff' && !cfg.businessAccount) {
      showBanner('待移交列表需要「当前商务号标识」（ownership=owned）', 'err');
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
    leads = Array.isArray(leadData) ? leadData : [];
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
    renderList();
    fillBulkSendForm();
    if (!keepBanner) {
      showBanner(`${currentViewLabel()} · ${leads.length} 条`, 'ok');
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
    showBanner('请先登录 CRM 并填写 Campaign ID', 'err');
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
    for (const l of captureLeads.length ? captureLeads : leads) {
      if (l.screenName) leadByScreen.set(String(l.screenName).toLowerCase().replace(/^@/, ''), l);
    }
    // refresh all plugin leads for better matching
    try {
      const all = await api(`/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads${leadsQuery(captureListQuery())}`);
      if (Array.isArray(all)) {
        captureLeads = all;
        for (const l of all) {
          if (l.screenName) {
            leadByScreen.set(String(l.screenName).toLowerCase().replace(/^@/, ''), l);
          }
        }
      }
    } catch (_) { /* use existing */ }

    let msgCount = 0;
    let quoteCount = 0;
    let skippedDup = 0;
    let matchedThreads = 0;
    let anchorMatched = 0;
    const unmatched = [];

    for (let ti = 0; ti < threads.length; ti++) {
      const th = threads[ti];
      renderSyncProgress({ phase: 'capture', current: ti + 1, total: threads.length });
      const sn = (th.screenName || '').toLowerCase().replace(/^@/, '');
      let lead = sn ? leadByScreen.get(sn) : null;
      let campaignIdForCapture = cfg.campaignId;
      let matchViaAnchor = false;

      if (!lead && sn) {
        try {
          const resolved = await api('/api/twitter-plugin/dm/resolve-thread', {
            method: 'POST',
            body: JSON.stringify({
              screenName: sn,
              preferCampaignId: cfg.campaignId,
              businessAccount: cfg.businessAccount || undefined,
              messages: (() => {
                const all = (th.messages || []).filter((m) => m && m.text);
                const outs = all.filter((m) => m.direction === 'OUT');
                const ins = all.filter((m) => m.direction !== 'OUT');
                return [...outs, ...ins].slice(0, 3).map((m) => ({
                  direction: m.direction === 'OUT' ? 'OUT' : 'IN',
                  text: m.text
                }));
              })()
            })
          });
          if (resolved?.matched && resolved.leadId && resolved.campaignId) {
            lead = {
              leadId: resolved.leadId,
              campaignId: resolved.campaignId,
              influencerId: resolved.influencerId,
              screenName: resolved.screenName || sn
            };
            campaignIdForCapture = resolved.campaignId;
            matchViaAnchor = resolved.matchScope === 'text_hash';
          }
        } catch (e) {
          console.warn('[Bioby sync] resolve-thread failed', sn, e);
        }
      }

      if (!lead) {
        unmatched.push(sn || (th.preview && th.preview[0]) || '(unknown)');
        continue;
      }
      matchedThreads += 1;
      if (matchViaAnchor) anchorMatched += 1;
      const messages = th.messages || [];
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i];
        if (!m.text) continue;
        const direction = m.direction === 'OUT' ? 'OUT' : 'IN';
        try {
          const result = await api(
            `/api/campaigns/${encodeURIComponent(campaignIdForCapture)}/twitter-plugin/dm/messages`,
            {
              method: 'POST',
              body: JSON.stringify({
                leadId: lead.leadId,
                direction,
                text: m.text,
                // IN 才抽报价；captureId 带方向，便于纠正误判后的重新同步
                extractQuote: direction === 'IN',
                businessAccount: cfg.businessAccount || undefined,
                pluginCaptureId: `sync5-${lead.leadId}-${hashText(m.text)}-${direction.toLowerCase()}`
              })
            }
          );
          if (result?.quoteSummary === 'duplicate capture skipped') {
            skippedDup += 1;
          } else {
            msgCount += 1;
          }
          if (result?.quoteExtracted) quoteCount += 1;
        } catch (e) {
          console.warn('[Bioby sync] capture failed', lead.leadId, direction, m.text?.slice(0, 40), e);
        }
      }
    }

    const matchLabel = anchorMatched
      ? `匹配 ${matchedThreads}（锚点 ${anchorMatched}）`
      : `匹配 ${matchedThreads}`;
    const syncSummary =
      `同步完成：会话 ${threads.length}，${matchLabel}，消息 ${msgCount}，报价 ${quoteCount}`
      + (skippedDup ? `，跳过重复 ${skippedDup}` : '')
      + (unmatched.length ? `；未匹配 ${unmatched.slice(0, 8).join(', ')}` : '');
    // refresh 会改横幅为 PENDING 条数，故先刷列表再恢复同步结果
    await refresh({ keepBanner: true });
    showBanner(syncSummary, 'ok');
  } catch (e) {
    showBanner(e.message || String(e), 'err');
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

document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('openSettings').addEventListener('click', async () => {
  await loadCfg();
  showSettings();
});

document.getElementById('workModeSeg')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-work-mode]');
  if (!btn || busy) return;
  const mode = btn.dataset.workMode;
  if (mode !== 'small' && mode !== 'big') return;
  if (cfg.workMode === mode) return;
  await persistCfg({ workMode: mode });
  updateModeUi();
  await refresh();
});

document.getElementById('smallQueueSeg')?.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-small-queue]');
  if (!btn || busy) return;
  const q = btn.dataset.smallQueue;
  if (q !== 'pending' && q !== 'handoff') return;
  if (cfg.smallQueue === q) return;
  await persistCfg({ smallQueue: q });
  updateModeUi();
  await refresh();
});

document.getElementById('bigStatusFilter')?.addEventListener('change', async (e) => {
  if (busy) return;
  const v = e.target.value || 'PLUGIN_CONTACTED';
  await persistCfg({ bigStatusFilter: v });
  updateModeUi();
  await refresh();
});

document.getElementById('backToMain').addEventListener('click', () => {
  // persist passcode even without re-login
  const xPasscode = document.getElementById('xPasscode').value.trim() || '1234';
  const campaignId = document.getElementById('campaignId').value.trim() || cfg.campaignId;
  const apiBase = document.getElementById('apiBase').value.trim().replace(/\/$/, '') || cfg.apiBase;
  persistCfg({
    xPasscode,
    campaignId,
    apiBase,
    businessAccount: document.getElementById('businessAccount')?.value.trim() || cfg.businessAccount || '',
    handoffTarget: document.getElementById('handoffTarget')?.value.trim() || cfg.handoffTarget || ''
  }).then(() => {
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
          direction,
          text,
          extractQuote: direction === 'IN',
          businessAccount: cfg.businessAccount || undefined,
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
  await loadCfg();
  fillBulkSendForm();
  updateModeUi();
  if (!cfg.token || !cfg.campaignId) {
    showSettings();
  } else {
    showMain();
    refresh();
  }
})();
