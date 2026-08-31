import type { SyncSource } from "@regenic/domain";
import {
  CRM_SOURCE,
  type CrmScope,
  opsStreamKey,
  orderStreamKey,
} from "./locators";

/** Fixed queue streams for SyncEngine catalog coverage. */
export function createCrmOpsSyncSource(scope: CrmScope): SyncSource {
  return {
    async listDirectory() {
      return {
        members: [
          {
            stream_key: opsStreamKey(scope),
            thread_id: `${CRM_SOURCE}:ops`,
            label: "CRM 待审运营任务",
            kind: "ops",
          },
        ],
        complete: true,
      };
    },
  };
}

export function createCrmOrderSyncSource(scope: CrmScope): SyncSource {
  return {
    async listDirectory() {
      return {
        members: [
          {
            stream_key: orderStreamKey(scope),
            thread_id: `${CRM_SOURCE}:order`,
            label: "CRM 待人工内审订单",
            kind: "order",
          },
        ],
        complete: true,
      };
    },
  };
}
