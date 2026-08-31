import type { OpsCompleteAction } from "./locators";

/** Scene keys DSH may output as the first line. Connector maps them to the four CRM actions. */
export const OPS_SCENE_ACTIONS: Record<string, OpsCompleteAction> = {
  NEED_QUOTE_GENERIC: "SEND_AND_CLOSE",
  NEED_QUOTE_BRIEF: "SEND_AND_CLOSE",
  NEED_QUOTE_FORMAT: "SEND_AND_CLOSE",
  NEED_QUOTE_BUDGET_ASK: "SEND_AND_CLOSE",
  NEED_QUOTE_WHATSAPP: "SEND_AND_CLOSE",
  NEED_QUOTE_GIFT: "SEND_AND_CLOSE",
  NEED_QUOTE_PLATFORM_OK: "SEND_AND_CLOSE",
  NEED_QUOTE_VERIFY_DOMAIN: "SEND_AND_CLOSE",
  NEED_QUOTE_VERIFY_CLIENT: "SEND_AND_CLOSE",
  NEED_QUOTE_STALL: "SEND_AND_CLOSE",
  NEED_QUOTE_PAY_OR_DATE: "SEND_AND_CLOSE",
  REJECT_OUR_NUMBER: "SEND_AND_CLOSE",
  ASK_STATUS_IN_REVIEW: "SEND_AND_CLOSE",
  NEED_CONTEXT: "SEND_AND_CLOSE",
  MORE_NAMES: "SEND_AND_CLOSE",
  QUOTE_PLUS_Q: "SUBMIT_THEN_CLOSE",
  QUOTE_UNPARSED_RANGE: "SUBMIT_THEN_CLOSE",
  REAL_HUMAN: "LEAVE_PENDING",
  NO_FOLLOW: "CLOSE_ONLY",
  NOT_OUTREACH: "CLOSE_ONLY",
};

export function parseOpsScene(value: string): string | undefined {
  const scene = value.trim();
  return OPS_SCENE_ACTIONS[scene] ? scene : undefined;
}

export function actionForScene(scene: string): OpsCompleteAction | undefined {
  return OPS_SCENE_ACTIONS[scene.trim()];
}

export function scenesForAction(
  action: OpsCompleteAction,
): string[] {
  return Object.entries(OPS_SCENE_ACTIONS)
    .filter(([, mapped]) => mapped === action)
    .map(([scene]) => scene);
}
