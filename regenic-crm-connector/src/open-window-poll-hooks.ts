import type { ResolveStreamsOptions } from "@regenic/domain";

export interface CrmOpenWindowPollHooks {
  findLocallyFinishedIds?: (ids: readonly string[]) => Promise<string[]>;
}

export function readCrmOpenWindowPollHooks(
  options?: ResolveStreamsOptions,
): CrmOpenWindowPollHooks {
  return (options ?? {}) as CrmOpenWindowPollHooks;
}
