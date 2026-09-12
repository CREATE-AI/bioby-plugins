import type { DmPlatform, PluginSettings } from './types';
import { inferPlatformFromProfileUrl } from './platform';

export const DM_PLATFORMS: DmPlatform[] = ['instagram', 'tiktok'];

export function isPlatformEnabled(settings: PluginSettings, platform: DmPlatform): boolean {
  return platform === 'instagram' ? settings.instagramEnabled : settings.tiktokEnabled;
}

export function accountLabelForPlatform(settings: PluginSettings, platform: DmPlatform): string {
  const label =
    platform === 'instagram' ? settings.instagramAccountLabel : settings.tiktokAccountLabel;
  return label.trim();
}

export function listEnabledPlatforms(settings: PluginSettings): DmPlatform[] {
  return DM_PLATFORMS.filter((p) => isPlatformEnabled(settings, p));
}

/** 已启用且已填商务号，可领任务/心跳 */
export function listReadyPlatforms(settings: PluginSettings): DmPlatform[] {
  return listEnabledPlatforms(settings).filter((p) => accountLabelForPlatform(settings, p).length > 0);
}

/** 心跳/检查连接用：已启用的渠道，或 Mock 下根据测试主页推断平台 */
export function listActivePlatforms(settings: PluginSettings): DmPlatform[] {
  const enabled = listEnabledPlatforms(settings);
  if (enabled.length > 0) return enabled;
  if (settings.mockApiEnabled) {
    const inferred = inferPlatformFromProfileUrl(settings.mockProfileUrl);
    if (inferred) return [inferred];
  }
  return [];
}

/** 同一物理设备上为 IG/TT 使用不同 deviceId，避免后端 lease/心跳互相覆盖 */
export function deviceIdForPlatform(baseDeviceId: string, platform: DmPlatform): string {
  const suffix = platform === 'instagram' ? 'ig' : 'tt';
  return `${baseDeviceId}_${suffix}`;
}

export function platformTitle(platform: DmPlatform): string {
  return platform === 'tiktok' ? 'TikTok' : 'Instagram';
}
