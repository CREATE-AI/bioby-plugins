import { statusLabel } from "./status";

const FIT_FIELD = "influencerFitAutoInternalReview";
const ORDER_FIELD = "regenicOrderInternalReview";

/** 把两条 AI 内审变更写成可读的结果、评分、请求和返回。不输出邮箱、令牌、用户 id。 */
export function formatReviewChange(change: {
  fieldName?: string;
  newValue?: string;
}): string | undefined {
  const field = change.fieldName?.trim() ?? "";
  if (field !== FIT_FIELD && field !== ORDER_FIELD) {
    return undefined;
  }
  const root = asObject(parseJson(change.newValue));
  if (!root) {
    return field === FIT_FIELD
      ? "AI 自动内审\n这条内审记录无法解析。"
      : "AI 内审\n这条内审记录无法解析。";
  }
  if (field === ORDER_FIELD) {
    return formatOrderReview(root);
  }
  return formatFitReview(root);
}

function formatOrderReview(root: Record<string, unknown>): string {
  const lines = ["AI 内审"];
  const result = decisionLabel(textOf(root.reviewResult) || textOf(root.decision));
  if (result) {
    lines.push(`结果：${result}`);
  }
  const previous = textOf(root.previousStatus);
  if (previous) {
    lines.push(`之前状态：${statusLabel(previous)}`);
  }
  const comment = clip(textOf(root.reviewComment), 500);
  if (comment) {
    lines.push(`说明：${comment}`);
  }
  if (lines.length === 1) {
    lines.push("这次记录里没有结果。");
  }
  return lines.join("\n");
}

function formatFitReview(root: Record<string, unknown>): string {
  const user = asObject(parseJson(root.userMessage));
  const agent = asObject(parseJson(root.agentResponse));
  const evaluation = firstObject(agent?.evaluations);
  const lines = ["AI 自动内审"];
  const result = decisionLabel(
    textOf(root.decision) || textOf(agent?.decision) || textOf(evaluation?.decision),
  );
  if (result) {
    lines.push(`结果：${result}`);
  }
  const score = showNumber(evaluation?.overallScore);
  if (score) {
    lines.push(`评分：${score}`);
  }
  const confidence = showNumber(agent?.confidence);
  if (confidence) {
    lines.push(`置信度：${confidence}`);
  }
  const comment = clip(textOf(root.reviewComment), 500);
  const summary = clip(textOf(agent?.summary) || textOf(evaluation?.summary), 400);
  if (comment) {
    lines.push(`说明：${comment}`);
  }
  if (summary && summary !== comment) {
    lines.push(`结论：${summary}`);
  }
  const recommendation = clip(
    textOf(agent?.recommendation) || textOf(evaluation?.recommendation),
    300,
  );
  if (recommendation) {
    lines.push(`建议：${recommendation}`);
  }
  const request = requestLines(user);
  if (request.length > 0) {
    lines.push("", "请求", ...request);
  }
  const dimensions = dimensionLines(evaluation?.dimensionScores);
  if (dimensions.length > 0) {
    lines.push("", "返回", ...dimensions);
  }
  return lines.join("\n");
}

function requestLines(user: Record<string, unknown> | undefined): string[] {
  if (!user) {
    return [];
  }
  const lines: string[] = [];
  const requirement = clip(textOf(user.clientRequirement), 400);
  if (requirement) {
    lines.push(`项目需求：${requirement}`);
  }
  const info = asObject(user.influencerInfo);
  if (!info) {
    return lines;
  }
  pushFact(lines, "平台", info.platform);
  pushFact(lines, "昵称", info.nickname);
  pushFact(lines, "地区", info.region);
  pushFact(lines, "粉丝", info.follower);
  pushFact(lines, "关注", info.followingCount);
  pushFact(lines, "均播", info.aveView);
  pushFact(lines, "互动率", info.engagementRate);
  pushFact(lines, "CPM", info.cpm);
  const quote = textOf(info.externalQuote);
  const currency = textOf(info.currency);
  if (quote) {
    lines.push(`报价：${currency ? `${quote} ${currency}` : quote}`);
  }
  pushFact(lines, "合作形式", info.cooperationMethod);
  pushFact(lines, "视频", info.inputUrl);
  pushFact(lines, "主页", info.profileUrl);
  return lines;
}

function dimensionLines(value: unknown): string[] {
  const scores = asObject(value);
  if (!scores) {
    return [];
  }
  const lines: string[] = [];
  for (const [name, raw] of Object.entries(scores)) {
    const analysis = clip(dimensionAnalysis(raw), 160);
    if (!analysis) {
      continue;
    }
    lines.push(`${dimensionLabel(name)}：${analysis}`);
  }
  return lines;
}

function dimensionAnalysis(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return textOf(value);
  }
  const row = asObject(value);
  if (!row) {
    return "";
  }
  return textOf(row.analysis) || textOf(row.summary) || showNumber(row.score);
}

function dimensionLabel(name: string): string {
  const mapped: Record<string, string> = {
    price: "价格",
    category: "类目",
    performance: "表现",
    audience: "受众",
    vidIQ: "vidIQ",
    cooperationMethod: "合作形式",
  };
  return mapped[name] ?? name;
}

function pushFact(lines: string[], label: string, value: unknown): void {
  const text = textOf(value);
  if (text) {
    lines.push(`${label}：${text}`);
  }
}

function decisionLabel(value: string): string {
  const mapped: Record<string, string> = {
    APPROVED: "通过",
    REJECTED: "不通过",
    PASS: "通过",
    FAIL: "不通过",
    HOLD: "暂缓",
    PENDING: "待处理",
  };
  if (!value) {
    return "";
  }
  return mapped[value.toUpperCase()] ?? value;
}

function firstObject(value: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return asObject(value[0]);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const text = value.trim();
  if (!text.startsWith("{") && !text.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return showNumber(value);
  }
  return "";
}

function showNumber(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "";
  }
  if (Number.isInteger(value)) {
    return String(value);
  }
  return String(Math.round(value * 100) / 100);
}

function clip(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) {
    return "";
  }
  if (text.length <= max) {
    return text;
  }
  return `${text.slice(0, max)}…`;
}
