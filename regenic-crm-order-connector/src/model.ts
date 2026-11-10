export interface FollowDoc {
  followTime?: string;
  followerName?: string;
  followContent?: string;
  followType?: string;
  followResult?: string;
  selectedStatus?: string;
}

export interface OrderDoc {
  id: string;
  projectId?: string;
  campaignId?: string;
  influencerId?: string;
  nickname?: string;
  platform?: string;
  bloggerLink?: string;
  externalQuote?: number | null;
  influencerQuote?: number | null;
  /** 账期 ACCOUNT_PERIOD，或预充值 PREPAID。空着表示订单没记。 */
  settlementMethod?: string;
  cooperationBenefits?: string;
  bargainServiceFeeUsd?: number | null;
  bargainValueAddedFeeUsd?: number | null;
  status?: string;
  isDeleted?: boolean;
  createdTime?: string;
  updatedTime?: string;
  sharedScene?: string;
  reviewNeeded?: boolean;
  reviewReason?: string;
  reviewHint?: string;
  reviewHandler?: string;
  reviewAt?: string;
  follows: FollowDoc[];
}

export interface ProjectDoc {
  id: string;
  name?: string;
  briefUrl?: string;
  briefType?: string;
  briefText?: string;
  benefits?: string;
  brandProjectInfo?: string;
  brandProjectInfoEnglish?: string;
  demands?: string;
  updatedTime?: string;
}

export interface MailDoc {
  id: string;
  projectFieldId?: string;
  projectId?: string;
  campaignId?: string;
  folder?: string;
  from?: string;
  to?: string[];
  subject?: string;
  content?: string;
  htmlContent?: string;
  sentDate?: string;
  updatedTime?: string;
}

export interface FieldChangeDoc {
  fieldName?: string;
  oldValue?: string;
  newValue?: string;
}

export interface LogDoc {
  id: string;
  logTime?: string;
  changeType?: string;
  operatorName?: string;
  reason?: string;
  changes: FieldChangeDoc[];
}

export interface FactDoc {
  kind?: string;
  value?: string;
}

export interface AskDoc {
  party?: string;
  lead?: string;
  scriptTemplate?: string;
  facts?: FactDoc[];
}

export interface DecisionDoc {
  id: string;
  updatedAt?: string;
  reason?: string;
  hint?: string;
  questionText?: string;
  waitingOn?: string;
  ask?: AskDoc;
}

export interface OpenOrderHead {
  id: string;
  nickname?: string;
  projectName?: string;
  bloggerLink?: string;
}

export interface IdPage<T> {
  items: T[];
  full: boolean;
}

export interface PageQuery {
  afterId: string | null;
  since: string | null;
}

export interface DeliveryStore {
  listOpenIds(afterId: string | null, limit: number): Promise<OpenOrderHead[]>;
  listRecentHeads(limit: number): Promise<OpenOrderHead[]>;
  listHeadsByIds(ids: string[]): Promise<OpenOrderHead[]>;
  readOrder(id: string): Promise<OrderDoc | null>;
  readProject(id: string): Promise<ProjectDoc | null>;
  listMails(order: OrderDoc, query: PageQuery, limit: number): Promise<IdPage<MailDoc>>;
  listLogs(orderId: string, query: PageQuery, limit: number): Promise<IdPage<LogDoc>>;
  listDecisions(orderId: string, query: PageQuery, limit: number): Promise<IdPage<DecisionDoc>>;
}

export function mailBelongs(mail: MailDoc, order: OrderDoc): boolean {
  const folder = (mail.folder ?? "").toUpperCase();
  if (folder !== "INBOX" && folder !== "SPAM" && folder !== "SENT") {
    return false;
  }
  if (mail.projectFieldId?.trim()) {
    return mail.projectFieldId.trim() === order.id;
  }
  if (order.projectId && mail.projectId && mail.projectId !== order.projectId) {
    return false;
  }
  if (order.campaignId && mail.campaignId) {
    return order.campaignId === mail.campaignId;
  }
  return true;
}

export function isAutoNote(content: string | undefined): boolean {
  const text = content?.trim() ?? "";
  return text.startsWith("发送跟进邮件") || text.startsWith("已发送下单邮件");
}

export function logChangesStatus(log: LogDoc): boolean {
  return log.changes.some((change) => change.fieldName === "selectedWorkflow.status");
}
