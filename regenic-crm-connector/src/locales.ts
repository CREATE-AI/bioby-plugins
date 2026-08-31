import { defineLocaleTables } from "@regenic/domain";

export const crmLocaleTables = defineLocaleTables({
  en: {
    "catalog.opsTitle": "CRM ops review",
    "catalog.orderTitle": "CRM order review",
    "catalog.channelLabel": "CRM",
    "catalog.opsDescription":
      "Private plugin. Pulls email-submit PENDING_REVIEW tasks; DSH decides, the connector completes.",
    "catalog.orderDescription":
      "Private plugin. Pulls orders whose AI internal review is waiting for a human.",
    "catalog.credentialHint":
      "CRM base URL in the form; REGENIC_CRM_SHARED_SECRET for prod caller auth; REGENIC_CRM_TOKEN optional JWT",
    "field.baseUrl": "CRM base URL",
    "field.baseUrl.placeholder": "https://crm-host/api",
    "field.maxOpenTasks": "Max open tasks",
    "field.maxOpenOrders": "Max open order reviews",
    "prereq.secret": "CRM internal shared secret",
    "prereq.secret.hint":
      "Production CRM: same value as INTERNAL_AUTH_REGENIC_SHARED_SECRET. Sent as X-Regenic-Key, not Authorization.",
    "prereq.token": "CRM reporting-ops token",
    "prereq.token.hint":
      "Optional JWT. When set, CRM must scope to that reporting-ops user. A bad token must 401. Do not put the shared secret here.",
    "present.ops": "Email submit review",
    "present.order": "Order internal review",
    "kind.opsReview": "Email submit review",
    "kind.orderReview": "Order AI review",
    "probe.loaded": "Private CRM connector is loaded. Set the CRM base URL in the connector form.",
    "probe.legacyUrl":
      "Legacy REGENIC_CRM_BASE_URL is set. Save the connector form to move it into config.",
    "probe.noEnvUrl": "CRM base URL is not on the process env. Set it in the connector form.",
  },
  zh: {
    "catalog.opsTitle": "CRM 运营待审",
    "catalog.orderTitle": "CRM 订单内审",
    "catalog.channelLabel": "CRM",
    "catalog.opsDescription":
      "私有插件。拉取邮件提报 PENDING_REVIEW 任务；DSH 判断，连接器 complete。",
    "catalog.orderDescription": "私有插件。拉取 AI 内审待人工的订单。",
    "catalog.credentialHint":
      "表单填 CRM 基址；生产用 REGENIC_CRM_SHARED_SECRET 做调用方鉴权；REGENIC_CRM_TOKEN 可选 JWT",
    "field.baseUrl": "CRM 基址",
    "field.baseUrl.placeholder": "https://crm-host/api",
    "field.maxOpenTasks": "同时打开任务上限",
    "field.maxOpenOrders": "同时打开订单内审上限",
    "prereq.secret": "CRM 内部共享密钥",
    "prereq.secret.hint":
      "生产与 INTERNAL_AUTH_REGENIC_SHARED_SECRET 相同。走 X-Regenic-Key，不要放进 Authorization。",
    "prereq.token": "CRM 提报运营 token",
    "prereq.token.hint":
      "可选 JWT。有则 CRM 必须按该提报运营收窄。非法 token 必须 401。不要把共享密钥填在这里。",
    "present.ops": "邮件提报待审",
    "present.order": "订单 AI 内审",
    "kind.opsReview": "邮件提报待审",
    "kind.orderReview": "订单 AI 内审",
    "probe.loaded": "私有 CRM 连接器已加载。请在连接器表单填写 CRM 基址。",
    "probe.legacyUrl":
      "仍有旧的 REGENIC_CRM_BASE_URL。保存连接器表单后会写进 config。",
    "probe.noEnvUrl": "进程环境没有 CRM 基址。请在连接器表单填写。",
  },
});
