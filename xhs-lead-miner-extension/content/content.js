(function initXhsContentScript() {
  if (window.__XHS_LEAD_CONTENT_INIT__) return;
  window.__XHS_LEAD_CONTENT_INIT__ = true;

  let running = false;
  let stopRequested = false;

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function humanDelay(minMs, maxMs) {
    await sleep(randomBetween(minMs, maxMs));
  }

  async function humanScrollStep() {
    const distance = randomBetween(450, 750);
    const steps = randomBetween(3, 6);
    const stepSize = distance / steps;
    for (let i = 0; i < steps; i += 1) {
      window.scrollBy({ top: stepSize, behavior: 'smooth' });
      await sleep(randomBetween(80, 180));
    }
  }

  function formatSignals(signals) {
    if (!signals || typeof signals !== 'object') return '';
    const parts = [];
    for (const [key, values] of Object.entries(signals)) {
      if (Array.isArray(values) && values.length) {
        parts.push(`${key}:${values.join('/')}`);
      }
    }
    return parts.join('; ');
  }

  function enrichByRules(rawLeads, keyword, config) {
    const {
      excludeKeywords = [],
      minLeadScore = 58,
    } = config;
    const maxAgeDays = Number(config.maxAgeDays);
    const classify = window.__XHS_TIME_PARSE__?.classifyLeadAge
      || window.__XHS_TIME_PARSE__?.classifyAge;
    const crawledAt = new Date().toISOString();
    const evaluate = window.__XHS_LEAD_FILTER__?.evaluateLead;
    if (!evaluate) {
      return { leads: [], stats: { scanned: 0, accepted: 0, rejected: 0 } };
    }

    const accepted = [];
    const stats = { scanned: 0, accepted: 0, rejected: 0, ageRejected: 0, ageUnknownRejected: 0 };

    for (const lead of rawLeads) {
      stats.scanned += 1;

      if (maxAgeDays > 0 && classify) {
        const ageClass = classify === window.__XHS_TIME_PARSE__?.classifyLeadAge
          ? classify(lead, maxAgeDays)
          : (() => {
            const publishDate = lead.publishAt ? new Date(lead.publishAt) : null;
            const okDate = Number.isNaN(publishDate?.getTime?.()) ? null : publishDate;
            return classify(okDate, maxAgeDays);
          })();
        if (ageClass === 'unknown') {
          stats.ageUnknownRejected += 1;
          stats.rejected += 1;
          continue;
        }
        if (ageClass === 'too_old') {
          stats.ageRejected += 1;
          stats.rejected += 1;
          continue;
        }
      }

      const text = `${lead.title} ${lead.desc}`;
      const result = evaluate({
        text,
        keyword,
        authorName: lead.authorName,
        excludeKeywords,
        minLeadScore,
      });

      if (!result.accepted) {
        stats.rejected += 1;
        continue;
      }

      stats.accepted += 1;
      accepted.push({
        ...lead,
        matchedKeyword: keyword,
        leadScore: result.leadScore,
        leadTier: result.leadTier,
        filterReason: result.filterReason,
        mustHavePath: result.mustHavePath || '',
        matchedSignals: formatSignals(result.matchedSignals),
        filterMode: 'rules',
        crawledAt,
      });
    }

    return { leads: accepted, stats };
  }

  function prefilterForAi(rawLeads, keyword, config) {
    let mode = config.aiPrefilterMode;
    if (!mode) {
      mode = config.aiKeepHardExclude === false ? 'off' : 'smart';
    }

    const excludeKeywords = config.excludeKeywords || [];
    const maxAgeDays = Number(config.maxAgeDays);
    const dropFn = window.__XHS_LEAD_FILTER__?.shouldDropBeforeAi;
    const candidates = [];
    const stats = {
      scanned: 0,
      hardRejected: 0,
      rescued: 0,
      ageRejected: 0,
      ageUnknownRejected: 0,
      toAi: 0,
    };

    for (const lead of rawLeads) {
      stats.scanned += 1;
      const text = `${lead.title} ${lead.desc} ${lead.authorName || ''}`;

      if (maxAgeDays > 0) {
        const classifyLead = window.__XHS_TIME_PARSE__?.classifyLeadAge;
        const classify = window.__XHS_TIME_PARSE__?.classifyAge;
        const isWithin = window.__XHS_TIME_PARSE__?.isWithinMaxAgeDays;
        let ageClass = 'ok';
        if (classifyLead) {
          ageClass = classifyLead(lead, maxAgeDays);
        } else {
          const publishDate = lead.publishAt ? new Date(lead.publishAt) : null;
          const okDate = Number.isNaN(publishDate?.getTime?.()) ? null : publishDate;
          ageClass = classify
            ? classify(okDate, maxAgeDays)
            : (isWithin?.(okDate, maxAgeDays) ? 'ok' : (okDate ? 'too_old' : 'unknown'));
        }
        if (ageClass === 'unknown') {
          stats.ageUnknownRejected += 1;
          continue;
        }
        if (ageClass === 'too_old') {
          stats.ageRejected += 1;
          continue;
        }
      }

      if (dropFn) {
        const decision = dropFn(text, excludeKeywords, mode, keyword);
        if (decision.rescued) stats.rescued += 1;
        if (decision.drop) {
          stats.hardRejected += 1;
          continue;
        }
      }

      stats.toAi += 1;
      candidates.push({
        ...lead,
        matchedKeyword: keyword,
      });
    }

    return { candidates, stats };
  }

  function reportProgress(payload) {
    try {
      chrome.runtime.sendMessage({ type: 'CRAWL_PROGRESS', payload });
    } catch {
      // ignore
    }
  }

  async function applySearchFilters(maxAgeDays) {
    const fn = window.__XHS_SEARCH_FILTER__?.ensureSearchFilters;
    if (!fn) {
      return { ok: false, error: '筛选模块未加载', warning: '请重新加载扩展' };
    }
    return fn(maxAgeDays);
  }

  async function runCrawl(config) {
    if (running) {
      return { ok: false, error: '已有采集任务在运行' };
    }

    running = true;
    stopRequested = false;

    const {
      keyword,
      useAiFilter = true,
      maxScrollRounds = 12,
      scrollDelayMinMs = 2000,
      scrollDelayMaxMs = 4000,
      pauseEveryRounds = 3,
      pauseDurationMinMs = 4000,
      pauseDurationMaxMs = 8000,
      maxCandidatesPerKeyword = 80,
      skipNoteIds = [],
      skipSearchFilters = false,
      searchFilters: preSearchFilters = null,
    } = config;

    if (useAiFilter && !config.aiApiKey) {
      running = false;
      return { ok: false, error: '已开启 AI 筛选，请先填写 API Key' };
    }

    // 跨次去重：库里已有的笔记不再送 AI / 不再当新线索
    const knownIds = new Set((skipNoteIds || []).map(String));
    const collected = new Map();
    const seenNoteIds = new Set();
    const pendingAi = new Map();
    let rounds = 0;
    let stagnantRounds = 0;
    let knownSkipped = 0;
    let consecutiveAgeHeavyRounds = 0;
    const filterStats = {
      scanned: 0,
      accepted: 0,
      rejected: 0,
      hardRejected: 0,
      aiJudged: 0,
      rescued: 0,
      ageRejected: 0,
      ageUnknownRejected: 0,
      knownSkipped: 0,
      searchFilters: null,
    };

    const maxAgeDays = Number(config.maxAgeDays);

    try {
      window.scrollTo({ top: 0, behavior: 'auto' });
      await humanDelay(800, 1200);

      if (skipSearchFilters && preSearchFilters) {
        filterStats.searchFilters = preSearchFilters;
        reportProgress({
          keyword,
          phase: preSearchFilters.ok ? 'search_filters_done' : 'search_filters',
          searchFilters: preSearchFilters,
          message: preSearchFilters.via === 'plugin_only'
            ? `插件按近 ${maxAgeDays} 天过滤，开始滚动…`
            : '',
          warning: preSearchFilters.ok ? '' : (preSearchFilters.warning || preSearchFilters.error || ''),
        });
        const waitMs = preSearchFilters.via === 'url' || preSearchFilters.via === 'url_only' ? 3500 : 1200;
        await humanDelay(waitMs, waitMs + 800);
      } else {
        const filterResult = await applySearchFilters(maxAgeDays);
        filterStats.searchFilters = filterResult;
        reportProgress({
          keyword,
          phase: 'search_filters',
          searchFilters: filterResult,
          warning: filterResult.ok ? '' : (filterResult.warning || filterResult.error || ''),
        });
      }
      await humanDelay(800, 1200);

      await window.__XHS_SEARCH_FILTER__?.closeNoteModalIfOpen?.();

      while (rounds < maxScrollRounds && !stopRequested) {
        const raw = window.__XHS_LEAD_EXTRACTOR__?.extractNotesFromDom?.() || [];
        const beforeSeen = seenNoteIds.size;

        // 只处理本轮新出现的卡片，避免重复预筛拖慢
        const fresh = [];
        for (const item of raw) {
          if (!item.noteId || seenNoteIds.has(item.noteId)) continue;
          seenNoteIds.add(item.noteId);
          if (knownIds.has(String(item.noteId))) {
            knownSkipped += 1;
            filterStats.knownSkipped = knownSkipped;
            continue;
          }
          fresh.push(item);
        }

        if (useAiFilter) {
          const { candidates, stats } = prefilterForAi(fresh, keyword, config);
          filterStats.scanned += stats.scanned;
          filterStats.hardRejected += stats.hardRejected;
          filterStats.rescued += stats.rescued || 0;
          filterStats.ageRejected = (filterStats.ageRejected || 0) + (stats.ageRejected || 0);
          filterStats.ageUnknownRejected = (filterStats.ageUnknownRejected || 0)
            + (stats.ageUnknownRejected || 0);

          // 最新序下越滚越旧：本轮新卡几乎全被年龄闸掉则累计，连续多轮早停
          const ageDrop = (stats.ageRejected || 0) + (stats.ageUnknownRejected || 0);
          if (fresh.length >= 3 && ageDrop >= Math.ceil(fresh.length * 0.8) && candidates.length === 0) {
            consecutiveAgeHeavyRounds += 1;
          } else if (fresh.length > 0) {
            consecutiveAgeHeavyRounds = 0;
          }

          for (const item of candidates) {
            if (pendingAi.size >= maxCandidatesPerKeyword) break;
            if (!pendingAi.has(item.noteId)) {
              pendingAi.set(item.noteId, item);
            }
          }
        } else {
          const { leads, stats } = enrichByRules(fresh, keyword, config);
          filterStats.scanned += stats.scanned;
          filterStats.accepted += stats.accepted;
          filterStats.rejected += stats.rejected;
          for (const lead of leads) {
            collected.set(lead.noteId, lead);
          }
        }

        const afterSeen = seenNoteIds.size;
        stagnantRounds = afterSeen === beforeSeen ? stagnantRounds + 1 : 0;

        reportProgress({
          keyword,
          round: rounds + 1,
          phase: 'scrolling',
          message: '正在滚动采集…',
          totalCollected: useAiFilter ? pendingAi.size : collected.size,
          cardsSeen: seenNoteIds.size,
          pendingAi: pendingAi.size,
          filterMode: useAiFilter ? 'ai' : 'rules',
          filterStats: { ...filterStats },
        });

        if (useAiFilter && pendingAi.size >= maxCandidatesPerKeyword) {
          break;
        }

        if (consecutiveAgeHeavyRounds >= 1) {
          break;
        }

        if (stagnantRounds >= 4) break;

        rounds += 1;
        if (rounds >= maxScrollRounds || stopRequested) break;

        await humanScrollStep();
        await humanDelay(scrollDelayMinMs, scrollDelayMaxMs);

        if (rounds % pauseEveryRounds === 0) {
          await humanDelay(pauseDurationMinMs, pauseDurationMaxMs);
        }
      }

      const sf = filterStats.searchFilters;
      const filterWarning = sf?.ok === false && sf?.via !== 'plugin_only'
        ? (sf.warning || sf.error || '')
        : '';

      if (useAiFilter) {
        // AI 放到 background 做，避免内容脚本↔后台互相等待卡死
        return {
          ok: true,
          keyword,
          rounds,
          filterStats,
          filterWarning,
          needsAi: true,
          candidates: Array.from(pendingAi.values()),
          leads: [],
        };
      }

      return {
        ok: true,
        keyword,
        rounds,
        filterStats,
        filterWarning,
        needsAi: false,
        leads: Array.from(collected.values()),
      };
    } finally {
      running = false;
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'START_CRAWL') {
      runCrawl(message.payload)
        .then((result) => sendResponse(result))
        .catch((error) => sendResponse({ ok: false, error: String(error) }));
      return true;
    }

    if (message.type === 'STOP_CRAWL') {
      stopRequested = true;
      sendResponse({ ok: true });
      return false;
    }

    if (message.type === 'PING') {
      sendResponse({ ok: true, page: location.href });
      return false;
    }

    return false;
  });
})();
