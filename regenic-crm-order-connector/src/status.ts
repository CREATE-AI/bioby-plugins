export const OPEN_STATUSES = [
  "TO_FOLLOW_UP",
  "FOLLOWING",
  "NEGOTIATING",
  "BARGAINING",
  "WAITING_DRAFT",
  "WAITING_ADDRESS",
  "WAITING_SCRIPT",
  "WAITING_TRACKING_NUMBER",
  "WAITING_LOGISTICS_DELIVERY",
  "SCRIPT_REVIEWING",
  "SCRIPT_REVISING",
  "VIDEO_DRAFT_REVIEWING",
  "VIDEO_DRAFT_REVISING",
  "LONG_TERM_NO_REPLY",
  "PENDING_PUBLISH",
  "PUBLISHED",
] as const;

/** 这些交付状态表示订单已结束。会话写成 done，之后不再追加。 */
export const ENDED_STATUSES = [
  "COMPLETED",
  "SETTLED_COMPLETED",
  "ABANDONED",
  "CANCELLED",
  "CUSTOMER_CANCELLED",
  "ABNORMAL_HANDLING",
  "PROJECT_DELAYED_OR_PAUSED",
] as const;

const ENDED = new Set<string>(ENDED_STATUSES);
const ENDED_LABELS = new Set([
  "已完成",
  "已完结",
  "已结清",
  "已结清-完结",
  "已放弃",
  "已取消",
  "客户取消",
  "异常处理",
  "项目延期/暂停",
]);

const LABELS: Record<string, string> = {
  TO_FOLLOW_UP: "待跟进",
  FOLLOWING: "跟进中",
  NEGOTIATING: "谈判中",
  BARGAINING: "砍价中",
  WAITING_DRAFT: "等待草稿",
  WAITING_ADDRESS: "等待地址",
  WAITING_SCRIPT: "等待脚本",
  WAITING_TRACKING_NUMBER: "等待快递单号",
  WAITING_LOGISTICS_DELIVERY: "等待物流送达",
  SCRIPT_REVIEWING: "脚本审核中",
  SCRIPT_REVISING: "脚本修改中",
  VIDEO_DRAFT_REVIEWING: "视频草稿审核",
  VIDEO_DRAFT_REVISING: "视频草稿修改中",
  LONG_TERM_NO_REPLY: "长期不回邮件",
  PENDING_PUBLISH: "待发布",
  PUBLISHED: "已发布",
  ABNORMAL_HANDLING: "异常处理",
  SETTLED_COMPLETED: "已结清",
  COMPLETED: "已完结",
  CANCELLED: "已取消",
  CUSTOMER_CANCELLED: "客户取消",
  ABANDONED: "已放弃",
  PROJECT_DELAYED_OR_PAUSED: "项目延期/暂停",
  CUSTOMER_HOLD: "客户 Hold",
  DELETED: "已删除",
};

const OPEN = new Set<string>(OPEN_STATUSES);

export function statusLabel(status: string | undefined): string {
  if (!status) {
    return "（无状态）";
  }
  return LABELS[status] ?? status;
}

export function isOpenStatus(status: string | undefined): boolean {
  return Boolean(status && OPEN.has(status));
}

export function isEndedStatus(status: string | undefined): boolean {
  if (!status) {
    return false;
  }
  const raw = status.trim();
  return ENDED.has(raw) || ENDED_LABELS.has(raw) || ENDED_LABELS.has(statusLabel(raw));
}
