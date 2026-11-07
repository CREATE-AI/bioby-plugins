import type { SubjectCatalog } from "@regenic/domain";

export const SOURCE = "crm-delivery";
export const CONNECTOR_TYPE = "crm-delivery-sync";
export const UNIT_KIND = "crm-delivery.order";
export const UNIT_KIND_LABEL = "交付订单";

export const DEFAULT_REFRESH_MS = 180_000;
export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_RECENT = 30;
export const PAGE_SIZE = 20;
export const RESTART_WAIT_MS = 120_000;

export function streamKey(orderId: string): string {
  return `${SOURCE}:${orderId}`;
}

export function threadId(orderId: string): string {
  return `${SOURCE}:${orderId}`;
}

export function externalId(orderId: string, step: string): string {
  return `${orderId}:${step}`;
}

export function subjectCatalog(): SubjectCatalog {
  return {
    kinds: [{ id: UNIT_KIND, label: "kind.order" }],
  };
}
