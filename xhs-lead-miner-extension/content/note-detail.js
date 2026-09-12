/**
 * 在笔记详情页提取正文、发布时间与验证码检测（限速补采用）
 */
(function initNoteDetailHelper() {
  if (window.__XHS_NOTE_DETAIL__) return;

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function pickText(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function detectCaptchaOrLogin() {
    const bodyText = pickText(document.body).slice(0, 2000);
    if (/扫码登录|请扫码|安全验证|滑动验证|验证码|登录后继续/.test(bodyText)) {
      return true;
    }
    const qr = document.querySelector(
      '[class*="qrcode"], [class*="QRCode"], [class*="login-container"], [class*="captcha"]',
    );
    return Boolean(qr);
  }

  function extractDescFromDom() {
    // 优先真实正文节点，避免抓到标题/整页容器
    const selectors = [
      '#detail-desc',
      '[id*="detail-desc"]',
      '[class*="desc"] .note-text',
      '[class*="Desc"] .note-text',
      '[class*="note-text"]',
      '#detail-desc .note-text',
      '[class*="desc"]',
      '[class*="Desc"]',
      '.note-content',
      'article',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      const t = pickText(el);
      if (t && t.length >= 8) {
        if (/^首页|^发现|^购物|^创作中心/.test(t) && t.length < 40) continue;
        // 过短且无话题标签，多半是标题节点
        if (t.length < 20 && !/#/.test(t)) continue;
        return t.slice(0, 800);
      }
    }
    const meta = document.querySelector('meta[name="description"]');
    const metaContent = meta?.getAttribute('content') || '';
    if (metaContent.length >= 8) return metaContent.slice(0, 800);
    return '';
  }

  function extractExtraImages() {
    const imgs = Array.from(document.querySelectorAll('img'));
    const urls = [];
    for (const img of imgs) {
      const src = img.currentSrc || img.src || '';
      if (!src || src.startsWith('data:')) continue;
      if (/avatar|head|icon|emoji|logo/i.test(src)) continue;
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (w > 0 && h > 0 && (w < 80 || h < 80)) continue;
      if (!urls.includes(src)) urls.push(src);
      if (urls.length >= 6) break;
    }
    return urls;
  }

  const ABS_DATE_RE = /(20\d{2}[./年-]\d{1,2}[./月-]\d{1,2}(?:日)?(?:\s*\d{1,2}:\d{2})?|\d{1,2}[./-]\d{1,2}(?:\s+\d{1,2}:\d{2})?)/;
  const REL_TIME_RE = /(刚刚|刚才|刚刚发布|(?:昨天|前天|今天)\s*\d{1,2}:\d{2}|(?:昨天|前天|今天)|\d+\s*分钟前|\d+\s*小时前|\d+\s*天前|\d+\s*周前|\d+\s*个月前|\d+\s*年前)/;

  function extractPublishTimeFromDetail() {
    const candidates = [];

    const timeNodes = document.querySelectorAll(
      '[class*="time"], [class*="Time"], [class*="date"], [class*="Date"], [class*="publish"], [class*="Publish"], time',
    );
    for (const el of timeNodes) {
      const t = pickText(el);
      if (!t || t.length > 48) continue;
      candidates.push(t);
      if (candidates.length >= 12) break;
    }

    // meta / 结构化
    const metaTime = document.querySelector('meta[itemprop="datePublished"], meta[name="publish_date"], meta[property="article:published_time"]');
    const metaVal = metaTime?.getAttribute('content') || '';
    if (metaVal) candidates.unshift(metaVal);

    // 绝对日期优先
    for (const c of candidates) {
      const abs = c.match(ABS_DATE_RE);
      if (abs) {
        const timeText = abs[1].replace(/\s+/g, '').replace(/[年月]/g, '-').replace(/日/g, '');
        const parse = window.__XHS_TIME_PARSE__?.parsePublishTime;
        const publishAt = parse ? parse(timeText) : null;
        if (publishAt) {
          return {
            publishTimeText: timeText,
            publishAt: publishAt.toISOString(),
          };
        }
      }
    }

    for (const c of candidates) {
      const rel = c.match(REL_TIME_RE);
      if (rel) {
        const timeText = rel[1].replace(/\s+/g, '');
        const parse = window.__XHS_TIME_PARSE__?.parsePublishTime;
        const publishAt = parse ? parse(timeText) : null;
        if (publishAt) {
          return {
            publishTimeText: timeText,
            publishAt: publishAt.toISOString(),
          };
        }
      }
    }

    // 页面正文里扫一眼短片段
    const bodySnippet = pickText(document.body).slice(0, 2500);
    const abs = bodySnippet.match(ABS_DATE_RE);
    if (abs) {
      const timeText = abs[1].replace(/\s+/g, '');
      const parse = window.__XHS_TIME_PARSE__?.parsePublishTime;
      const publishAt = parse ? parse(timeText) : null;
      if (publishAt) {
        return { publishTimeText: timeText, publishAt: publishAt.toISOString() };
      }
    }

    return { publishTimeText: '', publishAt: '' };
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

  /** 笔记详情：小红书号（非 24 位内部 userId） */
  function extractRedIdFromDetail() {
    const body = pickText(document.body).slice(0, 4000);
    const domMatch = body.match(/小红书号\s*[：:]\s*([A-Za-z0-9_\-.]+)/);
    if (domMatch?.[1] && !/^[a-f0-9]{24}$/i.test(domMatch[1])) {
      return domMatch[1];
    }

    try {
      const state = unwrapRef(window.__INITIAL_STATE__);
      if (!state) return '';

      const noteDetailMap = unwrapRef(state.note?.noteDetailMap) || {};
      for (const key of Object.keys(noteDetailMap)) {
        const entry = unwrapRef(noteDetailMap[key]) || {};
        const note = unwrapRef(entry.note) || unwrapRef(entry) || {};
        const user = unwrapRef(note.user) || {};
        const red = pickRedIdFromUser(user);
        if (red) return red;
      }

      const userPage = unwrapRef(state.user?.userPageData) || {};
      const basic = unwrapRef(userPage.basicInfo) || unwrapRef(userPage) || {};
      const red2 = pickRedIdFromUser(basic) || pickRedIdFromUser(userPage);
      if (red2) return red2;
    } catch {
      // ignore
    }
    return '';
  }

  async function enrichCurrentNote() {
    await sleep(900);
    if (detectCaptchaOrLogin()) {
      return { ok: false, captcha: true, message: '检测到登录/验证码，已停止详情补采' };
    }
    for (let i = 0; i < 8; i += 1) {
      if (detectCaptchaOrLogin()) {
        return { ok: false, captcha: true, message: '检测到登录/验证码，已停止详情补采' };
      }
      const desc = extractDescFromDom();
      const timeInfo = extractPublishTimeFromDetail();
      const redId = extractRedIdFromDetail();
      if (desc || timeInfo.publishAt || redId) {
        return {
          ok: Boolean(desc || timeInfo.publishAt || redId),
          desc: desc || '',
          imageUrls: extractExtraImages(),
          publishTimeText: timeInfo.publishTimeText || '',
          publishAt: timeInfo.publishAt || '',
          redId: redId || '',
        };
      }
      await sleep(350);
    }
    return { ok: false, message: '未解析到笔记正文' };
  }

  window.__XHS_NOTE_DETAIL__ = { enrichCurrentNote, detectCaptchaOrLogin };

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'ENRICH_CURRENT_NOTE') {
      enrichCurrentNote()
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, message: String(e) }));
      return true;
    }
    return false;
  });
})();
