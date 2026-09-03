import { ChannelDriverError, type PromptAnswer, type ThreadPrompt } from "@regenic/domain";
import {
  CrmApiError,
  auditComment,
  isEmailSubmitPending,
  isPendingHumanOrder,
  type CrmClient,
  type CrmOpsTask,
  type CrmOrder,
} from "./crm-client";
import {
  orderPromptId,
  parseOpsCompleteAction,
  parseOpsTaskId,
  parseOrderId,
  parseOrderReviewResult,
  type OpsCompleteAction,
  type OrderReviewResult,
} from "./locators";
import { opsPromptId } from "./locators";
import { actionForScene, parseOpsScene, scenesForAction } from "./scenes";

export function opsTaskPrompt(task: CrmOpsTask): ThreadPrompt {
  const allowed = task.reviewGuide.allowedActions;
  const options = allowed.flatMap((action) => {
    const scenes = scenesForAction(action);
    if (scenes.length === 0) {
      return [{ label: action, description: actionDescription(action) }];
    }
    return scenes.map((scene) => ({
      label: scene,
      description: sceneDescription(scene),
    }));
  });
  return {
    prompt_id: opsPromptId(task.id),
    presentation: "choice",
    title: "邮件提报待审",
    detail:
      task.reviewGuide.headline ??
      "工单正文已含最近来信和往来摘要。根据正文选出第一行 scene 键。不要打开收件箱，不要二次拉取邮件。",
    questions: [
      {
        id: "decision",
        prompt: "根据工单正文（最近来信 + 往来摘要）选出 scene 键写在第一行。不要打开收件箱。",
        options,
      },
    ],
  };
}

function actionDescription(action: OpsCompleteAction): string {
  switch (action) {
    case "SEND_AND_CLOSE":
      return "用 CRM scene 模板回邮后关单";
    case "SUBMIT_THEN_CLOSE":
      return "按 submit_quote 提报，成败都关单并标星；成功则可收悉";
    case "LEAVE_PENDING":
      return "不发信、不关单，留待真人";
    case "CLOSE_ONLY":
      return "不发信，关单并标星";
  }
}

function sceneDescription(scene: string): string {
  switch (scene) {
    case "NEED_QUOTE_GENERIC":
      return "通用要报价模板回邮后关单";
    case "NEED_QUOTE_BRIEF":
      return "对方要 brief/细节：先挡合作细节再要价后关单（不发 brief）";
    case "NEED_QUOTE_FORMAT":
      return "对方问报价格式：要金额+币种后关单（不是成片格式）";
    case "NEED_QUOTE_BUDGET_ASK":
      return "对方问预算，用要报价模板回后关单";
    case "NEED_QUOTE_WHATSAPP":
      return "引导回邮报价（勿转 WhatsApp）后关单";
    case "NEED_QUOTE_GIFT":
      return "礼品/置换合作，仍要报价后关单";
    case "NEED_QUOTE_PLATFORM_OK":
      return "平台可做，仍要报价后关单";
    case "NEED_QUOTE_VERIFY_DOMAIN":
      return "解释域名/发件身份后继续要报价关单";
    case "NEED_QUOTE_VERIFY_CLIENT":
      return "解释客户/品牌后继续要报价关单";
    case "NEED_QUOTE_STALL":
      return "已多次要价，简短再催一次后关单";
    case "NEED_QUOTE_PAY_OR_DATE":
      return "付款或档期问题，先要到报价后关单";
    case "REJECT_OUR_NUMBER":
      return "拒绝对方要我方出价，回模板后关单";
    case "ASK_STATUS_IN_REVIEW":
      return "仅已提报时回「审核中」后关单；未提报应改 QUOTE_PLUS_Q 或 REAL_HUMAN";
    case "NEED_CONTEXT":
      return "来信缺平台/条数等上下文，询问后仍要价关单";
    case "MORE_NAMES":
      return "对方给了更多达人名单，致谢后关单（不提报；本线程已有报价应改 QUOTE_PLUS_Q）";
    case "QUOTE_PLUS_Q":
      return "按本线程报价提报（CRM 选价同邮件提报：符合档最低价），可选收悉回邮后关单";
    case "QUOTE_UNPARSED_RANGE":
      return "报价是区间，按最高价提报后关单";
    case "REAL_HUMAN":
      return "不发信、不关单，留待真人";
    case "NO_FOLLOW":
      return "无需跟进，不发信直接关单";
    case "NOT_OUTREACH":
      return "非建联邮件，不发信直接关单";
    default: {
      const action = actionForScene(scene);
      return action ? actionDescription(action) : scene;
    }
  }
}

export function orderReviewPrompt(order: CrmOrder): ThreadPrompt {
  return {
    prompt_id: orderPromptId(order.id),
    presentation: "approval",
    title: "订单 AI 内审",
    detail: "只改本订单内审。不得 complete 关联运营任务。",
    questions: [
      {
        id: "decision",
        prompt: "该订单 AI 内审是否通过",
        options: [
          { label: "APPROVED", description: "通过" },
          { label: "REJECTED", description: "不通过" },
        ],
      },
    ],
  };
}

export async function listOpsPrompts(
  client: CrmClient,
  target: string,
): Promise<ThreadPrompt[]> {
  const taskId = parseOpsTaskId(target);
  if (!taskId) {
    return [];
  }
  try {
    const task = await client.getOpsTask(taskId);
    return isEmailSubmitPending(task) ? [opsTaskPrompt(task)] : [];
  } catch (error) {
    if (error instanceof CrmApiError && (error.status === 404 || error.status === 409)) {
      return [];
    }
    throw error;
  }
}

export async function listOrderPrompts(
  client: CrmClient,
  target: string,
): Promise<ThreadPrompt[]> {
  const orderId = parseOrderId(target);
  if (!orderId) {
    return [];
  }
  try {
    const order = await client.getOrder(orderId);
    return isPendingHumanOrder(order) ? [orderReviewPrompt(order)] : [];
  } catch (error) {
    if (error instanceof CrmApiError && (error.status === 404 || error.status === 409)) {
      return [];
    }
    throw error;
  }
}

export async function answerOpsPrompt(
  client: CrmClient,
  target: string,
  answer: PromptAnswer,
  onReleased?: (taskId: string) => void,
): Promise<{ accepted: boolean }> {
  const taskId = parseOpsTaskId(target);
  const fromPrompt = parseOpsTaskId(answer.prompt_id);
  if (!taskId || !fromPrompt || taskId !== fromPrompt) {
    throw new ChannelDriverError("invalid_config", "CRM ops prompt_id does not match this thread");
  }
  const conclusion = parseOpsConclusion(answer);
  let task: CrmOpsTask;
  try {
    task = await client.getOpsTask(taskId);
  } catch (error) {
    if (error instanceof CrmApiError && (error.status === 404 || error.status === 409)) {
      return { accepted: true };
    }
    throw error;
  }
  if (!isEmailSubmitPending(task)) {
    return { accepted: true };
  }
  if (!task.reviewGuide.allowedActions.includes(conclusion.action)) {
    throw new ChannelDriverError(
      "invalid_config",
      `DSH action ${conclusion.action} is not allowed by this task reviewGuide`,
    );
  }
  let accepted = false;
  try {
    accepted = await client.completeOpsTask(taskId, {
      action: conclusion.action,
      scene: conclusion.scene,
      comment: auditComment({
        queue: "ops",
        hasToken: client.hasToken,
        reportingOperationsUserId: task.reportingOperationsUserId,
        promptText: promptText(answer, conclusion.action),
      }),
    });
  } finally {
    onReleased?.(taskId);
  }
  return { accepted };
}

function parseOpsConclusion(answer: PromptAnswer): {
  action: OpsCompleteAction;
  scene?: string;
} {
  const decision = answer.answers.find((item) => item.id === "decision") ?? answer.answers[0];
  const tokens = [
    ...(decision?.selected ?? []),
    ...(decision?.custom ? [decision.custom] : []),
  ];
  for (const token of tokens) {
    const action = parseOpsCompleteAction(token);
    if (action) {
      return { action };
    }
    const scene = parseOpsScene(token);
    if (scene) {
      const mapped = actionForScene(scene);
      if (mapped) {
        return { action: mapped, scene };
      }
    }
  }
  throw new ChannelDriverError(
    "invalid_config",
    "CRM ops complete requires a DSH conclusion of SEND_AND_CLOSE, SUBMIT_THEN_CLOSE, LEAVE_PENDING, CLOSE_ONLY, or a known scene",
  );
}

export async function answerOrderPrompt(
  client: CrmClient,
  target: string,
  answer: PromptAnswer,
  onReleased?: (orderId: string) => void,
): Promise<{ accepted: boolean }> {
  const orderId = parseOrderId(target);
  const fromPrompt = parseOrderId(answer.prompt_id);
  if (!orderId || !fromPrompt || orderId !== fromPrompt) {
    throw new ChannelDriverError(
      "invalid_config",
      "CRM order prompt_id does not match this thread",
    );
  }
  const result = requireOrderResult(answer);
  let order: CrmOrder;
  try {
    order = await client.getOrder(orderId);
  } catch (error) {
    if (error instanceof CrmApiError && (error.status === 404 || error.status === 409)) {
      return { accepted: true };
    }
    throw error;
  }
  if (!isPendingHumanOrder(order)) {
    return { accepted: true };
  }
  let accepted = false;
  try {
    accepted = await client.submitOrderInternalReview(orderId, {
      result,
      comment: auditComment({
        queue: "order",
        hasToken: client.hasToken,
        reportingOperationsUserId: order.reportingOperationsUserId,
        promptText: promptText(answer, result),
      }),
    });
  } finally {
    onReleased?.(orderId);
  }
  return { accepted };
}

function requireOrderResult(answer: PromptAnswer): OrderReviewResult {
  const selected = selectedValues(answer);
  const result = selected
    .map((value) => parseOrderReviewResult(value))
    .find((value): value is OrderReviewResult => value !== undefined);
  if (!result) {
    throw new ChannelDriverError(
      "invalid_config",
      "CRM order review requires a conclusion of APPROVED or REJECTED",
    );
  }
  return result;
}

function selectedValues(answer: PromptAnswer): string[] {
  return answer.answers.flatMap((item) => [
    ...item.selected,
    ...(item.custom ? [item.custom] : []),
  ]);
}

function promptText(answer: PromptAnswer, fallback: string): string {
  const custom = answer.answers
    .map((item) => item.custom?.trim())
    .find((item) => item);
  return custom || fallback;
}
