import type { IngestRecord } from "@regenic/domain";
import { isOpenStatus, statusLabel } from "./status";
import { customerScriptFromAsk, customerScriptFromScene } from "./sentences";
import { stepRecord, type StepDraft } from "./records";
import { latestMailText } from "./mail-text";
import { compactTime, shortHash, stepToken, withOffsets } from "./time";
import {
  isAutoNote,
  logChangesStatus,
  mailBelongs,
  type DecisionDoc,
  type DeliveryStore,
  type LogDoc,
  type MailDoc,
  type OrderDoc,
  type ProjectDoc,
} from "./model";

export interface OrderCursor {
  v: 1;
  stage: "context" | "mails" | "notes" | "logs" | "decisions" | "tail" | "live";
  fp: Record<string, string>;
  status?: string;
  reviewAt?: string;
  script?: string;
  projectFp?: string;
  follows: Record<string, string>;
  auto: string[];
  notices: { customer?: string; ops?: string };
  asks: DecisionDoc[];
  mailAfter: string | null;
  logAfter: string | null;
  decisionAfter: string | null;
  noteSkip: number;
  sawStatusLog: boolean;
  watermark: string | null;
  ended?: boolean;
  /** 每拉一页加一。内核的 live / history 两条游标可能落后，用它判断哪份更新。 */
  seq?: number;
  /** 旧消息曾被标成系统，界面会折起正文。补写过一次就不再补。 */
  face?: number;
  mailRewind?: "started" | "done";
  /** 邮件正文去掉历史引用后，已同步过的旧邮件要再读一遍。 */
  mailText?: number;
  decisionRewind?: "started" | "done";
}

export function emptyOrderCursor(): OrderCursor {
  return {
    v: 1,
    stage: "context",
    fp: {},
    follows: {},
    auto: [],
    notices: {},
    asks: [],
    mailAfter: null,
    logAfter: null,
    decisionAfter: null,
    noteSkip: 0,
    sawStatusLog: false,
    watermark: null,
  };
}

export function parseOrderCursor(raw: string | null | undefined): OrderCursor {
  if (!raw) {
    return emptyOrderCursor();
  }
  try {
    const parsed = JSON.parse(raw) as Partial<OrderCursor>;
    if (parsed.v !== 1 || !parsed.fp || typeof parsed.fp !== "object") {
      return emptyOrderCursor();
    }
    return {
      ...emptyOrderCursor(),
      ...parsed,
      v: 1,
      fp: parsed.fp,
      follows: parsed.follows ?? {},
      auto: parsed.auto ?? [],
      notices: parsed.notices ?? {},
      asks: parsed.asks ?? [],
      noteSkip: parsed.noteSkip ?? 0,
      sawStatusLog: parsed.sawStatusLog === true,
    };
  } catch {
    return emptyOrderCursor();
  }
}

const NEXT_STAGE = {
  context: "mails",
  mails: "notes",
  notes: "logs",
  logs: "decisions",
  decisions: "tail",
  tail: "live",
  live: "live",
} as const;

export async function advanceDelivery(input: {
  orderId: string;
  order: OrderDoc | null;
  project: ProjectDoc | null;
  store: DeliveryStore;
  cursor: OrderCursor;
  pageSize: number;
  now: string;
}): Promise<{ records: IngestRecord[]; cursor: OrderCursor; hasMore: boolean; wroteEnd: boolean }> {
  const cursor = input.cursor;
  cursor.seq = (cursor.seq ?? 0) + 1;
  if (!input.order || input.order.isDeleted || !isOpenStatus(input.order.status)) {
    return finishClosed(input.orderId, input.order, input.project, cursor, input.now);
  }
  const order = input.order;
  const label = conversationLabel(order, input.project);
  const records: IngestRecord[] = [];
  if ((cursor.face ?? 0) < 1) {
    emit(order, label, cursor, records, storedFaceSteps(order, input.project, cursor));
    cursor.face = 1;
  }
  if ((cursor.face ?? 0) < 2) {
    emit(order, label, cursor, records, summaryDrops(order, cursor));
    cursor.face = 2;
  }
  let hasMore = false;
  let guard = 0;
  while (records.length < input.pageSize && guard < 8) {
    guard += 1;
    if (cursor.stage === "live") {
      hasMore = await pullLive(input, cursor, label, records);
      break;
    }
    const more = await pullHistoryStage(input, cursor, label, records, input.pageSize - records.length);
    if (more) {
      hasMore = true;
      break;
    }
    if (cursor.stage === "tail") {
      cursor.stage = "live";
      cursor.sawStatusLog = false;
      break;
    }
    cursor.stage = NEXT_STAGE[cursor.stage];
  }
  return {
    records,
    cursor,
    hasMore: hasMore || cursor.stage !== "live",
    wroteEnd: false,
  };
}

async function pullHistoryStage(
  input: Parameters<typeof advanceDelivery>[0],
  cursor: OrderCursor,
  label: string,
  records: IngestRecord[],
  budget: number,
): Promise<boolean> {
  const order = input.order!;
  if (cursor.stage === "context") {
    emit(order, label, cursor, records, contextSteps(order, input.project, cursor, false));
    return false;
  }
  if (cursor.stage === "mails") {
    return pullMails(input, cursor, label, records, budget, false);
  }
  if (cursor.stage === "notes") {
    const notes = noteSteps(order, cursor, hasRealMail(cursor));
    const slice = notes.slice(cursor.noteSkip, cursor.noteSkip + budget);
    cursor.noteSkip += slice.length;
    emit(order, label, cursor, records, slice);
    return cursor.noteSkip < notes.length;
  }
  if (cursor.stage === "logs") {
    return pullLogs(input, cursor, label, records, budget, false);
  }
  if (cursor.stage === "decisions") {
    return pullDecisions(input, cursor, label, records, budget, false);
  }
  emit(order, label, cursor, records, tailSteps(order, input.project, cursor, input.now));
  return false;
}

async function pullLive(
  input: Parameters<typeof advanceDelivery>[0],
  cursor: OrderCursor,
  label: string,
  records: IngestRecord[],
  ): Promise<boolean> {
  const order = input.order!;
  const budget = input.pageSize;
  emit(order, label, cursor, records, contextSteps(order, input.project, cursor, true));
  const mailsMore = await pullMails(input, cursor, label, records, budget, true);
  const notes = noteSteps(order, cursor, hasRealMail(cursor));
  emit(order, label, cursor, records, notes);
  const logsMore = await pullLogs(input, cursor, label, records, budget, true);
  const decisionsMore = await pullDecisions(input, cursor, label, records, budget, true);
  const more = mailsMore || logsMore || decisionsMore;
  if (!more) {
    emit(order, label, cursor, records, tailSteps(order, input.project, cursor, input.now));
    cursor.sawStatusLog = false;
    cursor.mailAfter = null;
    cursor.logAfter = null;
    cursor.decisionAfter = null;
  }
  return more;
}

async function pullMails(
  input: Parameters<typeof advanceDelivery>[0],
  cursor: OrderCursor,
  label: string,
  records: IngestRecord[],
  budget: number,
  live: boolean,
): Promise<boolean> {
  const order = input.order!;
  if (!order.influencerId) {
    cursor.mailAfter = null;
    return false;
  }
  if ((cursor.mailText ?? 0) < MAIL_TEXT_VERSION && cursor.mailRewind === "done") {
    cursor.mailAfter = null;
    cursor.mailRewind = "started";
  }
  if (!cursor.mailRewind) {
    cursor.mailAfter = null;
    cursor.mailRewind = "started";
  }
  const page = await input.store.listMails(
    order,
    {
      afterId: cursor.mailAfter,
      since: cursor.mailRewind === "done" && live ? cursor.watermark : null,
    },
    budget,
  );
  if (!page.full) {
    cursor.mailRewind = "done";
    cursor.mailText = MAIL_TEXT_VERSION;
  }
  const steps = page.items.filter((mail) => mailBelongs(mail, order)).map((mail) => mailStep(mail, order.nickname));
  emit(order, label, cursor, records, steps);
  const last = page.items[page.items.length - 1];
  cursor.mailAfter = page.full && last ? last.id : null;
  bumpWatermark(cursor, last?.updatedTime ?? last?.sentDate);
  return page.full;
}

async function pullLogs(
  input: Parameters<typeof advanceDelivery>[0],
  cursor: OrderCursor,
  label: string,
  records: IngestRecord[],
  budget: number,
  live: boolean,
): Promise<boolean> {
  const page = await input.store.listLogs(
    input.order!.id,
    { afterId: cursor.logAfter, since: live ? cursor.watermark : null },
    budget,
  );
  if (page.items.some(logChangesStatus)) {
    cursor.sawStatusLog = true;
    cursor.status = input.order!.status;
  }
  emit(input.order!, label, cursor, records, page.items.map(logStep));
  const last = page.items[page.items.length - 1];
  cursor.logAfter = page.full && last ? last.id : null;
  bumpWatermark(cursor, last?.logTime);
  return page.full;
}

async function pullDecisions(
  input: Parameters<typeof advanceDelivery>[0],
  cursor: OrderCursor,
  label: string,
  records: IngestRecord[],
  budget: number,
  live: boolean,
): Promise<boolean> {
  if (!cursor.decisionRewind) {
    cursor.decisionAfter = null;
    cursor.decisionRewind = "started";
  }
  const page = await input.store.listDecisions(
    input.order!.id,
    {
      afterId: cursor.decisionAfter,
      since: cursor.decisionRewind === "done" && live ? cursor.watermark : null,
    },
    budget,
  );
  if (!page.full) {
    cursor.decisionRewind = "done";
  }
  cursor.asks = [...cursor.asks, ...page.items].slice(-30);
  const last = page.items[page.items.length - 1];
  cursor.decisionAfter = page.full && last ? last.id : null;
  bumpWatermark(cursor, last?.updatedAt);
  return page.full;
}

function finishClosed(
  orderId: string,
  order: OrderDoc | null,
  project: ProjectDoc | null,
  cursor: OrderCursor,
  now: string,
): { records: IngestRecord[]; cursor: OrderCursor; hasMore: boolean; wroteEnd: boolean } {
  const status = order?.isDeleted || !order ? "DELETED" : (order.status ?? "DELETED");
  const at = order?.updatedTime || now;
  const suffix = `end-${stepToken(status)}-${compactTime(at)}`;
  const text = order
    ? `订单结束：${statusLabel(status)}`
    : "订单已经不在库里，按删除结束。";
  const label = order ? conversationLabel(order, project) : orderId;
  const records = emit(
    { id: orderId },
    label,
    cursor,
    [],
    [{ suffix, at, kind: "end", text, actor: "assistant", speaker: "系统" }],
  );
  cursor.ended = true;
  cursor.stage = "live";
  cursor.status = status;
  return { records, cursor, hasMore: false, wroteEnd: true };
}

function emit(
  order: { id: string },
  label: string,
  cursor: OrderCursor,
  records: IngestRecord[],
  steps: StepDraft[],
): IngestRecord[] {
  const stamped = withOffsets(steps);
  for (const step of stamped) {
    const hash = shortHash(
      step.tombstone ? `tombstone:${step.suffix}` : `${step.actor}\n${step.speaker}\n${step.text}`,
    );
    const previous = cursor.fp[step.suffix];
    if (!step.tombstone && previous === hash) {
      continue;
    }
    if (step.tombstone && !previous) {
      continue;
    }
    const operation = step.tombstone ? "tombstone" : previous ? "revise" : "create";
    records.push(stepRecord({ orderId: order.id, label, step, occurredAt: step.occurredAt, operation }));
    if (step.tombstone) {
      delete cursor.fp[step.suffix];
    } else {
      cursor.fp[step.suffix] = hash;
    }
    bumpWatermark(cursor, step.at);
  }
  return records;
}

function tailSteps(
  order: OrderDoc,
  project: ProjectDoc | null,
  cursor: OrderCursor,
  now: string,
): StepDraft[] {
  const steps: StepDraft[] = [];
  if (cursor.status !== order.status && !cursor.sawStatusLog) {
    const at = order.updatedTime || now;
    steps.push({
      suffix: `status-${compactTime(at)}-${stepToken(order.status ?? "UNKNOWN")}`,
      at,
      kind: "status",
      actor: "assistant",
      speaker: "状态",
      text: `交付状态：${statusLabel(order.status)}`,
    });
    cursor.status = order.status;
  }
  steps.push(...noticeSteps(order, cursor, now));
  void project;
  return steps;
}

function summaryDrops(order: OrderDoc, cursor: OrderCursor): StepDraft[] {
  const at = order.updatedTime || order.createdTime || new Date(0).toISOString();
  return Object.keys(cursor.fp)
    .filter((suffix) => suffix.startsWith("summary-"))
    .map((suffix) => ({
      suffix,
      at,
      kind: "summary" as const,
      actor: "assistant" as const,
      speaker: "小结",
      text: "",
      tombstone: true,
    }));
}

function noticeSteps(order: OrderDoc, cursor: OrderCursor, now: string): StepDraft[] {
  const steps: StepDraft[] = [];
  const decisions = cursor.asks;
  if (!order.reviewNeeded) {
    for (const suffix of [cursor.notices.customer, cursor.notices.ops]) {
      if (suffix && cursor.fp[suffix]) {
        steps.push({ suffix, at: now, kind: "notice", actor: "assistant", speaker: "给运营", text: "", tombstone: true });
      }
    }
    cursor.notices = {};
    cursor.reviewAt = undefined;
    cursor.script = undefined;
    return steps;
  }
  const reviewAt = order.reviewAt || order.updatedTime || now;
  const script = customerText(order, decisions);
  const scriptHash = shortHash(script);
  const fresh = cursor.reviewAt !== reviewAt;
  if (fresh) {
    cursor.reviewAt = reviewAt;
    cursor.script = scriptHash;
    if (script) {
      const suffix = `notice-${compactTime(reviewAt)}-customer`;
      cursor.notices.customer = suffix;
      steps.push({
        suffix,
        at: reviewAt,
        kind: "notice",
        actor: "assistant",
        speaker: "给客户",
        text: `[给客户]\n${script}`,
      });
    }
    const suffix = `notice-${compactTime(reviewAt)}-ops`;
    cursor.notices.ops = suffix;
    steps.push({
      suffix,
      at: reviewAt,
      kind: "notice",
      actor: "assistant",
      speaker: "给运营",
      text: opsNotice(order, decisions),
    });
    return steps;
  }
  if (script && !cursor.notices.customer) {
    const suffix = `notice-${compactTime(reviewAt)}-customer`;
    cursor.notices.customer = suffix;
    cursor.script = scriptHash;
    steps.push({
      suffix,
      at: reviewAt,
      kind: "notice",
      actor: "assistant",
      speaker: "给客户",
      text: `[给客户]\n${script}`,
    });
  }
  if (cursor.script !== scriptHash && cursor.notices.customer) {
    cursor.script = scriptHash;
    steps.push({
      suffix: cursor.notices.customer,
      at: reviewAt,
      kind: "notice",
      actor: "assistant",
      speaker: "给客户",
      text: script ? `[给客户]\n${script}` : "",
      tombstone: !script,
    });
  }
  return steps;
}

function customerText(order: OrderDoc, decisions: DecisionDoc[]): string {
  const ranked = [...decisions].sort((left, right) => partyRank(left) - partyRank(right));
  for (const item of ranked) {
    const text = customerScriptFromAsk(order, item.ask);
    if (text) {
      return text;
    }
  }
  if (order.sharedScene) {
    return customerScriptFromScene(order);
  }
  return "";
}

function partyRank(item: DecisionDoc): number {
  return item.ask?.party === "CUSTOMER" ? 0 : 1;
}

function opsNotice(order: OrderDoc, decisions: DecisionDoc[]): string {
  const lines = ["[给运营]"];
  const item = decisions.find((row) => row.ask?.party === "OPS" || row.waitingOn === "OPS" || row.waitingOn === "OPS_REVIEW");
  const reason = item?.reason || order.reviewReason;
  const hint = item?.hint || order.reviewHint;
  if (reason) {
    lines.push(`原因：${reason}`);
  }
  if (hint) {
    lines.push(hint);
  }
  if (item?.questionText) {
    lines.push(item.questionText);
  }
  if (order.reviewHandler) {
    lines.push(`处理人：${order.reviewHandler}`);
  }
  const fee = [order.bargainServiceFeeUsd, order.bargainValueAddedFeeUsd].filter((value) => value != null);
  if (fee.length > 0) {
    lines.push(`服务费：${fee.join(" + ")}`);
  }
  lines.push(
    `订单详情: https://agency.bioby.ai/zh/dashboard/projects/progress?view=delivery&followUpProjectFieldId=${order.id}`,
  );
  if (lines.length === 2) {
    lines.splice(1, 0, "这张订单转人工了。");
  }
  return lines.join("\n");
}

function contextSteps(
  order: OrderDoc,
  project: ProjectDoc | null,
  cursor: OrderCursor,
  laterOnly: boolean,
): StepDraft[] {
  const fp = shortHash(JSON.stringify(projectFingerprint(project)));
  const at = order.createdTime || order.updatedTime || new Date(0).toISOString();
  if (!cursor.projectFp) {
    cursor.projectFp = fp;
    if (laterOnly) {
      return [];
    }
    return [{
      suffix: "context",
      at,
      kind: "context",
      actor: "assistant",
      speaker: "订单",
      text: contextText(order, project),
    }];
  }
  if (cursor.projectFp === fp) {
    return [];
  }
  cursor.projectFp = fp;
  const changedAt = project?.updatedTime || order.updatedTime || at;
  return [{
    suffix: `context-${compactTime(changedAt)}`,
    at: changedAt,
    kind: "context",
    actor: "assistant",
    speaker: "订单",
    text: contextText(order, project),
  }];
}

function storedFaceSteps(order: OrderDoc, project: ProjectDoc | null, cursor: OrderCursor): StepDraft[] {
  const steps: StepDraft[] = [];
  const at = order.updatedTime || order.createdTime || new Date(0).toISOString();
  if (cursor.fp.context) {
    steps.push({
      suffix: "context",
      at: order.createdTime || at,
      kind: "context",
      actor: "assistant",
      speaker: "订单",
      text: contextText(order, project),
    });
  }
  for (const suffix of Object.keys(cursor.fp)) {
    if (suffix.startsWith("status-")) {
      steps.push({
        suffix,
        at,
        kind: "status",
        actor: "assistant",
        speaker: "状态",
        text: `交付状态：${statusLabel(order.status)}`,
      });
    } else if (suffix.startsWith("summary-")) {
      steps.push({
        suffix,
        at,
        kind: "summary",
        actor: "assistant",
        speaker: "小结",
        text: "",
        tombstone: true,
      });
    } else if (suffix.startsWith("notice-") && suffix.endsWith("-ops")) {
      steps.push({
        suffix,
        at: order.reviewAt || at,
        kind: "notice",
        actor: "assistant",
        speaker: "给运营",
        text: opsNotice(order, cursor.asks),
      });
    } else if (suffix.startsWith("notice-") && suffix.endsWith("-customer")) {
      const script = customerText(order, cursor.asks);
      steps.push({
        suffix,
        at: order.reviewAt || at,
        kind: "notice",
        actor: "assistant",
        speaker: "给客户",
        text: script ? `[给客户]\n${script}` : "",
        tombstone: !script,
      });
    }
  }
  return steps;
}

function noteSteps(order: OrderDoc, cursor: OrderCursor, realMail: boolean): StepDraft[] {
  const steps: StepDraft[] = [];
  if (realMail) {
    for (const suffix of cursor.auto) {
      if (cursor.fp[suffix]) {
        steps.push({ suffix, at: order.updatedTime || new Date(0).toISOString(), kind: "note", actor: "assistant", speaker: "跟进", text: "", tombstone: true });
      }
    }
    cursor.auto = [];
  }
  const seen = new Set<string>();
  for (const follow of order.follows) {
    const content = follow.followContent?.trim() ?? "";
    if (!content) {
      continue;
    }
    const at = follow.followTime || order.updatedTime || new Date(0).toISOString();
    const who = stepToken(follow.followerName || "unknown");
    const speaker = follow.followerName?.trim() || "跟进";
    const auto = isAutoNote(content);
    const pieces = auto ? [{ at, text: noteText(follow) }] : followPieces(follow);
    if (!auto && pieces.length > 1) {
      const combinedKey = `${compactTime(at)}-${who}`;
      const previous = cursor.follows[combinedKey];
      if (previous && cursor.fp[previous]) {
        steps.push({ suffix: previous, at, kind: "note", actor: "assistant", speaker, text: "", tombstone: true });
      }
      delete cursor.follows[combinedKey];
    }
    for (const piece of pieces) {
      const hash = shortHash(piece.text);
      const suffix = auto
        ? `note-auto-${shortHash(content)}`
        : `note-${compactTime(piece.at)}-${who}-${hash}`;
      const key = auto || pieces.length === 1
        ? (auto ? suffix : `${compactTime(at)}-${who}`)
        : `${compactTime(piece.at)}-${who}-${hash}`;
      seen.add(key);
      if (!auto) {
        const previous = cursor.follows[key];
        if (previous && previous !== suffix && cursor.fp[previous]) {
          steps.push({ suffix: previous, at: piece.at, kind: "note", actor: "assistant", speaker, text: "", tombstone: true });
        }
        cursor.follows[key] = suffix;
      } else if (!realMail && !cursor.auto.includes(suffix)) {
        cursor.auto.push(suffix);
      }
      if (auto && realMail) {
        continue;
      }
      steps.push({
        suffix,
        at: piece.at,
        kind: "note",
        actor: "assistant",
        speaker,
        text: piece.text,
      });
    }
  }
  for (const [key, suffix] of Object.entries(cursor.follows)) {
    if (!seen.has(key) && cursor.fp[suffix]) {
      steps.push({
        suffix,
        at: order.updatedTime || new Date(0).toISOString(),
        kind: "note",
        actor: "assistant",
        speaker: "跟进",
        text: "",
        tombstone: true,
      });
      delete cursor.follows[key];
    }
  }
  return steps;
}

function mailStep(mail: MailDoc, nickname?: string): StepDraft {
  const sent = (mail.folder ?? "").toUpperCase() === "SENT";
  const at = mail.sentDate || mail.updatedTime || new Date(0).toISOString();
  const who = sent ? "我们" : (nickname?.trim() || mail.from?.trim() || "达人");
  return {
    suffix: `mail-${stepToken(mail.id)}`,
    at,
    kind: "mail",
    actor: sent ? "assistant" : "user",
    speaker: who,
    text: mailText(mail),
  };
}

function mailText(mail: MailDoc): string {
  const lines: string[] = [];
  if (mail.from) {
    lines.push(`发件人：${mail.from}`);
  }
  if (mail.to && mail.to.length > 0) {
    lines.push(`收件人：${mail.to.join("，")}`);
  }
  if (mail.subject?.trim()) {
    lines.push(`主题：${mail.subject.trim()}`);
  }
  const body = readableMailBody(mail);
  if (body) {
    lines.push("", body);
  }
  return lines.join("\n").trim() || "（空邮件）";
}

const MAIL_TEXT_VERSION = 2;

function readableMailBody(mail: MailDoc): string {
  const plain = latestMailText(mail.content);
  const html = latestMailText(mail.htmlContent);
  if (plain && html && html.length > plain.length + 40) {
    return html;
  }
  return plain || html;
}

function followPieces(follow: { followTime?: string; followContent?: string; followType?: string; followResult?: string; selectedStatus?: string }): Array<{ at: string; text: string }> {
  const content = follow.followContent?.trim() ?? "";
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const base = follow.followTime || new Date(0).toISOString();
  if (lines.length < 2) {
    return [{ at: base, text: noteText(follow) }];
  }
  return lines.map((line, index) => ({
    at: lineTime(line, base, index),
    text: line,
  }));
}

function lineTime(line: string, followTime: string, index: number): string {
  const match = line.match(/^(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  const base = new Date(followTime);
  if (!match || Number.isNaN(base.getTime())) {
    return shifted(base, followTime, index);
  }
  const month = Number(match[1]);
  const day = Number(match[2]);
  let year = match[3] ? Number(match[3]) : base.getUTCFullYear();
  if (match[3] && year < 100) {
    year += 2000;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return shifted(base, followTime, index);
  }
  return new Date(Date.UTC(year, month - 1, day, 4, 0, 0, index)).toISOString();
}

function shifted(base: Date, followTime: string, index: number): string {
  if (Number.isNaN(base.getTime())) {
    return followTime;
  }
  return new Date(base.getTime() + index).toISOString();
}

function noteText(follow: { followType?: string; followResult?: string; selectedStatus?: string; followContent?: string }): string {
  const lines: string[] = [];
  const type = followTypeLabel(follow.followType);
  const result = followResultLabel(follow.followResult);
  const status = follow.selectedStatus ? statusLabel(follow.selectedStatus) : "";
  if (type) {
    lines.push(`跟进方式：${type}`);
  }
  if (result) {
    lines.push(`跟进结果：${result}`);
  }
  if (status && status !== "（无状态）") {
    lines.push(`当时状态：${status}`);
  }
  const content = follow.followContent?.trim();
  if (content) {
    lines.push(content);
  }
  return lines.join("\n");
}

function followTypeLabel(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return "";
  }
  const mapped: Record<string, string> = {
    EMAIL: "邮件",
    WHATSAPP: "WhatsApp",
    DM: "私信",
    BRAND_CUSTOMER_REVIEW: "品牌客户审核",
  };
  return mapped[raw.toUpperCase()] ?? raw;
}

function followResultLabel(value: string | undefined): string {
  const raw = value?.trim() ?? "";
  if (!raw) {
    return "";
  }
  const mapped: Record<string, string> = {
    APPROVED: "已通过",
    REJECTED: "已拒绝",
    HOLD: "暂缓",
    PENDING: "待处理",
    CANCELLED: "已取消",
    COMPLETED: "已完成",
    SUBMITTED: "已提交",
    SKIPPED: "已跳过",
  };
  return mapped[raw.toUpperCase()] ?? statusLabel(raw);
}

function logStep(log: LogDoc): StepDraft {
  const lines = [
    log.reason?.trim() ?? "",
    ...log.changes.map((change) => {
      const name = fieldLabel(change.fieldName);
      return `${name}：${showChange(change.fieldName, change.oldValue)} → ${showChange(change.fieldName, change.newValue)}`;
    }),
  ].filter(Boolean);
  return {
    suffix: `log-${stepToken(log.id)}`,
    at: log.logTime || new Date(0).toISOString(),
    kind: "log",
    actor: "assistant",
    speaker: log.operatorName?.trim() || "变更",
    text: lines.join("\n") || "有一条变更",
  };
}

function fieldLabel(name: string | undefined): string {
  const raw = name?.trim() ?? "";
  const mapped: Record<string, string> = {
    "selectedWorkflow.status": "交付状态",
    nickname: "达人昵称",
    externalQuote: "对外报价",
    influencerQuote: "达人报价",
    cooperationBenefits: "合作权益",
    bloggerLink: "主页链接",
    platform: "平台",
  };
  return mapped[raw] || raw || "字段";
}

function showChange(field: string | undefined, value: string | undefined): string {
  if (!value?.trim()) {
    return "空";
  }
  if ((field ?? "").toLowerCase().includes("status")) {
    return statusLabel(value);
  }
  return value;
}

function contextText(order: OrderDoc, project: ProjectDoc | null): string {
  const lines = [
    `达人：${order.nickname ?? ""}`,
    `项目：${project?.name ?? ""}`,
    `平台：${order.platform ?? ""}`,
    `链接：${order.bloggerLink ?? ""}`,
    `对外报价：${order.externalQuote ?? ""}`,
    `达人报价：${order.influencerQuote ?? ""}`,
    `合作权益：${order.cooperationBenefits ?? ""}`,
    `交付状态：${statusLabel(order.status)}`,
  ];
  if (project) {
    lines.push(
      `brief：${project.briefText ?? ""}`,
      `brief 链接：${project.briefUrl ?? ""}`,
      `权益：${project.benefits ?? ""}`,
      `产品信息：${project.brandProjectInfo ?? ""}`,
      `需求：${project.demands ?? ""}`,
    );
  }
  return lines.join("\n");
}

function projectFingerprint(project: ProjectDoc | null): unknown {
  if (!project) {
    return null;
  }
  return {
    name: project.name ?? "",
    briefUrl: project.briefUrl ?? "",
    briefType: project.briefType ?? "",
    briefText: project.briefText ?? "",
    benefits: project.benefits ?? "",
    brandProjectInfo: project.brandProjectInfo ?? "",
    brandProjectInfoEnglish: project.brandProjectInfoEnglish ?? "",
    demands: project.demands ?? "",
  };
}

function conversationLabel(order: OrderDoc, project: ProjectDoc | null): string {
  const nick = order.nickname?.trim();
  const name = project?.name?.trim();
  if (nick && name) {
    return `${nick} · ${name}`;
  }
  return nick || name || order.id;
}

function hasRealMail(cursor: OrderCursor): boolean {
  return Object.keys(cursor.fp).some((suffix) => suffix.startsWith("mail-"));
}

function bumpWatermark(cursor: OrderCursor, value: string | undefined): void {
  if (!value) {
    return;
  }
  if (!cursor.watermark || value > cursor.watermark) {
    cursor.watermark = value;
  }
}
