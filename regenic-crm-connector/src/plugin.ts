import "@regenic/domain";
import { definePlugin } from "@regenic/plugin-host";
import {
  crmClientFromConfig,
  crmHasToken,
  type CrmFetch,
} from "./crm-client";
import type { HideThread } from "./list-fold";
import { OpenWindowLedger } from "./open-window";
import { CRM_SOURCE, crmScopeOf, orderStreamKey, opsStreamKey } from "./locators";
import { CrmOrderPollConnector } from "./order-poll-connector";
import { CRM_STREAM_PACE, CrmOpsPollConnector } from "./ops-poll-connector";

export interface CrmOpsReviewPluginConfig {
  installation_id: string;
  org_id: string;
  base_url?: string;
  credentials_ref?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: CrmFetch;
  now?: () => string;
  hideThread?: HideThread;
  openWindowLedger?: OpenWindowLedger;
}

export interface CrmOrderReviewPluginConfig {
  installation_id: string;
  org_id: string;
  base_url?: string;
  credentials_ref?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: CrmFetch;
  now?: () => string;
  hideThread?: HideThread;
  openWindowLedger?: OpenWindowLedger;
}

export const crmOpsReviewPlugin = definePlugin<CrmOpsReviewPluginConfig>({
  name: "crm-ops-review",
  inject: ["connectors"],
  apply(ctx, config) {
    const env = config.env ?? process.env;
    const connector = new CrmOpsPollConnector(
      crmClientFromConfig({
        config: config.base_url ? { base_url: config.base_url } : {},
        env,
        fetch: config.fetch,
        credentials_ref: config.credentials_ref,
      }),
      {
        connector_id: config.installation_id,
        org_id: config.org_id,
        now: config.now,
        hideThread: config.hideThread,
        openWindowLedger: config.openWindowLedger,
      },
    );
    const scope = crmScopeOf(crmHasToken(env, config.credentials_ref));
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
      crmClientFromConfig({
        config: config.base_url ? { base_url: config.base_url } : {},
        env,
        fetch: config.fetch,
        credentials_ref: config.credentials_ref,
      }),
      {
        connector_id: config.installation_id,
        org_id: config.org_id,
        now: config.now,
        hideThread: config.hideThread,
        openWindowLedger: config.openWindowLedger,
      },
    );
    const scope = crmScopeOf(crmHasToken(env, config.credentials_ref));
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
