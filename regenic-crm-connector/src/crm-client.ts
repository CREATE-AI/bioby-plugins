import {
  ChannelDriverError,
  readEnvCredential,
  type ConnectorCatalogProbe,
  type DriverCatalogField,
} from "@regenic/domain";
import {
  parseOpsCompleteAction,
  type OpsCompleteAction,
  type OrderReviewResult,
} from "./locators";

export const CRM_BASE_URL_ENV = "REGENIC_CRM_BASE_URL";
export const CRM_TOKEN_ENV = "REGENIC_CRM_TOKEN";
export const CRM_SHARED_SECRET_ENV = "REGENIC_CRM_SHARED_SECRET";
export const CRM_INTERNAL_SERVICE = "regenic";
export const CRM_INTERNAL_SERVICE_HEADER = "X-Internal-Service";
export const CRM_INTERNAL_KEY_HEADER = "X-Regenic-Key";
export const CRM_REVIEWER = "regenic";

export function crmCatalogFields(extra: DriverCatalogField[] = []): DriverCatalogField[] {
  return [
    {
      key: "base_url",
      label: "field.baseUrl",
      required: true,
      placeholder: "field.baseUrl.placeholder",
    },
    ...extra,
  ];
}

export function crmCatalogPrerequisites() {
  return [
    {
      kind: "env" as const,
      key: CRM_SHARED_SECRET_ENV,
      label: "prereq.secret",
      required: false,
      hint: "prereq.secret.hint",
    },
    {
      kind: "env" as const,
      key: CRM_TOKEN_ENV,
      label: "prereq.token",
      required: false,
      hint: "prereq.token.hint",
    },
  ];
}

/**
 * Catalog probe cannot see the form `base_url`. `crm-connector` means the
 * private plugin is loaded. `crm` is leftover env only and is not a
 * prerequisite, so it does not grey the Engine install button.
 */
export function crmProbeCatalog(
  env: NodeJS.ProcessEnv = process.env,
): ConnectorCatalogProbe {
  const leftoverUrl = Boolean(env[CRM_BASE_URL_ENV]?.trim());
  return {
    services: {
      "crm-connector": {
        ready: true,
        hint: "probe.loaded",
      },
      crm: {
        ready: leftoverUrl,
        hint: leftoverUrl ? "probe.legacyUrl" : "probe.noEnvUrl",
      },
    },
  };
}

export const DEFAULT_MAX_OPEN_TASKS = 50;
export const DEFAULT_MAX_OPEN_ORDER_REVIEWS = 50;
export const CRM_REQUEST_TIMEOUT_ENV = "REGENIC_CRM_REQUEST_TIMEOUT_MS";
/** Default HTTP deadline. Pending-human lists can exceed 30s on production CRM. */
export const CRM_REQUEST_TIMEOUT_MS = 120_000;

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

export interface CrmSubmitQuote {
  raw: string;
  amount?: number;
  currency?: string;
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
    quoteLifecycleStatus?: string;
  };
  mail?: {
    messageId?: string;
    subject?: string;
    latestInboundSummary?: string;
    threadDigest?: string;
    proposedReply?: string;
    hasQuotes?: boolean;
    quotes?: string;
    attachmentCount?: number;
    quoteLifecycleStatus?: string;
    quoteGuideOutboundCount?: number;
  };
  conversationLabel?: string;
}

export interface CrmOrderAiReview {
  decision?: string;
  confidence?: string;
  summary?: string;
  invocationId?: string;
  evaluatedAt?: string;
  dimensionAnalyses?: string[];
}

export interface CrmOrderTalent {
  nickname?: string;
  platform?: string;
  profileUrl?: string;
  email?: string;
  follower?: string;
  region?: string;
  avgView?: string;
  engagementRate?: string;
  cpm?: string;
  quote?: string;
  externalQuote?: string;
  cooperationMethod?: string;
  category?: string;
  influencerType?: string;
  supplementaryNotesContent?: string;
}

export interface CrmOrderAutoReviewLog {
  operation?: string;
  decision?: string;
  invocationId?: string;
  reviewComment?: string;
  userMessage?: string;
  agentResponse?: string;
  error?: string;
  logTime?: string;
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
  aiReview?: CrmOrderAiReview;
  talent?: CrmOrderTalent;
  autoReviewLog?: CrmOrderAutoReviewLog;
}

export interface CrmClientOptions {
  baseUrl: string;
  token?: string;
  /** CRM `INTERNAL_AUTH_REGENIC_SHARED_SECRET`. Not a user JWT. */
  sharedSecret?: string;
  timeoutMs?: number;
  fetch?: CrmFetch;
}

export interface CrmEnvOptions {
  env?: NodeJS.ProcessEnv;
  fetch?: CrmFetch;
  credentials_ref?: string;
}

export class CrmClient {
  private readonly baseUrl: string;
  private readonly fetch: CrmFetch;
  private readonly timeoutMs: number;

  constructor(private readonly options: CrmClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    if (!this.baseUrl) {
      throw new ChannelDriverError(
        "invalid_config",
        "CRM base URL is required. Set it in the connector form.",
      );
    }
    this.timeoutMs = options.timeoutMs ?? CRM_REQUEST_TIMEOUT_MS;
    this.fetch =
      options.fetch ??
      ((url, init) => defaultFetch(url, init, this.timeoutMs));
  }

  get hasToken(): boolean {
    return Boolean(this.options.token?.trim());
  }

  get token(): string | undefined {
    const token = this.options.token?.trim();
    return token || undefined;
  }

  get sharedSecret(): string | undefined {
    const secret = this.options.sharedSecret?.trim();
    return secret || undefined;
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
    input: {
      action: OpsCompleteAction;
      scene?: string;
      submit_quote?: CrmSubmitQuote;
      comment: string;
    },
  ): Promise<void> {
    await this.request(
      "POST",
      `/internal/regenic/ops-tasks/${encodeURIComponent(taskId)}/complete`,
      {
        action: input.action,
        scene: input.scene,
        submit_quote: input.submit_quote,
        comment: input.comment,
      },
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
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (this.sharedSecret) {
      headers[CRM_INTERNAL_SERVICE_HEADER] = CRM_INTERNAL_SERVICE;
      headers[CRM_INTERNAL_KEY_HEADER] = this.sharedSecret;
    }
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

export function crmTokenFrom(
  env: NodeJS.ProcessEnv = process.env,
  credentialsRef?: string,
): string | undefined {
  return readEnvCredential(credentialsRef, env, CRM_TOKEN_ENV);
}

export function crmClientFromConfig(input: {
  config?: Record<string, unknown>;
  env?: NodeJS.ProcessEnv;
  fetch?: CrmFetch;
  credentials_ref?: string;
} = {}): CrmClient {
  const env = input.env ?? process.env;
  return new CrmClient({
    baseUrl: resolveCrmBaseUrl(input.config ?? {}, env),
    token: crmTokenFrom(env, input.credentials_ref),
    sharedSecret: crmSharedSecretFrom(env),
    timeoutMs: crmRequestTimeoutMs(env),
    fetch: input.fetch,
  });
}

export function crmRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
): number {
  const raw = env[CRM_REQUEST_TIMEOUT_ENV]?.trim();
  if (!raw) {
    return CRM_REQUEST_TIMEOUT_MS;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(1_000, Math.min(value, 180_000));
}

export function crmSharedSecretFrom(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const secret = env[CRM_SHARED_SECRET_ENV]?.trim();
  return secret || undefined;
}

/** @deprecated Prefer connector config `base_url`. Kept for old installs that still use the env. */
export function crmClientFromEnv(input: CrmEnvOptions = {}): CrmClient {
  return crmClientFromConfig({
    env: input.env,
    fetch: input.fetch,
    credentials_ref: input.credentials_ref,
  });
}

export function requireCrmBaseUrl(config: Record<string, unknown>): string {
  const raw = configString(config, "base_url");
  if (!raw) {
    throw new ChannelDriverError(
      "invalid_config",
      "CRM base URL is required. Set it in the connector form.",
    );
  }
  return normalizeCrmBaseUrl(raw);
}

export function resolveCrmBaseUrl(
  config: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = configString(config, "base_url") || env[CRM_BASE_URL_ENV]?.trim();
  if (!raw) {
    throw new ChannelDriverError(
      "invalid_config",
      "CRM base URL is required. Set it in the connector form.",
    );
  }
  return normalizeCrmBaseUrl(raw);
}

export function normalizeCrmBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ChannelDriverError(
      "invalid_config",
      "CRM base URL must be an http(s) URL, including /api",
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ChannelDriverError(
      "invalid_config",
      "CRM base URL must be an http(s) URL, including /api",
    );
  }
  const path = parsed.pathname.replace(/\/+$/, "") || "/";
  if (path !== "/api" && !path.endsWith("/api")) {
    throw new ChannelDriverError(
      "invalid_config",
      "CRM base URL must be an http(s) URL, including /api",
    );
  }
  return trimmed;
}

export function crmInstallDetail(
  config: Record<string, unknown>,
  maxKey: string,
  fallbackMax: string,
): string {
  const max = configString(config, maxKey) ?? fallbackMax;
  const baseUrl = configString(config, "base_url");
  if (!baseUrl) {
    return max;
  }
  try {
    return `${new URL(baseUrl).host} · ${max}`;
  } catch {
    return `${baseUrl} · ${max}`;
  }
}

export function configString(
  config: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = config[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function configNumber(
  config: Record<string, unknown>,
  name: string,
): number | undefined {
  const value = config[name];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function crmHasToken(
  env: NodeJS.ProcessEnv = process.env,
  credentialsRef?: string,
): boolean {
  return Boolean(crmTokenFrom(env, credentialsRef));
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
    aiReview: parseAiReview(value.aiReview ?? value.ai_review),
    talent: parseTalent(value.talent ?? value.influencer),
    autoReviewLog: parseAutoReviewLog(
      value.autoReviewLog ?? value.auto_review_log,
    ),
  };
}

function parseAiReview(value: unknown): CrmOrderAiReview | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const review: CrmOrderAiReview = {
    decision: scalarValue(value.decision),
    confidence: scalarValue(value.confidence),
    summary: scalarValue(value.summary),
    invocationId: scalarValue(value.invocationId ?? value.invocation_id),
    evaluatedAt: scalarValue(value.evaluatedAt ?? value.evaluated_at),
    dimensionAnalyses: stringList(
      value.dimensionAnalyses ?? value.dimension_analyses,
    ),
  };
  return hasDefined(review) ? review : undefined;
}

function parseTalent(value: unknown): CrmOrderTalent | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const talent: CrmOrderTalent = {
    nickname: scalarValue(value.nickname),
    platform: scalarValue(value.platform),
    profileUrl: scalarValue(value.profileUrl ?? value.profile_url ?? value.bloggerLink),
    email: scalarValue(value.email),
    follower: scalarValue(value.follower),
    region: scalarValue(value.region),
    avgView: scalarValue(value.avgView ?? value.aveView ?? value.avg_view),
    engagementRate: scalarValue(value.engagementRate ?? value.engagement_rate),
    cpm: scalarValue(value.cpm),
    quote: scalarValue(value.quote),
    externalQuote: scalarValue(value.externalQuote ?? value.external_quote),
    cooperationMethod: scalarValue(
      value.cooperationMethod ?? value.cooperation_method,
    ),
    category: scalarValue(value.category),
    influencerType: scalarValue(value.influencerType ?? value.influencer_type),
    supplementaryNotesContent: scalarValue(
      value.supplementaryNotesContent ?? value.supplementary_notes_content,
    ),
  };
  return hasDefined(talent) ? talent : undefined;
}

function parseAutoReviewLog(value: unknown): CrmOrderAutoReviewLog | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const log: CrmOrderAutoReviewLog = {
    operation: scalarValue(value.operation),
    decision: scalarValue(value.decision),
    invocationId: scalarValue(value.invocationId ?? value.invocation_id),
    reviewComment: scalarValue(value.reviewComment ?? value.review_comment),
    userMessage: scalarValue(value.userMessage ?? value.user_message),
    agentResponse: scalarValue(value.agentResponse ?? value.agent_response),
    error: scalarValue(value.error),
    logTime: scalarValue(value.logTime ?? value.log_time),
  };
  return hasDefined(log) ? log : undefined;
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

const DEFAULT_OPS_ACTIONS: OpsCompleteAction[] = [
  "SEND_AND_CLOSE",
  "SUBMIT_THEN_CLOSE",
  "LEAVE_PENDING",
  "CLOSE_ONLY",
];

function parseAllowedOpsActions(value: unknown): OpsCompleteAction[] {
  if (!isObject(value)) {
    return [...DEFAULT_OPS_ACTIONS];
  }
  const raw = readAllowedActionsField(value);
  if (raw === undefined) {
    return [...DEFAULT_OPS_ACTIONS];
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
      const parsed = label ? parseOpsCompleteAction(label) : undefined;
      return parsed ? [parsed] : [];
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
  const quoteLifecycleStatus = stringValue(
    value.quoteLifecycleStatus ?? value.quote_lifecycle_status,
  );
  if (
    !projectFieldId &&
    !name &&
    !clientRequirement &&
    !talentName &&
    !quote &&
    !quoteLifecycleStatus
  ) {
    return undefined;
  }
  return { projectFieldId, name, clientRequirement, talentName, quote, quoteLifecycleStatus };
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
  const threadDigest = stringValue(value.threadDigest ?? value.thread_digest);
  const proposedReply = stringValue(value.proposedReply ?? value.proposed_reply);
  const quotes = stringValue(value.quotes);
  const quoteLifecycleStatus = stringValue(
    value.quoteLifecycleStatus ?? value.quote_lifecycle_status,
  );
  const hasQuotes = booleanValue(value.hasQuotes ?? value.has_quotes);
  const attachmentCount = numberValue(value.attachmentCount ?? value.attachment_count);
  const quoteGuideOutboundCount = numberValue(
    value.quoteGuideOutboundCount ?? value.quote_guide_outbound_count,
  );
  if (
    !messageId &&
    !subject &&
    !latestInboundSummary &&
    !threadDigest &&
    !proposedReply &&
    !quotes &&
    !quoteLifecycleStatus &&
    hasQuotes === undefined &&
    attachmentCount === undefined &&
    quoteGuideOutboundCount === undefined
  ) {
    return undefined;
  }
  return {
    messageId,
    subject,
    latestInboundSummary,
    threadDigest,
    proposedReply,
    hasQuotes,
    quotes,
    attachmentCount,
    quoteLifecycleStatus,
    quoteGuideOutboundCount,
  };
}

async function defaultFetch(
  url: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
  timeoutMs: number = CRM_REQUEST_TIMEOUT_MS,
): Promise<CrmFetchResponse> {
  const response = await fetch(url, {
    ...init,
    ...(timeoutMs > 0 ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
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

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function scalarValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() ? value.trim() : undefined;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.flatMap((item) => {
    const text = scalarValue(item);
    return text ? [text] : [];
  });
  return items.length > 0 ? items : undefined;
}

function hasDefined(value: object): boolean {
  return Object.values(value).some((item) => item !== undefined);
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}
