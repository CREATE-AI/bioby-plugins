import {
  MongoClient,
  ObjectId,
  type Collection,
  type Db,
  type Document,
  type Filter,
  type FindCursor,
  type FindOptions,
} from "mongodb";
import { narrowProjectIds } from "./brands";
import { decodeDocument } from "./stored-text";
import { bareMessageId, campaignIdsOf } from "./model";
import type {
  CollectionDoc,
  DecisionDoc,
  DeliveryStore,
  IdPage,
  LogDoc,
  MailDoc,
  OpenOrderHead,
  OrderDoc,
  OrderListScope,
  PageQuery,
  ProjectDoc,
  ProjectInfoDoc,
  ProjectOrderRow,
  ProjectStore,
} from "./model";

const clients = new Map<string, Promise<MongoClient>>();

export function mongoStore(uri: string, dbName: string): DeliveryStore {
  const db = () => openConfiguredDb(uri, dbName);
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
    async listOpenIds(afterId, limit, brandIds, scope, projectIds) {
      const database = await db();
      const brand = await scopeFor(database, brandIds);
      const rows = await database
        .collection("project_fields")
        .find(openFilter(afterId ? { _id: { $gt: asId(afterId) } } : {}, brand, scope, projectIds))
        .sort({ _id: 1 })
        .limit(limit)
        .project(ORDER_HEAD_FIELDS)
        .toArray();
      return withProjects(database, rows);
    },

    async listRecentHeads(limit, brandIds, projectIds) {
      const database = await db();
      const brand = await scopeFor(database, brandIds);
      const rows = await database
        .collection("project_fields")
        .find(openFilter({}, brand, undefined, projectIds))
        .sort({ "submitWorkflow.submitTime": -1, createdTime: -1, _id: -1 })
        .limit(limit)
        .project(ORDER_HEAD_FIELDS)
        .toArray();
      return withProjects(database, rows);
    },

    async listHeadsByIds(ids, brandIds, projectIds) {
      const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
      if (unique.length === 0) {
        return [];
      }
      const database = await db();
      const brand = await scopeFor(database, brandIds);
      const rows = await database
        .collection("project_fields")
        .find(openFilter({ _id: { $in: unique.map(asId) } }, brand, undefined, projectIds))
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
      const database = await db();
      const row = await database.collection("project_fields").findOne(loose({ _id: asId(id) }));
      if (!row) {
        return null;
      }
      const order = mapOrder(row);
      order.projectCampaignIds = await campaignIdsUnderProject(database, order.projectId);
      return order;
    },

    async readProject(id) {
      const row = await (await db()).collection("projects").findOne(loose({ _id: asId(id) }));
      return row ? mapProject(row) : null;
    },

    async listMails(order, query, limit) {
      if (!order.influencerId) {
        return { items: [], full: false };
      }
      const database = await db();
      if (!order.projectCampaignIds) {
        order.projectCampaignIds = await campaignIdsUnderProject(database, order.projectId);
      }
      const scope: Filter<Document>[] = [
        ...influencerMailScope(order),
        pageFilter(query, "sentDate"),
      ];
      const rows = await database
        .collection("emailInbox")
        .find({ $and: scope })
        .sort(query.since ? { sentDate: 1, _id: 1 } : { _id: 1 })
        .limit(limit)
        .toArray();
      const mails = rows.map(mapMail);
      await attachSenders(database, mails);
      return pageOf(mails, limit);
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
  const db = () => openConfiguredDb(uri, dbName);
  return {
    async listProjects(limit, brandIds, projectIds) {
      const filter: Record<string, unknown> = { isDeleted: false };
      if (brandIds) {
        filter.brandId = { $in: brandIds };
      }
      const picked = [...new Set((projectIds ?? []).map((id) => id.trim()).filter(Boolean))];
      if (picked.length > 0) {
        filter._id = { $in: picked.map(asId) };
      }
      let query = (await db())
        .collection("projects")
        .find(loose(filter))
        .sort({ createdTime: -1, _id: -1 })
        .project({ name: 1 });
      if (picked.length === 0 && limit != null) {
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

    async listProjectOrders(projectId) {
      const rows = await (await db())
        .collection("project_fields")
        .find(openFilter({ projectId }))
        .sort({ "selectedWorkflow.selectedTime": 1, _id: 1 })
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
  deliveryOperationsUserName: 1,
  "selectedWorkflow.status": 1,
  "selectedWorkflow.selectedTime": 1,
  "selectedWorkflow.currentFollowerName": 1,
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
  const campaigns = campaignIdsOf(order);
  const sameProjectCampaign = campaigns.length === 0
    ? []
    : [{
      $and: [
        blank("projectFieldId"),
        campaigns.length === 1 ? { campaignId: campaigns[0] } : { campaignId: { $in: campaigns } },
        ...(order.projectId ? [{
          $or: [
            { projectId: order.projectId },
            ...blank("projectId").$or,
          ],
        }] : []),
      ],
    }];
  return [
    loose({ matchedInfluencerId: order.influencerId }),
    loose({ folder: { $in: ["INBOX", "SPAM", "SENT", "Inbox", "Sent", "Spam"] } }),
    loose({
      $or: [
        { projectFieldId: order.id },
        ...sameProjectCampaign,
      ],
    }),
  ];
}

async function campaignIdsUnderProject(database: Db, projectId: string | undefined): Promise<string[]> {
  const project = projectId?.trim();
  if (!project) {
    return [];
  }
  const rows = await database.collection("campaigns").find(
    loose({ projectId: project }),
    { projection: { _id: 1 } },
  ).toArray();
  return rows.map((row) => idOf(row._id)).filter(Boolean);
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

/** 只打开配置的那个库。连接串路径里的库名不相同的时候，只留作登录，不拿来查数据。 */
export function pinDatabaseUri(uri: string, dbName: string): string {
  const name = requireDbName(dbName);
  const match = uri.match(/^(mongodb(?:\+srv)?:\/\/[^/?]*)(?:\/([^?]*))?(\?.*)?$/i);
  if (!match) {
    throw new Error("MongoDB 连接串不对");
  }
  const [, base, path = "", query = ""] = match;
  const current = path ? decodeURIComponent(path) : "";
  if (current === name) {
    return uri;
  }
  const params = new URLSearchParams(query.startsWith("?") ? query.slice(1) : "");
  if (!params.has("authSource")) {
    params.set("authSource", current || "admin");
  }
  const suffix = params.toString();
  return `${base}/${encodeURIComponent(name)}${suffix ? `?${suffix}` : ""}`;
}

async function openConfiguredDb(uri: string, dbName: string): Promise<Db> {
  const name = requireDbName(dbName);
  const mongo = await client(pinDatabaseUri(uri, name));
  const database = mongo.db(name);
  if (database.databaseName !== name) {
    throw new Error("连接器只能使用配置的数据库");
  }
  return readingDb(database, name);
}

function requireDbName(dbName: string): string {
  const name = dbName.trim();
  if (!name || /[/?#\\\s\0]/.test(name)) {
    throw new Error("没有配置数据库名");
  }
  return name;
}

async function client(uri: string): Promise<MongoClient> {
  const cached = clients.get(uri);
  if (cached) {
    return cached;
  }
  const opening = MongoClient.connect(uri, {
    serverSelectionTimeoutMS: 8_000,
    readPreference: "secondaryPreferred",
  });
  clients.set(uri, opening);
  try {
    return await opening;
  } catch (error) {
    clients.delete(uri);
    throw error;
  }
}

function readingDb(database: Db, name: string): Db {
  return new Proxy(database, {
    get(target, prop, receiver) {
      if (prop === "client" || prop === "admin" || prop === "command") {
        throw new Error("连接器只能使用配置的数据库");
      }
      if (prop === "databaseName") {
        return name;
      }
      if (prop === "collection") {
        return (collectionName: string, options?: Parameters<Db["collection"]>[1]) =>
          readingCollection(target.collection(collectionName, options));
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function readingCollection<T extends Document>(collection: Collection<T>): Collection<T> {
  return new Proxy(collection, {
    get(target, prop, receiver) {
      if (prop === "find") {
        return (filter?: Filter<T>, options?: FindOptions) =>
          readingCursor(target.find(filter as Filter<T>, { ...options, raw: true }));
      }
      if (prop === "findOne") {
        return async (filter?: Filter<T>, options?: FindOptions) => {
          const raw = await target.findOne(filter as Filter<T>, { ...options, raw: true });
          return raw == null ? null : decoded(raw);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function readingCursor(cursor: FindCursor): FindCursor {
  return new Proxy(cursor, {
    get(target, prop, receiver) {
      if (prop === "toArray") {
        return async () => (await target.toArray()).map((row) => decoded(row));
      }
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const result = value.apply(target, args);
        return result === target ? receiver : result;
      };
    },
  });
}

function decoded(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return decodeDocument(value);
  }
  return value;
}

const CHOOSER_LIMIT = 5000;

export async function listChooserHeads(
  store: DeliveryStore,
  brandIds?: string[],
  projectIds?: string[],
): Promise<OpenOrderHead[]> {
  return store.listRecentHeads(CHOOSER_LIMIT, brandIds, projectIds);
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
  return rows.map((row): OpenOrderHead => {
    const workflow = asRecord(row.selectedWorkflow);
    return {
      id: idOf(row._id),
      nickname: stringOf(row.nickname),
      projectName: names.get(stringOf(row.projectId) ?? ""),
      bloggerLink: stringOf(row.bloggerLink),
      status: stringOf(workflow?.status),
      selectedTime: iso(workflow?.selectedTime),
      deliveryOwner: stringOf(row.deliveryOperationsUserName) ?? stringOf(workflow?.currentFollowerName),
    };
  });
}

function openFilter(
  extra: Record<string, unknown> = {},
  brand?: { brandIds: string[]; projectIds: string[] },
  scope?: OrderListScope,
  selectedProjectIds?: string[],
): Filter<Document> {
  const view = scope === "after_external"
    ? {
      $or: [
        { "viewFlags.inDeliveryView": true },
        // 审核中。已外提之后，提报状态会变成 REVIEWING。
        { "viewFlags.inSubmitView": true, "submitWorkflow.status": "REVIEWING" },
      ],
    }
    : { "viewFlags.inDeliveryView": true };
  const base = {
    isDeleted: { $ne: true },
    ...view,
    ...extra,
  };
  if (!brand) {
    return loose(base);
  }
  return { $and: [loose(base), loose(orderScopeClause(brand.brandIds, brand.projectIds, selectedProjectIds))] };
}

/** 没选项目时按品牌收。选了项目就只按这些项目的编号收，不再把品牌下其他项目并进来。 */
export function orderScopeClause(
  brandIds: string[],
  brandProjectIds: string[],
  selectedProjectIds?: string[],
): Record<string, unknown> {
  const narrowed = narrowProjectIds(brandProjectIds, selectedProjectIds);
  if (narrowed.restricted) {
    if (narrowed.ids.length === 0) {
      return { _id: { $in: [] } };
    }
    return { projectId: { $in: narrowed.ids } };
  }
  return orderBrandClause(brandIds, brandProjectIds);
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
): Promise<Array<{ value: string; label: { literal: string }; title?: string }>> {
  const database = await openConfiguredDb(uri, dbName);
  const rows = await database
    .collection("brands")
    .find(loose({ isDeleted: { $ne: true } }))
    .project({ brandName: 1 })
    .sort({ brandName: 1, _id: 1 })
    .limit(2_000)
    .toArray();
  return rows.map(brandChoice);
}

/** 没删除的项目，只含这些品牌。名称从 a 到 z，同名再按编号。 */
export async function listProjectChoices(
  uri: string,
  dbName: string,
  brandIds: readonly string[],
): Promise<Array<{ value: string; label: { literal: string }; title?: string }>> {
  const unique = [...new Set(brandIds.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) {
    return [];
  }
  const database = await openConfiguredDb(uri, dbName);
  const rows = await database
    .collection("projects")
    .find(loose({ isDeleted: false, brandId: { $in: unique } }))
    .project({ name: 1 })
    .sort({ name: 1, _id: 1 })
    .limit(2_000)
    .toArray();
  return rows.map(projectChoice);
}

/** 按已保存的项目编号去库里对名称，不依赖它是不是还在当前品牌这一页里。 */
export async function listProjectChoicesByIds(
  uri: string,
  dbName: string,
  ids: readonly string[],
): Promise<Array<{ value: string; label: { literal: string }; title?: string }>> {
  const unique = uniqueIds(ids);
  if (unique.length === 0) {
    return [];
  }
  const database = await openConfiguredDb(uri, dbName);
  const rows = await database
    .collection("projects")
    .find(loose({ _id: { $in: unique.map(asId) }, isDeleted: { $ne: true } }))
    .project({ name: 1 })
    .toArray();
  return rows.map(projectChoice);
}

/** 按已保存的品牌编号去库里对名称，不依赖当前这一页有没有把它列出来。 */
export async function listBrandChoicesByIds(
  uri: string,
  dbName: string,
  ids: readonly string[],
): Promise<Array<{ value: string; label: { literal: string }; title?: string }>> {
  const unique = uniqueIds(ids);
  if (unique.length === 0) {
    return [];
  }
  const database = await openConfiguredDb(uri, dbName);
  const rows = await database
    .collection("brands")
    .find(loose({ _id: { $in: unique.map(asId) }, isDeleted: { $ne: true } }))
    .project({ brandName: 1 })
    .toArray();
  return rows.map(brandChoice);
}

export async function listOrderHeadsByIds(
  uri: string,
  dbName: string,
  ids: readonly string[],
): Promise<OpenOrderHead[]> {
  const unique = uniqueIds(ids);
  if (unique.length === 0) {
    return [];
  }
  const database = await openConfiguredDb(uri, dbName);
  const rows = await database
    .collection("project_fields")
    .find(loose({ _id: { $in: unique.map(asId) } }))
    .project(ORDER_HEAD_FIELDS)
    .toArray();
  return withProjects(database, rows);
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))].slice(0, 200);
}

function brandChoice(row: Document): { value: string; label: { literal: string }; title?: string } {
  const id = idOf(row._id);
  const name = stringOf(row.brandName) || id;
  return {
    value: id,
    label: { literal: name },
    ...(name !== id ? { title: name } : {}),
  };
}

function projectChoice(row: Document): { value: string; label: { literal: string }; title?: string } {
  const id = idOf(row._id);
  const name = stringOf(row.name) || id;
  return {
    value: id,
    label: { literal: name },
    ...(name !== id ? { title: id } : {}),
  };
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
    cooperationBenefitsManual: row.cooperationBenefitsManual === true,
    targetBargainPrice: stringOf(row.targetBargainPrice),
    customerOtherRequirements: stringOf(row.customerOtherRequirements),
    bargainServiceFeeUsd: numberOf(row.bargainServiceFeeUsd),
    bargainValueAddedFeeUsd: numberOf(row.bargainValueAddedFeeUsd),
    status: stringOf(workflow?.status),
    inDeliveryView: asRecord(row.viewFlags)?.inDeliveryView === true,
    inExternalSubmit: asRecord(row.viewFlags)?.inSubmitView === true
      && stringOf(asRecord(row.submitWorkflow)?.status) === "REVIEWING",
    scriptLink: stringOf(workflow?.finalScriptLink),
    publishLinks: stringsOf(workflow?.publishLinks).length > 0
      ? stringsOf(workflow?.publishLinks)
      : stringsOf(workflow?.publishLink),
    deliveryOwner: stringOf(row.deliveryOperationsUserName) ?? stringOf(workflow?.currentFollowerName),
    selectedRemark: stringOf(workflow?.selectedRemark),
    publishTime: iso(workflow?.publishTime),
    isDeleted: row.isDeleted === true,
    createdTime: iso(row.createdTime),
    updatedTime: iso(row.updatedTime),
    sharedScene: stringOf(bargain?.sharedScene),
    reviewNeeded: row.deliveryHumanReviewNeeded === true,
    reviewReason: stringOf(row.deliveryHumanReviewReason),
    reviewHint: stringOf(row.deliveryHumanReviewHint),
    reviewHandler: stringOf(row.deliveryHumanReviewHandler),
    reviewAt: iso(row.deliveryHumanReviewNeededAt),
    collections: mapCollections(row),
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
        followerId: stringOf(follow.followerId),
        sent: follow.sent === true,
        sentMessageId: bareMessageId(stringOf(follow.sentEmailMessageId)),
      };
    }),
  };
}

function mapCollections(row: Document): CollectionDoc[] {
  const payment = asRecord(row.paymentWorkflow);
  const list = Array.isArray(payment?.collectionRecords) ? payment.collectionRecords : [];
  const records: CollectionDoc[] = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }
    records.push({
      customerRecordId: stringOf(record.customerCollectionRecordId),
      date: iso(record.collectionDate),
      amount: numberOf(record.collectionAmount),
      method: stringOf(record.collectionMethod),
      collectionId: stringOf(record.collectionId),
      voucher: stringOf(record.collectionVoucher),
      remark: stringOf(record.collectionRemark),
      operatorName: stringOf(record.operatorName),
      status: stringOf(record.collectionRecordStatus),
    });
  }
  return records;
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
    messageId: bareMessageId(stringOf(row.messageId)),
  };
}

/** 已发送的信按 messageId 去 outbound_email_sender 查是谁发的。表还没有或查不到时不填。 */
async function attachSenders(database: Db, mails: MailDoc[]): Promise<void> {
  const sent = mails.filter((mail) => mail.messageId && (mail.folder ?? "").toUpperCase() === "SENT");
  if (sent.length === 0) {
    return;
  }
  const ids = [...new Set(sent.map((mail) => mail.messageId!))];
  const rows = await database
    .collection("outbound_email_sender")
    .find(loose({ messageId: { $in: ids } }))
    .project({ messageId: 1, sentByUserId: 1, sentByUserName: 1, automatic: 1 })
    .toArray();
  const byId = new Map<string, Document>();
  for (const row of rows) {
    const id = stringOf(row.messageId);
    if (id) {
      byId.set(id, row);
    }
  }
  for (const mail of sent) {
    const row = byId.get(mail.messageId!);
    if (!row) {
      continue;
    }
    const userId = stringOf(row.sentByUserId) ?? "";
    mail.sentBy = {
      name: stringOf(row.sentByUserName),
      automatic: row.automatic === true || userId.toLowerCase().startsWith("system:"),
    };
  }
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
