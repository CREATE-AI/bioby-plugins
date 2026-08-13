/**
 * 与 content/lead-filter.js 保持同一套规则（供 popup / 测试复用）
 */
export const MARKET_WORDS = [
  '美区', '北美', '美国', '美国本土', '海外', '出海', '跨境', '欧美', '英文市场',
];

export const RESOURCE_WORDS = [
  '红人', 'kol', '达人', '博主', 'influencer', 'creator',
  'tiktok', 'instagram', 'youtube', 'shorts',
  'agency', 'mcn', '服务商', '代投',
];

export const INTENT_WORDS = [
  '求', '找', '需要', '招募', '寻', '对接', '合作', '预算', '报价', '邀约',
  '有没有', '推荐', '介绍', '联系', '私聊', '私信',
];

export const BRAND_WORDS = [
  '品牌', '商家', '店铺', '公司', '市场部', '出海品牌', '独立站', '亚马逊', 'shopify',
];

export const HARD_EXCLUDE_WORDS = [
  '教程', '教学', '经验分享', '复盘', '案例拆解', '入门', '学习', '怎么做',
  '运营笔记', '副业', '资料领取', '避坑', '盘点', '趋势', '新闻', '科普',
  '干货分享', '干货', '方法论', '全攻略', '攻略', '指南', '手把手', '亲测', '实测', '笔记分享',
  '求职', '招聘', '兼职', '培训', '课程', '代运营教学', '免费领', '接单教学',
  '陪跑', '训练营', '变现课', '割韭菜', '代理招商', '加盟',
  '去哪找', '怎么找', '如何找', '怎样找', '别再', '别只会', '只会搜', '不会搜',
  '教你', '告诉你', '一文看懂', '合集', '清单', '汇总', '渠道汇总',
  '种渠道', '种方法', '种方式', '种途径', '个渠道', '个方法',
  '误区', '揭秘', '真相', '收藏', '建议收藏',
];

/** 方法论/清单体标题模式 */
export const CONTENT_FRAME_PATTERNS = [
  /\d+\s*种(渠道|方法|方式|途径|技巧|策略)/,
  /(几|多|数)\s*种(渠道|方法|方式|途径)/,
  /去哪(里)?找/,
  /别再.{0,12}(搜|找|只会)/,
  /(怎么|如何|怎样)(找|搜|选).{0,8}(红人|达人|kol|influencer)?/,
  /找.{0,12}的(四|五|六|七|八|九|十|\d+)\s*种/,
  /(红人|达人|kol).{0,8}(去哪|渠道|方法|攻略|指南)/,
  /(渠道|方法|方式).{0,6}(汇总|盘点|合集|清单)/,
];

/** 高确信度内容号标题（误杀风险低） */
export const SAFE_SPAM_PATTERNS = [
  /\d+\s*种(渠道|方法|方式|途径|技巧|策略)/,
  /(几|多|数)\s*种(渠道|方法|方式|途径)/,
  /去哪(里)?找/,
  /别再.{0,12}(搜|找|只会)/,
  /找.{0,12}的(四|五|六|七|八|九|十|\d+)\s*种/,
  /(渠道|方法|方式).{0,6}(汇总|盘点|合集|清单)/,
  /(怎么|如何|怎样)(找|搜).{0,6}(红人|达人|kol)/,
  /(一文看懂|手把手|全攻略|干货分享)/,
];

/** 服务商自推广告，例：「#出海网红营销就找xxx」 */
export const SUPPLY_AD_PATTERNS = [
  /(网红|红人|达人|出海|跨境|海外|美区).{0,8}(营销|投放|代投|推广).{0,12}就找/,
  /(网红营销|红人营销|达人营销|出海营销|跨境营销|出海投放).{0,12}(就找|找我|找我们)/,
  /就找[\w\u4e00-\u9fff]{1,16}(机构|公司|团队|工作室|mcn|agency|传媒)/,
  /(就找我们|找我们合作|找我们做|找我司|认准我们|私我们|加我们详聊)/,
  /(专业|专注|深耕).{0,10}(出海|跨境|网红|红人|达人).{0,10}(服务商|agency|代运营|工作室)/,
  /(十年|多年).{0,6}(出海|红人|达人).{0,8}(经验|服务)/,
  /(欢迎品牌方|品牌方看过来|承接品牌|承接出海|承接投放)/,
];

export const CERTAIN_NOISE_WORDS = [
  '求职', '招聘', '兼职', '培训班', '训练营', '变现课', '代运营教学',
  '接单教学', '陪跑', '免费领资料', '资料领取', '割韭菜', '代理招商', '加盟火热',
  '就找我们', '找我们合作', '承接品牌', '欢迎品牌方',
];

export const PURCHASE_RESCUE_WORDS = [
  '有预算', '我们品牌', '我司品牌', '本公司', '品牌方求', '品牌方找',
  '寻求合作', '求合作', '找服务商', '找agency', '找 mcn', '找mcn',
  '需要达人', '招募达人', '求推荐达人', '求美区', '诚招达人', '招标',
  '求对接', '有预算找', '预算大概',
];

function normalize(text) {
  return (text || '').toLowerCase().replace(/\s+/g, ' ');
}

function hitWords(text, words) {
  const normalized = normalize(text);
  return words.filter((word) => normalized.includes(word.toLowerCase()));
}

function hitContentFrame(text) {
  const normalized = normalize(text);
  for (const pattern of CONTENT_FRAME_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function hitSafeSpam(text) {
  const normalized = normalize(text);
  for (const pattern of SAFE_SPAM_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function hitSupplyAd(text) {
  const normalized = normalize(text).replace(/#/g, '');
  for (const pattern of SUPPLY_AD_PATTERNS) {
    const match = normalized.match(pattern);
    if (match) return match[0];
  }
  return null;
}

export function hasPurchaseRescue(text) {
  if (hitSupplyAd(text)) return false;
  return hitWords(text, PURCHASE_RESCUE_WORDS).length > 0;
}

function hasDomainRelevance(text, keyword) {
  const bag = [
    ...MARKET_WORDS,
    ...RESOURCE_WORDS,
    ...INTENT_WORDS,
    ...BRAND_WORDS,
    '推广', '投放', '营销', '合作', '出海', '跨境',
  ];
  if (hitWords(text, bag).length > 0) return true;
  const kw = normalize(keyword);
  if (kw.length >= 2 && normalize(text).includes(kw)) return true;
  return false;
}

function smartPrefilter(text, keyword, extraExclude = []) {
  const trimmed = (text || '').trim();
  if (trimmed.length < 4) {
    return { drop: true, reason: '标题过短/空' };
  }
  const supply = hitSupplyAd(trimmed);
  if (supply) {
    return { drop: true, reason: `服务商自推广告：${supply}` };
  }
  if (hasPurchaseRescue(trimmed)) {
    return { drop: false, rescued: true };
  }
  const noise = hitWords(trimmed, [...CERTAIN_NOISE_WORDS, ...extraExclude]);
  if (noise.length) {
    return { drop: true, reason: `明确噪音：${noise.slice(0, 2).join('、')}` };
  }
  const spam = hitSafeSpam(trimmed);
  if (spam) {
    return { drop: true, reason: `内容号标题：${spam}` };
  }
  if (!hasDomainRelevance(trimmed, keyword)) {
    return { drop: true, reason: '与出海/达人主题无关' };
  }
  return { drop: false };
}

function passesHardExclude(text, extraExclude = []) {
  const hits = hitWords(text, [...HARD_EXCLUDE_WORDS, ...extraExclude]);
  if (hits.length) {
    return { ok: false, reason: `命中排除词：${hits.slice(0, 3).join('、')}` };
  }
  const frame = hitContentFrame(text);
  if (frame) {
    return { ok: false, reason: `命中内容号标题模式：${frame}` };
  }
  return { ok: true };
}

/** AI 预筛：smart / off / safe / strict；各模式都会挡服务商自推 */
export function shouldDropBeforeAi(text, extraExclude = [], mode = 'smart', keyword = '') {
  if (!mode || mode === 'off') {
    const supply = hitSupplyAd(text);
    if (supply) return { drop: true, reason: `服务商自推广告：${supply}` };
    return { drop: false };
  }
  if (mode === 'smart') {
    return smartPrefilter(text, keyword, extraExclude);
  }
  const supply = hitSupplyAd(text);
  if (supply) {
    return { drop: true, reason: `服务商自推广告：${supply}` };
  }
  if (hasPurchaseRescue(text)) {
    return { drop: false, rescued: true };
  }
  if (mode === 'safe') {
    const spam = hitSafeSpam(text);
    if (spam) return { drop: true, reason: `安全预筛：${spam}` };
    return { drop: false };
  }
  const hard = passesHardExclude(text, extraExclude);
  if (!hard.ok) return { drop: true, reason: hard.reason };
  return { drop: false };
}

function keywordImpliesMarket(keyword) {
  const kw = normalize(keyword);
  return MARKET_WORDS.some((word) => kw.includes(word.toLowerCase()));
}

function passesMustHave(text, keyword) {
  const market = hitWords(text, MARKET_WORDS);
  const resource = hitWords(text, RESOURCE_WORDS);
  const intent = hitWords(text, INTENT_WORDS);
  const kw = normalize(keyword);
  const textNorm = normalize(text);
  const kwInText = kw.length >= 2 && textNorm.includes(kw);
  const kwMarket = keywordImpliesMarket(keyword);

  if (market.length && resource.length && (intent.length || kwInText)) {
    return { ok: true, path: '地区+资源+需求', signals: { market, resource, intent } };
  }

  if (intent.length && resource.length && (market.length || kwMarket)) {
    return { ok: true, path: '需求+资源+地区语境', signals: { market, resource, intent } };
  }

  if (kwInText && resource.length && (market.length || intent.length || kwMarket)) {
    return { ok: true, path: '搜索词+资源匹配', signals: { market, resource, intent } };
  }

  const brand = hitWords(text, BRAND_WORDS);
  if (brand.length && intent.length && (market.length || resource.length || kwMarket)) {
    return { ok: true, path: '品牌+需求+场景', signals: { market, resource, intent } };
  }

  const categories = [market.length > 0, resource.length > 0, intent.length > 0]
    .filter(Boolean).length;
  return {
    ok: false,
    reason: categories < 2
      ? '未同时满足「地区/出海 + 达人资源 + 合作需求」组合'
      : '缺少明确合作需求信号（求/找/需要/预算等）',
    signals: { market, resource, intent },
  };
}

function scoreLead(text, keyword, signals, authorName) {
  let score = 45;
  const matched = {
    market: signals.market || [],
    resource: signals.resource || [],
    intent: signals.intent || [],
    brand: hitWords(text, BRAND_WORDS),
  };

  score += matched.market.length * 8;
  score += matched.resource.length * 8;
  score += matched.intent.length * 10;
  score += matched.brand.length * 6;

  if (normalize(text).includes(normalize(keyword))) score += 12;
  if (matched.intent.length >= 2) score += 8;

  const authorNoise = hitWords(authorName || '', ['讲师', '教练', '培训', '副业', '代运营', '课程', '陪跑', '导师']);
  if (authorNoise.length) score -= 20;

  score = Math.max(0, Math.min(100, score));

  let tier = 'low';
  if (score >= 75) tier = 'high';
  else if (score >= 60) tier = 'medium';

  return { score, tier, matched };
}

export function evaluateLead({
  text,
  keyword,
  authorName = '',
  excludeKeywords = [],
  minLeadScore = 58,
}) {
  const fullText = `${text} ${authorName}`.trim();

  const hardExclude = passesHardExclude(fullText, excludeKeywords);
  if (!hardExclude.ok) {
    return {
      accepted: false,
      leadScore: 0,
      leadTier: 'rejected',
      filterReason: hardExclude.reason,
      rejectedBy: 'hard_exclude',
      matchedSignals: {},
    };
  }

  const mustHave = passesMustHave(fullText, keyword);
  if (!mustHave.ok) {
    return {
      accepted: false,
      leadScore: 0,
      leadTier: 'rejected',
      filterReason: mustHave.reason,
      rejectedBy: 'must_have',
      matchedSignals: mustHave.signals || {},
    };
  }

  const { score, tier, matched } = scoreLead(fullText, keyword, mustHave.signals, authorName);

  if (score < minLeadScore) {
    return {
      accepted: false,
      leadScore: score,
      leadTier: tier,
      filterReason: `分数 ${score} 低于阈值 ${minLeadScore}`,
      rejectedBy: 'min_score',
      matchedSignals: matched,
      mustHavePath: mustHave.path,
    };
  }

  return {
    accepted: true,
    leadScore: score,
    leadTier: tier,
    filterReason: `通过：${mustHave.path}`,
    rejectedBy: null,
    matchedSignals: matched,
    mustHavePath: mustHave.path,
  };
}
