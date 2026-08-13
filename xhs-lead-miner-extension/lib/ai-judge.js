/**
 * OpenAI 兼容 Chat Completions：批量判断是否为品牌出海推广线索
 */
const SYSTEM_PROMPT = `你是网红营销公司的线索审核员。
我们做海外网红/达人营销，要找「客户」：国内品牌方/商家在小红书发帖，寻求海外推广、找达人/KOL、找 agency。

判定 isLead = true：
- 品牌/商家在求资源：求美区达人、找海外红人、有预算做投放、找服务商
- 需求方视角（我们缺资源）；正文里出现预算、品牌名、产品出海等更可信

判定 isLead = false（务必拦住）：
- 教程干货：「四种渠道」「去哪找」「别再只会搜」
- 求职培训卖课、代理招商
- 【重要】服务商/机构自推广告，例如：
  「#出海网红营销就找XXX」「出海投放找我们」「红人营销就找XX」
  「承接品牌出海」「欢迎品牌方私我」「专注出海代运营」
  这类是同行供给方招客，不是你的客户线索
- 【重要】标题像需求、但正文是接单广告/机构介绍/案例展示 → 仍判 false

请综合 title 与 desc（正文）判断，不要只看标题。
只输出 JSON，不要 markdown。`;

function normalizeBaseUrl(baseUrl) {
  const trimmed = (baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  if (trimmed.endsWith('/v1')) return trimmed;
  return `${trimmed}/v1`;
}

function extractJson(text) {
  const raw = (text || '').trim();
  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('AI 返回不是合法 JSON');
  }
}

function mapJudgedResults(items, rows, minConfidence) {
  const byId = new Map();
  for (const row of rows) {
    if (!row?.id) continue;
    const confidence = Number(row.confidence);
    const conf = Number.isFinite(confidence) ? confidence : (row.isLead ? 0.7 : 0.3);
    const rawIsLead = Boolean(row.isLead);
    byId.set(String(row.id), {
      rawIsLead,
      isLead: rawIsLead && conf >= minConfidence,
      confidence: conf,
      reason: row.reason || '',
    });
  }

  return items.map((item) => {
    const judged = byId.get(String(item.noteId));
    if (!judged) {
      return {
        noteId: item.noteId,
        rawIsLead: false,
        isLead: false,
        confidence: 0,
        reason: 'AI 未返回该条结果',
      };
    }
    return {
      noteId: item.noteId,
      rawIsLead: judged.rawIsLead,
      isLead: judged.isLead,
      confidence: judged.confidence,
      reason: judged.reason,
    };
  });
}

async function postChatCompletions({
  apiKey,
  apiBaseUrl,
  model,
  messages,
  useJsonFormat,
  timeoutMs,
}) {
  const base = normalizeBaseUrl(apiBaseUrl);
  const url = `${base}/chat/completions`;
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);

  const body = {
    model: model || 'gpt-4o-mini',
    temperature: 0.1,
    messages,
  };
  if (useJsonFormat) {
    body.response_format = { type: 'json_object' };
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    return response;
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`AI 请求超时（${Math.round(timeoutMs / 1000)}s）`);
    }
    throw error;
  } finally {
    clearTimeout(abortTimer);
  }
}

export async function judgeLeadsWithAi({
  items,
  keyword,
  apiKey,
  apiBaseUrl,
  model,
  minConfidence = 0.65,
  timeoutMs = 45000,
}) {
  if (!apiKey) {
    throw new Error('未配置 API Key');
  }
  if (!items?.length) {
    return { results: [], usage: null };
  }

  const payloadItems = items.map((item) => ({
    id: item.noteId,
    title: item.title || '',
    desc: (item.desc || '').slice(0, 600),
    authorName: item.authorName || '',
    keyword: keyword || item.matchedKeyword || '',
  }));

  const userPrompt = `当前搜索关键词：${keyword || ''}

请判断下列笔记是否为「国内品牌方寻找海外推广/达人资源」的有效客户线索。
综合 title 与 desc（正文）；若 desc 暴露为服务商广告则 isLead=false。
返回 JSON：
{"results":[{"id":"笔记id","isLead":true或false,"confidence":0到1的小数,"reason":"一句话中文原因"}]}

笔记列表：
${JSON.stringify(payloadItems, null, 2)}`;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  let response = await postChatCompletions({
    apiKey,
    apiBaseUrl,
    model,
    messages,
    useJsonFormat: true,
    timeoutMs,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    if (response.status === 400 && /response_format|json_object/i.test(errText)) {
      response = await postChatCompletions({
        apiKey,
        apiBaseUrl,
        model,
        messages,
        useJsonFormat: false,
        timeoutMs,
      });
      if (!response.ok) {
        const err2 = await response.text().catch(() => '');
        throw new Error(`AI 请求失败 ${response.status}: ${err2.slice(0, 300)}`);
      }
    } else {
      throw new Error(`AI 请求失败 ${response.status}: ${errText.slice(0, 300)}`);
    }
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  const parsed = extractJson(content);
  const rows = Array.isArray(parsed.results) ? parsed.results : [];

  return {
    results: mapJudgedResults(items, rows, minConfidence),
    usage: data.usage || null,
  };
}

export async function testAiConnection({ apiKey, apiBaseUrl, model }) {
  const response = await postChatCompletions({
    apiKey,
    apiBaseUrl,
    model,
    messages: [{ role: 'user', content: '回复OK两个字母即可' }],
    useJsonFormat: false,
    timeoutMs: 20000,
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error(`${response.status}: ${errText.slice(0, 200)}`);
  }
  return { ok: true };
}

export function chunkArray(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) {
    chunks.push(list.slice(i, i + size));
  }
  return chunks;
}
