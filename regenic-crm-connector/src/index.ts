import type { ChannelDriverRegistry } from "@regenic/domain";
import { crmOpsReviewDriver } from "./ops-driver";
import { crmOrderReviewDriver } from "./order-driver";

export * from "./locators";
export * from "./locales";
export * from "./list-fold";
export * from "./crm-client";
export * from "./reconcile";
export * from "./records";
export * from "./prompts";
export * from "./sync-source";
export * from "./ops-poll-connector";
export * from "./order-poll-connector";
export * from "./ops-driver";
export * from "./order-driver";
export * from "./plugin";

export function registerCrmDrivers(registry: ChannelDriverRegistry): void {
  registry.register(crmOpsReviewDriver);
  registry.register(crmOrderReviewDriver);
}
