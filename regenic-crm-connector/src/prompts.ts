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

export function opsTaskPrompt(task: CrmOpsTask): ThreadPrompt {
  return {
    prompt_id: opsPromptId(task.id),
    presentation: "choice",
    title: "邮件提报待审",
    detail: task.reviewGuide.headline ?? "DSH 判断后由连接器自动 complete，不要无人结论时猜动作。",
    questions: [
      {
        id: "decision",
        prompt: "根据工单正文判断如何处理该运营任务",
        options: task.reviewGuide.allowedActions.map((action) => ({
          label: action,
          description:
            action === "APPROVE_AND_CONTINUE"
              ? "继续自动化（回邮 / 自动提报）"
              : "关闭任务，不再往下走",
        })),
      },
    ],
  };
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
): Promise<{ accepted: boolean }> {
  const taskId = parseOpsTaskId(target);
  const fromPrompt = parseOpsTaskId(answer.prompt_id);
  if (!taskId || !fromPrompt || taskId !== fromPrompt) {
    throw new ChannelDriverError("invalid_config", "CRM ops prompt_id does not match this thread");
  }
  const action = requireOpsAction(answer);
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
  if (!task.reviewGuide.allowedActions.includes(action)) {
    throw new ChannelDriverError(
      "invalid_config",
      `DSH action ${action} is not allowed by this task reviewGuide`,
    );
  }
  try {
    await client.completeOpsTask(taskId, {
      action,
      comment: auditComment({
        queue: "ops",
        hasToken: client.hasToken,
        reportingOperationsUserId: task.reportingOperationsUserId,
        promptText: promptText(answer, action),
      }),
    });
    return { accepted: true };
  } catch (error) {
    if (error instanceof CrmApiError && error.status === 409) {
      return { accepted: true };
    }
    throw error;
  }
}

export async function answerOrderPrompt(
  client: CrmClient,
  target: string,
  answer: PromptAnswer,
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
  try {
    await client.submitOrderInternalReview(orderId, {
      result,
      comment: auditComment({
        queue: "order",
        hasToken: client.hasToken,
        reportingOperationsUserId: order.reportingOperationsUserId,
        promptText: promptText(answer, result),
      }),
    });
    return { accepted: true };
  } catch (error) {
    if (error instanceof CrmApiError && error.status === 409) {
      return { accepted: true };
    }
    throw error;
  }
}

function requireOpsAction(answer: PromptAnswer): OpsCompleteAction {
  const selected = selectedValues(answer);
  const action = selected
    .map((value) => parseOpsCompleteAction(value))
    .find((value): value is OpsCompleteAction => value !== undefined);
  if (!action) {
    throw new ChannelDriverError(
      "invalid_config",
      "CRM ops complete requires a DSH conclusion of APPROVE_AND_CONTINUE or CLOSE_TASK",
    );
  }
  return action;
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
