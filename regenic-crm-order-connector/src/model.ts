export interface FollowDoc {
  followTime?: string;
  followerName?: string;
  followContent?: string;
  followType?: string;
  followResult?: string;
  selectedStatus?: string;
  /** 跟进里贴的文件链接。 */
  attachmentUrls?: string[];
  /** 品牌端交付审核：SCRIPT 脚本，VIDEO 视频草稿。 */
  reviewType?: string;
  /** 这次审核当时用的材料链接。 */
  materialLinks?: string[];
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
  /** viewFlags.inDeliveryView。只有交付视图里的订单才继续同步。 */
  inDeliveryView?: boolean;
  /** selectedWorkflow.finalScriptLink，最终脚本链接。 */
  scriptLink?: string;
  /** selectedWorkflow.publishLinks，没有列表时用 publishLink。 */
  publishLinks?: string[];
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
  status?: string;
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
  /** brandIds 不传表示不按品牌收。传入（含空数组）就只收这些品牌下的订单。 */
  listOpenIds(afterId: string | null, limit: number, brandIds?: string[]): Promise<OpenOrderHead[]>;
  listRecentHeads(limit: number, brandIds?: string[]): Promise<OpenOrderHead[]>;
  listHeadsByIds(ids: string[], brandIds?: string[]): Promise<OpenOrderHead[]>;
  readOrder(id: string): Promise<OrderDoc | null>;
  readProject(id: string): Promise<ProjectDoc | null>;
  listMails(order: OrderDoc, query: PageQuery, limit: number): Promise<IdPage<MailDoc>>;
  listLogs(orderId: string, query: PageQuery, limit: number): Promise<IdPage<LogDoc>>;
  listDecisions(orderId: string, query: PageQuery, limit: number): Promise<IdPage<DecisionDoc>>;
}

export interface ProjectHead {
  id: string;
  name?: string;
}

export interface ProjectInfoDoc extends ProjectDoc {
  status?: string;
  level?: string;
  isDeleted?: boolean;
  description?: string;
  descriptionExtra?: string;
  quoteMethod?: string;
  contactGroupApp?: string;
  contactGroupName?: string;
  productUrl?: string;
  platforms?: string[];
  targetCountries?: string[];
  targetLanguages?: string[];
  currency?: string;
  totalBudget?: number | null;
  campaignNames?: string[];
  businessManager?: string;
  operationsManager?: string;
  pmManager?: string;
  startTime?: string;
  endTime?: string;
  deadline?: string;
  createdTime?: string;
}

export interface ProjectOrderRow {
  id: string;
  nickname?: string;
  platform?: string;
  bloggerLink?: string;
  externalQuote?: number | null;
  status?: string;
  inDeliveryView?: boolean;
  isDeleted?: boolean;
  selectedTime?: string;
  createdTime?: string;
}

export interface ProjectStore {
  /** 没删除的项目，创建时间从新到旧。limit 为 null 时取全部。brandIds 不传表示不按品牌收。 */
  listProjects(limit: number | null, brandIds?: string[]): Promise<ProjectHead[]>;
  /** 给出的项目里，已经删除或者库里没有了的那些。 */
  listGoneProjects(ids: string[]): Promise<string[]>;
  readProjectInfo(id: string): Promise<ProjectInfoDoc | null>;
  listProjectOrders(projectId: string, limit: number): Promise<ProjectOrderRow[]>;
  readOrderRows(ids: string[]): Promise<ProjectOrderRow[]>;
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
