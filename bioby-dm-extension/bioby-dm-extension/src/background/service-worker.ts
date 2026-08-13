import {
  BiobyDmApiError,
  postClaimNext,
  postHeartbeat,
  postMarkFailed,
  postMarkSent,
  postReportReply,
  postResumeAccount,
} from '../api/client';
import { resetMockClaimCounter } from '../api/mock';
import {
  accountLabelForPlatform,
  deviceIdForPlatform,
  listActivePlatforms,
  listEnabledPlatforms,
} from '../shared/channels';
import {
  ALARM_CLAIM_LOOP,
  ALARM_HEARTBEAT,
  ALARM_REPLY_SCAN,
  DEFAULT_HEARTBEAT_SEC,
  DEFAULT_MAX_INTERVAL_SEC,
  DEFAULT_MIN_INTERVAL_SEC,
  DEFAULT_REPLY_SCAN_SEC,
} from '../shared/constants';
import {
  inferPlatformFromProfileUrl,
  PLATFORM_HOME,
  PLATFORM_INBOX_URL,
  PLATFORM_TAB_QUERY_ALL,
  resolveTaskPlatform,
  type DmPlatform,
} from '../shared/platform';
import { platformTitle } from '../shared/channels';
import {
  defaultWorkOpenUrl,
  findWorkTab,
  readAccessTokenFromTab,
} from '../shared/work-token';
import {
  getOrCreateDeviceId,
  loadRuntime,
  loadSettings,
  patchChannelRuntime,
  patchRuntime,
  saveSettings,
} from '../shared/storage';
import type {
  BackgroundStatus,
  ClaimNextTask,
  ContentMessage,
  ContentResponse,
  ObservationWatch,
  PluginFailureCode,
  SendDmResult,
} from '../shared/types';

const claimLoopBusy: Record<DmPlatform, boolean> = {
  instagram: false,
  tiktok: false,
};

const replyScanBusy: Record<DmPlatform, boolean> = {
  instagram: false,
  tiktok: false,
};

type ClaimOnceResult = { ok: boolean; message: string };

function apiReady(settings: Awaited<ReturnType<typeof loadSettings>>): boolean {
  return settings.mockApiEnabled || settings.accessToken.trim().length > 0;
}

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  void scheduleAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  void scheduleAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_HEARTBEAT) void runHeartbeat();
  if (alarm.name === ALARM_CLAIM_LOOP) void runAllClaimLoops();
  if (alarm.name === ALARM_REPLY_SCAN) void runAllReplyScans();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    const type = (message as { type?: string }).type;
    if (type === 'GET_STATUS') {
      sendResponse(await buildStatus());
      return;
    }
    if (type === 'SAVE_SETTINGS') {
      const patch = (message as { patch?: Record<string, unknown> }).patch ?? {};
      const prev = await loadSettings();
      await saveSettings(patch as Parameters<typeof saveSettings>[0]);
      const next = await loadSettings();
      if (!prev.mockApiEnabled && next.mockApiEnabled) {
        resetMockClaimCounter();
      }
      await scheduleAlarms();
      sendResponse(await buildStatus());
      return;
    }
    if (type === 'IMPORT_WORK_TOKEN') {
      const workBaseUrl = (message as { workBaseUrl?: string }).workBaseUrl;
      if (workBaseUrl?.trim()) {
        await saveSettings({ workBaseUrl: workBaseUrl.trim() });
      }
      sendResponse(await importWorkToken());
      return;
    }
    if (type === 'OPEN_WORK_TAB') {
      const settings = await loadSettings();
      const url = defaultWorkOpenUrl(settings.workBaseUrl);
      await chrome.tabs.create({ url, active: true });
      sendResponse({ ok: true, url });
      return;
    }
    if (type === 'RUN_HEARTBEAT') {
      await runHeartbeat();
      sendResponse(await buildStatus());
      return;
    }
    if (type === 'RUN_CLAIM_ONCE') {
      const platform = (message as { platform?: DmPlatform }).platform;
      let claimResult: ClaimOnceResult = { ok: false, message: '未指定平台' };
      if (platform) {
        claimResult = await runClaimLoopTick(platform, { force: true });
      } else {
        const platforms = listEnabledPlatforms(await loadSettings());
        if (platforms.length === 0) {
          claimResult = { ok: false, message: '请先在对应平台卡片上勾选「自动发送」' };
        } else {
          const results = await Promise.all(platforms.map((p) => runClaimLoopTick(p, { force: true })));
          claimResult = results.find((r) => r.ok) ?? results[0] ?? claimResult;
        }
      }
      sendResponse({ ...(await buildStatus()), claimResult });
      return;
    }
    if (type === 'TOGGLE_AUTO_SEND') {
      const enabled = Boolean((message as { enabled?: boolean }).enabled);
      await saveSettings({ autoSendEnabled: enabled });
      await scheduleAlarms();
      sendResponse(await buildStatus());
      return;
    }
    if (type === 'CLEAR_CHANNEL_HALT') {
      const platform = (message as { platform?: DmPlatform }).platform;
      if (platform) {
        await patchChannelRuntime(platform, { halted: false, haltReason: undefined, lastError: undefined });
        const settings = await loadSettings();
        const label = accountLabelForPlatform(settings, platform);
        if (label.trim()) {
          try {
            await postResumeAccount(settings, label);
          } catch (e) {
            console.warn('[bioby-dm] resume account on server failed', e);
          }
        }
      }
      sendResponse(await buildStatus());
      return;
    }
    if (type === 'RUN_REPLY_SCAN') {
      const platform = (message as { platform?: DmPlatform }).platform;
      if (platform) {
        await runReplyScanForPlatform(platform);
      } else {
        await runAllReplyScans();
      }
      sendResponse(await buildStatus());
    }
  })();
  return true;
});

async function scheduleAlarms(): Promise<void> {
  const settings = await loadSettings();
  await chrome.alarms.clear(ALARM_HEARTBEAT);
  await chrome.alarms.clear(ALARM_CLAIM_LOOP);
  await chrome.alarms.clear(ALARM_REPLY_SCAN);

  const hb = Math.max(30, settings.heartbeatSec || DEFAULT_HEARTBEAT_SEC);
  chrome.alarms.create(ALARM_HEARTBEAT, { periodInMinutes: hb / 60 });

  const hasChannel = listEnabledPlatforms(settings).length > 0;
  if (hasChannel) {
    chrome.alarms.create(ALARM_REPLY_SCAN, {
      periodInMinutes: DEFAULT_REPLY_SCAN_SEC / 60,
    });
  }

  if (settings.autoSendEnabled && hasChannel) {
    const minSec = settings.minIntervalSec || DEFAULT_MIN_INTERVAL_SEC;
    chrome.alarms.create(ALARM_CLAIM_LOOP, { periodInMinutes: Math.max(1, minSec / 60) });
  }
}

async function importWorkToken(): Promise<BackgroundStatus & { importError?: string }> {
  const settings = await loadSettings();
  const tab = await findWorkTab(settings.workBaseUrl);
  if (!tab?.id) {
    return { ...(await buildStatus()), importError: '请先在 Chrome 打开工作台并登录，再点「同步登录」' };
  }
  try {
    const token = await readAccessTokenFromTab(tab.id);
    if (!token) {
      return { ...(await buildStatus()), importError: '工作台尚未登录，请先登录后再同步' };
    }
    await saveSettings({ accessToken: token });
    return await buildStatus();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ...(await buildStatus()), importError: `同步失败：${message}` };
  }
}

async function buildStatus(): Promise<BackgroundStatus> {
  const [settings, runtime, deviceId] = await Promise.all([
    loadSettings(),
    loadRuntime(),
    getOrCreateDeviceId(),
  ]);
  return { ...settings, ...runtime, deviceId } as BackgroundStatus & { deviceId: string };
}

async function queryLoggedInHandle(tabId: number, platform: DmPlatform): Promise<string | null> {
  let handle: string | null = null;

  try {
    await waitForContentScript(tabId, 10000);
    await sleep(1500);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const resp = (await chrome.tabs.sendMessage(tabId, {
          type: 'GET_LOGGED_IN_HANDLE',
        } satisfies ContentMessage)) as ContentResponse;
        if (resp?.type === 'LOGGED_IN_HANDLE' && resp.handle) {
          handle = resp.handle;
          break;
        }
      } catch {
        /* retry */
      }
      await sleep(600);
    }
  } catch {
    /* content script ping failed — try injection below */
  }

  if (!handle && platform === 'tiktok') {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        files: ['inject/tiktok-handle.js'],
      });
      const injected = results?.[0]?.result;
      if (typeof injected === 'string' && injected.trim()) {
        handle = injected;
      }
    } catch (e) {
      console.warn('[bioby-dm] TikTok handle inject failed', e);
    }
  }

  return handle;
}

async function findPlatformTab(platform: DmPlatform): Promise<chrome.tabs.Tab | null> {
  const patterns = PLATFORM_TAB_QUERY_ALL[platform];
  const tabs: chrome.tabs.Tab[] = [];
  for (const url of patterns) {
    const found = await chrome.tabs.query({ url });
    tabs.push(...found);
  }
  const active = tabs.find((t) => t.active) ?? tabs[0];
  return active ?? null;
}

async function ensurePlatformTab(platform: DmPlatform): Promise<number> {
  const existing = await findPlatformTab(platform);
  if (existing?.id != null) return existing.id;
  const created = await chrome.tabs.create({ url: PLATFORM_HOME[platform], active: false });
  if (created.id == null) throw new Error(`Failed to open ${platform} tab`);
  await waitTabComplete(created.id);
  return created.id;
}

function waitTabComplete(tabId: number, timeoutMs = 45000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('Tab load timeout'));
    }, timeoutMs);
    function listener(id: number, info: chrome.tabs.TabChangeInfo) {
      // Ignore the pre-navigation "complete" from the previous document.
      if (id === tabId && info.status === 'complete' && Date.now() - startedAt > 300) {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function waitForContentScript(tabId: number, timeoutMs = 20000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = (await chrome.tabs.sendMessage(tabId, {
        type: 'PING',
      } satisfies ContentMessage)) as ContentResponse;
      if (resp?.type === 'PONG') return;
    } catch {
      /* content script not injected yet */
    }
    await sleep(400);
  }
  throw new Error('Content script not ready');
}

async function sendDmToTab(
  tabId: number,
  message: Extract<ContentMessage, { type: 'SEND_DM' }>,
): Promise<SendDmResult> {
  await waitForContentScript(tabId);
  // IG/TikTok are SPAs: tab "complete" fires before profile UI is interactive.
  await sleep(2500);
  const resp = (await chrome.tabs.sendMessage(tabId, message)) as ContentResponse;
  if (resp?.type !== 'SEND_DM_RESULT') {
    throw new Error('Invalid content script response');
  }
  return resp.result;
}

async function runHeartbeatForPlatform(
  settings: Awaited<ReturnType<typeof loadSettings>>,
  baseDeviceId: string,
  platform: DmPlatform,
): Promise<void> {
  const deviceId = deviceIdForPlatform(baseDeviceId, platform);
  let handle: string | null = null;
  try {
    const tabId = await ensurePlatformTab(platform);
    // 优先用用户当前已打开的 TikTok 标签（如 /messages），避免不必要的跳转
    handle = await queryLoggedInHandle(tabId, platform);
    if (!handle && platform === 'tiktok') {
      const tab = await chrome.tabs.get(tabId);
      const onMessages = tab.url?.includes('/messages');
      if (!onMessages) {
        await chrome.tabs.update(tabId, { url: PLATFORM_HOME[platform], active: false });
        await waitTabComplete(tabId);
        handle = await queryLoggedInHandle(tabId, platform);
      }
    } else if (!handle) {
      await chrome.tabs.update(tabId, { url: PLATFORM_HOME[platform], active: false });
      await waitTabComplete(tabId);
      handle = await queryLoggedInHandle(tabId, platform);
    }
  } catch {
    /* optional */
  }

  try {
    const resp = await postHeartbeat(settings, platform, deviceId, handle);
    const watches = resp?.observationTasks ?? [];
    await patchChannelRuntime(platform, {
      loggedInHandle: handle ?? undefined,
      halted: Boolean(resp?.halted),
      haltReason: resp?.halted ? resp.haltReason : undefined,
      sentTodayCount: resp?.sentTodayCount,
      dailyQuota: resp?.dailyQuota,
      observationWatches: watches.length ? watches : undefined,
      lastError: undefined,
    });
  } catch (e) {
    const msg = e instanceof BiobyDmApiError ? e.message : e instanceof Error ? e.message : String(e);
    await patchChannelRuntime(platform, { lastError: msg });
    throw e;
  }
}

async function runHeartbeat(): Promise<void> {
  const settings = await loadSettings();
  if (!apiReady(settings)) {
    await patchRuntime({ lastError: '请先同步工作台登录，或开启 Mock API' });
    return;
  }
  const platforms = listActivePlatforms(settings);
  if (platforms.length === 0) {
    const msg = settings.mockApiEnabled
      ? '请勾选 Instagram 或 TikTok 的「自动发送」，或在 Mock 测试中填写测试主页'
      : '请先在 Instagram 或 TikTok 卡片上勾选「自动发送」';
    await patchRuntime({ lastError: msg });
    return;
  }

  const baseDeviceId = await getOrCreateDeviceId();
  const errors: string[] = [];
  for (const platform of platforms) {
    try {
      await runHeartbeatForPlatform(settings, baseDeviceId, platform);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${platform}: ${msg}`);
    }
  }
    await patchRuntime({
    lastHeartbeatAt: new Date().toISOString(),
    lastError: errors.length ? errors.join('；') : undefined,
  });
}

function randomDelayMs(settings: Awaited<ReturnType<typeof loadSettings>>): number {
  const min = settings.minIntervalSec || DEFAULT_MIN_INTERVAL_SEC;
  const max = Math.max(min, settings.maxIntervalSec || DEFAULT_MAX_INTERVAL_SEC);
  const sec = min + Math.random() * (max - min);
  return Math.round(sec * 1000);
}

function runAllClaimLoops(): void {
  void (async () => {
    const settings = await loadSettings();
    if (!settings.autoSendEnabled) return;
    for (const platform of listEnabledPlatforms(settings)) {
      void runClaimLoopTick(platform);
    }
  })();
}

function runAllReplyScans(): void {
  void (async () => {
    const settings = await loadSettings();
    if (!apiReady(settings)) return;
    for (const platform of listEnabledPlatforms(settings)) {
      void runReplyScanForPlatform(platform);
    }
  })();
}

function watchesWithHandles(watches: ObservationWatch[] | undefined): ObservationWatch[] {
  return (watches ?? []).filter((w) => w.influencerHandle?.trim());
}

async function runReplyScanForPlatform(platform: DmPlatform): Promise<void> {
  if (replyScanBusy[platform]) return;
  const settings = await loadSettings();
  if (!apiReady(settings)) return;

  const runtime = await loadRuntime();
  const watches = watchesWithHandles(runtime.channels[platform].observationWatches);
  if (watches.length === 0) return;

  replyScanBusy[platform] = true;
  try {
    const tabId = await ensurePlatformTab(platform);
    await chrome.tabs.update(tabId, { url: PLATFORM_INBOX_URL[platform], active: false });
    await waitTabComplete(tabId);

    const resp = (await chrome.tabs.sendMessage(tabId, {
      type: 'SCAN_OBSERVATION_REPLIES',
      watches,
    } satisfies ContentMessage)) as ContentResponse;

    if (resp?.type !== 'OBSERVATION_REPLY_SCAN') return;

    const baseDeviceId = await getOrCreateDeviceId();
    const deviceId = deviceIdForPlatform(baseDeviceId, platform);
    const reported = new Set<string>();

    for (const reply of resp.replies) {
      if (reported.has(reply.taskId)) continue;
      reported.add(reply.taskId);
      try {
        await postReportReply(settings, deviceId, reply.taskId, reply.snippet, reply.threadUrl);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await patchChannelRuntime(platform, { lastError: `report-reply: ${msg}` });
      }
    }

    if (resp.replies.length > 0) {
      const done = new Set(resp.replies.map((r) => r.taskId));
      const remaining = watches.filter((w) => !done.has(w.taskId));
      await patchChannelRuntime(platform, {
        observationWatches: remaining.length ? remaining : undefined,
        lastReplyScanAt: new Date().toISOString(),
      });
    } else {
      await patchChannelRuntime(platform, { lastReplyScanAt: new Date().toISOString() });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await patchChannelRuntime(platform, { lastError: `reply-scan: ${msg}` });
  } finally {
    replyScanBusy[platform] = false;
  }
}

async function runClaimLoopTick(
  platform: DmPlatform,
  opts?: { force?: boolean },
): Promise<ClaimOnceResult> {
  const title = platformTitle(platform);
  if (claimLoopBusy[platform]) {
    return { ok: false, message: `${title} 正在执行中，请稍候再试` };
  }

  const settings = await loadSettings();
  if (!settings.autoSendEnabled && !opts?.force) {
    return { ok: false, message: '全自动未开启' };
  }

  const mockTrial = Boolean(opts?.force && settings.mockApiEnabled);
  const channelEnabled = platform === 'instagram' ? settings.instagramEnabled : settings.tiktokEnabled;
  if (!channelEnabled && !mockTrial) {
    const msg = `请先在 ${title} 卡片上勾选「自动发送」`;
    return { ok: false, message: msg };
  }

  const accountLabel = accountLabelForPlatform(settings, platform);
  if (!accountLabel && !mockTrial) {
    const msg = `请填写 ${title} 商务号编号并保存`;
    await patchChannelRuntime(platform, { lastError: msg });
    return { ok: false, message: msg };
  }

  const runtime = await loadRuntime();
  const channel = runtime.channels[platform];
  if (channel.halted && !opts?.force) {
    const reason = channel.haltReason ? `（${channel.haltReason}）` : '';
    return { ok: false, message: `${title} 已暂停${reason}，请先点「恢复」` };
  }

  if (!apiReady(settings)) {
    const msg = '缺少登录凭证：请同步工作台登录，或开启 Mock API';
    await patchChannelRuntime(platform, { lastError: msg });
    return { ok: false, message: msg };
  }

  if (mockTrial) {
    const profileUrl = settings.mockProfileUrl?.trim();
    if (!profileUrl) {
      const msg = '请填写「测试用达人主页」并点「保存设置」';
      await patchChannelRuntime(platform, { lastError: msg });
      return { ok: false, message: msg };
    }
    const urlPlatform = inferPlatformFromProfileUrl(profileUrl);
    if (urlPlatform && urlPlatform !== platform) {
      const msg = `测试主页是 ${platformTitle(urlPlatform)} 链接，请点「试发 ${platformTitle(urlPlatform)}」`;
      await patchChannelRuntime(platform, { lastError: msg });
      return { ok: false, message: msg };
    }
  }

  claimLoopBusy[platform] = true;
  await patchChannelRuntime(platform, { loopRunning: true });
  try {
    if (!opts?.force) {
      await sleep(randomDelayMs(settings));
    }
    const baseDeviceId = await getOrCreateDeviceId();
    const deviceId = deviceIdForPlatform(baseDeviceId, platform);
    const task = await postClaimNext(settings, platform, deviceId);
    await patchChannelRuntime(platform, { lastClaimAt: new Date().toISOString() });
    if (!task) {
      const msg = mockTrial
        ? 'Mock 未生成任务，请检查测试主页是否已保存'
        : '当前没有待发送任务';
      await patchChannelRuntime(platform, { lastError: msg });
      return { ok: false, message: msg };
    }
    await executeTask(platform, task, deviceId);
    const msg = `已触发 ${title} 试发，请查看浏览器中的 ${title} 标签页`;
    await patchChannelRuntime(platform, { lastError: undefined });
    return { ok: true, message: msg };
  } catch (e) {
    const msg = e instanceof BiobyDmApiError ? e.message : e instanceof Error ? e.message : String(e);
    await patchChannelRuntime(platform, { lastError: msg });
    return { ok: false, message: msg };
  } finally {
    claimLoopBusy[platform] = false;
    await patchChannelRuntime(platform, { loopRunning: false });
  }
}

async function executeTask(platform: DmPlatform, task: ClaimNextTask, deviceId: string): Promise<void> {
  const settings = await loadSettings();
  const accountLabel = accountLabelForPlatform(settings, platform);
  const taskPlatform = resolveTaskPlatform(task, platform);
  await patchChannelRuntime(platform, { lastTaskId: task.taskId });

  if (!task.profileUrl || !task.draftBody) {
    await postMarkFailed(settings, deviceId, task.taskId, 'UNKNOWN', 'Missing profileUrl or draft', false);
    return;
  }

  if (taskPlatform !== platform) {
    await postMarkFailed(
      settings,
      deviceId,
      task.taskId,
      'ACCOUNT_MISMATCH',
      `Task channel ${taskPlatform} does not match ${platform}`,
      true,
    );
    return;
  }

  if (
    task.senderAccountLabel &&
    task.senderAccountLabel.trim() &&
    task.senderAccountLabel !== accountLabel
  ) {
    await postMarkFailed(
      settings,
      deviceId,
      task.taskId,
      'ACCOUNT_MISMATCH',
      `Task bound to ${task.senderAccountLabel}`,
      true,
    );
    return;
  }

  const tabId = await ensurePlatformTab(taskPlatform);
  await chrome.tabs.update(tabId, { url: task.profileUrl, active: false });
  await waitTabComplete(tabId);

  let result: SendDmResult;
  try {
    result = await sendDmToTab(tabId, {
      type: 'SEND_DM',
      profileUrl: task.profileUrl,
      body: task.draftBody,
      expectedHandle: task.influencerHandle,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await postMarkFailed(settings, deviceId, task.taskId, 'SELECTOR_BROKEN', message, false);
    return;
  }

  if (result.ok) {
    await postMarkSent(settings, platform, deviceId, task.taskId, task.roundIndex, result.threadUrl);
    await patchChannelRuntime(platform, { lastError: undefined });
    return;
  }

  await postMarkFailed(
    settings,
    deviceId,
    task.taskId,
    result.code as PluginFailureCode,
    result.message,
    Boolean(result.retryable),
  );
  if (['CAPTCHA', 'LOGIN_EXPIRED', 'SELECTOR_BROKEN', 'RATE_LIMITED'].includes(result.code)) {
    await patchChannelRuntime(platform, { halted: true, haltReason: result.code });
    await maybeStopAutoIfAllHalted();
  }
}

async function maybeStopAutoIfAllHalted(): Promise<void> {
  const [settings, runtime] = await Promise.all([loadSettings(), loadRuntime()]);
  const enabled = listEnabledPlatforms(settings);
  if (enabled.length === 0) return;
  const allHalted = enabled.every((p) => runtime.channels[p].halted);
  if (allHalted) {
    await saveSettings({ autoSendEnabled: false });
    await patchRuntime({ lastError: '所有已启用渠道均已熔断，已关闭全自动' });
    await scheduleAlarms();
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

void scheduleAlarms();
