import { MongoClient, ObjectId, type Db, type Document, type Filter } from "mongodb";
import { OPEN_STATUSES } from "./status";
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
} from "./model";

const clients = new Map<string, Promise<MongoClient>>();

export function mongoStore(uri: string, dbName: string): DeliveryStore {
  const db = () => client(uri).then((mongo) => mongo.db(dbName));
  return {
    async listOpenIds(afterId, limit) {
      const database = await db();
      const rows = await database
        .collection("project_fields")
        .find(openFilter(afterId ? { _id: { $gt: asId(afterId) } } : {}))
        .sort({ _id: 1 })
        .limit(limit)
        .project({ nickname: 1, projectId: 1, bloggerLink: 1 })
        .toArray();
      return withProjects(database, rows);
    },

    async listRecentHeads(limit) {
      const database = await db();
      const rows = await database
        .collection("project_fields")
        .find(openFilter())
        .sort({ "submitWorkflow.submitTime": -1, createdTime: -1, _id: -1 })
        .limit(limit)
        .project({ nickname: 1, projectId: 1, bloggerLink: 1 })
        .toArray();
      return withProjects(database, rows);
    },

    async listHeadsByIds(ids) {
      const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
      if (unique.length === 0) {
        return [];
      }
      const database = await db();
      const rows = await database
        .collection("project_fields")
        .find(openFilter({ _id: { $in: unique.map(asId) } }))
        .project({ nickname: 1, projectId: 1, bloggerLink: 1 })
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

export async function listChooserHeads(store: DeliveryStore): Promise<OpenOrderHead[]> {
  return store.listRecentHeads(CHOOSER_LIMIT);
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
  }));
}

function openFilter(extra: Record<string, unknown> = {}): Filter<Document> {
  return loose({
    isDeleted: { $ne: true },
    "selectedWorkflow.status": { $in: [...OPEN_STATUSES] },
    ...extra,
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
