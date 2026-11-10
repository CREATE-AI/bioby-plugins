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

/** 项目会话用自己的来源。和订单共用来源时，内核分不清一条会话归哪个连接器。 */
export const PROJECT_SOURCE = "crm-project";
export const PROJECT_CONNECTOR_TYPE = "crm-project-sync";
export const PROJECT_UNIT_KIND = "crm-project.project";

export const DEFAULT_PROJECT_REFRESH_MS = 300_000;
export const DEFAULT_PROJECT_RECENT = 30;
export const PROJECT_RECENT_MAX = 600;
/** 一个项目里最多列多少张交付中的订单。 */
export const PROJECT_ORDER_LIMIT = 300;

export function projectStreamKey(projectId: string): string {
  return `${PROJECT_SOURCE}:${projectId}`;
}

export function projectThreadId(projectId: string): string {
  return `${PROJECT_SOURCE}:${projectId}`;
}

export function projectSubjectCatalog(): SubjectCatalog {
  return {
    kinds: [{ id: PROJECT_UNIT_KIND, label: "kind.project" }],
  };
}
