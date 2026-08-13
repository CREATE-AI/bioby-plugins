export function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function humanDelay(minMs, maxMs) {
  await sleep(randomBetween(minMs, maxMs));
}

/** 分段滚动，模拟真人浏览节奏 */
export async function humanScrollStep() {
  const distance = randomBetween(280, 520);
  const steps = randomBetween(3, 6);
  const stepSize = distance / steps;

  for (let i = 0; i < steps; i += 1) {
    window.scrollBy({ top: stepSize, behavior: 'smooth' });
    await sleep(randomBetween(80, 180));
  }
}

/** 小红书网页搜索时间筛选（英文枚举，中文「一周内」会导致页面报错） */
export function mapMaxAgeToUrlTime(maxAgeDays) {
  const days = Number(maxAgeDays);
  if (!days || days <= 0) return null;
  if (days <= 1) return 'ONE_DAY';
  if (days <= 7) return 'ONE_WEEK';
  if (days <= 183) return 'HALF_YEAR';
  return null;
}

export function buildSearchUrl(keyword, options = {}) {
  const params = new URLSearchParams({
    keyword,
    source: 'web_search_result_notes',
  });
  // 默认不在 URL 叠加 sort/note_time（与页面「最新+一周内」叠加会导致时间不准）
  if (options.xhsPlatformFilter === true) {
    if (options.sortByTime !== false) {
      params.set('sort', 'time_descending');
    }
    const noteTime = mapMaxAgeToUrlTime(options.maxAgeDays);
    if (noteTime) {
      params.set('note_time', noteTime);
    }
  }
  return `https://www.xiaohongshu.com/search_result?${params.toString()}`;
}
