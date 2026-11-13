import { MongoClient, ObjectId, type Db, type Document, type Filter } from "mongodb";
import type {
  DecisionDoc,
  DeliveryStore,
  IdPage,
  LogDoc,
  MailDoc,
  OpenOrderHead,
  OrderDoc,
  PageQuery,
  ProjectDoc,
  ProjectInfoDoc,
  ProjectOrderRow,
  ProjectStore,
} from "./model";

const clients = new Map<string, Promise<MongoClient>>();

export function mongoStore(uri: string, dbName: string): DeliveryStore {
  const db = () => client(uri).then((mongo) => mongo.db(dbName));
  let brandKey = "";
  let brandProjectIds: string[] = [];
  async function scopeFor(database: Db, brandIds: string[] | undefined) {
    if (!brandIds) {
      return undefined;
    }
    const key = brandIds.join("\u0000");
    if (key !== brandKey) {
      brandKey = key;
      brandProjectIds = brandIds.length === 0 ? [] : await projectIdsOfBrands(database, brandIds);
    }
    return { brandIds, projectIds: brandProjectIds };
  }
  return {
    async listOpenIds(afterId, limit, brandIds) {
      const database = await db();
      const brand = await scopeFor(database, brandIds);
      const rows = await database
        .collection("project_fields")
        .find(openFilter(afterId ? { _id: { $gt: asId(afterId) } } : {}, brand))
        .sort({ _id: 1 })
        .limit(limit)
        .project(ORDER_HEAD_FIELDS)
        .toArray();
      return withProjects(database, rows);
    },

    async listRecentHeads(limit, brandIds) {
      const database = await db();
      const brand = await scopeFor(database, brandIds);
      const rows = await database
        .collection("project_fields")
        .find(openFilter({}, brand))
        .sort({ "submitWorkflow.submitTime": -1, createdTime: -1, _id: -1 })
        .limit(limit)
        .project(ORDER_HEAD_FIELDS)
        .toArray();
      return withProjects(database, rows);
    },

    async listHeadsByIds(ids, brandIds) {
      const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
      if (unique.length === 0) {
        return [];
      }
      const database = await db();
      const brand = await scopeFor(database, brandIds);
      const rows = await database
        .collection("project_fields")
        .find(openFilter({ _id: { $in: unique.map(asId) } }, brand))
        .project(ORDER_HEAD_FIELDS)
        .toArray();
      const heads = await withProjects(database, rows);
      const byId = new Map(heads.map((row) => [row.id, row]));
      return unique.flatMap((id) => {
        const head = byId.get(id);
        return head ? [head] : [];
      });
    },

    async readOrder(id) {
      const row = await (await db()).collection("project_fields").findOne(loose({ _id: asId(id) }));
      return row ? mapOrder(row) : null;
    },

    async readProject(id) {
      const row = await (await db()).collection("projects").findOne(loose({ _id: asId(id) }));
      return row ? mapProject(row) : null;
    },

    async listMails(order, query, limit) {
      if (!order.influencerId) {
        return { items: [], full: false };
      }
      const scope: Filter<Document>[] = [
        ...influencerMailScope(order),
        pageFilter(query, "sentDate"),
      ];
      const rows = await (await db())
        .collection("emailInbox")
        .find({ $and: scope })
        .sort(query.since ? { sentDate: 1, _id: 1 } : { _id: 1 })
        .limit(limit)
        .toArray();
      return pageOf(rows.map(mapMail), limit);
    },

    async listLogs(orderId, query, limit) {
      const rows = await (await db())
        .collection("project_field_change_logs")
        .find({
          $and: [{ projectFieldId: orderId }, pageFilter(query, "logTime")],
        })
        .sort(query.since ? { logTime: 1, _id: 1 } : { _id: 1 })
        .limit(limit)
        .toArray();
      return pageOf(rows.map(mapLog), limit);
    },

    async listDecisions(orderId, query, limit) {
      const rows = await (await db())
        .collection("delivery_decision_items")
        .find({
          $and: [{ projectFieldId: orderId }, pageFilter(query, "updatedAt")],
        })
        .sort(query.since ? { updatedAt: 1, _id: 1 } : { _id: 1 })
        .limit(limit)
        .toArray();
      return pageOf(rows.map(mapDecision), limit);
    },
  };
}

export function projectStore(uri: string, dbName: string): ProjectStore {
  const db = () => client(uri).then((mongo) => mongo.db(dbName));
  return {
    async listProjects(limit, brandIds) {
      const filter: Record<string, unknown> = { isDeleted: false };
      if (brandIds) {
        filter.brandId = { $in: brandIds };
      }
      let query = (await db())
        .collection("projects")
        .find(loose(filter))
        .sort({ createdTime: -1, _id: -1 })
        .project({ name: 1 });
      if (limit != null) {
        query = query.limit(limit);
      }
      const rows = await query.toArray();
      return rows.map((row) => ({ id: idOf(row._id), name: stringOf(row.name) }));
    },

    async listGoneProjects(ids) {
      const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
      if (unique.length === 0) {
        return [];
      }
      const alive = await (await db())
        .collection("projects")
        .find(loose({ _id: { $in: unique.map(asId) }, isDeleted: false }))
        .project({ _id: 1 })
        .toArray();
      const kept = new Set(alive.map((row) => idOf(row._id)));
      return unique.filter((id) => !kept.has(id));
    },

    async readProjectInfo(id) {
      const row = await (await db()).collection("projects").findOne(loose({ _id: asId(id) }));
      return row ? mapProjectInfo(row) : null;
    },

    async listProjectOrders(projectId, limit) {
      const rows = await (await db())
        .collection("project_fields")
        .find(openFilter({ projectId }))
        .sort({ "selectedWorkflow.selectedTime": 1, _id: 1 })
        .limit(limit)
        .project(ORDER_ROW_FIELDS)
        .toArray();
      return rows.map(mapOrderRow);
    },

    async readOrderRows(ids) {
      const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
      if (unique.length === 0) {
        return [];
      }
      const rows = await (await db())
        .collection("project_fields")
        .find(loose({ _id: { $in: unique.map(asId) } }))
        .project(ORDER_ROW_FIELDS)
        .toArray();
      return rows.map(mapOrderRow);
    },
  };
}

const ORDER_HEAD_FIELDS = {
  nickname: 1,
  projectId: 1,
  bloggerLink: 1,
  "selectedWorkflow.status": 1,
};

const ORDER_ROW_FIELDS = {
  nickname: 1,
  platform: 1,
  bloggerLink: 1,
  externalQuote: 1,
  isDeleted: 1,
  createdTime: 1,
  "viewFlags.inDeliveryView": 1,
  "selectedWorkflow.status": 1,
  "selectedWorkflow.selectedTime": 1,
};

function mapOrderRow(row: Document): ProjectOrderRow {
  const workflow = asRecord(row.selectedWorkflow);
  return {
    id: idOf(row._id),
    nickname: stringOf(row.nickname),
    platform: stringOf(row.platform),
    bloggerLink: stringOf(row.bloggerLink),
    externalQuote: numberOf(row.externalQuote),
    status: stringOf(workflow?.status),
    inDeliveryView: asRecord(row.viewFlags)?.inDeliveryView === true,
    isDeleted: row.isDeleted === true,
    selectedTime: iso(workflow?.selectedTime),
    createdTime: iso(row.createdTime),
  };
}

function mapProjectInfo(row: Document): ProjectInfoDoc {
  return {
    ...mapProject(row),
    status: stringOf(row.status),
    level: stringOf(row.level),
    isDeleted: row.isDeleted !== false,
    description: stringOf(row.description),
    descriptionExtra: stringOf(row.descriptionExtra),
    quoteMethod: stringOf(row.quoteMethod),
    contactGroupApp: stringOf(row.contactGroupApp),
    contactGroupName: stringOf(row.contactGroupName),
    productUrl: stringOf(row.productUrl),
    platforms: stringList(row.platforms),
    targetCountries: stringList(row.targetCountries),
    targetLanguages: stringList(row.targetLanguages),
    currency: stringOf(row.currency),
    totalBudget: decimalOf(row.totalBudget),
    campaignNames: stringList(row.campaignNames),
    businessManager: stringOf(row.businessManagerUserName),
    operationsManager: stringOf(row.operationsManagerUserName),
    pmManager: stringOf(row.pmManagerUserName),
    startTime: iso(row.startTime),
    endTime: iso(row.endTime),
    deadline: iso(row.deadline),
    createdTime: iso(row.createdTime),
    updatedTime: iso(row.updatedTime),
  };
}

/** 金额在库里可能是 Decimal128。 */
function decimalOf(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (value && typeof value === "object" && "toString" in value) {
    const parsed = Number(String(value));
    return Number.isFinite(parsed) ? parsed : null;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function influencerMailScope(order: OrderDoc): Filter<Document>[] {
  const blank = (field: string) => ({
    $or: [
      { [field]: { $exists: false } },
      { [field]: null },
      { [field]: "" },
    ],
  });
  const scope: Filter<Document>[] = [
    loose({ matchedInfluencerId: order.influencerId }),
    loose({ folder: { $in: ["INBOX", "SPAM", "SENT", "Inbox", "Sent", "Spam"] } }),
    loose({
      $or: [
        { projectFieldId: order.id },
        blank("projectFieldId"),
      ],
    }),
  ];
  if (order.projectId) {
    scope.push(loose({
      $or: [
        { projectId: order.projectId },
        { projectFieldId: order.id },
        blank("projectId"),
      ],
    }));
  }
  if (order.campaignId) {
    scope.push(loose({
      $or: [
        { campaignId: order.campaignId },
        { projectFieldId: order.id },
        blank("campaignId"),
      ],
    }));
  }
  return scope;
}

function loose(filter: Record<string, unknown>): Filter<Document> {
  return filter as Filter<Document>;
}

function pageFilter(query: PageQuery, timeField: string): Filter<Document> {
  const clauses: Filter<Document>[] = [];
  if (query.since) {
    const since = new Date(query.since);
    clauses.push(loose({
      $or: [{ [timeField]: { $gt: since } }, { updatedTime: { $gt: since } }],
    }));
  }
  if (query.afterId) {
    clauses.push(loose({ _id: { $gt: asId(query.afterId) } }));
  }
  if (clauses.length === 0) {
    return {};
  }
  if (clauses.length === 1) {
    return clauses[0]!;
  }
  return { $and: clauses };
}

function pageOf<T>(items: T[], limit: number): IdPage<T> {
  return { items, full: items.length >= limit };
}

async function client(uri: string): Promise<MongoClient> {
  const cached = clients.get(uri);
  if (cached) {
    return cached;
  }
  const opening = MongoClient.connect(uri, {
    serverSelectionTimeoutMS: 8_000,
    readPreference: "secondaryPreferred",
    // 变更记录里偶尔夹着半个表情：只有 UTF-16 高位，低位没写进库。
    // 严格按 UTF-8 会整张订单读失败。关掉校验后，这一处换成替换字符，其余文字照常读。
    enableUtf8Validation: false,
  });
  clients.set(uri, opening);
  try {
    return await opening;
  } catch (error) {
    clients.delete(uri);
    throw error;
  }
}

const CHOOSER_LIMIT = 5000;

export async function listChooserHeads(store: DeliveryStore, brandIds?: string[]): Promise<OpenOrderHead[]> {
  return store.listRecentHeads(CHOOSER_LIMIT, brandIds);
}

async function withProjects(database: Db, rows: Document[]): Promise<OpenOrderHead[]> {
  const projectIds = rows
    .map((row) => stringOf(row.projectId))
    .filter((id): id is string => Boolean(id));
  const names = new Map<string, string>();
  if (projectIds.length > 0) {
    const projects = await database
      .collection("projects")
      .find(loose({ _id: { $in: projectIds.map(asId) } }))
      .project({ name: 1 })
      .toArray();
    for (const project of projects) {
      const name = stringOf(project.name);
      if (name) {
        names.set(idOf(project._id), name);
      }
    }
  }
  return rows.map((row): OpenOrderHead => ({
    id: idOf(row._id),
    nickname: stringOf(row.nickname),
    projectName: names.get(stringOf(row.projectId) ?? ""),
    bloggerLink: stringOf(row.bloggerLink),
    status: stringOf(asRecord(row.selectedWorkflow)?.status),
  }));
}

function openFilter(
  extra: Record<string, unknown> = {},
  brand?: { brandIds: string[]; projectIds: string[] },
): Filter<Document> {
  const base = {
    isDeleted: { $ne: true },
    "viewFlags.inDeliveryView": true,
    ...extra,
  };
  if (!brand) {
    return loose(base);
  }
  return { $and: [loose(base), loose(orderBrandClause(brand.brandIds, brand.projectIds))] };
}

function orderBrandClause(brandIds: string[], projectIds: string[]): Record<string, unknown> {
  const or: Record<string, unknown>[] = [];
  if (brandIds.length > 0) {
    or.push({ brandId: { $in: brandIds } });
  }
  if (projectIds.length > 0) {
    or.push({ projectId: { $in: projectIds } });
  }
  if (or.length === 0) {
    return { _id: { $in: [] } };
  }
  if (or.length === 1) {
    return or[0]!;
  }
  return { $or: or };
}

async function projectIdsOfBrands(database: Db, brandIds: string[]): Promise<string[]> {
  const rows = await database
    .collection("projects")
    .find(loose({ isDeleted: false, brandId: { $in: brandIds } }))
    .project({ _id: 1 })
    .toArray();
  return rows.map((row) => idOf(row._id));
}

export async function listBrandChoices(
  uri: string,
  dbName: string,
): Promise<Array<{ value: string; label: { literal: string } }>> {
  const database = (await client(uri)).db(dbName);
  const rows = await database
    .collection("brands")
    .find(loose({ isDeleted: { $ne: true } }))
    .project({ brandName: 1 })
    .sort({ brandName: 1, _id: 1 })
    .limit(2_000)
    .toArray();
  return rows.map((row) => {
    const id = idOf(row._id);
    const name = stringOf(row.brandName) || id;
    return { value: id, label: { literal: name } };
  });
}

function mapOrder(row: Document): OrderDoc {
  const workflow = asRecord(row.selectedWorkflow);
  const bargain = asRecord(row.bargainTerms);
  const follows = Array.isArray(workflow?.followUpRecords) ? workflow.followUpRecords : [];
  return {
    id: idOf(row._id),
    projectId: stringOf(row.projectId),
    campaignId: stringOf(row.campaignId),
    influencerId: stringOf(row.influencerId),
    nickname: stringOf(row.nickname),
    platform: stringOf(row.platform),
    bloggerLink: stringOf(row.bloggerLink),
    externalQuote: numberOf(row.externalQuote),
    influencerQuote: numberOf(row.influencerQuote),
    settlementMethod: stringOf(row.settlementMethod),
    cooperationBenefits: stringOf(row.cooperationBenefits),
    bargainServiceFeeUsd: numberOf(row.bargainServiceFeeUsd),
    bargainValueAddedFeeUsd: numberOf(row.bargainValueAddedFeeUsd),
    status: stringOf(workflow?.status),
    inDeliveryView: asRecord(row.viewFlags)?.inDeliveryView === true,
    scriptLink: stringOf(workflow?.finalScriptLink),
    publishLinks: stringsOf(workflow?.publishLinks).length > 0
      ? stringsOf(workflow?.publishLinks)
      : stringsOf(workflow?.publishLink),
    isDeleted: row.isDeleted === true,
    createdTime: iso(row.createdTime),
    updatedTime: iso(row.updatedTime),
    sharedScene: stringOf(bargain?.sharedScene),
    reviewNeeded: row.deliveryHumanReviewNeeded === true,
    reviewReason: stringOf(row.deliveryHumanReviewReason),
    reviewHint: stringOf(row.deliveryHumanReviewHint),
    reviewHandler: stringOf(row.deliveryHumanReviewHandler),
    reviewAt: iso(row.deliveryHumanReviewNeededAt),
    follows: follows.map((item) => {
      const follow = asRecord(item) ?? {};
      return {
        followTime: iso(follow.followTime),
        followerName: stringOf(follow.followerName),
        followContent: stringOf(follow.followContent),
        followType: stringOf(follow.followType),
        followResult: stringOf(follow.followResult),
        selectedStatus: stringOf(follow.selectedStatus),
        attachmentUrls: stringsOf(follow.attachmentUrls),
        reviewType: stringOf(follow.deliveryCustomerReviewType),
        materialLinks: stringsOf(follow.deliveryCustomerReviewMaterialSnapshot),
      };
    }),
  };
}

function mapProject(row: Document): ProjectDoc {
  return {
    id: idOf(row._id),
    name: stringOf(row.name),
    briefUrl: stringOf(row.briefUrl),
    briefType: stringOf(row.briefType),
    briefText: stringOf(row.briefText),
    benefits: stringOf(row.benefits),
    brandProjectInfo: stringOf(row.brandProjectInfo),
    brandProjectInfoEnglish: stringOf(row.brandProjectInfoEnglish),
    demands: stringOf(row.demands),
    updatedTime: iso(row.updatedTime) ?? iso(row.demandsUpdatedTime),
  };
}

function mapMail(row: Document): MailDoc {
  return {
    id: idOf(row._id),
    projectFieldId: stringOf(row.projectFieldId),
    projectId: stringOf(row.projectId),
    campaignId: stringOf(row.campaignId),
    folder: stringOf(row.folder),
    from: stringOf(row.from),
    to: stringList(row.to),
    subject: stringOf(row.subject),
    content: stringOf(row.content),
    htmlContent: stringOf(row.htmlContent),
    sentDate: iso(row.sentDate) ?? iso(row.receivedDate),
    updatedTime: iso(row.updatedTime),
  };
}

function mapLog(row: Document): LogDoc {
  const changes = Array.isArray(row.changes) ? row.changes : [];
  return {
    id: idOf(row._id),
    logTime: iso(row.logTime),
    changeType: stringOf(row.changeType),
    operatorName: stringOf(row.operatorName),
    reason: stringOf(row.reason),
    changes: changes.map((item) => {
      const change = asRecord(item) ?? {};
      return {
        fieldName: stringOf(change.fieldName),
        oldValue: stringOf(change.oldValue),
        newValue: stringOf(change.newValue),
      };
    }),
  };
}

function mapDecision(row: Document): DecisionDoc {
  const ask = parseAsk(row.askJson);
  return {
    id: idOf(row._id),
    updatedAt: iso(row.updatedAt),
    reason: stringOf(row.reason),
    hint: stringOf(row.hint),
    questionText: stringOf(row.questionText),
    waitingOn: stringOf(row.waitingOn),
    ask,
  };
}

function parseAsk(raw: unknown): DecisionDoc["ask"] {
  const value = typeof raw === "string" ? safeJson(raw) : asRecord(raw);
  if (!value) {
    return undefined;
  }
  const facts = Array.isArray(value.facts) ? value.facts : [];
  return {
    party: stringOf(value.party),
    lead: stringOf(value.lead),
    scriptTemplate: stringOf(value.scriptTemplate),
    facts: facts.map((item) => {
      const fact = asRecord(item) ?? {};
      return { kind: stringOf(fact.kind), value: stringOf(fact.value) };
    }),
  };
}

function safeJson(raw: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function asId(id: string): ObjectId | string {
  return /^[a-f0-9]{24}$/i.test(id) ? new ObjectId(id) : id;
}

function idOf(value: unknown): string {
  if (value instanceof ObjectId) {
    return value.toHexString();
  }
  return String(value ?? "");
}

function stringList(value: unknown): string[] | undefined {
  const items = Array.isArray(value) ? value : value == null ? [] : [value];
  const texts = items.map((item) => stringOf(item)).filter((item): item is string => Boolean(item));
  return texts.length > 0 ? texts : undefined;
}

function stringsOf(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : value == null ? [] : [value];
  const seen = new Set<string>();
  const links: string[] = [];
  for (const item of raw) {
    const text = stringOf(item);
    if (text && !seen.has(text)) {
      seen.add(text);
      links.push(text);
    }
  }
  return links;
}

function stringOf(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function iso(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}
