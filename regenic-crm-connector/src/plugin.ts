import "@regenic/domain";
import { definePlugin } from "@regenic/plugin-host";
import {
  crmClientFromEnv,
  crmHasToken,
  type CrmFetch,
} from "./crm-client";
import { CRM_SOURCE, crmScopeOf, orderStreamKey, opsStreamKey } from "./locators";
import { CrmOrderPollConnector } from "./order-poll-connector";
import { CRM_STREAM_PACE, CrmOpsPollConnector } from "./ops-poll-connector";

export interface CrmOpsReviewPluginConfig {
  installation_id: string;
  org_id: string;
  max_open_tasks?: number;
  env?: NodeJS.ProcessEnv;
  fetch?: CrmFetch;
  now?: () => string;
}

export interface CrmOrderReviewPluginConfig {
  installation_id: string;
  org_id: string;
  max_open_order_reviews?: number;
  env?: NodeJS.ProcessEnv;
  fetch?: CrmFetch;
  now?: () => string;
}

export const crmOpsReviewPlugin = definePlugin<CrmOpsReviewPluginConfig>({
  name: "crm-ops-review",
  inject: ["connectors"],
  apply(ctx, config) {
    const env = config.env ?? process.env;
    const connector = new CrmOpsPollConnector(crmClientFromEnv({ env, fetch: config.fetch }), {
      connector_id: config.installation_id,
      org_id: config.org_id,
      max_open_tasks: config.max_open_tasks,
      now: config.now,
    });
    const scope = crmScopeOf(crmHasToken(env));
    ctx.effect(() =>
      ctx.get("connectors").register(config.installation_id, connector, {
        stream_key: opsStreamKey(scope),
        thread_id: `${CRM_SOURCE}:ops`,
        label: "CRM 待审运营任务",
        pace: { ...CRM_STREAM_PACE },
      }),
    );
  },
});

export const crmOrderReviewPlugin = definePlugin<CrmOrderReviewPluginConfig>({
  name: "crm-order-review",
  inject: ["connectors"],
  apply(ctx, config) {
    const env = config.env ?? process.env;
    const connector = new CrmOrderPollConnector(
      crmClientFromEnv({ env, fetch: config.fetch }),
      {
        connector_id: config.installation_id,
        org_id: config.org_id,
        max_open_order_reviews: config.max_open_order_reviews,
        now: config.now,
      },
    );
    const scope = crmScopeOf(crmHasToken(env));
    ctx.effect(() =>
      ctx.get("connectors").register(config.installation_id, connector, {
        stream_key: orderStreamKey(scope),
        thread_id: `${CRM_SOURCE}:order`,
        label: "CRM 待人工内审订单",
        pace: { ...CRM_STREAM_PACE },
      }),
    );
  },
});
