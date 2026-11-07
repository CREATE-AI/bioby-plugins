import type { ChannelDriverRegistry } from "@regenic/domain";
import { crmDeliverySyncDriver } from "./driver";

export * from "./directory";
export * from "./driver";
export * from "./locators";
export * from "./locales";
export * from "./model";
export * from "./records";
export * from "./sentences";
export * from "./status";
export * from "./sync";
export * from "./time";

export function registerCrmDeliveryDrivers(registry: ChannelDriverRegistry): void {
  registry.register(crmDeliverySyncDriver);
}
