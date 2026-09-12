export type PluginFailureCode =
  | 'CAPTCHA'
  | 'LOGIN_EXPIRED'
  | 'SELECTOR_BROKEN'
  | 'RATE_LIMITED'
  | 'ACCOUNT_MISMATCH'
  | 'NO_DM_ACCESS'
  | 'UNKNOWN';

export type DmPlatform = 'instagram' | 'tiktok';

export type PluginSettings = {
  apiBaseUrl: string;
  /** bioby-work 前端地址，用于打开工作台与同步登录 */
  workBaseUrl: string;
  accessToken: string;
  /** 是否在本机启用 Instagram 自动发送 */
  instagramEnabled: boolean;
  /** 是否在本机启用 TikTok 自动发送 */
  tiktokEnabled: boolean;
  instagramAccountLabel: string;
  tiktokAccountLabel: string;
  autoSendEnabled: boolean;
  minIntervalSec: number;
  maxIntervalSec: number;
  heartbeatSec: number;
  /** 无后端时本地假任务，仅测 DOM */
  mockApiEnabled: boolean;
  mockProfileUrl: string;
  mockDraftBody: string;
  /** 侧栏「调试与高级设置」是否展开 */
  developerModeEnabled: boolean;
  /** @deprecated 迁移用，新配置请用 instagramAccountLabel / tiktokAccountLabel */
  accountLabel?: string;
  /** @deprecated */
  platform?: DmPlatform;
};

export type ObservationWatch = {
  taskId: string;
  influencerHandle?: string;
  profileUrl?: string;
};

export type DetectedReply = {
  taskId: string;
  snippet: string;
  threadUrl?: string;
};

export type ChannelRuntimeState = {
  halted: boolean;
  haltReason?: string;
  loggedInHandle?: string;
  sentTodayCount?: number;
  dailyQuota?: number;
  lastError?: string;
  lastTaskId?: string;
  lastClaimAt?: string;
  lastReplyScanAt?: string;
  observationWatches?: ObservationWatch[];
  loopRunning: boolean;
};

export type PluginRuntimeState = {
  lastHeartbeatAt?: string;
  lastError?: string;
  channels: Record<DmPlatform, ChannelRuntimeState>;
};

export type ClaimNextTask = {
  taskId: string;
  roundIndex: number;
  draftBody: string;
  profileUrl: string;
  influencerHandle?: string;
  senderAccountLabel?: string;
  platform?: DmPlatform;
  outreachChannel?: string;
};

export type HeartbeatResponse = {
  halted?: boolean;
  haltReason?: string;
  sentTodayCount?: number;
  dailyQuota?: number;
  observationTaskIds?: string[];
  observationTasks?: ObservationWatch[];
};

export type ApiEnvelope<T> = {
  success?: boolean;
  message?: string;
  data?: T;
};

export type SendDmResult =
  | { ok: true; threadUrl?: string }
  | { ok: false; code: PluginFailureCode; message: string; retryable?: boolean };

export type ContentMessage =
  | { type: 'PING' }
  | { type: 'GET_LOGGED_IN_HANDLE' }
  | { type: 'SEND_DM'; profileUrl: string; body: string; expectedHandle?: string }
  | { type: 'SCAN_OBSERVATION_REPLIES'; watches: ObservationWatch[] };

export type ContentResponse =
  | { type: 'PONG' }
  | { type: 'LOGGED_IN_HANDLE'; handle: string | null }
  | { type: 'SEND_DM_RESULT'; result: SendDmResult }
  | { type: 'OBSERVATION_REPLY_SCAN'; replies: DetectedReply[] };

export type BackgroundStatus = PluginSettings & PluginRuntimeState & { deviceId?: string };
