/**
 * 发帖时间解析（background / 导出共用）
 * 注意：不要用 last_update_time / og:updated_time，那是编辑时间。
 */

function atLocalNoon(baseDate, dayOffset = 0) {
  const d = new Date(baseDate);
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() + dayOffset);
  return d;
}

function atLocalClock(baseDate, dayOffset, hour, minute) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, minute, 0, 0);
  return d;
}

export function parseNumericTimestamp(raw) {
  if (raw == null || raw === '') return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  const ms = n > 1e12 ? n : n * 1000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 仅取发帖时间字段，排除 last_update_time */
export function pickCreateTimestampFromCard(card) {
  if (!card || typeof card !== 'object') return null;
  const fields = [
    card.create_time,
    card.createTime,
    card.note_time,
    card.noteTime,
    card.publish_time,
    card.publishTime,
    card.time,
    card.timestamp,
  ];
  for (const raw of fields) {
    const d = parseNumericTimestamp(raw);
    if (d) return d;
  }
  return null;
}

export function parsePublishTime(raw, now = new Date()) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return null;

  if (/刚刚|刚才|刚刚发布/.test(text)) {
    return new Date(now.getTime() - 60 * 1000);
  }

  let m = text.match(/(\d+)\s*分钟前/);
  if (m) return new Date(now.getTime() - Number(m[1]) * 60 * 1000);

  m = text.match(/(\d+)\s*小时前/);
  if (m) return new Date(now.getTime() - Number(m[1]) * 60 * 60 * 1000);

  m = text.match(/(昨天|前天|今天)\s*(\d{1,2}):(\d{2})/);
  if (m) {
    const dayOffset = m[1] === '昨天' ? -1 : (m[1] === '前天' ? -2 : 0);
    const hour = Number(m[2]);
    const minute = Number(m[3]);
    if (hour <= 23 && minute <= 59) {
      return atLocalClock(now, dayOffset, hour, minute);
    }
  }

  if (/昨天/.test(text)) return atLocalNoon(now, -1);
  if (/前天/.test(text)) return atLocalNoon(now, -2);
  if (/今天/.test(text)) return atLocalNoon(now, 0);

  if (/^上周$|上周发布/.test(text)) return atLocalNoon(now, -7);
  if (/^本周$|本周发布/.test(text)) return atLocalNoon(now, -2);
  if (/上个月|上月/.test(text)) return atLocalNoon(now, -30);

  m = text.match(/(\d+)\s*天前/);
  if (m) return atLocalNoon(now, -Number(m[1]));

  m = text.match(/(\d+)\s*周前/);
  if (m) return atLocalNoon(now, -Number(m[1]) * 7);

  m = text.match(/(\d+)\s*个月前/);
  if (m) {
    const d = atLocalNoon(now, 0);
    d.setMonth(d.getMonth() - Number(m[1]));
    return d;
  }

  m = text.match(/(\d+)\s*年前/);
  if (m) {
    const d = atLocalNoon(now, 0);
    d.setFullYear(d.getFullYear() - Number(m[1]));
    return d;
  }

  m = text.match(/(20\d{2})[./年-](\d{1,2})[./月-](\d{1,2})(?:日)?\s*(\d{1,2}):(\d{2})/);
  if (m) {
    return new Date(
      Number(m[1]), Number(m[2]) - 1, Number(m[3]),
      Number(m[4]), Number(m[5]), 0, 0,
    );
  }

  m = text.match(/(20\d{2})[./年-](\d{1,2})[./月-](\d{1,2})/);
  if (m) {
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  }

  m = text.match(/^(\d{1,2})[./-](\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    const hour = Number(m[3]);
    const minute = Number(m[4]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31 && hour <= 23 && minute <= 59) {
      let year = now.getFullYear();
      let candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
      if (candidate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
        year -= 1;
        candidate = new Date(year, month - 1, day, hour, minute, 0, 0);
      }
      return candidate;
    }
  }

  m = text.match(/^(\d{1,2})[./-](\d{1,2})$/);
  if (m) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    let year = now.getFullYear();
    const candidate = new Date(year, month - 1, day, 12, 0, 0, 0);
    if (candidate.getTime() > now.getTime() + 24 * 60 * 60 * 1000) {
      year -= 1;
    }
    return new Date(year, month - 1, day, 12, 0, 0, 0);
  }

  return null;
}

/**
 * 合并 API 时间戳与页面文案，优先发帖时间、取更早日期的保守策略
 */
export function resolvePublishAt(tsDate, publishTimeText, now = new Date()) {
  const fromText = parsePublishTime(publishTimeText, now);
  const ts = tsDate && !Number.isNaN(tsDate.getTime()) ? tsDate : null;

  if (!ts && fromText) {
    return { publishAt: fromText.toISOString(), publishAtSource: 'text' };
  }
  if (ts && !fromText) {
    return { publishAt: ts.toISOString(), publishAtSource: 'timestamp' };
  }
  if (!ts && !fromText) {
    return { publishAt: '', publishAtSource: '' };
  }

  const ageTs = now.getTime() - ts.getTime();
  const ageText = now.getTime() - fromText.getTime();
  const textRaw = String(publishTimeText || '');

  if (/周前|个月前|年前|上周|上月|去年/.test(textRaw) && ageText > ageTs + 2 * 24 * 60 * 60 * 1000) {
    return { publishAt: fromText.toISOString(), publishAtSource: 'text_override' };
  }

  if (fromText.getTime() < ts.getTime() - 12 * 60 * 60 * 1000) {
    return { publishAt: fromText.toISOString(), publishAtSource: 'text_older' };
  }

  const earlier = fromText.getTime() <= ts.getTime() ? fromText : ts;
  return {
    publishAt: earlier.toISOString(),
    publishAtSource: fromText.getTime() <= ts.getTime() ? 'text' : 'timestamp',
  };
}

export function resolveLeadPublishAt(lead, now = new Date()) {
  const ts = lead?.publishAt ? new Date(lead.publishAt) : null;
  const okTs = ts && !Number.isNaN(ts.getTime()) ? ts : null;
  return resolvePublishAt(okTs, lead?.publishTimeText, now);
}

export function passesMaxAgeDays(publishAtIso, maxAgeDays, nowMs = Date.now()) {
  const days = Number(maxAgeDays);
  if (!days || days <= 0) return true;

  const ts = Date.parse(publishAtIso || '');
  if (!Number.isFinite(ts)) return false;

  const ageMs = nowMs - ts;
  if (ageMs < -24 * 60 * 60 * 1000) return false;

  return ageMs <= days * 24 * 60 * 60 * 1000;
}

export function isClearlyTooOldByText(raw, maxAgeDays, nowMs = Date.now()) {
  const days = Number(maxAgeDays);
  if (!days || days <= 0) return false;
  const text = String(raw || '').trim();
  if (!text) return false;

  const mDay = text.match(/(\d+)\s*天前/);
  if (mDay && Number(mDay[1]) > days) return true;

  const mWeek = text.match(/(\d+)\s*周前/);
  if (mWeek && Number(mWeek[1]) * 7 > days) return true;

  if (/个月前|年前|上周|上月|去年/.test(text)) return true;

  const parsed = parsePublishTime(text, new Date(nowMs));
  if (parsed && !passesMaxAgeDays(parsed.toISOString(), days, nowMs)) return true;
  return false;
}

export function passesLeadMaxAge(lead, maxAgeDays, nowMs = Date.now()) {
  const days = Number(maxAgeDays);
  if (!days || days <= 0) return true;

  const text = lead?.publishTimeText || '';
  if (isClearlyTooOldByText(text, days, nowMs)) return false;

  const resolved = resolveLeadPublishAt(lead, new Date(nowMs));
  if (!resolved.publishAt) return false;
  if (!passesMaxAgeDays(resolved.publishAt, days, nowMs)) return false;

  if (text) {
    const onlyText = parsePublishTime(text, new Date(nowMs));
    if (onlyText && !passesMaxAgeDays(onlyText.toISOString(), days, nowMs)) return false;
  }

  return true;
}

export function classifyLeadMaxAgeStrict(lead, maxAgeDays, nowMs = Date.now()) {
  const days = Number(maxAgeDays);
  if (!days || days <= 0) return 'ok';
  if (!lead?.publishTimeText && !lead?.publishAt) return 'unknown';
  return passesLeadMaxAge(lead, days, nowMs) ? 'ok' : 'too_old';
}
