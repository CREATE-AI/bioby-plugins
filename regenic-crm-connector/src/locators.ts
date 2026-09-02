import type { SubjectCatalog } from "@regenic/domain";

export const CRM_SOURCE = "crm";
export const CRM_CHANNEL_LABEL = "CRM";

/** Opaque work-unit ids. Kernel equality-matches only. Convention: `{source}.{native}`. */
export const OPS_UNIT_KIND = "crm.ops_review";
export const ORDER_UNIT_KIND = "crm.order_review";
export const OPS_UNIT_KIND_LABEL = "邮件提报待审";
export const ORDER_UNIT_KIND_LABEL = "订单 AI 内审";

export const OPS_TARGET_PREFIX = "ops_task:";
export const ORDER_TARGET_PREFIX = "order:";

export const OPS_CONNECTOR_TYPE = "crm-ops-review";
export const ORDER_CONNECTOR_TYPE = "crm-order-review";

export const OPS_TASK_RECORD_SUFFIX = "task";
export const ORDER_RECORD_SUFFIX = "task";

export type CrmScope = "scoped" | "all";
export type CrmQueue = "ops" | "order";

export type OpsCompleteAction =
  | "SEND_AND_CLOSE"
  | "SUBMIT_THEN_CLOSE"
  | "LEAVE_PENDING"
  | "CLOSE_ONLY";
export type OrderReviewResult = "APPROVED" | "REJECTED";

export function crmScopeOf(hasToken: boolean): CrmScope {
  return hasToken ? "scoped" : "all";
}

export function opsStreamKey(scope: CrmScope): string {
  return `crm:pending-ops:${scope}`;
}

export function orderStreamKey(scope: CrmScope): string {
  return `crm:pending-review:${scope}`;
}

/** Inbox conversation id after kernel `threadIdOf(source, target)`. */
export function opsTaskThreadId(taskId: string): string {
  return `${CRM_SOURCE}:${opsTaskTarget(taskId)}`;
}

/** Inbox conversation id after kernel `threadIdOf(source, target)`. */
export function orderThreadId(projectFieldId: string): string {
  return `${CRM_SOURCE}:${orderTarget(projectFieldId)}`;
}

export function opsTaskTarget(taskId: string): string {
  return `${OPS_TARGET_PREFIX}${requireId(taskId, "ops task")}`;
}

export function orderTarget(projectFieldId: string): string {
  return `${ORDER_TARGET_PREFIX}${requireId(projectFieldId, "order")}`;
}

/**
 * Kernel conversationId() is `source:` + external_id before the last colon.
 * `ops_task:<id>:task` therefore groups as `crm:ops_task:<id>`.
 * Do not put `crm:ops_task:<id>` on `record.thread.id` — ingest does threadIdOf(source, thread.id)
 * and would store `crm:crm:ops_task:<id>`, which the inbox cannot open.
 */
export function opsTaskExternalId(taskId: string): string {
  return `${opsTaskTarget(taskId)}:${OPS_TASK_RECORD_SUFFIX}`;
}

export function orderExternalId(projectFieldId: string): string {
  return `${orderTarget(projectFieldId)}:${ORDER_RECORD_SUFFIX}`;
}

export function opsPromptId(taskId: string): string {
  return `crm:ops:${requireId(taskId, "ops task")}`;
}

export function orderPromptId(projectFieldId: string): string {
  return `crm:audit:${requireId(projectFieldId, "order")}`;
}

export function parseOpsTaskId(value: string): string | undefined {
  return parsePrefixedId(value, [
    OPS_TARGET_PREFIX,
    `${CRM_SOURCE}:${OPS_TARGET_PREFIX}`,
    "crm:ops:",
  ]);
}

export function parseOrderId(value: string): string | undefined {
  return parsePrefixedId(value, [
    ORDER_TARGET_PREFIX,
    `${CRM_SOURCE}:${ORDER_TARGET_PREFIX}`,
    "crm:audit:",
  ]);
}

export function isOpsTaskTarget(target: string): boolean {
  return target.startsWith(OPS_TARGET_PREFIX);
}

export function isOrderTarget(target: string): boolean {
  return target.startsWith(ORDER_TARGET_PREFIX);
}

export function parseOpsCompleteAction(value: string): OpsCompleteAction | undefined {
  const normalized = value.trim();
  if (normalized === "SEND_AND_CLOSE" || normalized === "发信并关单") {
    return "SEND_AND_CLOSE";
  }
  if (normalized === "SUBMIT_THEN_CLOSE" || normalized === "提报后关单") {
    return "SUBMIT_THEN_CLOSE";
  }
  if (
    normalized === "LEAVE_PENDING" ||
    normalized === "留待真人" ||
    normalized === "PENDING" ||
    normalized === "HOLD"
  ) {
    return "LEAVE_PENDING";
  }
  if (
    normalized === "CLOSE_ONLY" ||
    normalized === "仅关单" ||
    normalized === "CLOSE_TASK" ||
    normalized === "关闭任务"
  ) {
    return "CLOSE_ONLY";
  }
  return undefined;
}

export function parseOrderReviewResult(value: string): OrderReviewResult | undefined {
  const normalized = value.trim();
  if (normalized === "APPROVED" || normalized === "通过") {
    return "APPROVED";
  }
  if (normalized === "REJECTED" || normalized === "不通过") {
    return "REJECTED";
  }
  return undefined;
}

export function crmSubjectCatalog(): SubjectCatalog {
  return {
    kinds: [
      { id: OPS_UNIT_KIND, label: "kind.opsReview" },
      { id: ORDER_UNIT_KIND, label: "kind.orderReview" },
    ],
  };
}

export function writeBackLabels(label: string): string[] {
  const trimmed = label.trim();
  if (trimmed === "REJECTED") {
    return ["REJECTED", "不通过"];
  }
  if (trimmed === "APPROVED") {
    return ["APPROVED", "通过"];
  }
  if (trimmed === "CLOSE_ONLY" || trimmed === "CLOSE_TASK") {
    return ["CLOSE_ONLY", "CLOSE_TASK", "仅关单", "关闭任务"];
  }
  if (trimmed === "LEAVE_PENDING") {
    return ["LEAVE_PENDING", "留待真人", "PENDING", "HOLD"];
  }
  if (trimmed === "SEND_AND_CLOSE") {
    return ["SEND_AND_CLOSE", "发信并关单"];
  }
  if (trimmed === "SUBMIT_THEN_CLOSE") {
    return ["SUBMIT_THEN_CLOSE", "提报后关单"];
  }
  return trimmed ? [trimmed] : [];
}

function parsePrefixedId(value: string, prefixes: string[]): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  for (const prefix of prefixes) {
    if (trimmed.startsWith(prefix)) {
      const id = stripRecordSuffix(trimmed.slice(prefix.length));
      return id || undefined;
    }
  }
  return undefined;
}

function stripRecordSuffix(value: string): string {
  if (value.endsWith(`:${OPS_TASK_RECORD_SUFFIX}`)) {
    return value.slice(0, -(OPS_TASK_RECORD_SUFFIX.length + 1));
  }
  return value;
}

function requireId(value: string, label: string): string {
  const id = value.trim();
  if (!id) {
    throw new Error(`${label} id is required`);
  }
  if (id.includes(":")) {
    throw new Error(`${label} id must not contain a colon`);
  }
  return id;
}
