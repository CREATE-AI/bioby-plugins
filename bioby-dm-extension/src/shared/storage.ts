import { STORAGE_KEYS } from './constants';
import { normalizeDmPlatform } from './platform';
import type { ChannelRuntimeState, DmPlatform, PluginRuntimeState, PluginSettings } from './types';

const DEFAULT_CHANNEL_RUNTIME: ChannelRuntimeState = {
  halted: false,
  loopRunning: false,
};

const DEFAULT_CHANNELS: Record<DmPlatform, ChannelRuntimeState> = {
  instagram: { ...DEFAULT_CHANNEL_RUNTIME },
  tiktok: { ...DEFAULT_CHANNEL_RUNTIME },
};

const DEFAULT_SETTINGS: PluginSettings = {
  apiBaseUrl: 'http://localhost:8081',
  workBaseUrl: '',
  accessToken: '',
  instagramEnabled: false,
  tiktokEnabled: false,
  instagramAccountLabel: '',
  tiktokAccountLabel: '',
  autoSendEnabled: false,
  minIntervalSec: 90,
  maxIntervalSec: 240,
  heartbeatSec: 60,
  mockApiEnabled: false,
  mockProfileUrl: '',
  mockDraftBody: '',
  developerModeEnabled: false,
};

const DEFAULT_RUNTIME: PluginRuntimeState = {
  channels: { ...DEFAULT_CHANNELS },
};

function migrateSettings(raw: Partial<PluginSettings> | undefined): PluginSettings {
  const merged = { ...DEFAULT_SETTINGS, ...raw };
  const legacyLabel = (merged.accountLabel ?? '').trim();
  const legacyPlatform = normalizeDmPlatform(merged.platform) ?? 'instagram';
  if (legacyLabel) {
    if (!merged.instagramAccountLabel.trim() && legacyPlatform === 'instagram') {
      merged.instagramAccountLabel = legacyLabel;
    }
    if (!merged.tiktokAccountLabel.trim() && legacyPlatform === 'tiktok') {
      merged.tiktokAccountLabel = legacyLabel;
    }
  }
  delete merged.accountLabel;
  delete merged.platform;
  if (merged.instagramAccountLabel.trim() && raw?.instagramEnabled === undefined) {
    merged.instagramEnabled = true;
  }
  if (merged.tiktokAccountLabel.trim() && raw?.tiktokEnabled === undefined) {
    merged.tiktokEnabled = true;
  }
  return merged;
}

function migrateRuntime(raw: Partial<PluginRuntimeState> & Record<string, unknown> | undefined): PluginRuntimeState {
  const channels: Record<DmPlatform, ChannelRuntimeState> = {
    instagram: { ...DEFAULT_CHANNEL_RUNTIME, ...raw?.channels?.instagram },
    tiktok: { ...DEFAULT_CHANNEL_RUNTIME, ...raw?.channels?.tiktok },
  };
  if (raw && ('halted' in raw || 'loggedInHandle' in raw)) {
    const legacyPlatform = normalizeDmPlatform(raw.platform as string) ?? 'instagram';
    const ch = channels[legacyPlatform];
    if (raw.halted != null) ch.halted = Boolean(raw.halted);
    if (raw.haltReason != null) ch.haltReason = String(raw.haltReason);
    if (raw.loggedInHandle != null) ch.loggedInHandle = String(raw.loggedInHandle);
    if (raw.sentTodayCount != null) ch.sentTodayCount = Number(raw.sentTodayCount);
    if (raw.dailyQuota != null) ch.dailyQuota = Number(raw.dailyQuota);
    if (raw.lastTaskId != null) ch.lastTaskId = String(raw.lastTaskId);
    if (raw.lastError != null) ch.lastError = String(raw.lastError);
  }
  return {
    lastHeartbeatAt: raw?.lastHeartbeatAt,
    lastError: raw?.lastError,
    channels,
  };
}

export async function getOrCreateDeviceId(): Promise<string> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.deviceId);
  const existing = stored[STORAGE_KEYS.deviceId] as string | undefined;
  if (existing?.trim()) return existing.trim();
  const id = `ext_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  await chrome.storage.local.set({ [STORAGE_KEYS.deviceId]: id });
  return id;
}

export async function loadSettings(): Promise<PluginSettings> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const raw = stored[STORAGE_KEYS.settings] as Partial<PluginSettings> | undefined;
  return migrateSettings(raw);
}

export async function saveSettings(patch: Partial<PluginSettings>): Promise<PluginSettings> {
  const current = await loadSettings();
  const next = migrateSettings({ ...current, ...patch });
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function loadRuntime(): Promise<PluginRuntimeState> {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.runtime);
  const raw = stored[STORAGE_KEYS.runtime] as Partial<PluginRuntimeState> | undefined;
  return migrateRuntime(raw);
}

export async function patchRuntime(patch: Partial<PluginRuntimeState>): Promise<PluginRuntimeState> {
  const current = await loadRuntime();
  const next: PluginRuntimeState = {
    ...current,
    ...patch,
    channels: {
      instagram: { ...current.channels.instagram, ...patch.channels?.instagram },
      tiktok: { ...current.channels.tiktok, ...patch.channels?.tiktok },
    },
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.runtime]: next });
  return next;
}

export async function patchChannelRuntime(
  platform: DmPlatform,
  patch: Partial<ChannelRuntimeState>,
): Promise<PluginRuntimeState> {
  const current = await loadRuntime();
  return patchRuntime({
    channels: {
      ...current.channels,
      [platform]: { ...current.channels[platform], ...patch },
    },
  });
}
