/**
 * 在小红书搜索结果页提取笔记卡片。
 * 页面 DOM 会变，采用多策略选择器 + 链接归一化。
 */
(function initXhsExtractor() {
  if (window.__XHS_LEAD_EXTRACTOR__) return;
  const NOTE_HREF_RE = /\/(?:explore|discovery\/item|search_result\/[^/]+)\/([a-f0-9]{24})/i;

  function parseNoteId(href) {
    if (!href) return null;
    try {
      const url = new URL(href, location.origin);
      const match = url.pathname.match(NOTE_HREF_RE);
      if (match) return match[1];
      const parts = url.pathname.split('/').filter(Boolean);
      const last = parts[parts.length - 1];
      if (last && /^[a-f0-9]{24}$/i.test(last)) return last;
    } catch {
      return null;
    }
    return null;
  }

  function pickText(el) {
    return (el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function findCardRoot(anchor) {
    let node = anchor;
    for (let i = 0; i < 8 && node; i += 1) {
      if (node.querySelector?.('a[href*="/user/profile/"]') || node.classList?.length) {
        return node;
      }
      node = node.parentElement;
    }
    return anchor.parentElement || anchor;
  }

  function extractAuthor(card) {
    const profile = card.querySelector('a[href*="/user/profile/"]');
    if (!profile) return { authorName: '', authorId: '' };
    let authorName = pickText(profile);
    // 昵称旁常拼上时间文案，如「余温昨天 14:14」
    authorName = authorName
      .replace(/(昨天|前天|今天)\s*\d{1,2}:\d{2}/g, '')
      .replace(/\d+\s*(分钟前|小时前|天前|周前|个月前|年前)/g, '')
      .replace(/\b\d{1,2}:\d{2}\b/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const href = profile.getAttribute('href') || '';
    const idMatch = href.match(/\/user\/profile\/([a-f0-9]{24})/i);
    return { authorName, authorId: idMatch ? idMatch[1] : '' };
  }

  function unwrapRef(v) {
    if (v && typeof v === 'object' && ('value' in v || '_value' in v)) {
      return v.value !== undefined ? v.value : v._value;
    }
    return v;
  }

  function pickRedIdFromUser(user) {
    if (!user || typeof user !== 'object') return '';
    const u = unwrapRef(user) || {};
    const red = u.red_id || u.redId || u.redID || u.xhs_id || u.xhsId || '';
    const s = String(red || '').trim();
    if (!s || /^[a-f0-9]{24}$/i.test(s)) return '';
    return s.slice(0, 64);
  }

  /** 从主世界 state-bridge 或 __INITIAL_STATE__ 构建笔记索引 */
  function readFeedBridgeSnapshot() {
    try {
      const el = document.getElementById('__xhs_lead_feed_bridge__');
      if (!el?.textContent) return null;
      return JSON.parse(el.textContent);
    } catch {
      return null;
    }
  }

  function buildFeedIndex() {
    const byNoteId = new Map();
    const byAuthorId = new Map();

    const bridge = readFeedBridgeSnapshot();
    if (bridge?.byNoteId) {
      for (const [id, entry] of Object.entries(bridge.byNoteId)) {
        if (entry) byNoteId.set(String(id), entry);
      }
    }
    if (bridge?.byAuthorId) {
      for (const [id, red] of Object.entries(bridge.byAuthorId)) {
        if (red) byAuthorId.set(String(id), String(red));
      }
    }
    if (byNoteId.size) return { byNoteId, byAuthorId };

    function parseTimestamp(raw) {
      const pick = window.__XHS_TIME_PARSE__?.parseNumericTimestamp;
      if (pick) return pick(raw);
      if (raw == null || raw === '') return null;
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) return null;
      const ms = n > 1e12 ? n : n * 1000;
      const d = new Date(ms);
      return Number.isNaN(d.getTime()) ? null : d;
    }

    function pickCreateTimestamp(card) {
      const pick = window.__XHS_TIME_PARSE__?.pickCreateTimestampFromCard;
      if (pick) return pick(card);
      return parseTimestamp(
        card.create_time || card.createTime || card.note_time || card.noteTime
          || card.publish_time || card.publishTime || card.time || card.timestamp,
      );
    }

    function pickTimeText(card) {
      const corner = unwrapRef(card.corner_tag_info) || card.corner_tag_info;
      if (Array.isArray(corner)) {
        for (const tag of corner) {
          const t = unwrapRef(tag) || tag;
          const text = String(t?.text || t?.content || '').trim();
          if (text) return text;
        }
      }
      const fields = [
        card.time_desc, card.timeDesc, card.publish_time_text, card.publishTimeText,
      ];
      for (const f of fields) {
        const s = String(f || '').trim();
        if (s) return s;
      }
      return '';
    }

    function ingestItem(item) {
      const card = unwrapRef(item?.note_card) || unwrapRef(item?.noteCard) || unwrapRef(item) || {};
      const noteId = String(card.note_id || card.noteId || card.id || item?.id || '');
      if (!noteId) return;

      const user = unwrapRef(card.user) || unwrapRef(item?.user) || {};
      const authorId = String(user.user_id || user.userid || user.userId || user.id || '');
      const authorName = String(
        user.nickname || user.nick_name || user.name || user.user_name || '',
      ).trim();
      const redId = pickRedIdFromUser(user);

      const title = String(
        card.display_title || card.title || card.desc || '',
      ).trim().slice(0, 120);
      const desc = String(card.desc || card.description || title || '').trim().slice(0, 300);

      const interact = unwrapRef(card.interact_info) || card.interact_info || {};
      const likes = Number(interact.liked_count ?? card.liked_count ?? card.likes ?? 0) || 0;

      let publishTimeText = pickTimeText(card);
      let publishAt = '';
      let publishAtSource = '';

      const ts = pickCreateTimestamp(card);
      const resolve = window.__XHS_TIME_PARSE__?.resolvePublishAt;
      const resolved = resolve
        ? resolve(ts, publishTimeText)
        : null;

      if (resolved?.publishAt) {
        publishAt = resolved.publishAt.toISOString();
        publishAtSource = resolved.publishAtSource || 'timestamp';
        if (!publishTimeText) {
          const format = window.__XHS_TIME_PARSE__?.formatPublishAtLocal;
          publishTimeText = format ? format(resolved.publishAt) : publishTimeText;
        }
      } else if (ts) {
        publishAt = ts.toISOString();
        publishAtSource = 'timestamp';
        if (!publishTimeText) {
          const format = window.__XHS_TIME_PARSE__?.formatPublishAtLocal;
          publishTimeText = format ? format(ts) : publishTimeText;
        }
      } else if (publishTimeText) {
        const parse = window.__XHS_TIME_PARSE__?.parsePublishTime;
        const parsed = parse ? parse(publishTimeText) : null;
        if (parsed) {
          publishAt = parsed.toISOString();
          publishAtSource = 'text';
        }
      }

      const cover = card.cover || {};
      const coverImageUrl = String(
        cover.url_default || cover.url || cover.info_list?.[0]?.url || '',
      ).trim();

      const entry = {
        noteId,
        title,
        desc: desc || title,
        authorName,
        authorId,
        redId,
        likes,
        publishTimeText,
        publishAt,
        publishAtSource,
        coverImageUrl,
      };

      byNoteId.set(noteId, entry);
      if (authorId && redId) byAuthorId.set(authorId, redId);
    }

    try {
      const state = unwrapRef(window.__INITIAL_STATE__);
      if (!state) return { byNoteId, byAuthorId };

      const lists = [];
      const searchFeeds = unwrapRef(state.search?.feeds);
      if (searchFeeds) lists.push(searchFeeds);
      const feedFeeds = unwrapRef(state.feed?.feeds);
      if (feedFeeds) lists.push(feedFeeds);

      for (const list of lists) {
        const arr = Array.isArray(list) ? list : [];
        for (const item of arr) ingestItem(item);
      }
    } catch {
      // ignore
    }

    return { byNoteId, byAuthorId };
  }

  /** 保留兼容：仅返回小红书号映射 */
  function buildRedIdIndex() {
    const { byNoteId, byAuthorId } = buildFeedIndex();
    const redByNote = new Map();
    for (const [id, entry] of byNoteId) {
      if (entry?.redId) redByNote.set(id, entry.redId);
    }
    return { byNoteId: redByNote, byAuthorId };
  }

  function extractTitle(card) {
    const candidates = [
      card.querySelector('[class*="title"]'),
      card.querySelector('a[href*="/explore/"] span'),
      card.querySelector('a[href*="/discovery/item/"] span'),
      card.querySelector('span'),
    ];
    for (const el of candidates) {
      const text = pickText(el);
      if (text && text.length >= 4) return text.slice(0, 120);
    }
    return pickText(card).slice(0, 120);
  }

  function extractLikes(card) {
    const likeEl = card.querySelector('[class*="like"], [class*="count"], [class*="interaction"]');
    const text = pickText(likeEl);
    const num = text.replace(/[^\d.万wWkK]/g, '');
    if (/万|w/i.test(text)) {
      const base = parseFloat(num) || 0;
      return Math.round(base * 10000);
    }
    if (/k/i.test(text)) {
      const base = parseFloat(num) || 0;
      return Math.round(base * 1000);
    }
    return parseInt(num, 10) || 0;
  }

  function extractPublishTime(card) {
    const ABS_RE = /(20\d{2}[./年-]\d{1,2}[./月-]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2})?)/;
    // 带时分的相对时间优先于裸「昨天」
    const REL_RE = /(刚刚|刚才|刚刚发布|(?:昨天|前天|今天)\s*\d{1,2}:\d{2}|(?:昨天|前天|今天)|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|\d+\s*周前|\d+\s*个月前|\d+\s*年前)/;
    // MM-DD 需更严：整段短文本，避免标题「1/5」误抓
    const MD_RE = /^(\d{1,2})[./-](\d{1,2})(?:\s+\d{1,2}:\d{2})?$/;

    // 优先时间相关节点，去掉过宽的裸 span/div
    const timeNodes = card.querySelectorAll(
      '[class*="time"], [class*="Time"], [class*="date"], [class*="Date"], [class*="publish"], [class*="Publish"], time',
    );
    const candidates = [];
    for (const el of timeNodes) {
      const t = pickText(el);
      if (!t || t.length > 40) continue;
      candidates.push(t);
      if (candidates.length >= 8) break;
    }

    // 作者旁时间常无独立 class，从整卡再捞一遍候选
    const cardText = pickText(card);
    const glued = cardText.match(/(昨天|前天|今天)\s*\d{1,2}:\d{2}/);
    if (glued) candidates.unshift(glued[0]);

    function pickFromText(t) {
      if (!t) return '';
      const abs = t.match(ABS_RE);
      if (abs) return abs[1].replace(/\s+/g, ' ').trim();
      const rel = t.match(REL_RE);
      if (rel) return rel[1].replace(/\s+/g, ' ').trim();
      const trimmed = t.replace(/\s+/g, ' ').trim();
      if (MD_RE.test(trimmed)) return trimmed;
      return '';
    }

    // 绝对日期优先于相对文案；相对中带时分优先
    let timeText = '';
    for (const c of candidates) {
      const abs = pickFromText(c);
      if (abs && /20\d{2}/.test(abs)) {
        timeText = abs;
        break;
      }
    }
    if (!timeText) {
      for (const c of candidates) {
        const picked = pickFromText(c);
        if (picked && /(?:昨天|前天|今天)\s*\d{1,2}:\d{2}/.test(picked)) {
          timeText = picked;
          break;
        }
      }
    }
    if (!timeText) {
      for (const c of candidates) {
        timeText = pickFromText(c);
        if (timeText) break;
      }
    }

    if (!timeText) {
      // 仅从作者行附近取 MM-DD，避免标题里的日期误抓
      const profile = card.querySelector('a[href*="/user/profile/"]');
      if (profile?.parentElement) {
        const authorRow = pickText(profile.parentElement);
        const rel = authorRow.match(REL_RE);
        if (rel) timeText = rel[1].replace(/\s+/g, ' ').trim();
        if (!timeText) {
          const md = authorRow.match(/\b(\d{1,2}[./-]\d{1,2})\b/);
          if (md) timeText = md[1];
        }
      }
    }

    const parse = window.__XHS_TIME_PARSE__?.parsePublishTime;
    const publishAt = parse ? parse(timeText) : null;
    return {
      publishTimeText: timeText || '',
      publishAt: publishAt ? publishAt.toISOString() : '',
    };
  }

  function extractCoverImage(card) {
    const imgs = Array.from(card.querySelectorAll('img'));
    let best = '';
    let bestArea = 0;
    for (const img of imgs) {
      const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
      if (!src || src.startsWith('data:')) continue;
      if (/avatar|head|icon|emoji|logo/i.test(src)) continue;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      const area = w * h;
      // 太小多半是头像/图标
      if (w > 0 && h > 0 && (w < 40 || h < 40)) continue;
      if (area >= bestArea || (!best && src)) {
        bestArea = area || bestArea;
        best = src;
      }
    }
    return best;
  }

  function pickOldestPublish(domNote, feedEntry) {
    const resolve = window.__XHS_TIME_PARSE__?.resolvePublishAt;
    const parse = window.__XHS_TIME_PARSE__?.parsePublishTime;
    const dates = [];
    const texts = new Set();

    function addDate(d) {
      if (d && !Number.isNaN(d.getTime())) dates.push(d);
    }

    function addFrom(ts, text) {
      if (text) texts.add(text);
      if (resolve) {
        const r = resolve(ts && !Number.isNaN(ts?.getTime?.()) ? ts : null, text);
        if (r?.publishAt) addDate(r.publishAt);
      } else if (text && parse) {
        const p = parse(text);
        if (p) addDate(p);
      } else if (ts && !Number.isNaN(ts.getTime())) {
        addDate(ts);
      }
    }

    addFrom(domNote.publishAt ? new Date(domNote.publishAt) : null, domNote.publishTimeText);
    if (feedEntry) {
      addFrom(feedEntry.publishAt ? new Date(feedEntry.publishAt) : null, feedEntry.publishTimeText);
    }
    for (const t of texts) {
      addFrom(null, t);
    }

    if (!dates.length) return null;
    const oldest = dates.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
    return {
      publishAt: oldest.toISOString(),
      publishTimeText: feedEntry?.publishTimeText || domNote.publishTimeText || '',
    };
  }

  function mergeWithFeedState(domNote, feedEntry, redByAuthor) {
    if (!feedEntry) {
      const redId = redByAuthor.get(String(domNote.authorId || '')) || domNote.redId || '';
      return redId ? { ...domNote, redId } : domNote;
    }

    const merged = { ...domNote };

    if (feedEntry.title) merged.title = feedEntry.title;
    if (feedEntry.desc && feedEntry.desc !== feedEntry.title) {
      merged.desc = feedEntry.desc;
    } else if (feedEntry.title) {
      merged.desc = feedEntry.title;
    }
    if (feedEntry.authorName) merged.authorName = feedEntry.authorName;
    if (feedEntry.authorId) merged.authorId = feedEntry.authorId;
    if (feedEntry.redId) merged.redId = feedEntry.redId;
    if (!merged.redId) {
      merged.redId = redByAuthor.get(String(merged.authorId || '')) || '';
    }
    if (feedEntry.likes > 0 && (!merged.likes || merged.likes === 0)) {
      merged.likes = feedEntry.likes;
    }
    if (feedEntry.coverImageUrl && !merged.coverImageUrl) {
      merged.coverImageUrl = feedEntry.coverImageUrl;
    }

    const oldest = pickOldestPublish(domNote, feedEntry);
    if (oldest?.publishAt) {
      merged.publishAt = oldest.publishAt;
      if (oldest.publishTimeText) merged.publishTimeText = oldest.publishTimeText;
    } else {
      const resolve = window.__XHS_TIME_PARSE__?.resolvePublishAt;
      const domTs = domNote.publishAt ? new Date(domNote.publishAt) : null;
      const feedTs = feedEntry?.publishAt ? new Date(feedEntry.publishAt) : null;
      const text = feedEntry?.publishTimeText || domNote.publishTimeText || '';

      if (resolve) {
        const fromDom = resolve(
          domTs && !Number.isNaN(domTs.getTime()) ? domTs : null,
          domNote.publishTimeText,
        );
        const fromFeed = resolve(
          feedTs && !Number.isNaN(feedTs.getTime()) ? feedTs : null,
          feedEntry?.publishTimeText || domNote.publishTimeText,
        );
        let chosen = fromFeed?.publishAt ? fromFeed : fromDom;
        if (fromDom?.publishAt && fromFeed?.publishAt) {
          chosen = fromDom.publishAt.getTime() <= fromFeed.publishAt.getTime() ? fromDom : fromFeed;
        }
        if (chosen?.publishAt) {
          merged.publishAt = chosen.publishAt.toISOString();
          merged.publishAtSource = chosen.publishAtSource || merged.publishAtSource;
        }
        if (text) merged.publishTimeText = text;
      } else if (feedEntry?.publishAt) {
        merged.publishAt = feedEntry.publishAt;
        if (feedEntry.publishTimeText) merged.publishTimeText = feedEntry.publishTimeText;
      }
    }

    if (merged.authorId && !merged.authorUrl) {
      merged.authorUrl = `https://www.xiaohongshu.com/user/profile/${merged.authorId}`;
    }

    merged.dataSource = feedEntry.title ? 'state+dom' : 'dom';
    return merged;
  }

  function extractNotesFromDom() {
    const anchors = Array.from(document.querySelectorAll(
      'a[href*="/explore/"], a[href*="/discovery/item/"], a[href*="/search_result/"]',
    ));
    const results = [];
    const seen = new Set();
    const { byNoteId: feedByNoteId, byAuthorId: redByAuthor } = buildFeedIndex();

    for (const anchor of anchors) {
      const href = anchor.href || anchor.getAttribute('href');
      const noteId = parseNoteId(href);
      if (!noteId || seen.has(noteId)) continue;
      seen.add(noteId);

      const card = findCardRoot(anchor);
      const { authorName, authorId } = extractAuthor(card);
      const title = extractTitle(card);
      const likes = extractLikes(card);
      const { publishTimeText, publishAt } = extractPublishTime(card);
      const coverImageUrl = extractCoverImage(card);
      const noteUrl = `https://www.xiaohongshu.com/explore/${noteId}`;
      const authorUrl = authorId
        ? `https://www.xiaohongshu.com/user/profile/${authorId}`
        : '';
      const redId = feedByNoteId.get(String(noteId))?.redId
        || redByAuthor.get(String(authorId))
        || '';

      const domNote = {
        noteId,
        title,
        desc: title,
        authorName,
        authorId,
        redId,
        authorUrl,
        likes,
        publishTimeText,
        publishAt,
        coverImageUrl,
        noteUrl,
      };

      results.push(mergeWithFeedState(domNote, feedByNoteId.get(String(noteId)), redByAuthor));
    }

    return results;
  }

  window.__XHS_LEAD_EXTRACTOR__ = { extractNotesFromDom };
})();
