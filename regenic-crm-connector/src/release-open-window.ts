import type { ConversationThread, ConnectorHost } from "@regenic/domain";
import type { CrmScope } from "./locators";
import { parseOpsTaskId, parseOrderId } from "./locators";
import { releaseOpsOpenWindow, releaseOrderOpenWindow } from "./open-window";

export function releaseThreadFromOpenWindow(
  installationId: string,
  scope: CrmScope,
  thread: ConversationThread,
  _host: ConnectorHost,
  _env: NodeJS.ProcessEnv,
): void {
  const opsTaskId = parseOpsTaskId(thread.target);
  if (opsTaskId) {
    releaseOpsOpenWindow(installationId, scope, opsTaskId);
    return;
  }
  const orderId = parseOrderId(thread.target);
  if (orderId) {
    releaseOrderOpenWindow(installationId, scope, orderId);
  }
}
