import type { ClaimNextTask, DmPlatform, HeartbeatResponse, PluginSettings } from '../shared/types';

let mockClaimCount = 0;

export function resetMockClaimCounter(): void {
  mockClaimCount = 0;
}

export function mockHeartbeatResponse(): HeartbeatResponse {
  return {
    halted: false,
    sentTodayCount: mockClaimCount,
    dailyQuota: 50,
    observationTasks: [],
  };
}

export function mockClaimNextTask(settings: PluginSettings, platform: DmPlatform): ClaimNextTask | null {
  const profileUrl = (settings.mockProfileUrl ?? '').trim();
  const draftBody = (settings.mockDraftBody ?? '').trim() || 'Bioby mock DM — 请在后端就绪后关闭 Mock API';
  if (!profileUrl) {
    return null;
  }
  mockClaimCount += 1;
  const handleMatch = profileUrl.match(/instagram\.com\/([^/?#]+)/i) ?? profileUrl.match(/@([^/?#]+)/);
  return {
    taskId: `mock_task_${platform}_${mockClaimCount}`,
    roundIndex: 1,
    draftBody,
    profileUrl,
    influencerHandle: handleMatch?.[1],
    platform,
    outreachChannel: platform === 'instagram' ? 'IG_DM' : 'TIKTOK_DM',
  };
}
