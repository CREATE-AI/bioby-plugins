export const EXTENSION_VERSION = '0.4.0';

/** 与 bioby-email 设计一致：/api/auto-dm-delivery */
export const API_PREFIX = '/api/auto-dm-delivery';

export const ALARM_HEARTBEAT = 'bioby-dm-heartbeat';
export const ALARM_CLAIM_LOOP = 'bioby-dm-claim-loop';
export const ALARM_REPLY_SCAN = 'bioby-dm-reply-scan';

export const DEFAULT_HEARTBEAT_SEC = 60;
export const DEFAULT_REPLY_SCAN_SEC = 300;
export const DEFAULT_MIN_INTERVAL_SEC = 90;
export const DEFAULT_MAX_INTERVAL_SEC = 240;

export const STORAGE_KEYS = {
  settings: 'biobyDmSettings',
  deviceId: 'biobyDmDeviceId',
  runtime: 'biobyDmRuntime',
} as const;
