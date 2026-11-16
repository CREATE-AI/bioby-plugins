import { homedir } from "node:os";
import { join } from "node:path";

let root = join(homedir(), ".regenic", "crm-push");

export function pushStateDir(): string {
  return root;
}

/** 测试把进度文件放到临时目录，避免碰到正在用的那份。 */
export function setPushStateDir(dir?: string): void {
  root = dir?.trim() || join(homedir(), ".regenic", "crm-push");
}

export function pushStatePath(name: string): string {
  return join(root, name);
}
