import type { ConnectorInstallation, JsonValue } from "@regenic/domain";
import {
  forgetInstallation,
  listRememberedInstallations,
  refreshInstallationsFromKernel,
} from "./installation-snapshot";
import { kernelBase } from "./kernel-http";
import { isPushRunning, stopPush } from "./push";

const RESUME_DELAY_MS = 8_000;
const RESUME_INTERVAL_MS = 20_000;

export interface ArmedPushStarter {
  connectorType: string;
  start: (installation: ConnectorInstallation) => void;
}

const startedRevision = new Map<string, string>();
let watchTimer: ReturnType<typeof setInterval> | undefined;

export function watchArmedPush(starters: readonly ArmedPushStarter[]): void {
  if (watchTimer) {
    return;
  }
  const tick = () => {
    void (async () => {
      if (!(await kernelAccepting())) {
        return;
      }
      try {
        const listed = await refreshInstallationsFromKernel();
        resumeArmedPush(starters, listed);
      } catch (error) {
        const message = error instanceof Error ? error.message : "重新拉起推送失败";
        console.error(`[crm-push] ${message}`);
      }
    })();
  };
  const first = setTimeout(tick, RESUME_DELAY_MS);
  first.unref?.();
  watchTimer = setInterval(tick, RESUME_INTERVAL_MS);
  watchTimer.unref?.();
}

export function resumeArmedPush(
  starters: readonly ArmedPushStarter[],
  listed?: readonly ConnectorInstallation[],
): void {
  if (starters.length === 0) {
    return;
  }
  const types = new Set(starters.map((item) => item.connectorType));
  if (listed) {
    const live = new Set(listed.map((item) => item.id));
    for (const saved of listRememberedInstallations()) {
      if (types.has(saved.connector_type) && !live.has(saved.id)) {
        forgetInstallation(saved.id);
        if (isPushRunning(saved.id)) {
          stopPush(saved.id);
        }
        startedRevision.delete(saved.id);
      }
    }
  }
  const rows = (listed ?? listRememberedInstallations()).filter((item) => types.has(item.connector_type));
  const seen = new Set<string>();
  for (const installation of rows) {
    seen.add(installation.id);
    const starter = starters.find((item) => item.connectorType === installation.connector_type);
    if (!starter) {
      continue;
    }
    const running = isPushRunning(installation.id);
    if (installation.status !== "enabled" || !configHasUri(installation.config)) {
      if (running) {
        stopPush(installation.id);
      }
      startedRevision.delete(installation.id);
      continue;
    }
    const seenRevision = startedRevision.get(installation.id);
    if (running && seenRevision === installation.updated_at) {
      continue;
    }
    if (running && seenRevision !== undefined) {
      stopPush(installation.id);
    }
    if (!isPushRunning(installation.id)) {
      starter.start(installation);
    }
    startedRevision.set(installation.id, installation.updated_at);
  }
  for (const id of [...startedRevision.keys()]) {
    if (!seen.has(id)) {
      stopPush(id);
      startedRevision.delete(id);
    }
  }
}

function configHasUri(config: Record<string, JsonValue>): boolean {
  const uri = typeof config.mongo_uri === "string" ? config.mongo_uri.trim() : "";
  return uri.startsWith("mongodb://") || uri.startsWith("mongodb+srv://");
}

async function kernelAccepting(): Promise<boolean> {
  try {
    const response = await fetch(`${kernelBase()}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
