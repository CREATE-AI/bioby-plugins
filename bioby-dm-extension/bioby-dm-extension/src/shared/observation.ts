import type { ObservationWatch } from './types';

function rowToWatch(row: Record<string, unknown>): ObservationWatch | null {
  const taskId = String(row.taskId ?? row.task_id ?? '').trim();
  if (!taskId) return null;
  const watch: ObservationWatch = { taskId };
  if (row.influencerHandle != null) watch.influencerHandle = String(row.influencerHandle);
  else if (row.influencer_handle != null) watch.influencerHandle = String(row.influencer_handle);
  if (row.profileUrl != null) watch.profileUrl = String(row.profileUrl);
  else if (row.profile_url != null) watch.profileUrl = String(row.profile_url);
  return watch;
}

/** 从 heartbeat 响应归一化观察任务列表。 */
export function parseObservationWatches(data: Record<string, unknown> | null | undefined): ObservationWatch[] {
  if (!data) return [];

  const tasks = data.observationTasks;
  if (Array.isArray(tasks)) {
    const out: ObservationWatch[] = [];
    for (const t of tasks) {
      if (!t || typeof t !== 'object') continue;
      const watch = rowToWatch(t as Record<string, unknown>);
      if (watch) out.push(watch);
    }
    return out;
  }

  const ids = data.observationTaskIds;
  if (Array.isArray(ids)) {
    const out: ObservationWatch[] = [];
    for (const id of ids) {
      const taskId = String(id ?? '').trim();
      if (taskId) out.push({ taskId });
    }
    return out;
  }

  return [];
}
