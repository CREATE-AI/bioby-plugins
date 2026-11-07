import { channelRecord, type IngestRecord } from "@regenic/domain";
import { externalId, SOURCE, UNIT_KIND } from "./locators";
import { shortHash } from "./time";

export type StepKind = "context" | "mail" | "note" | "log" | "status" | "notice" | "summary" | "end";
export type StepActor = "user" | "assistant" | "system";

export interface StepDraft {
  suffix: string;
  at: string;
  kind: StepKind;
  text: string;
  actor: StepActor;
  /** 会话里显示的名字。kind 用 system 时界面会把正文折起来，所以人名不要用 system。 */
  speaker: string;
  tombstone?: boolean;
}

export function stepRecord(input: {
  orderId: string;
  label: string;
  step: StepDraft;
  occurredAt: string;
  operation: "create" | "revise" | "tombstone";
}): IngestRecord {
  const speaker = input.step.speaker.trim() || "系统";
  const record = channelRecord({
    channel: SOURCE,
    kind: input.step.actor,
    direction: input.step.actor === "assistant" ? "outbound" : "inbound",
    external_id: externalId(input.orderId, input.step.suffix),
    occurred_at: input.occurredAt,
    actor_id: `${SOURCE}:${input.step.actor}:${speaker}`,
    actor_label: speaker,
    scope_id: input.orderId,
    scope_name: input.label,
    unit_kind: UNIT_KIND,
    type: "message",
    thread_id: input.orderId,
    text: input.step.tombstone ? "" : input.step.text,
  });
  return {
    ...record,
    operation: input.operation,
    ...(input.operation === "create"
      ? {}
      : { revision_id: shortHash(`${input.operation}:${input.step.text}`) }),
  };
}
