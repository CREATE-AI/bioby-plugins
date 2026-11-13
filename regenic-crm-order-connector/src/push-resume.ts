import { DatabaseSync } from "node:sqlite";
import type { ConnectorInstallation, JsonValue } from "@regenic/domain";
import { isPushRunning, pushArmed, stopPush } from "./push";

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
        resumeArmedPush(starters);
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
  env: NodeJS.ProcessEnv = process.env,
): void {
  const path = env.REGENIC_DATABASE?.trim();
  if (!path || starters.length === 0) {
    return;
  }
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(path, { readOnly: true, timeout: 1_000, enableForeignKeyConstraints: false });
  } catch {
    return;
  }
  try {
    const placeholders = starters.map(() => "?").join(", ");
    const rows = database.prepare(
      `SELECT id, org_id, connector_type, status, config_json, created_at, updated_at
       FROM connector_installations
       WHERE connector_type IN (${placeholders})`,
    ).all(...starters.map((item) => item.connectorType)) as Array<Record<string, unknown>>;
    const seen = new Set<string>();
    for (const row of rows) {
      const installation = installationFromRow(row);
      if (!installation) {
        continue;
      }
      seen.add(installation.id);
      const starter = starters.find((item) => item.connectorType === installation.connector_type);
      if (!starter) {
        continue;
      }
      const running = isPushRunning(installation.id);
      if (installation.status !== "enabled" || !pushArmed(installation.id) || !configHasUri(installation.config)) {
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
  } finally {
    database.close();
  }
}

function configHasUri(config: Record<string, JsonValue>): boolean {
  const uri = typeof config.mongo_uri === "string" ? config.mongo_uri.trim() : "";
  return uri.startsWith("mongodb://") || uri.startsWith("mongodb+srv://");
}

function installationFromRow(row: Record<string, unknown>): ConnectorInstallation | undefined {
  const id = stringOf(row.id);
  const connectorType = stringOf(row.connector_type);
  const status = stringOf(row.status);
  if (!id || !connectorType || (status !== "enabled" && status !== "disabled" && status !== "needs_attention")) {
    return undefined;
  }
  let config: Record<string, JsonValue> = {};
  if (typeof row.config_json === "string" && row.config_json) {
    try {
      const parsed = JSON.parse(row.config_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as Record<string, JsonValue>;
      }
    } catch {
      return undefined;
    }
  }
  const createdAt = stringOf(row.created_at) || new Date(0).toISOString();
  const updatedAt = stringOf(row.updated_at) || createdAt;
  return {
    id,
    org_id: stringOf(row.org_id),
    connector_type: connectorType,
    status,
    config,
    created_at: createdAt,
    updated_at: updatedAt,
  };
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function kernelAccepting(): Promise<boolean> {
  const port = process.env.PORT?.trim() || "4370";
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(1_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
