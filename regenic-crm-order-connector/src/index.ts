import type { ChannelDriverRegistry } from "@regenic/domain";
import { crmDeliverySyncDriver, resumeDeliveryPush } from "./driver";
import { CONNECTOR_TYPE, PROJECT_CONNECTOR_TYPE } from "./locators";
import { crmProjectSyncDriver, resumeProjectPush } from "./project-driver";
import { watchArmedPush } from "./push-resume";

export * from "./directory";
export * from "./driver";
export * from "./locators";
export * from "./locales";
export * from "./model";
export * from "./project-driver";
export * from "./project-locales";
export * from "./project-sync";
export * from "./records";
export * from "./sentences";
export * from "./status";
export * from "./sync";
export * from "./time";

watchArmedPush([
  { connectorType: CONNECTOR_TYPE, start: resumeDeliveryPush },
  { connectorType: PROJECT_CONNECTOR_TYPE, start: resumeProjectPush },
]);

export function registerCrmDeliveryDrivers(registry: ChannelDriverRegistry): void {
  registry.register(crmDeliverySyncDriver);
  registry.register(crmProjectSyncDriver);
}
