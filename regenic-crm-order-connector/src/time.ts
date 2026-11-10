import { createHash } from "node:crypto";

export function compactTime(value: string | undefined): string {
  const parsed = value ? new Date(value) : new Date(0);
  const time = Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return (
    String(time.getUTCFullYear()) +
    pad(time.getUTCMonth() + 1) +
    pad(time.getUTCDate()) +
    pad(time.getUTCHours()) +
    pad(time.getUTCMinutes()) +
    pad(time.getUTCSeconds()) +
    pad(time.getUTCMilliseconds(), 3)
  );
}

export function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

/** The step id sits after the only colon. Drop characters that would split the conversation. */
export function stepToken(value: string): string {
  return value.replace(/[:.\s/\\]+/g, "").slice(0, 48);
}

export function stampIso(base: string, offsetMs: number): string {
  const parsed = new Date(base);
  const origin = Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
  return new Date(origin.getTime() + offsetMs).toISOString();
}

const KIND_RANK: Record<string, number> = {
  context: 0,
  mail: 1,
  note: 2,
  log: 3,
  status: 4,
  notice: 5,
  summary: 6,
  order: 7,
  end: 8,
};

export interface TimedStep {
  kind: string;
  at: string;
  suffix: string;
}

/** Same-second steps get a stable millisecond offset so the inbox can sort them. */
export function withOffsets<T extends TimedStep>(steps: T[]): Array<T & { occurredAt: string }> {
  const sorted = [...steps].sort((a, b) => {
    const byTime = a.at.localeCompare(b.at);
    if (byTime !== 0) {
      return byTime;
    }
    const byKind = (KIND_RANK[a.kind] ?? 9) - (KIND_RANK[b.kind] ?? 9);
    if (byKind !== 0) {
      return byKind;
    }
    return a.suffix.localeCompare(b.suffix);
  });
  let lastSecond = "";
  let offset = 0;
  return sorted.map((step) => {
    const second = step.at.slice(0, 19);
    if (second === lastSecond) {
      offset += 1;
    } else {
      lastSecond = second;
      offset = KIND_RANK[step.kind] ?? 0;
    }
    return { ...step, occurredAt: stampIso(step.at, offset) };
  });
}
