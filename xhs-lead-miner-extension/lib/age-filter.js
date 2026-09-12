import {
  passesMaxAgeDays as passesPublishAtMaxAge,
  passesLeadMaxAge,
  resolveLeadPublishAt,
  classifyLeadMaxAgeStrict,
} from './publish-time.js';

/**
 * 统一的「近 N 天」判定（popup / background 共用）
 */
export function passesMaxAgeDays(publishAtIso, maxAgeDays, nowMs = Date.now()) {
  return passesPublishAtMaxAge(publishAtIso, maxAgeDays, nowMs);
}

export function classifyMaxAge(publishAtIso, maxAgeDays, nowMs = Date.now()) {
  const days = Number(maxAgeDays);
  if (!days || days <= 0) return 'ok';

  const ts = Date.parse(publishAtIso || '');
  if (!Number.isFinite(ts)) return 'unknown';

  const ageMs = nowMs - ts;
  if (ageMs < -24 * 60 * 60 * 1000) return 'unknown';
  return ageMs <= days * 24 * 60 * 60 * 1000 ? 'ok' : 'too_old';
}

export function classifyLeadMaxAge(lead, maxAgeDays, nowMs = Date.now()) {
  return classifyLeadMaxAgeStrict(lead, maxAgeDays, nowMs);
}

export function filterLeadsByMaxAge(leads, maxAgeDays) {
  const days = Number(maxAgeDays);
  if (!days || days <= 0) return leads || [];
  return (leads || []).filter((lead) => passesLeadMaxAge(lead, days));
}
