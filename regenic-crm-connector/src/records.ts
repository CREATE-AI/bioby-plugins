import { channelRecord, type IngestRecord } from "@regenic/domain";
import type { CrmOpsTask, CrmOrder } from "./crm-client";
import {
  CRM_SOURCE,
  orderExternalId,
  orderThreadId,
  opsTaskExternalId,
  opsTaskThreadId,
} from "./locators";
import { withOperation } from "./reconcile";

export function opsTaskRecord(
  task: CrmOpsTask,
  operation: "create" | "revise" | "tombstone",
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
  operation: "create" | "revise" | "tombstone",
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
  lines.push(task.reviewGuide.suggestedNext ?? "根据上下文选择继续自动化或关闭任务。");
  if (task.project) {
    lines.push("", "## 关联订单");
    if (task.project.projectFieldId) {
      lines.push(`- locator: ${orderThreadId(task.project.projectFieldId)}`);
    }
    pushField(lines, "项目", task.project.name);
    pushField(lines, "达人", task.project.talentName);
    pushField(lines, "报价", task.project.quote);
    if (task.project.clientRequirement) {
      lines.push("", "### 客户需求", "", task.project.clientRequirement);
    }
  }
  if (task.mail) {
    lines.push("", "## 关联邮件");
    if (task.mail.messageId) {
      lines.push(`- locator: crm:mail:${task.mail.messageId}`);
    }
    pushField(lines, "主题", task.mail.subject);
    if (task.mail.latestInboundSummary) {
      lines.push("", "### 最近来信", "", task.mail.latestInboundSummary);
    }
    if (task.mail.proposedReply) {
      lines.push("", "### 建议回邮底稿", "", task.mail.proposedReply);
    }
  }
  return lines.join("\n");
}

export function formatOrderBody(order: CrmOrder): string {
  const lines = [
    "# 订单 AI 内审待人工",
    "",
    `- locator: ${orderThreadId(order.id)}`,
    `- projectFieldId: ${order.id}`,
    `- internalReviewStatus: ${order.internalReviewStatus}`,
  ];
  if (order.relatedOpsTaskId) {
    lines.push(`- relatedOpsTask: ${opsTaskThreadId(order.relatedOpsTaskId)}`);
  }
  pushField(lines, "项目", order.projectName);
  pushField(lines, "达人", order.talentName);
  pushField(lines, "报价", order.quote);
  if (order.clientRequirement) {
    lines.push("", "## 客户需求", "", order.clientRequirement);
  }
  lines.push(
    "",
    "## 写回",
    "只改本订单内审（APPROVED / REJECTED）。不得 complete 关联运营任务。",
  );
  return lines.join("\n");
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
