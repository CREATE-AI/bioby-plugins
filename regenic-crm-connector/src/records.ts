import { channelRecord, type IngestRecord } from "@regenic/domain";
import type { CrmOpsTask, CrmOrder } from "./crm-client";
import {
  CRM_SOURCE,
  ORDER_UNIT_KIND,
  OPS_UNIT_KIND,
  orderExternalId,
  orderThreadId,
  opsTaskExternalId,
  opsTaskThreadId,
} from "./locators";
import { withOperation } from "./reconcile";

export function opsTaskRecord(
  task: CrmOpsTask,
  operation: "create" | "revise",
  revisionId?: string,
): IngestRecord {
  const label = opsConversationLabel(task);
  const record = channelRecord({
    channel: CRM_SOURCE,
    kind: "system",
    direction: "inbound",
    external_id: opsTaskExternalId(task.id),
    occurred_at: occurredAt(task.updatedAt),
    actor_id: CRM_SOURCE,
    actor_label: "CRM",
    scope_id: task.id,
    scope_name: label,
    conversation_kind: "ops_task",
    unit_kind: OPS_UNIT_KIND,
    thread_facet: "ticket",
    type: "task",
    thread_id: opsTaskThreadId(task.id),
    text: formatOpsBody(task),
    media_type: "text/markdown",
    content: [
      {
        role: "metadata",
        media_type: "application/json",
        text: JSON.stringify(opsMetadata(task)),
      },
    ],
  });
  return withOperation(record, operation, revisionId);
}

export function orderRecord(
  order: CrmOrder,
  operation: "create" | "revise",
  revisionId?: string,
): IngestRecord {
  const label = orderConversationLabel(order);
  const record = channelRecord({
    channel: CRM_SOURCE,
    kind: "system",
    direction: "inbound",
    external_id: orderExternalId(order.id),
    occurred_at: occurredAt(order.updatedAt),
    actor_id: CRM_SOURCE,
    actor_label: "CRM",
    scope_id: order.id,
    scope_name: label,
    conversation_kind: "order",
    unit_kind: ORDER_UNIT_KIND,
    thread_facet: "ticket",
    type: "task",
    thread_id: orderThreadId(order.id),
    text: formatOrderBody(order),
    media_type: "text/markdown",
    content: [
      {
        role: "metadata",
        media_type: "application/json",
        text: JSON.stringify(orderMetadata(order)),
      },
    ],
  });
  return withOperation(record, operation, revisionId);
}

export function opsConversationLabel(task: CrmOpsTask): string {
  if (task.conversationLabel?.trim()) {
    return task.conversationLabel.trim();
  }
  const subject = task.project?.name ?? task.project?.talentName ?? task.id;
  return `${subject} · 邮件提报待审`;
}

export function orderConversationLabel(order: CrmOrder): string {
  if (order.conversationLabel?.trim()) {
    return order.conversationLabel.trim();
  }
  const subject = order.projectName ?? order.talentName ?? order.id;
  return `${subject} · AI 内审待人工`;
}

export function formatOpsBody(task: CrmOpsTask): string {
  const lines = [
    "# 邮件提报待审",
    "",
    `- locator: ${opsTaskThreadId(task.id)}`,
    `- status: ${task.status}`,
    `- taskType: ${task.taskType}`,
  ];
  if (task.nextAction) {
    lines.push(`- nextAction: ${task.nextAction}`);
  }
  lines.push(
    `- allowedActions: ${task.reviewGuide.allowedActions.join(" | ")}`,
    "",
    "## 为何待审",
    task.reviewGuide.headline ?? "（无标题）",
  );
  if (task.reviewGuide.rationale) {
    lines.push("", task.reviewGuide.rationale);
  }
  lines.push("", "## 建议下一步");
  lines.push(
    task.reviewGuide.suggestedNext ??
      "根据最近来信和往来摘要选出 scene 键，写在结论第一行。不要打开收件箱，不要二次拉取邮件。",
  );
  if (task.project) {
    lines.push("", "## 关联订单");
    if (task.project.projectFieldId) {
      lines.push(`- locator: ${orderThreadId(task.project.projectFieldId)}`);
    }
    pushField(lines, "项目", task.project.name);
    pushField(lines, "达人", task.project.talentName);
    pushField(lines, "报价", task.project.quote);
    pushField(lines, "报价生命周期", task.project.quoteLifecycleStatus);
    if (task.project.clientRequirement) {
      lines.push("", "### 客户需求", "", task.project.clientRequirement);
    }
  }
  if (task.mail) {
    lines.push("", "## 关联邮件");
    if (task.mail.messageId) {
      lines.push(`- emailInboxId: ${task.mail.messageId}`);
    }
    pushField(lines, "主题", task.mail.subject);
    if (task.mail.hasQuotes !== undefined) {
      lines.push(`- hasQuotes: ${task.mail.hasQuotes}`);
    }
    pushField(lines, "解析报价", task.mail.quotes);
    if (task.mail.attachmentCount !== undefined) {
      lines.push(`- 附件数: ${task.mail.attachmentCount}`);
    }
    pushField(lines, "报价生命周期", task.mail.quoteLifecycleStatus);
    if (task.mail.quoteGuideOutboundCount !== undefined) {
      lines.push(`- 我方已发引导轮次: ${task.mail.quoteGuideOutboundCount}`);
    }
    if (task.mail.latestInboundSummary) {
      lines.push("", "### 最近来信", "", task.mail.latestInboundSummary);
    }
    if (task.mail.threadDigest) {
      lines.push("", "### 往来摘要", "", task.mail.threadDigest);
    }
    if (task.mail.proposedReply) {
      lines.push("", "### 建议回邮底稿（仅参考，发信以 CRM scene 模板为准）", "", task.mail.proposedReply);
    }
  }
  return lines.join("\n");
}

const MAX_LOG_CHARS = 12_000;

export function formatOrderBody(order: CrmOrder): string {
  const talent = order.talent;
  const review = order.aiReview;
  const log = order.autoReviewLog;
  const lines = ["# 订单 AI 内审待人工", ""];
  pushField(lines, "项目", order.projectName);
  pushField(lines, "达人", talent?.nickname ?? order.talentName);
  pushField(lines, "报价", talent?.quote ?? order.quote);
  if (review && hasReviewContent(review)) {
    lines.push("", "## AI 内审结论");
    pushField(lines, "decision", review.decision);
    pushField(lines, "confidence", review.confidence);
    pushField(lines, "invocationId", review.invocationId);
    pushField(lines, "evaluatedAt", review.evaluatedAt);
    if (review.summary) {
      lines.push("", review.summary);
    }
    if (review.dimensionAnalyses?.length) {
      lines.push("", "### 维度分析");
      for (const item of review.dimensionAnalyses) {
        lines.push(`- ${item}`);
      }
    }
  }
  if (order.clientRequirement) {
    lines.push("", "## 项目需求", "", order.clientRequirement);
  }
  if (talent && hasTalentContent(talent)) {
    lines.push("", "## 达人");
    pushField(lines, "昵称", talent.nickname ?? order.talentName);
    pushField(lines, "平台", talent.platform);
    pushField(lines, "主页", talent.profileUrl);
    pushField(lines, "邮箱", talent.email);
    pushField(lines, "粉丝", talent.follower);
    pushField(lines, "地区", talent.region);
    pushField(lines, "均播", talent.avgView);
    pushField(lines, "互动率", talent.engagementRate);
    pushField(lines, "CPM", talent.cpm);
    pushField(lines, "报价", talent.quote ?? order.quote);
    pushField(lines, "对外报价", talent.externalQuote);
    pushField(lines, "合作形式", talent.cooperationMethod);
    pushField(lines, "分类", talent.category);
    pushField(lines, "达人类型", talent.influencerType);
    if (talent.supplementaryNotesContent) {
      lines.push("", "### 补充说明", "", talent.supplementaryNotesContent);
    }
  }
  if (log && hasLogContent(log)) {
    lines.push("", "## 自动内审日志");
    pushField(lines, "operation", log.operation);
    pushField(lines, "decision", log.decision);
    pushField(lines, "invocationId", log.invocationId);
    pushField(lines, "logTime", log.logTime);
    if (log.reviewComment) {
      lines.push("", log.reviewComment);
    }
    pushCode(lines, "userMessage", log.userMessage);
    pushCode(lines, "agentResponse", log.agentResponse);
    if (log.error) {
      pushCode(lines, "error", log.error);
    }
  }
  lines.push(
    "",
    "## 写回",
    "只改本订单内审（APPROVED / REJECTED）。不得 complete 关联运营任务。",
  );
  return lines.join("\n");
}

function hasReviewContent(review: NonNullable<CrmOrder["aiReview"]>): boolean {
  return Boolean(
    review.decision ||
      review.confidence ||
      review.summary ||
      review.invocationId ||
      review.dimensionAnalyses?.length,
  );
}

function hasTalentContent(talent: NonNullable<CrmOrder["talent"]>): boolean {
  return Boolean(
    talent.nickname ||
      talent.platform ||
      talent.profileUrl ||
      talent.email ||
      talent.follower ||
      talent.region ||
      talent.avgView ||
      talent.engagementRate ||
      talent.cpm ||
      talent.quote ||
      talent.externalQuote ||
      talent.cooperationMethod ||
      talent.category ||
      talent.influencerType ||
      talent.supplementaryNotesContent,
  );
}

function hasLogContent(log: NonNullable<CrmOrder["autoReviewLog"]>): boolean {
  return Boolean(
    log.operation ||
      log.userMessage ||
      log.agentResponse ||
      log.decision ||
      log.error,
  );
}

function pushCode(lines: string[], title: string, value: string | undefined): void {
  if (!value) {
    return;
  }
  lines.push("", `### ${title}`, "", "```", clipLog(value), "```");
}

function clipLog(value: string): string {
  if (value.length <= MAX_LOG_CHARS) {
    return value;
  }
  return `${value.slice(0, MAX_LOG_CHARS)}\n…（已截断）`;
}

function opsMetadata(task: CrmOpsTask): Record<string, unknown> {
  return {
    locator: opsTaskThreadId(task.id),
    status: task.status,
    taskType: task.taskType,
    nextAction: task.nextAction,
    allowedActions: task.reviewGuide.allowedActions,
    projectFieldId: task.project?.projectFieldId,
    mailMessageId: task.mail?.messageId,
  };
}

function orderMetadata(order: CrmOrder): Record<string, unknown> {
  return {
    locator: orderThreadId(order.id),
    projectFieldId: order.id,
    internalReviewStatus: order.internalReviewStatus,
    relatedOpsTaskId: order.relatedOpsTaskId,
  };
}

function pushField(lines: string[], label: string, value: string | undefined): void {
  if (value) {
    lines.push(`- ${label}: ${value}`);
  }
}

function occurredAt(value: string): string {
  const parsed = Date.parse(value);
  if (Number.isFinite(parsed)) {
    return new Date(parsed).toISOString();
  }
  return new Date(0).toISOString();
}
