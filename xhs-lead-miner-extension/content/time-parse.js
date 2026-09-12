/**
 * 解析小红书常见相对/绝对时间文案，返回 Date 或 null
 */
(function initTimeParse() {
  if (window.__XHS_TIME_PARSE__) return;

  /** 本地日历日 12:00（无具体时分时用） */
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

  function parsePublishTime(raw, now = new Date()) {
    const text = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!text) return null;

    if (/刚刚|刚才|刚刚发布/.test(text)) {
      return new Date(now.getTime() - 60 * 1000);
    }

    let m = text.match(/(\d+)\s*分钟前/);
    if (m) return new Date(now.getTime() - Number(m[1]) * 60 * 1000);

    m = text.match(/(\d+)\s*小时前/);
    if (m) return new Date(now.getTime() - Number(m[1]) * 60 * 60 * 1000);

    // 昨天/前天/今天 + 具体时分（如「昨天 14:14」）
    m = text.match(/(昨天|前天|今天)\s*(\d{1,2}):(\d{2})/);
    if (m) {
      const dayOffset = m[1] === '昨天' ? -1 : (m[1] === '前天' ? -2 : 0);
      const hour = Number(m[2]);
      const minute = Number(m[3]);
      if (hour <= 23 && minute <= 59) {
        return atLocalClock(now, dayOffset, hour, minute);
      }
    }

    if (/昨天/.test(text)) {
      return atLocalNoon(now, -1);
    }

    if (/前天/.test(text)) {
      return atLocalNoon(now, -2);
    }

    if (/今天/.test(text)) {
      return atLocalNoon(now, 0);
    }

    if (/^上周$|上周发布/.test(text)) {
      return atLocalNoon(now, -7);
    }

    if (/^本周$|本周发布/.test(text)) {
      return atLocalNoon(now, -2);
    }

    if (/上个月|上月/.test(text)) {
      return atLocalNoon(now, -30);
    }

    m = text.match(/(\d+)\s*天前/);
    if (m) {
      return atLocalNoon(now, -Number(m[1]));
    }

    m = text.match(/(\d+)\s*周前/);
    if (m) {
      return atLocalNoon(now, -Number(m[1]) * 7);
    }

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

    // 2024-08-06 14:14 / 2024年8月6日 14:14
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

    // 08-06 14:14
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

    // MM-DD / MM/DD：整段匹配，避免标题里的 1/5 误抓
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

  /** 导出/展示用：Asia/Shanghai → YYYY-MM-DD HH:mm */
  function formatPublishAtLocal(dateOrIso) {
    if (!dateOrIso) return '';
    const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
    if (Number.isNaN(d.getTime())) return '';
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).formatToParts(d);
      const get = (type) => parts.find((p) => p.type === type)?.value || '';
      return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
    } catch {
      const pad = (n) => String(n).padStart(2, '0');
      // 回退：按本地时区（国内机器一般为 CST）
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    }
  }

  function isWithinMaxAgeDays(publishDate, maxAgeDays, now = new Date()) {
    if (!maxAgeDays || maxAgeDays <= 0) return true;
    if (!publishDate || Number.isNaN(publishDate.getTime?.())) return false;
    const ageMs = now.getTime() - publishDate.getTime();
    if (ageMs < -24 * 60 * 60 * 1000) return false;
    return ageMs <= maxAgeDays * 24 * 60 * 60 * 1000;
  }

  /** 细分结果：ok | too_old | unknown */
  function classifyAge(publishDate, maxAgeDays, now = new Date()) {
    if (!maxAgeDays || maxAgeDays <= 0) return 'ok';
    if (!publishDate || Number.isNaN(publishDate.getTime?.())) return 'unknown';
    const ageMs = now.getTime() - publishDate.getTime();
    if (ageMs < -24 * 60 * 60 * 1000) return 'unknown';
    return ageMs <= maxAgeDays * 24 * 60 * 60 * 1000 ? 'ok' : 'too_old';
  }

  function parseNumericTimestamp(raw) {
    if (raw == null || raw === '') return null;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return null;
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** 仅发帖时间，不用 last_update_time */
  function pickCreateTimestampFromCard(card) {
    if (!card || typeof card !== 'object') return null;
    const fields = [
      card.create_time, card.createTime,
      card.note_time, card.noteTime,
      card.publish_time, card.publishTime,
      card.time, card.timestamp,
    ];
    for (const raw of fields) {
      const d = parseNumericTimestamp(raw);
      if (d) return d;
    }
    return null;
  }

  /**
   * 合并 API 时间戳与页面文案；取更早日期的保守策略
   */
  function resolvePublishAt(tsDate, publishTimeText, now = new Date()) {
    const fromText = parsePublishTime(publishTimeText, now);
    const ts = tsDate && !Number.isNaN(tsDate.getTime()) ? tsDate : null;

    if (!ts && fromText) {
      return { publishAt: fromText, publishAtSource: 'text' };
    }
    if (ts && !fromText) {
      return { publishAt: ts, publishAtSource: 'timestamp' };
    }
    if (!ts && !fromText) {
      return { publishAt: null, publishAtSource: '' };
    }

    const ageTs = now.getTime() - ts.getTime();
    const ageText = now.getTime() - fromText.getTime();
    const textRaw = String(publishTimeText || '');

    if (/周前|个月前|年前|上周|上月|去年/.test(textRaw) && ageText > ageTs + 2 * 24 * 60 * 60 * 1000) {
      return { publishAt: fromText, publishAtSource: 'text_override' };
    }

    if (fromText.getTime() < ts.getTime() - 12 * 60 * 60 * 1000) {
      return { publishAt: fromText, publishAtSource: 'text_older' };
    }

    const earlier = fromText.getTime() <= ts.getTime() ? fromText : ts;
    return {
      publishAt: earlier,
      publishAtSource: fromText.getTime() <= ts.getTime() ? 'text' : 'timestamp',
    };
  }

  function resolveLeadPublishDate(lead, now = new Date()) {
    const ts = lead?.publishAt ? new Date(lead.publishAt) : null;
    const okTs = ts && !Number.isNaN(ts.getTime()) ? ts : null;
    return resolvePublishAt(okTs, lead?.publishTimeText, now);
  }

  function isClearlyTooOldByText(raw, maxAgeDays, now = new Date()) {
    const days = Number(maxAgeDays);
    if (!days || days <= 0) return false;
    const text = String(raw || '').trim();
    if (!text) return false;
    const mDay = text.match(/(\d+)\s*天前/);
    if (mDay && Number(mDay[1]) > days) return true;
    const mWeek = text.match(/(\d+)\s*周前/);
    if (mWeek && Number(mWeek[1]) * 7 > days) return true;
    if (/个月前|年前|上周|上月|去年/.test(text)) return true;
    const parsed = parsePublishTime(text, now);
    return parsed ? !isWithinMaxAgeDays(parsed, days, now) : false;
  }

  function classifyLeadAge(lead, maxAgeDays, now = new Date()) {
    const days = Number(maxAgeDays);
    if (!days || days <= 0) return 'ok';
    if (!lead?.publishTimeText && !lead?.publishAt) return 'unknown';
    if (isClearlyTooOldByText(lead?.publishTimeText, days, now)) return 'too_old';
    const resolved = resolveLeadPublishDate(lead, now);
    if (!resolved.publishAt) return 'unknown';
    const main = classifyAge(resolved.publishAt, maxAgeDays, now);
    if (main !== 'ok') return main;
    if (lead?.publishTimeText) {
      const onlyText = parsePublishTime(lead.publishTimeText, now);
      if (onlyText && !isWithinMaxAgeDays(onlyText, days, now)) return 'too_old';
    }
    return 'ok';
  }

  window.__XHS_TIME_PARSE__ = {
    parsePublishTime,
    formatPublishAtLocal,
    isWithinMaxAgeDays,
    classifyAge,
    isClearlyTooOldByText,
    parseNumericTimestamp,
    pickCreateTimestampFromCard,
    resolvePublishAt,
    resolveLeadPublishDate,
    classifyLeadAge,
  };
})();
