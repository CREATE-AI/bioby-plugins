const viewMain = document.getElementById('viewMain');
const viewSettings = document.getElementById('viewSettings');
const listEl = document.getElementById('list');
const bannerEl = document.getElementById('banner');
const templateSelect = document.getElementById('templateSelect');
const captureLead = document.getElementById('captureLead');
const captureText = document.getElementById('captureText');
const settingsStatus = document.getElementById('settingsStatus');
const loginInfo = document.getElementById('loginInfo');

const API_ENV = {
  test: 'https://lmdxqolvnkyj.sealosbja.site',
  local: 'http://localhost:8081'
};

const BIG_ACCOUNT = 'admin';

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

function readPopupRole() {
  const pluginRole = document.getElementById('pluginRole')?.value === 'big' ? 'big' : 'small';
  rememberSmallBusinessAccount(document.getElementById('businessAccount')?.value);
  return { pluginRole, businessAccount: storedSmallBusinessAccount() };
}

let cfg = {
  apiEnv: 'test',
  apiBase: '',
  campaignId: '',
  campaignName: '',
  businessAccount: '',
  pluginRole: 'small',
  username: '',
  password: '',
  token: '',
  displayName: ''
};
let templates = [];
let leads = [];
/** 含已联系线索，供收录回复 */
let captureLeads = [];
let campaignSearchTimer = null;

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
    // ignore
  }
}

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
    username: '',
    password: '',
    token: '',
    displayName: ''
  });
  // 兼容旧版 sync 配置
  if (!cfg.token) {
    const legacy = await chrome.storage.sync.get({
      apiBase: '',
      campaignId: '',
      token: ''
    });
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
  normalizeApiEnvCfg();
  if (cfg.pluginRole !== 'big') cfg.pluginRole = 'small';
  if (String(cfg.businessAccount || '').trim().toLowerCase() === 'admin') {
    cfg.businessAccount = '';
  }
}

async function persistCfg(partial) {
  cfg = { ...cfg, ...partial };
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'apiEnv')) {
    normalizeApiEnvCfg();
  } else if (partial && Object.prototype.hasOwnProperty.call(partial, 'apiBase') && !partial.apiEnv) {
    cfg.apiEnv = inferApiEnv(cfg.apiBase);
    normalizeApiEnvCfg();
  } else {
    normalizeApiEnvCfg();
  }
  if (cfg.pluginRole !== 'big') cfg.pluginRole = 'small';
  if (String(cfg.businessAccount || '').trim().toLowerCase() === 'admin') {
    cfg.businessAccount = '';
  }
  await chrome.storage.local.set({
    apiEnv: cfg.apiEnv || 'test',
    apiBase: cfg.apiBase || '',
    campaignId: cfg.campaignId || '',
    campaignName: cfg.campaignName || '',
    businessAccount: cfg.businessAccount || '',
    pluginRole: cfg.pluginRole || 'small',
    username: cfg.username || '',
    password: cfg.password || '',
    token: cfg.token || '',
    displayName: cfg.displayName || ''
  });
}

function applyPopupRoleUi() {
  const roleEl = document.getElementById('pluginRole');
  const bizEl = document.getElementById('businessAccount');
  if (roleEl) roleEl.value = cfg.pluginRole === 'big' ? 'big' : 'small';
  if (!bizEl) return;
  if (cfg.pluginRole === 'big') {
    bizEl.value = BIG_ACCOUNT;
    bizEl.readOnly = true;
  } else {
    bizEl.readOnly = false;
    bizEl.value = storedSmallBusinessAccount();
  }
}

function fillSettingsForm() {
  applySettingsApiEnvUi();
  updateCampaignPickerUi();
  const bizEl = document.getElementById('businessAccount');
  if (bizEl) bizEl.value = cfg.pluginRole === 'big' ? BIG_ACCOUNT : storedSmallBusinessAccount();
  applyPopupRoleUi();
  document.getElementById('username').value = cfg.username || '';
  document.getElementById('password').value = cfg.password || '';
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
  if (!options.skipAuth) {
    headers.Authorization = authHeader();
  }
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
      const token = data && data.accessToken;
      if (!token) return false;
      await persistCfg({
        token,
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
  const { pluginRole, businessAccount } = readPopupRole();
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
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
    const token = data && data.accessToken;
    if (!token) {
      throw new Error('登录成功但未返回 accessToken');
    }
    await persistCfg({
      apiEnv,
      apiBase,
      pluginRole,
      businessAccount,
      username,
      password,
      token,
      displayName: (data.nickname || data.username || username)
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
  const pluginRole = document.getElementById('pluginRole')?.value === 'big' ? 'big' : 'small';
  const businessAccount = pluginRole === 'big'
    ? 'admin'
    : (document.getElementById('businessAccount')?.value.trim() || cfg.businessAccount || '');
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
    const q = new URLSearchParams({ status: 'PENDING_PLUGIN' });
    if (businessAccount) q.set('businessAccount', businessAccount);
    const data = await api(
      `/api/campaigns/${encodeURIComponent(campaignId)}/twitter-plugin/leads?${q}`
    );
    const n = Array.isArray(data) ? data.length : 0;
    await persistCfg({
      apiEnv,
      apiBase,
      campaignId,
      campaignName: cfg.campaignName || '',
      pluginRole,
      businessAccount
    });
    showSettingsStatus(
      pluginRole === 'big'
        ? `连接成功，PENDING_PLUGIN 线索 ${n} 条（系统数据库请用侧栏）`
        : `连接成功，PENDING_PLUGIN 线索 ${n} 条`,
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
    const label = lead.screenName
      ? `@${lead.screenName}`
      : (lead.nickname || lead.leadId);
    opt.textContent = `${label} · ${lead.contactStatus || ''}`;
    captureLead.appendChild(opt);
  }
}

function renderList() {
  if (!leads.length) {
    listEl.innerHTML = '<div class="empty">暂无 PENDING_PLUGIN 线索。<br/>确认活动已搜号落库，或检查设置。</div>';
    renderCaptureLeads();
    return;
  }
  listEl.innerHTML = '';
  for (const lead of leads) {
    const card = document.createElement('div');
    card.className = 'card';
    const handle = lead.screenName ? `@${lead.screenName}` : '';
    card.innerHTML = `
      <div class="name">${escapeHtml(lead.nickname || handle || lead.leadId)}</div>
      <div class="handle">${escapeHtml(handle)}</div>
      <div class="meta">粉丝 ${fmtNum(lead.follower)} · 均播 ${fmtNum(lead.avgView)}</div>
      ${lead.bio ? `<div class="bio">${escapeHtml(lead.bio)}</div>` : ''}
      <div class="actions">
        <button type="button" class="accent" data-act="open">打开主页</button>
        <button type="button" class="accent" data-act="copy">复制话术</button>
        <button type="button" class="ok" data-act="contacted">已私信</button>
        <button type="button" class="warn" data-act="skip">跳过</button>
        <button type="button" class="err" data-act="fail">发送失败</button>
      </div>
    `;
    card.querySelectorAll('button').forEach((btn) => {
      btn.addEventListener('click', () => onAction(btn.dataset.act, lead));
    });
    listEl.appendChild(card);
  }
  renderCaptureLeads();
}

function selectedTemplateBody() {
  const id = templateSelect.value;
  const t = templates.find((x) => x.id === id);
  return t ? t.body : '';
}

async function onAction(act, lead) {
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
      showBanner(`已打开 ${lead.screenName || ''}，话术已尝试注入/写入剪贴板`, 'ok');
      return;
    }
    if (act === 'copy') {
      const text = renderTemplate(selectedTemplateBody(), lead);
      await navigator.clipboard.writeText(text);
      showBanner('话术已复制到剪贴板', 'ok');
      return;
    }
    const statusMap = {
      contacted: 'PLUGIN_CONTACTED',
      skip: 'SKIPPED',
      fail: 'SEND_FAILED'
    };
    const contactStatus = statusMap[act];
    if (!contactStatus) return;
    await api(
      `/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads/${encodeURIComponent(lead.leadId)}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          contactStatus,
          note: `extension:${act}`,
          businessAccount: cfg.businessAccount || undefined
        })
      }
    );
    if (act === 'contacted') {
      const outText = renderTemplate(selectedTemplateBody(), lead);
      if (outText) {
        try {
          await api(
            `/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/dm/messages`,
            {
              method: 'POST',
              body: JSON.stringify({
                leadId: lead.leadId,
                direction: 'OUT',
                text: outText,
                extractQuote: false,
                businessAccount: cfg.businessAccount || undefined,
                pluginCaptureId: `ext-${lead.leadId}-${hashText(outText)}-out`,
                source: 'manual'
              })
            }
          );
        } catch (_) {
          /* 状态已回写，收录失败不阻塞 */
        }
      }
    }
    leads = leads.filter((l) => l.leadId !== lead.leadId);
    renderList();
    showBanner(`已回写 ${contactStatus}`, 'ok');
  } catch (e) {
    showBanner(formatExtError(e), 'err');
  }
}

async function refresh() {
  showBanner('加载中…');
  try {
    await loadCfg();
    if (!cfg.apiBase || !cfg.campaignId || !cfg.token) {
      showBanner('请先在设置中登录并选择活动', 'err');
      listEl.innerHTML = '<div class="empty">打开右上角 ⚙，登录 CRM 并选择活动名称</div>';
      return;
    }
    if (cfg.pluginRole === 'big') {
      leads = [];
      captureLeads = [];
      templates = [];
      renderList();
      showBanner('系统数据库请用侧栏查看已移交线索，popup 不承担移交/系统数据库沟通', 'ok');
      return;
    }
    const [leadData, tplData, allPluginLeads] = await Promise.all([
      api(`/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads?status=PENDING_PLUGIN${cfg.businessAccount ? `&businessAccount=${encodeURIComponent(cfg.businessAccount)}` : ''}`),
      api(`/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/templates`),
      api(`/api/campaigns/${encodeURIComponent(cfg.campaignId)}/twitter-plugin/leads${cfg.businessAccount ? `?businessAccount=${encodeURIComponent(cfg.businessAccount)}` : ''}`)
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
    showBanner(`PENDING_PLUGIN：${leads.length} 条`, 'ok');
  } catch (e) {
    const msg = e.message || String(e);
    if (/401|未登录|token|过期|认证|授权/i.test(msg)) {
      showBanner('登录已失效，请到设置重新登录', 'err');
    } else {
      showBanner(msg, 'err');
    }
    listEl.innerHTML = '<div class="empty">加载失败</div>';
  }
}

document.getElementById('refresh').addEventListener('click', refresh);
document.getElementById('openSettings').addEventListener('click', async () => {
  await loadCfg();
  await showSettings();
});
document.getElementById('backToMain').addEventListener('click', () => {
  const apiEnv = readSettingsApiEnv();
  const campaignId = document.getElementById('campaignId').value.trim() || cfg.campaignId;
  const { pluginRole, businessAccount } = readPopupRole();
  persistCfg({
    apiEnv,
    apiBase: resolveApiBase(apiEnv),
    campaignId,
    campaignName: cfg.campaignName || '',
    pluginRole,
    businessAccount
  }).then(() => {
    hideCampaignSuggest();
    showMain();
    refresh();
  });
});
document.getElementById('loginSave').addEventListener('click', loginAndSave);
document.getElementById('testConn').addEventListener('click', testConnection);
document.getElementById('logout').addEventListener('click', logout);
document.getElementById('pluginRole')?.addEventListener('change', () => {
  rememberSmallBusinessAccount(document.getElementById('businessAccount')?.value);
  cfg.pluginRole = document.getElementById('pluginRole').value === 'big' ? 'big' : 'small';
  applyPopupRoleUi();
  persistCfg({ pluginRole: cfg.pluginRole, businessAccount: storedSmallBusinessAccount() });
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

function hashText(s) {
  let h = 0;
  const str = String(s || '');
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h) + str.charCodeAt(i);
  return String(h >>> 0);
}

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
          pluginCaptureId: `ext-${leadId}-${hashText(text)}-${direction.toLowerCase()}`,
          source: 'manual'
        })
      }
    );
    captureText.value = '';
    const quoteHint = result && result.quoteExtracted
      ? ` · 已抽报价 ${result.quoteSummary || ''}`
      : '';
    showBanner(`已收录 message ${result?.messageId || ''}${quoteHint}`, 'ok');
  } catch (e) {
    showBanner(e.message || String(e), 'err');
  }
});

(async () => {
  fillExtVersion();
  await loadCfg();
  if (!cfg.token || !cfg.campaignId) {
    await showSettings();
  } else {
    showMain();
    refresh();
  }
})();
