/**
 * 主世界脚本：读取 __INITIAL_STATE__ 写入 DOM，供 isolated 内容脚本使用。
 * Chrome 扩展的内容脚本默认无法访问页面 JS 变量。
 */
(function initXhsStateBridge() {
  if (window.__XHS_STATE_BRIDGE_INIT__) return;
  window.__XHS_STATE_BRIDGE_INIT__ = true;

  const BRIDGE_ID = '__xhs_lead_feed_bridge__';

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

  function parseTimestamp(raw) {
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
    const candidates = [
      card.create_time,
      card.createTime,
      card.note_time,
      card.noteTime,
      card.publish_time,
      card.publishTime,
      card.time,
      card.timestamp,
    ];
    for (const raw of candidates) {
      const d = parseTimestamp(raw);
      if (d) return d;
    }
    return null;
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
    const fields = [card.time_desc, card.timeDesc, card.publish_time_text, card.publishTimeText];
    for (const f of fields) {
      const s = String(f || '').trim();
      if (s) return s;
    }
    return '';
  }

  function buildSnapshot() {
    const byNoteId = {};
    const byAuthorId = {};
    try {
      const state = unwrapRef(window.__INITIAL_STATE__);
      if (!state) return { byNoteId, byAuthorId, updatedAt: Date.now() };

      const lists = [];
      const searchFeeds = unwrapRef(state.search?.feeds);
      if (searchFeeds) lists.push(searchFeeds);
      const feedFeeds = unwrapRef(state.feed?.feeds);
      if (feedFeeds) lists.push(feedFeeds);

      for (const list of lists) {
        const arr = Array.isArray(list) ? list : [];
        for (const item of arr) {
          const card = unwrapRef(item?.note_card) || unwrapRef(item?.noteCard) || unwrapRef(item) || {};
          const noteId = String(card.note_id || card.noteId || card.id || item?.id || '');
          if (!noteId) continue;

          const user = unwrapRef(card.user) || unwrapRef(item?.user) || {};
          const authorId = String(user.user_id || user.userid || user.userId || user.id || '');
          const authorName = String(
            user.nickname || user.nick_name || user.name || user.user_name || '',
          ).trim();
          const redId = pickRedIdFromUser(user);

          const title = String(card.display_title || card.title || '').trim().slice(0, 120);
          const desc = String(card.desc || card.description || title || '').trim().slice(0, 300);

          const interact = unwrapRef(card.interact_info) || card.interact_info || {};
          const likes = Number(interact.liked_count ?? card.liked_count ?? card.likes ?? 0) || 0;

          const ts = pickCreateTimestamp(card);
          const publishTimeText = pickTimeText(card);
          const resolve = window.__XHS_TIME_PARSE__?.resolvePublishAt;
          const resolved = resolve
            ? resolve(ts, publishTimeText)
            : { publishAt: ts || null, publishAtSource: ts ? 'timestamp' : '' };
          let publishAt = resolved.publishAt ? resolved.publishAt.toISOString() : '';
          let publishAtSource = resolved.publishAtSource || (ts ? 'timestamp' : '');

          const cover = card.cover || {};
          const coverImageUrl = String(
            cover.url_default || cover.url || cover.info_list?.[0]?.url || '',
          ).trim();

          byNoteId[noteId] = {
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
          if (authorId && redId) byAuthorId[authorId] = redId;
        }
      }
    } catch {
      // ignore
    }

    return { byNoteId, byAuthorId, updatedAt: Date.now() };
  }

  function publishSnapshot() {
    const snapshot = buildSnapshot();
    let el = document.getElementById(BRIDGE_ID);
    if (!el) {
      el = document.createElement('script');
      el.id = BRIDGE_ID;
      el.type = 'application/json';
      el.setAttribute('aria-hidden', 'true');
      (document.documentElement || document.head || document.body).appendChild(el);
    }
    el.textContent = JSON.stringify(snapshot);
    return snapshot;
  }

  publishSnapshot();
  setInterval(publishSnapshot, 1500);

  const origPushState = history.pushState;
  const origReplaceState = history.replaceState;
  history.pushState = function patchedPushState(...args) {
    const ret = origPushState.apply(this, args);
    setTimeout(publishSnapshot, 400);
    return ret;
  };
  history.replaceState = function patchedReplaceState(...args) {
    const ret = origReplaceState.apply(this, args);
    setTimeout(publishSnapshot, 400);
    return ret;
  };
  window.addEventListener('popstate', () => setTimeout(publishSnapshot, 400));
})();
