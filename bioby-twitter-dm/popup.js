const viewMain = document.getElementById('viewMain');
const viewSettings = document.getElementById('viewSettings');
const listEl = document.getElementById('list');
const bannerEl = document.getElementById('banner');
const templateSelect = document.getElementById('templateSelect');
const captureLead = document.getElementById('captureLead');
const captureText = document.getElementById('captureText');
const settingsStatus = document.getElementById('settingsStatus');
const loginInfo = document.getElementById('loginInfo');

let cfg = {
  apiBase: '',
  campaignId: '',
  businessAccount: '',
  username: '',
  token: '',
  displayName: ''
};
let templates = [];
let leads = [];
/** 含已联系线索，供收录回复 */
let captureLeads = [];

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

async function loadCfg() {
  cfg = await chrome.storage.local.get({
    apiBase: 'http://localhost:8080',
    campaignId: '',
    businessAccount: '',
    username: '',
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
  cfg.apiBase = (cfg.apiBase || '').replace(/\/$/, '');
}

async function persistCfg(partial) {
  cfg = { ...cfg, ...partial };
  await chrome.storage.local.set({
    apiBase: cfg.apiBase || '',
    campaignId: cfg.campaignId || '',
    businessAccount: cfg.businessAccount || '',
    username: cfg.username || '',
    token: cfg.token || '',
    displayName: cfg.displayName || ''
  });
}

function fillSettingsForm() {
  document.getElementById('apiBase').value = cfg.apiBase || '';
  document.getElementById('campaignId').value = cfg.campaignId || '';
  const bizEl = document.getElementById('businessAccount');
  if (bizEl) bizEl.value = cfg.businessAccount || '';
  document.getElementById('username').value = cfg.username || '';
  document.getElementById('password').value = '';
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
  if (!options.skipAuth) {
    headers.Authorization = authHeader();
  }
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
  const businessAccount = document.getElementById('businessAccount')?.value.trim() || '';
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  if (!apiBase) {
    showSettingsStatus('请填写 API Base URL', 'err');
    return;
  }
  if (!campaignId) {
    showSettingsStatus('请填写 Campaign ID', 'err');
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
    const token = data && data.accessToken;
    if (!token) {
      throw new Error('登录成功但未返回 accessToken');
    }
    await persistCfg({
      apiBase,
      campaignId,
      businessAccount,
      username,
      token,
      displayName: (data.nickname || data.username || username)
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
  const businessAccount = document.getElementById('businessAccount')?.value.trim() || cfg.businessAccount || '';
  if (!apiBase || !campaignId) {
    showSettingsStatus('请先填写 API Base 与 Campaign ID', 'err');
    return;
  }
  if (!cfg.token) {
    showSettingsStatus('请先登录并保存', 'err');
    return;
  }
  cfg.apiBase = apiBase;
  showSettingsStatus('测试中…');
  try {
    const q = new URLSearchParams({ status: 'PENDING_PLUGIN' });
    if (businessAccount) q.set('businessAccount', businessAccount);
    const data = await api(
      `/api/campaigns/${encodeURIComponent(campaignId)}/twitter-plugin/leads?${q}`
    );
    const n = Array.isArray(data) ? data.length : 0;
    await persistCfg({ apiBase, campaignId, businessAccount });
    showSettingsStatus(`连接成功，PENDING_PLUGIN 线索 ${n} 条`, 'ok');
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
                pluginCaptureId: `ext-${lead.leadId}-${hashText(outText)}-out`
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
    showBanner(e.message || String(e), 'err');
  }
}

async function refresh() {
  showBanner('加载中…');
  try {
    await loadCfg();
    if (!cfg.apiBase || !cfg.campaignId || !cfg.token) {
      showBanner('请先在设置中用账号密码登录', 'err');
      listEl.innerHTML = '<div class="empty">打开右上角 ⚙，用 CRM 账号登录并填写活动 ID</div>';
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
  showSettings();
});
document.getElementById('backToMain').addEventListener('click', () => {
  showMain();
  refresh();
});
document.getElementById('loginSave').addEventListener('click', loginAndSave);
document.getElementById('testConn').addEventListener('click', testConnection);
document.getElementById('logout').addEventListener('click', logout);

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
          pluginCaptureId: `ext-${leadId}-${hashText(text)}-${direction.toLowerCase()}`
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
  await loadCfg();
  if (!cfg.token || !cfg.campaignId) {
    showSettings();
  } else {
    showMain();
    refresh();
  }
})();
