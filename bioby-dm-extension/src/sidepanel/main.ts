import { EXTENSION_VERSION } from '../shared/constants';
import { explainError } from '../shared/user-messages';
import type { BackgroundStatus, DmPlatform } from '../shared/types';

type StatusPayload = BackgroundStatus & { deviceId?: string };
type ClaimOnceResponse = StatusPayload & { claimResult?: { ok: boolean; message: string } };

type SetupStep = { label: string; done: boolean };

const $ = (id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el;
};

const input = (id: string) => $(id) as HTMLInputElement;

const HALT_LABELS: Record<string, string> = {
  CAPTCHA: '需处理验证码',
  LOGIN_EXPIRED: '请重新登录平台',
  SELECTOR_BROKEN: '页面打不开私信',
  RATE_LIMITED: '发送太频繁',
  NO_DM_ACCESS: '无法给该达人发私信',
  ACCOUNT_MISMATCH: '商务号不一致',
};

async function send<T>(type: string, extra?: Record<string, unknown>): Promise<T> {
  return chrome.runtime.sendMessage({ type, ...extra }) as Promise<T>;
}

function formatHandle(handle: string | undefined): string {
  if (!handle?.trim()) return '未检测到';
  return `@${handle.replace(/^@/, '')}`;
}

function formatSent(
  count: number | undefined,
  quota: number | undefined,
  halted: boolean,
  haltReason?: string,
): string {
  if (halted) {
    const reason = haltReason ? (HALT_LABELS[haltReason] ?? haltReason) : '已暂停';
    return reason;
  }
  if (count != null && quota != null) return `已发 ${count} / 每日 ${quota}`;
  if (count != null) return `已发 ${count} 条`;
  return '暂无数据';
}

function formatWatches(count: number | undefined, lastScan?: string): string {
  const n = count ?? 0;
  if (n === 0) return '0 人';
  const scan = lastScan ? `（${new Date(lastScan).toLocaleTimeString()} 查过）` : '';
  return `${n} 人${scan}`;
}

function setChannelDot(dotId: string, cardId: string, halted: boolean, enabled: boolean): void {
  const dot = $(dotId);
  const card = $(cardId);
  dot.className = 'status-dot';
  card.classList.remove('channel-halted', 'channel-idle');
  if (!enabled) {
    dot.classList.add('idle');
    card.classList.add('channel-idle');
  } else if (halted) {
    dot.classList.add('halted');
    card.classList.add('channel-halted');
  } else {
    dot.classList.add('ok');
  }
}

function hasAuth(status: StatusPayload): boolean {
  return Boolean(status.accessToken?.trim()) || Boolean(status.mockApiEnabled);
}

function isChannelReady(status: StatusPayload, platform: DmPlatform): boolean {
  const enabled = platform === 'instagram' ? status.instagramEnabled : status.tiktokEnabled;
  const label =
    platform === 'instagram' ? status.instagramAccountLabel : status.tiktokAccountLabel;
  return Boolean(enabled && label?.trim());
}

function hasChannel(status: StatusPayload): boolean {
  if (isChannelReady(status, 'instagram') || isChannelReady(status, 'tiktok')) return true;
  if (status.mockApiEnabled && status.mockProfileUrl?.trim()) return true;
  return false;
}

function buildSetupSteps(status: StatusPayload): SetupStep[] {
  const enabledAny = status.instagramEnabled || status.tiktokEnabled;
  return [
    { label: '填写后台地址与工作台地址', done: Boolean(status.apiBaseUrl?.trim() && status.workBaseUrl?.trim()) },
    { label: '同步工作台登录', done: hasAuth(status) },
    {
      label: enabledAny
        ? '为已启用的渠道填写商务号编号'
        : '打开 Instagram 或 TikTok 的「自动发送」',
      done: hasChannel(status),
    },
    { label: '点击「检查连接是否正常」', done: Boolean(status.lastHeartbeatAt) },
  ];
}

function isSetupComplete(status: StatusPayload): boolean {
  return buildSetupSteps(status).every((s) => s.done);
}

function renderSetupGuide(status: StatusPayload): void {
  const steps = buildSetupSteps(status);
  const complete = isSetupComplete(status);
  const guide = $('setupGuide');
  const list = $('setupSteps');

  guide.classList.toggle('hidden', complete);
  list.innerHTML = steps
    .map(
      (step) =>
        `<li class="setup-step${step.done ? ' done' : ''}"><span class="setup-step-mark" aria-hidden="true">${step.done ? '✓' : '○'}</span>${step.label}</li>`,
    )
    .join('');
}

function applyAdvancedPanelOpen(open: boolean): void {
  const panel = $('advancedPanel') as HTMLDetailsElement;
  panel.open = open;
}

function applyChannelConfigVisibility(): void {
  const igOn = input('instagramEnabledToggle').checked;
  const ttOn = input('tiktokEnabledToggle').checked;
  $('igConfig').classList.toggle('hidden', !igOn);
  $('ttConfig').classList.toggle('hidden', !ttOn);
}

function fillForm(status: StatusPayload): void {
  applyAdvancedPanelOpen(Boolean(status.developerModeEnabled));
  input('apiBaseUrl').value = status.apiBaseUrl ?? '';
  input('workBaseUrl').value = status.workBaseUrl ?? '';
  input('accessToken').value = status.accessToken ?? '';
  input('accessTokenManual').value = '';
  input('instagramEnabledToggle').checked = Boolean(status.instagramEnabled);
  input('tiktokEnabledToggle').checked = Boolean(status.tiktokEnabled);
  input('instagramAccountLabel').value = status.instagramAccountLabel ?? '';
  input('tiktokAccountLabel').value = status.tiktokAccountLabel ?? '';
  applyChannelConfigVisibility();
  input('minIntervalSec').value = String(status.minIntervalSec ?? 90);
  input('maxIntervalSec').value = String(status.maxIntervalSec ?? 240);
  input('mockApiEnabled').checked = Boolean(status.mockApiEnabled);
  input('mockProfileUrl').value = status.mockProfileUrl ?? '';
  input('mockDraftBody').value = status.mockDraftBody ?? '';
  $('extensionVersion').textContent = EXTENSION_VERSION;
}

function renderTokenStatus(status: StatusPayload): void {
  const hasToken = hasAuth(status);
  $('tokenDot').className = `login-dot${hasToken ? ' ok' : ''}`;
  if (status.mockApiEnabled && !status.accessToken?.trim()) {
    $('tokenStatusText').textContent = 'Mock 模式（无需登录）';
  } else {
    $('tokenStatusText').textContent = hasToken ? '已同步工作台登录' : '未同步工作台登录';
  }
}

function renderStatus(status: StatusPayload): void {
  renderSetupGuide(status);
  renderTokenStatus(status);
  $('deviceId').textContent = status.deviceId ?? '—';
  const ig = status.channels?.instagram;
  const tt = status.channels?.tiktok;
  const igEnabled = Boolean(status.instagramEnabled);
  const ttEnabled = Boolean(status.tiktokEnabled);

  input('instagramEnabledToggle').checked = igEnabled;
  input('tiktokEnabledToggle').checked = ttEnabled;
  applyChannelConfigVisibility();

  $('igHandle').textContent = igEnabled ? formatHandle(ig?.loggedInHandle) : '—';
  $('ttHandle').textContent = ttEnabled ? formatHandle(tt?.loggedInHandle) : '—';
  $('igSent').textContent = igEnabled
    ? formatSent(ig?.sentTodayCount, ig?.dailyQuota, Boolean(ig?.halted), ig?.haltReason)
    : '未启用';
  $('ttSent').textContent = ttEnabled
    ? formatSent(tt?.sentTodayCount, tt?.dailyQuota, Boolean(tt?.halted), tt?.haltReason)
    : '未启用';
  $('igWatch').textContent = igEnabled
    ? formatWatches(ig?.observationWatches?.length, ig?.lastReplyScanAt)
    : '—';
  $('ttWatch').textContent = ttEnabled
    ? formatWatches(tt?.observationWatches?.length, tt?.lastReplyScanAt)
    : '—';

  setChannelDot('igDot', 'igCard', Boolean(ig?.halted), igEnabled);
  setChannelDot('ttDot', 'ttCard', Boolean(tt?.halted), ttEnabled);

  const showResume = Boolean(ig?.halted) || Boolean(tt?.halted);
  $('resumeRow').classList.toggle('hidden', !showResume);
  $('resumeIgBtn').classList.toggle('hidden', !ig?.halted);
  $('resumeTtBtn').classList.toggle('hidden', !tt?.halted);

  renderErrorPanel(status);

  const hero = $('heroCard');
  const heroHint = $('heroHint');
  const btn = $('toggleAutoBtn');
  const label = btn.querySelector('.switch-text');
  if (status.autoSendEnabled) {
    hero.classList.add('is-on');
    hero.classList.remove('is-off');
    heroHint.textContent = '正在自动领任务并发送，请勿关闭 Chrome';
    btn.className = 'switch on';
    btn.setAttribute('aria-checked', 'true');
    if (label) label.textContent = '已开启';
  } else {
    hero.classList.add('is-off');
    hero.classList.remove('is-on');
    if (!isSetupComplete(status)) {
      heroHint.textContent = '完成上方「开始使用」步骤后再开启';
    } else {
      heroHint.textContent = '打开后系统会自动领任务并发送';
    }
    btn.className = 'switch off';
    btn.setAttribute('aria-checked', 'false');
    if (label) label.textContent = '已关闭';
  }
}

function renderErrorPanel(status: StatusPayload): void {
  const raw = status.lastError?.trim();
  let rawError = raw ?? '';

  if (!status.apiBaseUrl?.trim() && !status.mockApiEnabled) {
    rawError = rawError
      ? `${rawError}；请在账号设置中填写后台地址`
      : '请先在账号设置中填写后台地址';
  }

  const guidance = explainError(rawError, {
    mockApiEnabled: status.mockApiEnabled,
    apiBaseUrl: status.apiBaseUrl,
  });

  const panel = $('lastErrorPanel');
  const actionEl = $('lastErrorAction');

  $('igConfig').classList.remove('field-highlight');
  $('ttConfig').classList.remove('field-highlight');

  if (!guidance) {
    panel.classList.add('hidden');
    $('lastError').textContent = '';
    actionEl.textContent = '';
    actionEl.classList.add('hidden');
    return;
  }

  $('lastErrorTitle').textContent = guidance.title;
  $('lastError').textContent = guidance.body;

  if (guidance.action) {
    actionEl.textContent = `👉 ${guidance.action}`;
    actionEl.classList.remove('hidden');
  } else {
    actionEl.textContent = '';
    actionEl.classList.add('hidden');
  }

  panel.classList.remove('hidden');

  if (/商务号|渠道|accountlabel/i.test(rawError)) {
    if (status.instagramEnabled) $('igConfig').classList.add('field-highlight');
    if (status.tiktokEnabled) $('ttConfig').classList.add('field-highlight');
  }
}

function showSaveToast(): void {
  const toast = $('saveToast');
  toast.classList.remove('hidden');
  window.setTimeout(() => toast.classList.add('hidden'), 2000);
}

function collectSettingsPatch(): Record<string, unknown> {
  const manualToken = input('accessTokenManual').value.trim();
  const advancedPanel = $('advancedPanel') as HTMLDetailsElement;
  return {
    developerModeEnabled: advancedPanel.open,
    apiBaseUrl: input('apiBaseUrl').value.trim(),
    workBaseUrl: input('workBaseUrl').value.trim(),
    accessToken: manualToken || input('accessToken').value.trim(),
    instagramEnabled: input('instagramEnabledToggle').checked,
    tiktokEnabled: input('tiktokEnabledToggle').checked,
    instagramAccountLabel: input('instagramAccountLabel').value.trim(),
    tiktokAccountLabel: input('tiktokAccountLabel').value.trim(),
    minIntervalSec: Number(input('minIntervalSec').value) || 90,
    maxIntervalSec: Number(input('maxIntervalSec').value) || 240,
    mockApiEnabled: input('mockApiEnabled').checked,
    mockProfileUrl: input('mockProfileUrl').value.trim(),
    mockDraftBody: input('mockDraftBody').value.trim(),
  };
}

async function refreshStatus(): Promise<void> {
  const status = await send<StatusPayload>('GET_STATUS');
  renderStatus(status);
}

async function loadForm(): Promise<void> {
  const status = await send<StatusPayload>('GET_STATUS');
  fillForm(status);
  renderSetupGuide(status);
}

async function saveSettings(): Promise<void> {
  const status = await send<StatusPayload>('SAVE_SETTINGS', { patch: collectSettingsPatch() });
  fillForm(status);
  renderStatus(status);
  showSaveToast();
}

async function persistChannelToggle(platform: DmPlatform, enabled: boolean): Promise<void> {
  const key = platform === 'instagram' ? 'instagramEnabled' : 'tiktokEnabled';
  applyChannelConfigVisibility();
  const status = await send<StatusPayload>('SAVE_SETTINGS', {
    patch: { ...collectSettingsPatch(), [key]: enabled },
  });
  fillForm(status);
  renderStatus(status);
}

function persistAdvancedOpen(): void {
  const advancedPanel = $('advancedPanel') as HTMLDetailsElement;
  void send<StatusPayload>('SAVE_SETTINGS', {
    patch: { developerModeEnabled: advancedPanel.open },
  });
}

$('saveBtn').addEventListener('click', () => void saveSettings());

$('advancedPanel').addEventListener('toggle', () => {
  persistAdvancedOpen();
});

input('instagramEnabledToggle').addEventListener('change', () => {
  void persistChannelToggle('instagram', input('instagramEnabledToggle').checked);
});

input('tiktokEnabledToggle').addEventListener('change', () => {
  void persistChannelToggle('tiktok', input('tiktokEnabledToggle').checked);
});

$('toggleAutoBtn').addEventListener('click', async () => {
  const current = await send<StatusPayload>('GET_STATUS');
  const enabled = !current.autoSendEnabled;
  const status = await send<StatusPayload>('TOGGLE_AUTO_SEND', { enabled });
  renderStatus(status);
});

$('heartbeatBtn').addEventListener('click', async () => {
  const btn = $('heartbeatBtn') as HTMLButtonElement;
  btn.disabled = true;
  try {
    const saved = await send<StatusPayload>('SAVE_SETTINGS', { patch: collectSettingsPatch() });
    fillForm(saved);
    const status = await send<StatusPayload>('RUN_HEARTBEAT');
    renderStatus(status);
  } finally {
    btn.disabled = false;
  }
});

function showTrialHint(message: string, ok: boolean): void {
  const hint = $('trialHint');
  hint.textContent = message;
  hint.className = `field-tip trial-hint${ok ? ' ok' : ' err'}`;
  hint.classList.remove('hidden');
}

function clearTrialHint(): void {
  const hint = $('trialHint');
  hint.textContent = '';
  hint.className = 'field-tip trial-hint hidden';
}

async function claimOnce(platform: DmPlatform): Promise<void> {
  const btnId = platform === 'instagram' ? 'claimIgBtn' : 'claimTtBtn';
  const btn = $(btnId) as HTMLButtonElement;
  clearTrialHint();
  btn.disabled = true;
  showTrialHint('正在保存并试发…', true);
  try {
    const status = await send<ClaimOnceResponse>('SAVE_SETTINGS', { patch: collectSettingsPatch() });
    fillForm(status);
    const result = await send<ClaimOnceResponse>('RUN_CLAIM_ONCE', { platform });
    if (result.claimResult) {
      showTrialHint(result.claimResult.message, result.claimResult.ok);
    }
    renderStatus(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showTrialHint(`试发失败：${msg}`, false);
  } finally {
    btn.disabled = false;
  }
}

function clearHalt(platform: DmPlatform): void {
  void send<StatusPayload>('CLEAR_CHANNEL_HALT', { platform }).then(renderStatus);
}

$('claimIgBtn').addEventListener('click', () => void claimOnce('instagram'));
$('claimTtBtn').addEventListener('click', () => void claimOnce('tiktok'));
$('resumeIgBtn').addEventListener('click', () => clearHalt('instagram'));
$('resumeTtBtn').addEventListener('click', () => clearHalt('tiktok'));
$('replyScanBtn').addEventListener('click', async () => {
  const status = await send<StatusPayload>('RUN_REPLY_SCAN', {});
  renderStatus(status);
});

$('openWorkBtn').addEventListener('click', () => {
  void send('OPEN_WORK_TAB');
});

$('importWorkTokenBtn').addEventListener('click', async () => {
  const hint = $('importTokenHint');
  hint.classList.add('hidden');
  hint.textContent = '';
  const status = await send<StatusPayload & { importError?: string }>('IMPORT_WORK_TOKEN', {
    workBaseUrl: input('workBaseUrl').value.trim(),
  });
  if (status.importError) {
    hint.textContent = status.importError;
    hint.classList.remove('hidden');
  } else {
    input('accessToken').value = status.accessToken ?? '';
    showSaveToast();
  }
  renderStatus(status);
});

void loadForm();
void refreshStatus();
setInterval(() => void refreshStatus(), 8000);
