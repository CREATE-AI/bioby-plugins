import { API_PREFIX, EXTENSION_VERSION } from '../shared/constants';
import { parseObservationWatches } from '../shared/observation';
import { accountLabelForPlatform } from '../shared/channels';
import type {
  ApiEnvelope,
  ClaimNextTask,
  DmPlatform,
  HeartbeatResponse,
  PluginFailureCode,
  PluginSettings,
} from '../shared/types';
import { inferPlatformFromProfileUrl, normalizeDmPlatform, platformFromOutreachChannel } from '../shared/platform';
import { mockClaimNextTask, mockHeartbeatResponse } from './mock';

export class BiobyDmApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'BiobyDmApiError';
  }
}

function baseUrl(settings: PluginSettings): string {
  return settings.apiBaseUrl.replace(/\/$/, '');
}

function authHeaders(settings: PluginSettings): HeadersInit {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const token = settings.accessToken.trim();
  if (token) {
    headers.Authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
  }
  return headers;
}

async function requestJson<T>(
  settings: PluginSettings,
  path: string,
  init: RequestInit,
): Promise<T | null> {
  const url = `${baseUrl(settings)}${API_PREFIX}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: { ...authHeaders(settings), ...(init.headers as Record<string, string>) },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  if (!res.ok) {
    throw new BiobyDmApiError(`HTTP ${res.status}: ${text || res.statusText}`, res.status, text);
  }
  if (!text) return null;
  const parsed = JSON.parse(text) as ApiEnvelope<T> | T;
  if (parsed && typeof parsed === 'object' && 'data' in parsed) {
    return (parsed as ApiEnvelope<T>).data ?? null;
  }
  return parsed as T;
}

export async function postHeartbeat(
  settings: PluginSettings,
  platform: DmPlatform,
  deviceId: string,
  loggedInHandle: string | null,
): Promise<HeartbeatResponse | null> {
  if (settings.mockApiEnabled) {
    return mockHeartbeatResponse();
  }
  const accountLabel = accountLabelForPlatform(settings, platform);
  const data = await requestJson<Record<string, unknown>>(settings, '/plugin/heartbeat', {
    method: 'POST',
    body: JSON.stringify({
      deviceId,
      accountLabel,
      platform,
      loggedInHandle: loggedInHandle ?? '',
      extensionVersion: EXTENSION_VERSION,
      autoSendEnabled: settings.autoSendEnabled,
    }),
  });
  if (!data) return null;
  const watches = parseObservationWatches(data);
  return {
    halted: data.halted != null ? Boolean(data.halted) : undefined,
    haltReason: data.haltReason != null ? String(data.haltReason) : undefined,
    sentTodayCount: data.sentTodayCount != null ? Number(data.sentTodayCount) : undefined,
    dailyQuota: data.dailyQuota != null ? Number(data.dailyQuota) : undefined,
    observationTasks: watches,
    observationTaskIds: watches.map((w) => w.taskId),
  };
}

export async function postClaimNext(
  settings: PluginSettings,
  platform: DmPlatform,
  deviceId: string,
): Promise<ClaimNextTask | null> {
  if (settings.mockApiEnabled) {
    return mockClaimNextTask(settings, platform);
  }
  const accountLabel = accountLabelForPlatform(settings, platform);
  const data = await requestJson<Record<string, unknown>>(settings, '/plugin/claim-next', {
    method: 'POST',
    body: JSON.stringify({
      deviceId,
      accountLabel,
      platform,
    }),
  });
  if (!data) return null;
  const taskId = String(data.taskId ?? '');
  if (!taskId) return null;
  const draft = (data.draft as Record<string, unknown> | undefined) ?? {};
  const deepLink = (data.deepLink as Record<string, unknown> | undefined) ?? {};
  const profileUrl = String(deepLink.profileUrl ?? data.profileUrl ?? '');
  const outreachChannel =
    data.outreachChannel != null
      ? String(data.outreachChannel)
      : data.outreach_channel != null
        ? String(data.outreach_channel)
        : undefined;
  const taskPlatform =
    normalizeDmPlatform(data.platform != null ? String(data.platform) : undefined) ??
    platformFromOutreachChannel(outreachChannel) ??
    inferPlatformFromProfileUrl(profileUrl) ??
    platform;
  return {
    taskId,
    roundIndex: Number(data.roundIndex ?? 1),
    draftBody: String(draft.body ?? data.draftBody ?? ''),
    profileUrl,
    influencerHandle: data.influencerHandle != null ? String(data.influencerHandle) : undefined,
    senderAccountLabel:
      data.senderAccountLabel != null ? String(data.senderAccountLabel) : undefined,
    platform: taskPlatform,
    outreachChannel,
  };
}

export async function postMarkSent(
  settings: PluginSettings,
  platform: DmPlatform,
  deviceId: string,
  taskId: string,
  roundIndex: number,
  threadUrl?: string,
): Promise<void> {
  if (settings.mockApiEnabled) {
    console.info('[bioby-dm mock] mark-sent', { taskId, roundIndex, threadUrl });
    return;
  }
  const accountLabel = accountLabelForPlatform(settings, platform);
  await requestJson(settings, `/plugin/tasks/${encodeURIComponent(taskId)}/mark-sent`, {
    method: 'POST',
    body: JSON.stringify({
      deviceId,
      roundIndex,
      senderAccountLabel: accountLabel,
      sendEvidence: {
        threadUrl: threadUrl ?? undefined,
        note: 'plugin-auto',
      },
    }),
  });
}

export async function postMarkFailed(
  settings: PluginSettings,
  deviceId: string,
  taskId: string,
  code: PluginFailureCode,
  message: string,
  retryable: boolean,
): Promise<void> {
  if (settings.mockApiEnabled) {
    console.info('[bioby-dm mock] mark-failed', { taskId, code, message, retryable });
    return;
  }
  await requestJson(settings, `/plugin/tasks/${encodeURIComponent(taskId)}/mark-failed`, {
    method: 'POST',
    body: JSON.stringify({
      deviceId,
      code,
      message,
      retryable,
    }),
  });
}

export async function postReportReply(
  settings: PluginSettings,
  deviceId: string,
  taskId: string,
  snippet: string,
  threadUrl?: string,
): Promise<void> {
  if (settings.mockApiEnabled) {
    console.info('[bioby-dm mock] report-reply', { taskId, snippet, threadUrl });
    return;
  }
  await requestJson(settings, `/plugin/tasks/${encodeURIComponent(taskId)}/report-reply`, {
    method: 'POST',
    body: JSON.stringify({
      deviceId,
      detectedAt: new Date().toISOString(),
      snippet,
      threadUrl,
      source: 'PLUGIN_INBOX',
    }),
  });
}

/** 与侧栏「解除熔断」联动，清除服务端 session 熔断状态 */
export async function postResumeAccount(
  settings: PluginSettings,
  accountLabel: string,
): Promise<void> {
  if (settings.mockApiEnabled) {
    console.info('[bioby-dm mock] resume-account', { accountLabel });
    return;
  }
  const label = accountLabel.trim();
  if (!label) return;
  await requestJson(settings, '/plugin/accounts/resume', {
    method: 'POST',
    body: JSON.stringify({ accountLabel: label }),
  });
}
