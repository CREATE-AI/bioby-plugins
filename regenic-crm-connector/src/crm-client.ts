import { ChannelDriverError } from "@regenic/domain";
import type {
  OpsCompleteAction,
  OrderReviewResult,
} from "./locators";

export const CRM_BASE_URL_ENV = "REGENIC_CRM_BASE_URL";
export const CRM_TOKEN_ENV = "REGENIC_CRM_TOKEN";
export const CRM_REVIEWER = "regenic";

export const DEFAULT_MAX_OPEN_TASKS = 50;
export const DEFAULT_MAX_OPEN_ORDER_REVIEWS = 50;
export const CRM_REQUEST_TIMEOUT_MS = 15_000;

export type CrmFetch = (
  url: string,
  init: {
    method?: string;
    headers: Record<string, string>;
    body?: string;
  },
) => Promise<CrmFetchResponse>;

export interface CrmFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export class CrmApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CrmApiError";
  }
}

export interface CrmOpsReviewGuide {
  headline?: string;
  rationale?: string;
  suggestedNext?: string;
  allowedActions: OpsCompleteAction[];
}

export interface CrmOpsTask {
  id: string;
  status: string;
  taskType: string;
  nextAction?: string;
  updatedAt: string;
  reportingOperationsUserId?: string;
  reviewGuide: CrmOpsReviewGuide;
  project?: {
    projectFieldId?: string;
    name?: string;
    clientRequirement?: string;
    talentName?: string;
    quote?: string;
  };
  mail?: {
    messageId?: string;
    subject?: string;
    latestInboundSummary?: string;
    proposedReply?: string;
  };
  conversationLabel?: string;
}

export interface CrmOrder {
  id: string;
  internalReviewStatus: string;
  updatedAt: string;
  reportingOperationsUserId?: string;
  projectName?: string;
  talentName?: string;
  clientRequirement?: string;
  quote?: string;
  relatedOpsTaskId?: string;
  conversationLabel?: string;
}

export interface CrmClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: CrmFetch;
}

export interface CrmEnvOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: CrmFetch;
}

export class CrmClient {
  private readonly baseUrl: string;
  private readonly fetch: CrmFetch;

  constructor(private readonly options: CrmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!this.baseUrl) {
      throw new ChannelDriverError(
        "invalid_config",
        `${CRM_BASE_URL_ENV} is required`,
      );
    }
    this.fetch = options.fetch ?? defaultFetch;
  }

  get hasToken(): boolean {
    return Boolean(this.options.token?.trim());
  }

  get token(): string | undefined {
    const token = this.options.token?.trim();
    return token || undefined;
  }

  async listPendingOpsTasks(): Promise<CrmOpsTask[]> {
    const payload = unwrapPayload(
      await this.request("GET", "/internal/regenic/pending-ops-tasks"),
    );
    return parseList(payload, parseOpsTask).filter(isEmailSubmitPending);
  }

  async getOpsTask(taskId: string): Promise<CrmOpsTask> {
    const payload = await this.request(
      "GET",
      `/internal/regenic/ops-tasks/${encodeURIComponent(taskId)}`,
    );
    const task = parseOpsTask(unwrapPayload(payload));
    if (!task) {
      throw new CrmApiError(502, "CRM ops task response is invalid");
    }
    return task;
  }

  async completeOpsTask(
    taskId: string,
    input: { action: OpsCompleteAction; comment: string },
  ): Promise<void> {
    await this.request(
      "POST",
      `/internal/regenic/ops-tasks/${encodeURIComponent(taskId)}/complete`,
      { action: input.action, comment: input.comment },
    );
  }

  async listPendingHumanOrders(): Promise<CrmOrder[]> {
    const payload = await this.request(
      "GET",
      "/internal/regenic/pending-human-orders",
    );
    return parseList(unwrapPayload(payload), parseOrder).filter(isPendingHumanOrder);
  }

  async getOrder(projectFieldId: string): Promise<CrmOrder> {
    const payload = await this.request(
      "GET",
      `/internal/regenic/orders/${encodeURIComponent(projectFieldId)}`,
    );
    const order = parseOrder(unwrapPayload(payload));
    if (!order) {
      throw new CrmApiError(502, "CRM order response is invalid");
    }
    return order;
  }

  async submitOrderInternalReview(
    projectFieldId: string,
    input: { result: OrderReviewResult; comment: string },
  ): Promise<void> {
    await this.request(
      "POST",
      `/internal/regenic/orders/${encodeURIComponent(projectFieldId)}/internal-review`,
      { result: input.result, comment: input.comment },
    );
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: Record<string, string>,
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.token) {
      headers.authorization = `Bearer ${this.token}`;
    }
    if (body) {
      headers["content-type"] = "application/json";
    }
    let response: CrmFetchResponse;
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      throw new CrmApiError(
        0,
        error instanceof Error ? error.message : "CRM request failed",
      );
    }
    if (response.status === 401) {
      throw new CrmApiError(401, "CRM rejected the connector token");
    }
    if (response.status === 404) {
      throw new CrmApiError(404, `CRM resource not found: ${path}`);
    }
    if (response.status === 409) {
      throw new CrmApiError(409, `CRM resource is no longer pending: ${path}`);
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new CrmApiError(
        response.status,
        detail.trim() || `CRM request failed: ${method} ${path}`,
      );
    }
    if (response.status === 204) {
      return undefined;
    }
    try {
      return await response.json();
    } catch {
      return undefined;
    }
  }
}

export function crmClientFromEnv(input: CrmEnvOptions = {}): CrmClient {
  const env = input.env ?? process.env;
  const baseUrl = env[CRM_BASE_URL_ENV]?.trim();
  if (!baseUrl) {
    throw new ChannelDriverError(
      "invalid_config",
      `${CRM_BASE_URL_ENV} is required`,
    );
  }
  return new CrmClient({
    baseUrl,
    token: env[CRM_TOKEN_ENV],
    fetch: input.fetch,
  });
}

export function crmHasToken(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[CRM_TOKEN_ENV]?.trim());
}

export function isEmailSubmitPending(task: CrmOpsTask): boolean {
  if (task.status !== "PENDING_REVIEW") {
    return false;
  }
  return (
    task.taskType === "EMAIL_SUBMIT_AUTOMATION" ||
    task.taskType === "EMAIL_SUBMIT"
  );
}

export function isPendingHumanOrder(order: CrmOrder): boolean {
  const status = order.internalReviewStatus;
  if (status === "IN_PROGRESS") {
    return false;
  }
  return (
    status === "PENDING_HUMAN" ||
    status === "WAITING_HUMAN" ||
    status === "PENDING_MANUAL" ||
    status === "HUMAN_REVIEW"
  );
}

export function auditComment(input: {
  queue: "ops" | "order";
  hasToken: boolean;
  reportingOperationsUserId?: string;
  promptText?: string;
}): string {
  const lines = [
    `source=${input.queue === "ops" ? "regenic" : "regenic-order-review"}`,
    `token=${input.hasToken ? "yes" : "no"}`,
  ];
  if (input.reportingOperationsUserId?.trim()) {
    lines.push(`reportingOperationsUserId=${input.reportingOperationsUserId.trim()}`);
  }
  if (input.promptText?.trim()) {
    lines.push(input.promptText.trim());
  }
  return lines.join("\n");
}

export function mapCrmError(
  error: unknown,
  kind: "sync" | "send",
): never {
  if (error instanceof ChannelDriverError) {
    throw error;
  }
  if (error instanceof CrmApiError && error.status === 401) {
    throw new ChannelDriverError(
      "missing_credentials",
      "CRM rejected the connector token",
    );
  }
  throw new ChannelDriverError(
    kind === "send" ? "send_failed" : "sync_failed",
    error instanceof Error ? error.message : "CRM request failed",
  );
}

function unwrapPayload(payload: unknown): unknown {
  if (isObject(payload) && payload.data !== undefined) {
    return unwrapPayload(payload.data);
  }
  return payload;
}

function parseList<T>(
  payload: unknown,
  parseItem: (value: unknown) => T | undefined,
): T[] {
  const items = Array.isArray(payload)
    ? payload
    : isObject(payload) && Array.isArray(payload.items)
      ? payload.items
      : [];
  return items.flatMap((item) => {
    const parsed = parseItem(item);
    return parsed ? [parsed] : [];
  });
}

function parseOpsTask(value: unknown): CrmOpsTask | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const id = stringValue(value.id ?? value.taskId);
  const status = stringValue(value.status);
  const taskType = stringValue(value.taskType ?? value.kind);
  if (!id || !status || !taskType) {
    return undefined;
  }
  const allowed = parseAllowedOpsActions(value);
  return {
    id,
    status,
    taskType,
    nextAction: stringValue(value.nextAction),
    updatedAt:
      stringValue(value.updatedAt ?? value.updated_at ?? value.occurredAt) ??
      new Date(0).toISOString(),
    reportingOperationsUserId: stringValue(
      value.reportingOperationsUserId ?? value.reporting_operations_user_id,
    ),
    reviewGuide: parseReviewGuide(value.reviewGuide ?? value.review_guide, allowed),
    project: parseProject(value.project ?? value.businessRef ?? value.order),
    mail: parseMail(value.mail ?? value.email),
    conversationLabel: stringValue(value.conversationLabel ?? value.conversation_label),
  };
}

function parseOrder(value: unknown): CrmOrder | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const id = stringValue(
    value.id ?? value.projectFieldId ?? value.project_field_id,
  );
  const internalReviewStatus = stringValue(
    value.internalReviewStatus ??
      value.aiInternalReviewStatus ??
      value.reviewStatus ??
      value.status,
  );
  if (!id || !internalReviewStatus) {
    return undefined;
  }
  return {
    id,
    internalReviewStatus,
    updatedAt:
      stringValue(value.updatedAt ?? value.updated_at ?? value.occurredAt) ??
      new Date(0).toISOString(),
    reportingOperationsUserId: stringValue(
      value.reportingOperationsUserId ?? value.reporting_operations_user_id,
    ),
    projectName: stringValue(value.projectName ?? value.project_name),
    talentName: stringValue(value.talentName ?? value.talent_name),
    clientRequirement: stringValue(
      value.clientRequirement ?? value.client_requirement,
    ),
    quote: stringValue(value.quote),
    relatedOpsTaskId: stringValue(
      value.relatedOpsTaskId ?? value.related_ops_task_id,
    ),
    conversationLabel: stringValue(value.conversationLabel ?? value.conversation_label),
  };
}

function parseReviewGuide(
  value: unknown,
  fallback: OpsCompleteAction[],
): CrmOpsReviewGuide {
  if (!isObject(value)) {
    return { allowedActions: fallback };
  }
  const raw = readAllowedActionsField(value);
  return {
    headline: stringValue(value.headline),
    rationale: stringValue(value.rationale),
    suggestedNext: stringValue(value.suggestedNext ?? value.suggested_next),
    allowedActions: raw === undefined ? fallback : parseAllowedList(raw),
  };
}

function parseAllowedOpsActions(value: unknown): OpsCompleteAction[] {
  if (!isObject(value)) {
    return ["CLOSE_TASK"];
  }
  const raw = readAllowedActionsField(value);
  if (raw === undefined) {
    return ["CLOSE_TASK"];
  }
  return parseAllowedList(raw);
}

function readAllowedActionsField(value: Record<string, unknown>): unknown {
  if ("allowedActions" in value) {
    return value.allowedActions;
  }
  if ("allowed_actions" in value) {
    return value.allowed_actions;
  }
  if ("ctas" in value) {
    return value.ctas;
  }
  return undefined;
}

function parseAllowedList(raw: unknown): OpsCompleteAction[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return unique(
    raw.flatMap((item) => {
      const label =
        typeof item === "string"
          ? item
          : isObject(item)
            ? stringValue(item.action ?? item.label)
            : undefined;
      if (label === "APPROVE_AND_CONTINUE" || label === "CLOSE_TASK") {
        return [label];
      }
      return [];
    }),
  );
}

function parseProject(value: unknown): CrmOpsTask["project"] {
  if (!isObject(value)) {
    return undefined;
  }
  const projectFieldId = stringValue(
    value.projectFieldId ?? value.project_field_id ?? value.id,
  );
  const name = stringValue(value.name ?? value.projectName);
  const clientRequirement = stringValue(
    value.clientRequirement ?? value.client_requirement,
  );
  const talentName = stringValue(value.talentName ?? value.talent_name);
  const quote = stringValue(value.quote);
  if (!projectFieldId && !name && !clientRequirement && !talentName && !quote) {
    return undefined;
  }
  return { projectFieldId, name, clientRequirement, talentName, quote };
}

function parseMail(value: unknown): CrmOpsTask["mail"] {
  if (!isObject(value)) {
    return undefined;
  }
  const messageId = stringValue(value.messageId ?? value.message_id ?? value.id);
  const subject = stringValue(value.subject);
  const latestInboundSummary = stringValue(
    value.latestInboundSummary ?? value.latest_inbound_summary,
  );
  const proposedReply = stringValue(value.proposedReply ?? value.proposed_reply);
  if (!messageId && !subject && !latestInboundSummary && !proposedReply) {
    return undefined;
  }
  return { messageId, subject, latestInboundSummary, proposedReply };
}

async function defaultFetch(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
): Promise<CrmFetchResponse> {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(CRM_REQUEST_TIMEOUT_MS),
  });
  return {
    ok: response.ok,
    status: response.status,
    json: () => response.json(),
    text: () => response.text(),
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
