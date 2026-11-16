import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import type { ConnectorInstallation, ConnectorInstallationStatus, JsonValue } from "@regenic/domain";
import { pushStateDir, pushStatePath } from "./push-paths";

const REFRESH_MS = 5_000;

let refreshedAt = 0;
let lastListed: ConnectorInstallation[] | undefined;
let refreshFlight: Promise<ConnectorInstallation[] | undefined> | undefined;

/** 记下内核交给我们的安装配置。恢复推送时读这份，不再另开一份 SQLite。 */
export function rememberInstallation(installation: ConnectorInstallation): void {
  const path = installationPath(installation.id);
  mkdirSync(pushStateDir(), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(installation));
  renameSync(tmp, path);
}

export function forgetInstallation(installationId: string): void {
  rmSync(installationPath(installationId), { force: true });
}

export function listRememberedInstallations(): ConnectorInstallation[] {
  let names: string[] = [];
  try {
    names = readdirSync(pushStateDir());
  } catch {
    return [];
  }
  const found: ConnectorInstallation[] = [];
  for (const name of names) {
    if (!name.endsWith(".installation.json")) {
      continue;
    }
    const installation = readInstallation(pushStatePath(name));
    if (installation) {
      found.push(installation);
    }
  }
  return found;
}

export function rememberedInstallation(connectorType: string): ConnectorInstallation | undefined {
  return listRememberedInstallations().find((item) =>
    item.connector_type === connectorType && configHasUri(item.config));
}

/**
 * 向内核要已安装的连接器。走它自己的接口，不打开数据库文件。
 * 失败时返回 undefined，调用方继续用上次记下的配置。
 */
export function refreshInstallationsFromKernel(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConnectorInstallation[] | undefined> {
  const now = Date.now();
  if (refreshFlight) {
    return refreshFlight;
  }
  if (lastListed && now - refreshedAt < REFRESH_MS) {
    return Promise.resolve(lastListed);
  }
  refreshFlight = fetchInstallations(env).then((listed) => {
    if (!listed) {
      return undefined;
    }
    refreshedAt = Date.now();
    lastListed = listed;
    for (const installation of listed) {
      rememberInstallation(installation);
    }
    return listed;
  }).finally(() => {
    refreshFlight = undefined;
  });
  return refreshFlight;
}

function fetchInstallations(env: NodeJS.ProcessEnv): Promise<ConnectorInstallation[] | undefined> {
  const port = env.PORT?.trim() || "4370";
  return fetch(`http://127.0.0.1:${port}/v1/me/engine?detail=0`, {
    signal: AbortSignal.timeout(2_000),
  }).then(async (response) => {
    if (!response.ok) {
      return undefined;
    }
    const body = await response.json() as { org_id?: unknown; installations?: unknown };
    const orgId = stringOf(body.org_id);
    if (!orgId || !Array.isArray(body.installations)) {
      return undefined;
    }
    return body.installations.flatMap((row) => {
      const installation = installationFromEngine(orgId, row);
      return installation ? [installation] : [];
    });
  }).catch(() => undefined);
}

function installationFromEngine(orgId: string, row: unknown): ConnectorInstallation | undefined {
  if (!row || typeof row !== "object") {
    return undefined;
  }
  const item = row as Record<string, unknown>;
  const id = stringOf(item.id);
  const connectorType = stringOf(item.connector_type);
  const status = installationStatus(item.status);
  if (!id || !connectorType || !status) {
    return undefined;
  }
  const config = configFromSettings(item.settings);
  return {
    id,
    org_id: orgId,
    connector_type: connectorType,
    status,
    config,
    created_at: stringOf(item.created_at) || "1970-01-01T00:00:00.000Z",
    updated_at: configRevision(config),
  };
}

function configRevision(config: Record<string, JsonValue>): string {
  const keys = Object.keys(config).sort();
  const stable = keys.map((key) => `${JSON.stringify(key)}:${JSON.stringify(config[key])}`).join(",");
  return createHash("sha256").update(stable).digest("hex");
}

function configFromSettings(value: unknown): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const config: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" || typeof entry === "boolean") {
      config[key] = entry;
    } else if (typeof entry === "number" && Number.isFinite(entry)) {
      config[key] = entry;
    } else if (Array.isArray(entry) && entry.every((item) => typeof item === "string")) {
      config[key] = entry;
    }
  }
  return config;
}

function installationStatus(value: unknown): ConnectorInstallationStatus | undefined {
  return value === "enabled" || value === "disabled" || value === "needs_attention" ? value : undefined;
}

function configHasUri(config: Record<string, JsonValue>): boolean {
  const uri = typeof config.mongo_uri === "string" ? config.mongo_uri.trim() : "";
  return uri.startsWith("mongodb://") || uri.startsWith("mongodb+srv://");
}

function readInstallation(path: string): ConnectorInstallation | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const row = parsed as Record<string, unknown>;
    const id = stringOf(row.id);
    const connectorType = stringOf(row.connector_type);
    const status = installationStatus(row.status);
    const orgId = stringOf(row.org_id);
    const createdAt = stringOf(row.created_at);
    const updatedAt = stringOf(row.updated_at);
    if (!id || !connectorType || !status || !orgId || !createdAt || !updatedAt) {
      return undefined;
    }
    return {
      id,
      org_id: orgId,
      connector_type: connectorType,
      status,
      config: configFromSettings(row.config),
      created_at: createdAt,
      updated_at: updatedAt,
    };
  } catch {
    return undefined;
  }
}

function installationPath(installationId: string): string {
  return pushStatePath(`${installationId}.installation.json`);
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
