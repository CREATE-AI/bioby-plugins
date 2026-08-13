export const STORAGE_KEYS = {
  CONFIG: 'xhs_lead_config',
  LEADS: 'xhs_lead_leads',
  RUN_STATE: 'xhs_lead_run_state',
};

/**
 * 日产词库：一次跑完整套，目标凑满「已收藏」条数（默认 15）
 * 覆盖：求合作 / 找达人 / 美区投放 / 品牌出海 等意图
 */
export const DAILY_KEYWORD_MATRIX = [
  // 明确求合作
  '求美区达人',
  '求海外红人',
  '求海外达人合作',
  '求TikTok达人',
  '求北美达人',
  '找海外红人合作',
  '找美区达人合作',
  '找TikTok达人合作',
  '找Instagram达人',
  '找YouTube达人',
  // 找资源
  '找海外红人',
  '找美区达人',
  '找海外KOL',
  '找TikTok达人',
  '出海找达人',
  '出海找红人',
  '跨境找达人',
  '品牌找海外达人',
  '品牌方找达人',
  '需要海外达人',
  // 投放 / 推广
  '美区推广',
  '北美投放',
  '海外投放',
  'TikTok投放',
  '美区投放',
  '出海投放',
  '品牌出海推广',
  '海外网红推广',
  'TikTok网红营销',
  '海外KOL合作',
  // 合作表述
  '海外达人合作',
  '美区达人合作',
  'TikTok达人合作',
  '北美红人合作',
  '出海达人合作',
  '跨境电商达人合作',
  '寻求海外推广',
  '寻求美区达人',
  '招募海外达人',
  '招募TikTok达人',
  // 补充长尾
  '有预算找达人',
  '美区influencer',
  '海外influencer合作',
  '找agency做海外',
  '找服务商出海推广',
];

/**
 * 额外排除词默认预设（命中标题/正文则不进 AI）
 * 侧重：服务商自推、教程干货、求职培训等噪音
 */
export const DEFAULT_EXCLUDE_KEYWORDS = [
  '就找我们',
  '找我们合作',
  '承接品牌',
  '欢迎品牌方',
  '品牌方看过来',
  '专业出海',
  '专注出海',
  '代运营',
  '陪跑',
  '训练营',
  '变现课',
  '免费领',
  '资料领取',
  '求职',
  '招聘',
  '兼职',
  '四种渠道',
  '去哪找',
  '别再只会',
  '一文看懂',
  '全攻略',
  '干货分享',
  '代理招商',
  '加盟火热',
  '接单教学',
  '网红营销就找',
  '出海营销就找',
];

export const DEFAULT_CONFIG = {
  /** 升级标记：首次加载日产模式会覆盖旧短词库 */
  dailyCapacityMode: true,
  keywords: DAILY_KEYWORD_MATRIX,
  excludeKeywords: DEFAULT_EXCLUDE_KEYWORDS,
  minLeadScore: 58,
  maxScrollRounds: 15,
  scrollDelayMinMs: 2000,
  scrollDelayMaxMs: 4000,
  pauseEveryRounds: 3,
  pauseDurationMinMs: 4000,
  pauseDurationMaxMs: 8000,
  keywordDelayMinMs: 3500,
  keywordDelayMaxMs: 7000,
  useAiFilter: true,
  aiApiKey: '',
  aiApiBaseUrl: 'https://api.deepseek.com/v1',
  aiModel: 'deepseek-v4-flash',
  aiMinConfidence: 0.45,
  aiSoftConfidence: 0.35,
  aiBatchSize: 6,
  aiPrefilterMode: 'safe',
  aiKeepHardExclude: false,
  maxCandidatesPerKeyword: 100,
  maxAgeDays: 7,
  sortByTime: false,
  /** 本轮目标：筛出可触达的「符合」条数（主路径不再依赖收藏） */
  targetCollectedCount: 15,
  /** 兼容旧字段 */
  targetLeadCount: 15,
  minLeadsPerKeyword: 2,
  /** 自动收藏默认关闭（易触发扫码风控）；主路径改为开主页私信 */
  autoCollect: false,
  collectDelayMinMs: 2800,
  collectDelayMaxMs: 5000,
  /** 预筛后限速打开笔记补正文，提升需求 vs 广告判断（默认开但限量） */
  enrichNoteDetail: true,
  detailEnrichLimit: 25,
  detailDelayMinMs: 2500,
  detailDelayMaxMs: 5000,
};
