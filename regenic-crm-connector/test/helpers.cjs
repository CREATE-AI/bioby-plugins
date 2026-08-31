function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return body === undefined ? "" : JSON.stringify(body);
    },
  };
}

function createFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    const key = `${(init.method ?? "GET").toUpperCase()} ${parsed.pathname}`;
    calls.push({
      key,
      url,
      method: (init.method ?? "GET").toUpperCase(),
      pathname: parsed.pathname,
      headers: init.headers ?? {},
      body: init.body,
    });
    const handler = routes[key];
    if (!handler) {
      return jsonResponse(404, { error: `unhandled ${key}` });
    }
    return typeof handler === "function" ? handler({ url, init, parsed }) : handler;
  };
  fetch.calls = calls;
  return fetch;
}

function sampleOpsTask(overrides = {}) {
  return {
    id: "task-1",
    status: "PENDING_REVIEW",
    taskType: "EMAIL_SUBMIT_AUTOMATION",
    nextAction: "NEED_MANUAL_REVIEW",
    updatedAt: "2026-08-26T00:00:00.000Z",
    reportingOperationsUserId: "ops-9",
    reviewGuide: {
      headline: "报价不确定，不敢自动回邮",
      rationale: "达人改了档期。",
      suggestedNext: "确认后继续回邮并提报",
      allowedActions: ["SEND_AND_CLOSE", "SUBMIT_THEN_CLOSE", "LEAVE_PENDING", "CLOSE_ONLY"],
    },
    project: {
      projectFieldId: "pf-1",
      name: "夏季投放",
      talentName: "小红",
      quote: "8000",
      clientRequirement: "要竖屏带货",
      quoteLifecycleStatus: "NONE",
    },
    mail: {
      messageId: "m-1",
      subject: "档期确认",
      latestInboundSummary: "达人问能否改期。",
      threadDigest: "--- folder=SENT\nplease quote\n--- [ANCHOR] folder=INBOX\n能否改期",
      proposedReply: "可以，我们改到下周。",
      hasQuotes: false,
      attachmentCount: 0,
      quoteLifecycleStatus: "NONE",
      quoteGuideOutboundCount: 1,
    },
    ...overrides,
  };
}

function sampleOrder(overrides = {}) {
  return {
    id: "pf-1",
    internalReviewStatus: "PENDING_HUMAN",
    updatedAt: "2026-08-26T00:00:00.000Z",
    reportingOperationsUserId: "ops-9",
    projectName: "夏季投放",
    talentName: "小红",
    clientRequirement: "要竖屏带货",
    quote: "8000",
    relatedOpsTaskId: "task-1",
    aiReview: {
      decision: "PENDING",
      confidence: "0.71",
      summary: "报价和内容都需要人工看一下",
      invocationId: "inv-1",
      dimensionAnalyses: ["粉丝量够", "内容风格偏弱"],
    },
    talent: {
      nickname: "小红",
      platform: "tiktok",
      profileUrl: "https://www.tiktok.com/@xiaohong",
      email: "red@example.com",
      follower: "12000",
      region: "US",
      avgView: "800",
      engagementRate: "0.042",
      cpm: "18",
      quote: "8000",
      cooperationMethod: "带货",
    },
    autoReviewLog: {
      operation: "INFLUENCER_FIT_AUTO_INTERNAL_REVIEW",
      decision: "PENDING",
      userMessage: '{"clientRequirement":"要竖屏带货","influencerInfo":{"nickname":"小红"}}',
      agentResponse: '{"decision":"PENDING","summary":"需要人工确认"}',
    },
    ...overrides,
  };
}

function surfaceOf(record) {
  const part = (record.content ?? []).find(
    (item) => item.role === "metadata" && item.media_type === "application/vnd.regenic.surface+json",
  );
  return part ? JSON.parse(part.text) : {};
}

module.exports = {
  jsonResponse,
  createFetch,
  sampleOpsTask,
  sampleOrder,
  surfaceOf,
};
