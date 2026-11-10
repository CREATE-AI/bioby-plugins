import type { IngestRecord } from "@regenic/domain";
import {
  PROJECT_ORDER_LIMIT,
  PROJECT_SOURCE,
  PROJECT_UNIT_KIND,
  threadId as orderThreadId,
} from "./locators";
import type { ProjectInfoDoc, ProjectLogDoc, ProjectOrderRow, ProjectStore } from "./model";
import { stepRecord, type StepDraft } from "./records";
import { isOpenStatus, statusLabel } from "./status";
import { compactTime, shortHash, stepToken, withOffsets } from "./time";

export interface ProjectCursor {
  v: 1;
  stage: "logs" | "orders" | "live";
  fp: Record<string, string>;
  infoFp?: string;
  status?: string;
  logAfter: string | null;
  /** 还在交付中、已经写进项目会话的订单。 */
  orders: string[];
  orderSkip: number;
  ended?: boolean;
  seq?: number;
}

export function emptyProjectCursor(): ProjectCursor {
  return { v: 1, stage: "logs", fp: {}, logAfter: null, orders: [], orderSkip: 0 };
}

export function parseProjectCursor(raw: string | null | undefined): ProjectCursor {
  if (!raw) {
    return emptyProjectCursor();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ProjectCursor>;
    if (parsed.v !== 1 || !parsed.fp || typeof parsed.fp !== "object") {
      return emptyProjectCursor();
    }
    return {
      ...emptyProjectCursor(),
      ...parsed,
      v: 1,
      fp: parsed.fp,
      orders: Array.isArray(parsed.orders) ? parsed.orders.filter((id) => typeof id === "string") : [],
      orderSkip: typeof parsed.orderSkip === "number" ? parsed.orderSkip : 0,
    };
  } catch {
    return emptyProjectCursor();
  }
}

export async function advanceProject(input: {
  projectId: string;
  project: ProjectInfoDoc | null;
  store: ProjectStore;
  cursor: ProjectCursor;
  pageSize: number;
  now: string;
}): Promise<{ records: IngestRecord[]; cursor: ProjectCursor; hasMore: boolean; wroteEnd: boolean }> {
  const cursor = input.cursor;
  cursor.seq = (cursor.seq ?? 0) + 1;
  if (!input.project || input.project.isDeleted) {
    return finishProject(input.projectId, input.project, cursor, input.now);
  }
  const project = input.project;
  const label = projectLabel(project);
  const records: IngestRecord[] = [];
  emit(project.id, label, cursor, records, infoSteps(project, cursor, input.now));

  if (cursor.stage === "logs") {
    const more = await pullLogs(input, cursor, label, records, input.pageSize);
    if (more) {
      return { records, cursor, hasMore: true, wroteEnd: false };
    }
    cursor.stage = "orders";
    cursor.orderSkip = 0;
  }

  if (cursor.stage === "orders") {
    const open = await input.store.listProjectOrders(project.id, PROJECT_ORDER_LIMIT);
    const budget = Math.max(1, input.pageSize - records.length);
    const slice = open.slice(cursor.orderSkip, cursor.orderSkip + budget);
    cursor.orderSkip += slice.length;
    track(cursor, slice);
    emit(project.id, label, cursor, records, slice.map((row) => orderStep(row, project)));
    if (cursor.orderSkip < open.length) {
      return { records, cursor, hasMore: true, wroteEnd: false };
    }
    cursor.stage = "live";
    cursor.orderSkip = 0;
    return { records, cursor, hasMore: false, wroteEnd: false };
  }

  const logsMore = await pullLogs(input, cursor, label, records, input.pageSize);
  await syncOrders(input.store, project, cursor, label, records);
  return { records, cursor, hasMore: logsMore, wroteEnd: false };
}

async function pullLogs(
  input: Parameters<typeof advanceProject>[0],
  cursor: ProjectCursor,
  label: string,
  records: IngestRecord[],
  budget: number,
): Promise<boolean> {
  const page = await input.store.listProjectLogs(input.projectId, cursor.logAfter, Math.max(1, budget));
  const orderIds = page.items.map((log) => stringOf(log.metadata.projectFieldId)).filter(Boolean);
  const nicknames = new Map<string, string>();
  if (orderIds.length > 0) {
    for (const row of await input.store.readOrderRows(orderIds)) {
      if (row.nickname) {
        nicknames.set(row.id, row.nickname);
      }
    }
  }
  emit(input.projectId, label, cursor, records, page.items.map((log) => logStep(log, nicknames)));
  const last = page.items[page.items.length - 1];
  if (last) {
    cursor.logAfter = last.id;
  }
  return page.full;
}

async function syncOrders(
  store: ProjectStore,
  project: ProjectInfoDoc,
  cursor: ProjectCursor,
  label: string,
  records: IngestRecord[],
): Promise<void> {
  const open = await store.listProjectOrders(project.id, PROJECT_ORDER_LIMIT);
  const openIds = new Set(open.map((row) => row.id));
  const left = cursor.orders.filter((id) => !openIds.has(id));
  const steps = open.map((row) => orderStep(row, project));
  if (left.length > 0) {
    const rows = new Map((await store.readOrderRows(left)).map((row) => [row.id, row]));
    for (const id of left) {
      steps.push(orderStep(rows.get(id) ?? { id, isDeleted: true }, project));
    }
  }
  cursor.orders = cursor.orders.filter((id) => openIds.has(id));
  track(cursor, open);
  emit(project.id, label, cursor, records, steps);
}

function track(cursor: ProjectCursor, rows: ProjectOrderRow[]): void {
  for (const row of rows) {
    if (!cursor.orders.includes(row.id)) {
      cursor.orders.push(row.id);
    }
  }
}

function finishProject(
  projectId: string,
  project: ProjectInfoDoc | null,
  cursor: ProjectCursor,
  now: string,
): { records: IngestRecord[]; cursor: ProjectCursor; hasMore: boolean; wroteEnd: boolean } {
  if (cursor.ended) {
    return { records: [], cursor, hasMore: false, wroteEnd: true };
  }
  const at = project?.updatedTime || now;
  const records = emit(
    projectId,
    project ? projectLabel(project) : projectId,
    cursor,
    [],
    [{
      suffix: `end-deleted-${compactTime(at)}`,
      at,
      kind: "end",
      actor: "assistant",
      speaker: "项目",
      text: project ? "项目已删除，这个会话不再更新。" : "项目已经不在库里，按删除处理，这个会话不再更新。",
    }],
  );
  cursor.ended = true;
  cursor.stage = "live";
  return { records, cursor, hasMore: false, wroteEnd: true };
}

function infoSteps(project: ProjectInfoDoc, cursor: ProjectCursor, now: string): StepDraft[] {
  const steps: StepDraft[] = [];
  const text = projectInfoText(project);
  const fp = shortHash(text);
  const created = project.createdTime || project.updatedTime || now;
  if (!cursor.infoFp) {
    steps.push({ suffix: "context", at: created, kind: "context", actor: "assistant", speaker: "项目", text });
  } else if (cursor.infoFp !== fp) {
    const at = project.updatedTime || now;
    steps.push({
      suffix: `context-${compactTime(at)}`,
      at,
      kind: "context",
      actor: "assistant",
      speaker: "项目",
      text: `项目信息有更新\n${text}`,
    });
  }
  cursor.infoFp = fp;
  const status = project.status || "IN_PROGRESS";
  if (cursor.status !== status) {
    const at = cursor.status ? (project.updatedTime || now) : (project.updatedTime || created);
    steps.push({
      suffix: `status-${compactTime(at)}-${stepToken(status)}`,
      at,
      kind: "status",
      actor: "assistant",
      speaker: "状态",
      text: cursor.status
        ? `项目状态：${projectStatusLabel(cursor.status)} → ${projectStatusLabel(status)}`
        : `项目状态：${projectStatusLabel(status)}`,
    });
    cursor.status = status;
  }
  return steps;
}

export function projectInfoText(project: ProjectInfoDoc): string {
  const lines: string[] = [];
  const add = (name: string, value: string | undefined | null) => {
    const text = value?.trim();
    if (text) {
      lines.push(`${name}：${text}`);
    }
  };
  add("项目", project.name);
  add("项目 ID", project.id);
  add("项目等级", levelLabel(project.level));
  add("平台", joined(project.platforms));
  add("目标国家", joined(project.targetCountries));
  add("目标语言", joined(project.targetLanguages));
  if (project.totalBudget != null) {
    add("总预算", `${project.totalBudget}${project.currency ? ` ${project.currency}` : ""}`);
  }
  add("报价方式", project.quoteMethod);
  add("对接群", [project.contactGroupApp, project.contactGroupName].filter((item) => item?.trim()).join(" · "));
  add("商务", project.businessManager);
  add("运营", project.operationsManager);
  add("PM", project.pmManager);
  add("开始时间", dateOnly(project.startTime));
  add("结束时间", dateOnly(project.endTime));
  add("截止日期", dateOnly(project.deadline));
  add("活动", joined(project.campaignNames));
  add("产品链接", project.productUrl);
  add("brief", project.briefText);
  add("brief 链接", project.briefUrl);
  add("产品信息", project.brandProjectInfo);
  add("英文品牌和产品名", project.brandProjectInfoEnglish);
  add("需求", project.demands);
  add("项目权益", project.benefits);
  const split = Boolean(project.quoteMethod || project.contactGroupApp || project.contactGroupName || project.descriptionExtra);
  add(split ? "其他说明" : "项目描述", split ? project.descriptionExtra : project.description);
  lines.push("这个项目里每张还在交付的订单，在本会话里各占一条，写着它的订单会话。");
  return lines.join("\n");
}

function orderStep(row: ProjectOrderRow, project: ProjectInfoDoc): StepDraft {
  const at = row.selectedTime || row.createdTime || project.createdTime || new Date(0).toISOString();
  return {
    suffix: `order-${stepToken(row.id)}`,
    at,
    kind: "order",
    actor: "assistant",
    speaker: "订单",
    text: orderLine(row),
  };
}

export function orderLine(row: ProjectOrderRow): string {
  const lines: string[] = [];
  if (row.nickname) {
    lines.push(`达人：${row.nickname}`);
  }
  if (row.platform) {
    lines.push(`平台：${row.platform}`);
  }
  if (row.bloggerLink) {
    lines.push(`链接：${row.bloggerLink}`);
  }
  if (row.isDeleted) {
    lines.push("交付状态：订单已删除");
  } else if (isOpenStatus(row.status)) {
    lines.push(`交付状态：${statusLabel(row.status)}`);
  } else {
    lines.push(`交付状态：${statusLabel(row.status)}（已不在交付中）`);
  }
  if (row.externalQuote != null) {
    lines.push(`对外报价：${row.externalQuote}`);
  }
  lines.push(`订单 ID：${row.id}`);
  lines.push(`订单会话：${orderThreadId(row.id)}`);
  return lines.join("\n");
}

const LOG_TYPES: Record<string, string> = {
  PROJECT_CREATED: "项目创建",
  MATCHING_LAUNCHED: "开始匹配达人",
  CAMPAIGN_CREATED: "新建活动",
  CAMPAIGN_SEARCH_STARTED: "开始搜索达人",
  FILTER_TASK_STARTED: "开始筛选达人",
  LEAD_MATCH_REVIEWED: "客户看了匹配的达人",
  LEAD_SUBMIT_REVIEW: "达人提交给客户审核",
  ONE_CLICK_SUBMIT: "一键提报",
  PROJECT_RESUBMIT: "重新提报",
  ORDER_CUSTOMER_REVIEW_SUBMIT: "客户审核提报的达人",
  ORDER_CUSTOMER_REVIEW_DELIVERY: "客户审核交付内容",
  PROJECT_DELETED: "项目删除",
};

const ACTORS: Record<string, string> = {
  USER: "用户",
  BRAND: "品牌",
  SYSTEM: "系统",
};

const REVIEW_RESULTS: Record<string, string> = {
  APPROVED: "通过",
  REJECTED: "驳回",
  HOLD: "暂缓",
};

const REVIEW_TYPES: Record<string, string> = {
  IDEA: "想法",
  SCRIPT: "脚本",
  VIDEO: "视频草稿",
  DRAFT: "草稿",
};

function logStep(log: ProjectLogDoc, nicknames: Map<string, string>): StepDraft {
  const type = log.operationType ?? "";
  const meta = log.metadata;
  const lines = [LOG_TYPES[type] ?? (type || "项目动态")];
  if (type === "LEAD_MATCH_REVIEWED" && typeof meta.isMatch === "boolean") {
    lines.push(`结果：${meta.isMatch ? "合适" : "不合适"}`);
  }
  const result = stringOf(meta.reviewResult).toUpperCase();
  if (result) {
    lines.push(`结果：${REVIEW_RESULTS[result] ?? result}`);
  }
  const reviewType = stringOf(meta.reviewType).toUpperCase();
  if (reviewType) {
    lines.push(`审核内容：${REVIEW_TYPES[reviewType] ?? reviewType}`);
  }
  const comment = stringOf(meta.reviewComment);
  if (comment) {
    lines.push(`意见：${comment}`);
  }
  if (typeof meta.submittedCount === "number") {
    lines.push(`提报人数：${meta.submittedCount}`);
  }
  if (typeof meta.fieldCount === "number") {
    lines.push(`重新提报人数：${meta.fieldCount}`);
  }
  const message = log.message?.trim() ?? "";
  if (/[\u4e00-\u9fff]/.test(message) && !lines.includes(message)) {
    lines.push(message);
  }
  const orderId = stringOf(meta.projectFieldId);
  if (orderId) {
    const nick = nicknames.get(orderId);
    if (nick) {
      lines.push(`达人：${nick}`);
    }
    lines.push(`订单会话：${orderThreadId(orderId)}`);
  }
  const actor = log.actorType ? ACTORS[log.actorType.toUpperCase()] ?? log.actorType : "";
  if (actor) {
    lines.push(`操作方：${actor}`);
  }
  return {
    suffix: `log-${stepToken(log.id)}`,
    at: log.createdAt || new Date(0).toISOString(),
    kind: "log",
    actor: "assistant",
    speaker: "项目动态",
    text: lines.join("\n"),
  };
}

function emit(
  projectId: string,
  label: string,
  cursor: ProjectCursor,
  records: IngestRecord[],
  steps: StepDraft[],
): IngestRecord[] {
  for (const step of withOffsets(steps)) {
    const hash = shortHash(`${step.actor}\n${step.speaker}\n${step.text}`);
    const previous = cursor.fp[step.suffix];
    if (previous === hash) {
      continue;
    }
    records.push(stepRecord({
      orderId: projectId,
      label,
      step,
      occurredAt: step.occurredAt,
      operation: previous ? "revise" : "create",
      source: PROJECT_SOURCE,
      unitKind: PROJECT_UNIT_KIND,
    }));
    cursor.fp[step.suffix] = hash;
  }
  return records;
}

export function projectLabel(project: { id: string; name?: string }): string {
  return project.name?.trim() || project.id;
}

export function projectStatusLabel(status: string | undefined): string {
  const mapped: Record<string, string> = {
    DRAFT: "草稿",
    IN_PROGRESS: "进行中",
    PAUSED: "暂停",
    ENDED: "结束",
  };
  return status ? mapped[status] ?? status : "（无状态）";
}

function levelLabel(level: string | undefined): string {
  const mapped: Record<string, string> = { LARGE: "大", MEDIUM: "中", SMALL: "小" };
  return level ? mapped[level] ?? level : "";
}

function joined(values: string[] | undefined): string {
  return values?.filter((item) => item.trim()).join("、") ?? "";
}

function dateOnly(value: string | undefined): string {
  return value ? value.slice(0, 10) : "";
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "";
}
