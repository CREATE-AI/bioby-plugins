export function kernelPort(env: NodeJS.ProcessEnv = process.env): string {
  return env.PORT?.trim() || "4370";
}

export function kernelBase(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${kernelPort(env)}`;
}

export function kernelHeaders(
  extra: Record<string, string> = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const headers = { ...extra };
  const key = env.REGENIC_PERSONAL_API_KEY?.trim();
  if (key) {
    headers["x-regenic-personal-key"] = key;
  }
  return headers;
}
