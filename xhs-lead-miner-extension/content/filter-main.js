/**
 * 主世界：筛选抽屉内点击（与 Vue 同上下文）
 */
(function initXhsFilterMain() {
  const CMD_ATTR = 'data-xhs-lead-filter-cmd';
  const RES_ATTR = 'data-xhs-lead-filter-res';
  const VERSION = '1.11.24';

  function publishLabelCandidates(days) {
    const d = Number(days) || 7;
    if (d <= 1) return ['一天内', '1天内', '24小时内', '一天'];
    if (d <= 7) return ['一周内', '一周', '7天内', '七天内', '最近一周', '7天'];
    if (d <= 183) return ['半年内', '半年', '6个月'];
    return [];
  }

  function mapMaxAgeToUrlTime(days) {
    const d = Number(days) || 7;
    if (d <= 1) return 'ONE_DAY';
    if (d <= 7) return 'ONE_WEEK';
    if (d <= 183) return 'HALF_YEAR';
    return null;
  }

  function urlFiltersMatch(days) {
    try {
      const u = new URL(location.href);
      if (u.searchParams.get('sort') !== 'time_descending') return false;
      const want = mapMaxAgeToUrlTime(days);
      if (!want) return true;
      return u.searchParams.get('note_time') === want;
    } catch {
      return false;
    }
  }

  function buildFiltersUrl(days) {
    const u = new URL(location.href);
    u.searchParams.set('sort', 'time_descending');
    const want = mapMaxAgeToUrlTime(days);
    if (want) u.searchParams.set('note_time', want);
    else u.searchParams.delete('note_time');
    return u.toString();
  }

  function scoreFilterPanel(el) {
    if (!vis(el)) return 0;
    const text = (el.innerText || '').replace(/\s+/g, '');
    const r = el.getBoundingClientRect();
    if (r.height < 36 || r.width < 80) return 0;
    if (r.width > window.innerWidth * 0.98 && r.height > window.innerHeight * 0.92) return 0;

    let score = 0;
    if (/综合/.test(text) && /最新/.test(text)) score += 55;
    if (/发布时间/.test(text)) score += 35;
    if (/一天内|一周内|半年内/.test(text)) score += 30;
    if (/笔记类型|搜索范围/.test(text)) score += 12;
    if (r.top > 48 && r.top < 560) score += 12;
    const area = r.width * r.height;
    if (area < window.innerWidth * window.innerHeight * 0.45) score += 8;
    return score;
  }

  /** 筛选下拉/展开区域（选项常在 filter 按钮上方或同高度，不只下方） */
  function getFilterDropdownBox() {
    const fd = findFilterDiv();
    if (!fd) return null;
    const r = fd.getBoundingClientRect();
    return {
      left: 0,
      right: window.innerWidth,
      top: Math.max(48, r.top - 160),
      bottom: Math.min(window.innerHeight - 16, r.bottom + 480),
    };
  }

  function isInNoteCard(el) {
    if (!el) return false;
    if (el.closest('a[href*="/explore/"], a[href*="/discovery/item/"]')) return true;
    const feed = el.closest('[class*="feeds"], [class*="feed"], [class*="search"]');
    if (feed && el.closest('a[href*="/search_result/"]')) return true;
    const r = el.getBoundingClientRect();
    return r.top > 320 && r.width > 160 && r.height > 140
      && Boolean(el.closest('a[href*="/explore/"]'));
  }

  function norm(el) {
    return (el?.innerText || el?.textContent || '').replace(/\s+/g, '').trim();
  }

  function vis(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 4 && r.height > 4
      && s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function upperProbe() {
    return {
      left: 0,
      right: window.innerWidth,
      top: 48,
      bottom: Math.min(window.innerHeight * 0.72, 720),
    };
  }

  /** 筛选展开后的面板：含「排序依据」「发布时间」 */
  function findOpenFilterPanel() {
    let best = null;
    let bestScore = 0;
    for (const el of document.querySelectorAll('div, section, aside')) {
      if (!vis(el)) continue;
      const text = (el.innerText || '').replace(/\s+/g, '');
      if (!/排序依据/.test(text) || !/发布时间/.test(text)) continue;
      if (!/综合/.test(text) || !/最新/.test(text)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 56 || r.width < 90) continue;
      if (r.width > window.innerWidth * 0.98 && r.height > window.innerHeight * 0.92) continue;
      let score = 60;
      if (/重置/.test(text)) score += 25;
      if (/收起/.test(text)) score += 25;
      if (/一天内|一周内|半年内/.test(text)) score += 20;
      if (r.left > window.innerWidth * 0.2) score += 10;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  /** 小红书搜索页筛选入口 */
  function findFilterDiv() {
    let best = null;
    let bestScore = 0;
    for (const el of document.querySelectorAll(
      'div.filter, div[class*="filter" i], [class*="Filter"], button, [role="button"], span, div',
    )) {
      if (!vis(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.top < 40 || r.top > 520 || r.height > 100 || r.width > 600) continue;
      const t = norm(el);
      const aria = el.getAttribute('aria-label') || '';
      const merged = `${t} ${aria}`;
      const isFilter = el.classList?.contains('filter')
        || /^筛选$/.test(t)
        || /筛选/.test(merged);
      if (!isFilter) continue;
      if (el.closest('a[href*="/explore/"], a[href*="/discovery/item/"]')) continue;
      const area = r.width * r.height;
      if (area > 120000) continue;
      let score = 2000 - r.top + r.left * 0.5;
      if (el.classList?.contains('filter')) score += 8000;
      if (/^筛选$/.test(t)) score += 4000;
      if (r.left > window.innerWidth * 0.5) score += 2000;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function getClickChain(el) {
    const chain = [];
    let n = el?.parentElement;
    for (let i = 0; i < 4 && n; i += 1) {
      if (vis(n)) chain.push(n);
      n = n.parentElement;
    }
    if (el?.querySelectorAll) {
      for (const s of el.querySelectorAll('span, svg, i, img')) {
        if (vis(s)) chain.push(s);
      }
    }
    return chain;
  }

  /** 收集所有可能的「筛选」触发器 */
  function findAllFilterTriggers() {
    const out = [];
    const seen = new Set();

    function add(el, score, via) {
      if (!el || seen.has(el) || !vis(el)) return;
      seen.add(el);
      out.push({ el, score, via });
    }

    const filterDiv = findFilterDiv();
    if (filterDiv) add(filterDiv, 12000, 'filter-div');

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const txt = (walker.currentNode.textContent || '').replace(/\s+/g, '').trim();
      if (txt !== '筛选') continue;
      let el = walker.currentNode.parentElement;
      for (let i = 0; i < 7 && el; i += 1) {
        const r = el.getBoundingClientRect();
        if (r.top >= 40 && r.top <= 520 && vis(el)) {
          const clickable = el.closest('div.filter, [class*="filter" i], button, [role="button"]') || el;
          let score = 6000 + (r.left / Math.max(window.innerWidth, 1)) * 3000 - r.top * 0.5;
          add(clickable, score, 'text-筛选');
          break;
        }
        el = el.parentElement;
      }
    }

    for (const { el, score } of findFilterButtonCandidates()) {
      add(el, score, 'legacy-btn');
    }

    out.sort((a, b) => b.score - a.score);
    return out;
  }

  /** 筛选展开后的面板容器 */
  function findFilterPanelElement() {
    const open = findOpenFilterPanel();
    if (open) return open;

    const anchor = findFilterDiv();
    let best = null;
    let bestScore = 0;

    for (const el of document.querySelectorAll('div, section, aside')) {
      const score = scoreFilterPanel(el);
      if (score < 32) continue;
      let total = score;
      if (anchor) {
        const ar = anchor.getBoundingClientRect();
        const r = el.getBoundingClientRect();
        const near = r.top >= ar.top - 24 && r.top <= ar.bottom + 480;
        if (near) total += 20;
      }
      if (total > bestScore) {
        bestScore = total;
        best = el;
      }
    }
    return best;
  }

  function findCollapse() {
    for (const el of document.querySelectorAll('button, span, div, a, p')) {
      if (!vis(el)) continue;
      const t = norm(el);
      if (t === '收起' || t.startsWith('收起')) return el;
    }
    return null;
  }

  function findExpandedFilterRegion() {
    let best = null;
    let bestArea = 0;
    for (const el of document.querySelectorAll('div, section, aside')) {
      if (!vis(el)) continue;
      const text = el.innerText || '';
      if (!/最新/.test(text)) continue;
      if (!/一天内|一周内|半年内|发布时间|笔记类型|综合|最热/.test(text)) continue;
      const r = el.getBoundingClientRect();
      if (r.height < 70 || r.width < 120) continue;
      if (r.width > window.innerWidth * 0.96 && r.height > window.innerHeight * 0.88) continue;
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        best = { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
      }
    }
    return best;
  }

  function isFilterExpanded() {
    for (const { el } of findFilterButtonCandidates()) {
      let n = el;
      for (let i = 0; i < 5 && n; i += 1) {
        if (n.getAttribute('aria-expanded') === 'true') return true;
        n = n.parentElement;
      }
    }
    return false;
  }

  function panelOpen() {
    if (findOpenFilterPanel()) return true;
    if (findFilterPanelElement()) return true;
    if (findCollapse()) return true;
    if (isFilterExpanded()) return true;
    const region = findExpandedFilterRegion();
    if (region && region.bottom - region.top >= 70) return true;

    const drop = getFilterDropdownBox();
    if (drop) {
      const hasNewest = findCandidates('最新', drop).length > 0;
      const hasTime = ['一天内', '一周内', '半年内'].some((l) => findCandidates(l, drop).length > 0);
      if (hasNewest || hasTime) return true;
    }

    const box = upperProbe();
    const hasNewest = findCandidates('最新', box).length > 0;
    const hasTime = ['一天内', '一周内', '半年内', '发布时间'].some(
      (label) => findCandidates(label, box).length > 0,
    );
    if (hasNewest && hasTime) return true;
    if (findCandidates('发布时间', box).length > 0) return true;
    return false;
  }

  function getPanelDebug() {
    const box = upperProbe();
    return {
      collapse: Boolean(findCollapse()),
      expanded: Boolean(findExpandedFilterRegion()),
      ariaExpanded: isFilterExpanded(),
      newest: findCandidates('最新', box).length,
      day: findCandidates('一天内', box).length,
      week: findCandidates('一周内', box).length,
      publish: findCandidates('发布时间', box).length,
      filterDiv: Boolean(findFilterDiv()),
      filterPanel: Boolean(findFilterPanelElement() || findOpenFilterPanel()),
      openPanel: Boolean(findOpenFilterPanel()),
      triggers: findAllFilterTriggers().length,
      dropdownBox: Boolean(getFilterDropdownBox()),
    };
  }

  function findFilterButtonCandidates() {
    const out = [];
    const seen = new Set();

    function push(el, score) {
      if (!el || seen.has(el) || !vis(el)) return;
      seen.add(el);
      out.push({ el, score });
    }

    const filterDiv = findFilterDiv();
    if (filterDiv) push(filterDiv, 12000);

    for (const el of document.querySelectorAll('button, [role="button"], a, span, div, i, svg')) {
      if (!vis(el)) continue;
      const t = norm(el);
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const merged = `${t} ${aria} ${title}`;
      if (!/(^筛选$|筛选$|\b筛选\b)/.test(merged.replace(/\s+/g, ''))) continue;
      if (el.closest('a[href*="/explore/"], a[href*="/discovery/item/"]')) continue;

      const r = el.getBoundingClientRect();
      if (r.top < 40 || r.top > 520) continue;
      if (r.height > 120) continue;

      const clickEl = el.closest('div.filter, [class*="filter" i], button,[role="button"],a') || el;
      let score = 2000 - r.top + r.left * 0.2;
      if (r.left > window.innerWidth * 0.45) score += 500;
      if (clickEl.classList?.contains('filter')) score += 8000;
      if (clickEl.tagName === 'BUTTON' || clickEl.getAttribute('role') === 'button') score += 300;
      push(clickEl, score);
    }

    out.sort((a, b) => b.score - a.score);
    return out;
  }

  function findFilterButton() {
    return findFilterButtonCandidates()[0]?.el || null;
  }

  function getFilterBoxes() {
    const boxes = [];
    const drop = getFilterDropdownBox();
    if (drop) boxes.push(drop);

    const expanded = findExpandedFilterRegion();
    if (expanded) boxes.push(expanded);

    const panel = findFilterPanelElement();
    if (panel) {
      const r = panel.getBoundingClientRect();
      boxes.push({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });
    }

    const collapse = findCollapse();
    if (collapse) {
      const cr = collapse.getBoundingClientRect();
      boxes.push({
        left: Math.max(0, cr.left - 420),
        right: window.innerWidth,
        top: 48,
        bottom: cr.top + 20,
      });
    }

    boxes.push(upperProbe());
    boxes.push({
      left: window.innerWidth * 0.35,
      right: window.innerWidth,
      top: 56,
      bottom: window.innerHeight - 24,
    });
    return boxes;
  }

  function inBox(rect, box) {
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    return cx >= box.left && cx <= box.right && cy >= box.top && cy <= box.bottom;
  }

  function expectedPublishLabel(days) {
    const d = Number(days) || 7;
    if (d <= 1) return '一天内';
    if (d <= 7) return '一周内';
    if (d <= 183) return '半年内';
    return null;
  }

  function findChipElement(el) {
    let n = el;
    for (let i = 0; i < 6 && n; i += 1) {
      const r = n.getBoundingClientRect();
      if (r.width >= 36 && r.width <= 220 && r.height >= 22 && r.height <= 64) return n;
      n = n.parentElement;
    }
    return el;
  }

  /** 小红书筛选 chip 选中态：红字 + 浅红底 */
  function isFilterChipSelected(el) {
    if (!el) return false;
    let n = el;
    for (let i = 0; i < 8 && n; i += 1) {
      const s = getComputedStyle(n);
      const bg = s.backgroundColor || '';
      const color = s.color || '';
      const border = s.borderColor || '';
      const merged = `${bg} ${color} ${border}`;
      // 选中：文字红 #ff2442 或背景浅红 rgba(255,36,66,0.08~0.15)
      if (/255,\s*3[0-9],\s*6[0-9]/.test(color) && !/128,\s*128,\s*128/.test(color)) return true;
      if (/255,\s*3[0-9],\s*6[0-9]/.test(merged) && /0\.0[5-9]|0\.1[0-5]/.test(bg)) return true;
      if (/255,\s*36,\s*66/.test(merged)) return true;
      const cls = String(n.className || '');
      if (/active|selected|checked|current|on/i.test(cls)) return true;
      if (n.getAttribute('aria-selected') === 'true') return true;
      if (n.getAttribute('aria-pressed') === 'true') return true;
      n = n.parentElement;
    }
    return isRedActive(el);
  }

  function findFilterSections() {
    const panel = findOpenFilterPanel() || findFilterPanelElement();
    if (!panel) return { panel: null, sort: null, time: null };

    const sections = { sort: null, time: null };
    const markers = [
      { key: 'sort', labels: ['排序依据', '排序'] },
      { key: 'time', labels: ['发布时间', '发布'] },
    ];

    for (const el of panel.querySelectorAll('div, section, p, span')) {
      if (!vis(el)) continue;
      const t = norm(el);
      if (t.length > 12) continue;
      for (const marker of markers) {
        if (sections[marker.key]) continue;
        if (!marker.labels.some((l) => t === l || t.startsWith(l))) continue;
        let container = el.parentElement;
        for (let i = 0; i < 4 && container && container !== panel; i += 1) {
          const text = (container.innerText || '').replace(/\s+/g, '');
          const hasChips = marker.key === 'sort'
            ? /综合/.test(text) && /最新/.test(text)
            : /不限/.test(text) && /一周内/.test(text);
          if (hasChips) {
            sections[marker.key] = container;
            break;
          }
          container = container.parentElement;
        }
      }
    }

    return { panel, ...sections };
  }

  function readFilterSelectionState(days = 7) {
    const { panel, sort: sortSection, time: timeSection } = findFilterSections();
    const root = panel || document.body;

    const sortLabels = ['综合', '最新', '最多点赞', '最多收藏', '最多评论'];
    const timeLabels = ['不限', '一天内', '一周内', '半年内'];

    function pickSelected(labels, sectionRoot) {
      const scope = sectionRoot || root;
      for (const label of labels) {
        for (const el of findCandidatesInRoot(label, scope)) {
          if (isFilterChipSelected(findChipElement(el))) return label;
        }
      }
      return null;
    }

    return {
      sort: pickSelected(sortLabels, sortSection),
      publishTime: pickSelected(timeLabels, timeSection),
      panelFound: Boolean(panel),
      urlMatch: urlFiltersMatch(days),
    };
  }

  function filtersMatchExpected(days, state) {
    const publish = expectedPublishLabel(days);
    if (state?.sort !== '最新') return false;
    if (publish && state?.publishTime !== publish) return false;
    return true;
  }

  async function clickChipInSection(sectionRoot, label, panel) {
    const scope = sectionRoot || panel || findFilterPanelElement();
    if (!scope) return { ok: false, label, error: '筛选面板未找到' };

    const list = findCandidatesInRoot(label, scope);
    if (!list.length) {
      return { ok: false, label, error: `面板内无「${label}」`, debug: getPanelDebug() };
    }

    for (const raw of list.slice(0, 8)) {
      const chip = findChipElement(raw);
      if (isFilterChipSelected(chip)) return { ok: true, label, already: true };

      const targets = [chip, raw, chip.parentElement, raw.parentElement].filter(Boolean);
      for (const target of targets) {
        if (!vis(target) || isInNoteCard(target)) continue;
        realClick(target);
        await delay(550);
        if (isFilterChipSelected(chip) || isFilterChipSelected(target)) {
          return { ok: true, label, clicked: true };
        }
      }
    }

    return { ok: false, label, error: `未能激活「${label}」`, debug: getPanelDebug() };
  }

  async function applyFilterPanelUi(days) {
    const publish = expectedPublishLabel(days);
    const sections = findFilterSections();

    let openRes = await openPanel();
    if (!openRes.ok) return { ok: false, step: 'open', openRes };

    await waitPanelReady(8000);
    await delay(500);

    const sec = findFilterSections();
    const sortRes = await clickChipInSection(sec.sort, '最新', sec.panel);
    await delay(600);

    let timeRes = { ok: true };
    if (publish) {
      timeRes = await clickChipInSection(sec.time, publish, sec.panel);
      if (!timeRes.ok) {
        timeRes = await clickPublishTime(days);
      }
      await delay(600);
    }

    const state = readFilterSelectionState();
    const verified = filtersMatchExpected(days, state);

    if (verified) {
      if (!urlFiltersMatch(days)) {
        try {
          history.replaceState(null, '', buildFiltersUrl(days));
        } catch {
          // ignore
        }
      }
      await delay(1200);
      await closePanel();
      return {
        ok: true,
        via: 'ui',
        state,
        sortRes,
        timeRes,
        openRes,
        sections: Boolean(sections.panel),
      };
    }

    return {
      ok: false,
      step: state.sort !== '最新' ? 'newest' : 'time',
      state,
      sortRes,
      timeRes,
      openRes,
      error: state.sort !== '最新'
        ? '「最新」未选中（仍为综合）'
        : `「${publish}」未选中（仍为${state.publishTime || '不限'}）`,
    };
  }

  function isRedActive(el) {
    let n = el;
    for (let i = 0; i < 8 && n; i += 1) {
      const c = getComputedStyle(n).color || '';
      if (/255,\s*(3[6-9]|4[0-9]|5[0-9])/.test(c)) return true;
      const cls = String(n.className || '');
      if (/active|selected|checked|current|on/i.test(cls)) return true;
      if (n.getAttribute('aria-selected') === 'true') return true;
      if (n.getAttribute('aria-pressed') === 'true') return true;
      n = n.parentElement;
    }
    return false;
  }

  function findCandidatesInRoot(label, root) {
    const seen = new Set();
    const out = [];

    function push(el) {
      if (!el || seen.has(el) || !vis(el)) return;
      if (el.closest('a[href*="/explore/"], a[href*="/discovery/item/"]')) return;
      const r = el.getBoundingClientRect();
      if (r.width > 480 || r.height > 110) return;
      const t = norm(el);
      if (t !== label) return;
      seen.add(el);
      out.push({ el, area: r.width * r.height, top: r.top });
    }

    if (root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const txt = (walker.currentNode.textContent || '').replace(/\s+/g, '').trim();
        if (txt !== label) continue;
        let el = walker.currentNode.parentElement;
        for (let i = 0; i < 5 && el && root.contains(el); i += 1) {
          if (norm(el) === label) {
            push(el);
            break;
          }
          el = el.parentElement;
        }
      }
      for (const el of root.querySelectorAll('span, div, button, li, label, p, [role="button"]')) {
        push(el);
      }
    }

    out.sort((a, b) => a.area - b.area || a.top - b.top);
    return out.map((x) => x.el);
  }

  function findCandidates(label, box) {
    const seen = new Set();
    const out = [];

    function scoreEl(el, r) {
      let score = 1000 - r.width * r.height * 0.02;
      if (r.top > 72 && r.top < 560) score += 300;
      const fd = findFilterDiv();
      if (fd) {
        const fr = fd.getBoundingClientRect();
        if (r.top >= fr.top - 180 && r.top <= fr.bottom + 420) score += 250;
      }
      if (isRedActive(el)) score += 80;
      return score;
    }

    function push(el) {
      if (!el || seen.has(el) || !vis(el) || isInNoteCard(el)) return;
      const r = el.getBoundingClientRect();
      if (box && !inBox(r, box)) return;
      if (r.width > 520 || r.height > 110) return;
      const t = norm(el);
      if (t !== label) return;
      seen.add(el);
      out.push({ el, score: scoreEl(el, r), top: r.top });
    }

    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const txt = (walker.currentNode.textContent || '').replace(/\s+/g, '').trim();
      if (txt !== label) continue;
      let el = walker.currentNode.parentElement;
      for (let i = 0; i < 8 && el; i += 1) {
        if (norm(el) === label) {
          push(el);
          break;
        }
        el = el.parentElement;
      }
    }

    for (const el of document.querySelectorAll('button, span, div, a, li, label, p, [role="button"]')) {
      if (norm(el) === label) push(el);
    }

    out.sort((a, b) => b.score - a.score || a.top - b.top);
    return out.map((x) => x.el);
  }

  function realClick(el) {
    if (!el || !vis(el)) return false;
    try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch { /* ignore */ }
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width * 0.5, r.width - 2);
    const y = r.top + Math.min(r.height * 0.5, r.height - 2);
    const base = {
      bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: 1,
    };

    const targets = [el];
    const atPoint = document.elementFromPoint(x, y);
    if (atPoint && !targets.includes(atPoint)) targets.push(atPoint);

    for (const target of targets) {
      if (!target) continue;
      try {
        if (target.focus) target.focus({ preventScroll: true });
        target.dispatchEvent(new PointerEvent('pointerdown', { ...base, pointerId: 1, pointerType: 'mouse' }));
        target.dispatchEvent(new MouseEvent('mousedown', base));
        target.dispatchEvent(new PointerEvent('pointerup', { ...base, pointerId: 1, pointerType: 'mouse' }));
        target.dispatchEvent(new MouseEvent('mouseup', base));
        target.dispatchEvent(new MouseEvent('click', { ...base, detail: 1 }));
        target.click();
      } catch {
        try { target.click(); } catch { /* ignore */ }
      }
    }
    return true;
  }

  async function clickTopBarNewest() {
    const box = { left: 0, right: window.innerWidth, top: 40, bottom: 240 };
    const list = findCandidates('最新', box);
    if (!list.length) return { ok: false, via: 'topbar', reason: '未找到顶栏最新' };

    for (const el of list.slice(0, 8)) {
      if (isRedActive(el)) return { ok: true, already: true, via: 'topbar' };
      realClick(el);
      await delay(400);
      if (isRedActive(el)) return { ok: true, clicked: true, via: 'topbar' };
    }
    return { ok: false, via: 'topbar', reason: '顶栏最新未能激活' };
  }

  async function clickFilterEntry() {
    const triggers = findAllFilterTriggers();
    if (!triggers.length) return { ok: false, error: '未找到筛选入口', debug: getPanelDebug() };

    for (const { el, via } of triggers.slice(0, 5)) {
      for (const target of [el, ...getClickChain(el)]) {
        realClick(target);
      }
      await delay(900);
      if (panelOpen()) return { ok: true, via, target: el.tagName };
    }
    return { ok: false, error: '筛选入口点击后无下拉', debug: getPanelDebug() };
  }

  async function openPanel() {
    if (panelOpen()) return { ok: true, already: true };

    window.scrollTo({ top: 0, behavior: 'auto' });
    await delay(350);

    const triggers = findAllFilterTriggers();
    if (!triggers.length) {
      return { ok: false, error: '未找到筛选按钮', debug: getPanelDebug() };
    }

    for (let round = 0; round < 8; round += 1) {
      for (const { el, via } of triggers.slice(0, 6)) {
        for (const target of [el, ...getClickChain(el)]) {
          realClick(target);
        }
        await delay(450 + round * 80);
        if (await waitPanelReady(2200)) {
          return { ok: true, clicked: true, tries: round + 1, via };
        }
      }

      // 坐标兜底：筛选在搜索结果 tab 行右侧
      const yList = [100, 120, 140, 160, 180, 200];
      const xList = [0.94, 0.9, 0.86, 0.82];
      for (const y of yList) {
        for (const xr of xList) {
          const x = Math.floor(window.innerWidth * xr);
          const at = document.elementFromPoint(x, y);
          if (!at) continue;
          const hit = at.closest('div.filter, [class*="filter" i], button, [role="button"], span, div') || at;
          const ht = norm(hit);
          if (!/筛选/.test(ht) && !hit.classList?.contains?.('filter')) continue;
          realClick(hit);
          await delay(700);
          if (await waitPanelReady(2000)) {
            return { ok: true, clicked: true, via: 'coords', tries: round + 1 };
          }
        }
      }
    }

    return { ok: false, error: '点击筛选后未能展开面板', debug: getPanelDebug() };
  }

  async function closePanel() {
    const c = findCollapse();
    if (c) {
      realClick(c);
      await delay(350);
      return { ok: true, via: 'collapse' };
    }
    if (panelOpen()) {
      const btn = findFilterButton();
      if (btn) {
        realClick(btn);
        await delay(300);
        return { ok: true, via: 'toggle' };
      }
    }
    return { ok: false };
  }

  async function waitPanelReady(maxMs = 10000) {
    const end = Date.now() + maxMs;
    while (Date.now() < end) {
      if (panelOpen()) return true;
      await delay(200);
    }
    return panelOpen();
  }

  async function clickLabel(label) {
    const boxes = getFilterBoxes();
    const lists = [];
    const seenLists = new Set();

    for (const box of boxes) {
      const list = findCandidates(label, box);
      const key = list.map((el) => el).join('|');
      if (list.length && !seenLists.has(key)) {
        seenLists.add(key);
        lists.push(list);
      }
    }

    for (const list of lists) {
      for (const el of list.slice(0, 12)) {
        if (isRedActive(el)) return { ok: true, label, already: true };
        realClick(el);
        await delay(400);
        if (isRedActive(el)) return { ok: true, label, clicked: true };
        const p = el.parentElement;
        if (p && vis(p) && !isInNoteCard(p)) {
          realClick(p);
          await delay(300);
          if (isRedActive(el) || isRedActive(p)) {
            return { ok: true, label, clicked: true, via: 'parent' };
          }
        }
      }
    }
    return { ok: false, label, error: `未找到「${label}」`, debug: getPanelDebug() };
  }

  async function clickPublishTime(days) {
    const labels = publishLabelCandidates(days);
    const panel = findFilterPanelElement();

    if (panel) {
      try {
        panel.scrollTop = 0;
        await delay(200);
        panel.scrollTop = panel.scrollHeight;
        await delay(300);
      } catch {
        // ignore
      }
    }

    for (const label of labels) {
      let res = await clickLabel(label);
      if (res.ok) return { ...res, usedLabel: label };
      await delay(280);
      res = await clickLabel(label);
      if (res.ok) return { ...res, usedLabel: label };
    }

    return {
      ok: false,
      error: `未找到时间选项（已尝试：${labels.join('、')}）`,
      tried: labels,
      debug: getPanelDebug(),
    };
  }

  function readFeedFreshness(maxAgeDays) {
    const days = Number(maxAgeDays) || 7;
    const maxMs = days * 24 * 60 * 60 * 1000;
    const graceMs = Math.min(24 * 60 * 60 * 1000, maxMs * 0.15);
    let withTime = 0;
    let tooOld = 0;

    try {
      const bridgeEl = document.getElementById('__xhs_lead_feed_bridge__');
      if (bridgeEl?.textContent) {
        const bridge = JSON.parse(bridgeEl.textContent);
        const notes = Object.values(bridge?.byNoteId || {}).slice(0, 12);
        for (const note of notes) {
          const ts = Date.parse(note.publishAt || '');
          if (!Number.isFinite(ts)) continue;
          withTime += 1;
          if (Date.now() - ts > maxMs + graceMs) tooOld += 1;
        }
      }
    } catch {
      // ignore
    }

    if (withTime >= 2) {
      return { withTime, tooOld, fresh: (tooOld / withTime) <= 0.34 };
    }
    return { withTime, tooOld, fresh: null };
  }

  function showLeadStatus(message, durationMs = 12000) {
    if (!message) return;
    const eventName = window.__XHS_LEAD_STATUS_EVENT__ || 'xhs-lead-status-show';
    document.dispatchEvent(new CustomEvent(eventName, {
      detail: { message, durationMs },
    }));
    // 主世界兜底：复用已有节点，绝不新建第二条
    const id = '__xhs_lead_status_banner__';
    document.querySelectorAll(`#${id}`).forEach((el, index) => {
      if (index > 0) el.remove();
    });
    const banner = document.getElementById(id);
    if (banner) {
      banner.textContent = message;
      banner.style.display = 'block';
      clearTimeout(showLeadStatus._t);
      showLeadStatus._t = setTimeout(() => { banner.style.display = 'none'; }, durationMs);
    }
  }

  /** 清除 URL 上的 sort / note_time，避免与插件天数过滤冲突 */
  function stripPlatformFilterParams() {
    try {
      const u = new URL(location.href);
      let changed = false;
      if (u.searchParams.has('sort')) {
        u.searchParams.delete('sort');
        changed = true;
      }
      if (u.searchParams.has('note_time')) {
        u.searchParams.delete('note_time');
        changed = true;
      }
      if (changed) {
        history.replaceState(null, '', u.toString());
      }
      return changed;
    } catch {
      return false;
    }
  }

  async function applyFilters(maxAgeDays = 7) {
    const days = Number(maxAgeDays) || 7;

    window.scrollTo({ top: 0, behavior: 'auto' });
    await delay(300);
    stripPlatformFilterParams();

    showLeadStatus(`线索助手：不点小红书筛选，将按近 ${days} 天过滤`, 8000);
    return {
      ok: true,
      via: 'plugin_only',
      maxAgeDays: days,
      message: `插件按近 ${days} 天过滤（未使用小红书「最新+一周内」）`,
      version: VERSION,
    };
  }

  async function handleAction(detail) {
    const { action, label, maxAgeDays } = detail || {};
    if (action === 'ping') {
      const box = upperProbe();
      let noteTimeParam = null;
      try { noteTimeParam = new URL(location.href).searchParams.get('note_time'); } catch { /* ignore */ }
      const state = readFilterSelectionState();
      return {
        ok: true,
        loaded: true,
        version: VERSION,
        panelOpen: panelOpen(),
        filterState: state,
        filterMatch: filtersMatchExpected(maxAgeDays || 7, state),
        hasCollapse: Boolean(findCollapse()),
        hasExpanded: Boolean(findExpandedFilterRegion()),
        ariaExpanded: isFilterExpanded(),
        newestVisible: findCandidates('最新', box).length,
        dayVisible: findCandidates('一天内', box).length,
        weekVisible: findCandidates('一周内', box).length,
        filterButtons: findFilterButtonCandidates().length,
        urlFilters: urlFiltersMatch(7),
        noteTimeParam,
        debug: getPanelDebug(),
      };
    }
    if (action === 'open') return openPanel();
    if (action === 'close') return closePanel();
    if (action === 'click') return clickLabel(label);
    if (action === 'apply') return applyFilters(maxAgeDays);
    return { ok: false, error: `unknown action: ${action}` };
  }

  function reply(requestId, action, result) {
    const payload = { action, requestId, result };
    document.documentElement.setAttribute(RES_ATTR, JSON.stringify(payload));
    document.dispatchEvent(new CustomEvent('xhs-lead-filter-result', { detail: payload }));
  }

  async function processDomCommand() {
    const root = document.documentElement;
    const raw = root.getAttribute(CMD_ATTR);
    if (!raw) return;
    root.removeAttribute(CMD_ATTR);
    let cmd;
    try {
      cmd = JSON.parse(raw);
    } catch (err) {
      reply('parse_err', 'apply', { ok: false, error: String(err) });
      return;
    }
    let result;
    try {
      result = await handleAction(cmd);
    } catch (err) {
      result = { ok: false, error: String(err) };
    }
    reply(cmd.requestId, cmd.action, result);
  }

  function publishApis() {
    window.__XHS_APPLY_FILTER__ = applyFilters;
    window.__XHS_FILTER_PING__ = () => handleAction({ action: 'ping' });
    window.__XHS_READ_FILTER_STATE__ = (days = 7) => {
      const state = readFilterSelectionState(days);
      return {
        state,
        expected: { sort: '最新', publishTime: expectedPublishLabel(days) },
        match: filtersMatchExpected(days, state),
        urlMatch: urlFiltersMatch(days),
      };
    };
    window.__XHS_FILTER_VERSION__ = VERSION;
    try {
      document.documentElement.setAttribute('data-xhs-filter-ready', VERSION);
    } catch {
      // ignore
    }
  }

  if (!window.__XHS_FILTER_MAIN_LISTENERS__) {
    window.__XHS_FILTER_MAIN_LISTENERS__ = true;

    document.addEventListener('xhs-lead-filter-action', async (ev) => {
      const cmd = ev.detail || {};
      let result;
      try {
        result = await handleAction(cmd);
      } catch (err) {
        result = { ok: false, error: String(err) };
      }
      reply(cmd.requestId, cmd.action, result);
    });

    setInterval(() => {
      processDomCommand().catch(() => {});
    }, 80);
  }

  publishApis();
  window.__XHS_FILTER_MAIN__ = true;
})();
