import { STORAGE_KEYS } from './constants.js';

export async function setConfig(config) {
  await chrome.storage.local.set({ [STORAGE_KEYS.CONFIG]: config });
}

export async function getConfig() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.CONFIG);
  return result[STORAGE_KEYS.CONFIG] || null;
}

export async function getLeads() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.LEADS);
  return sortLeadsByNewest(result[STORAGE_KEYS.LEADS] || []);
}

/** 同状态内：发帖时间越新越靠前；无时间则靠后 */
export function sortLeadsByNewest(leads) {
  const order = { qualified: 0, pending: 1, rejected: 2 };
  return [...(leads || [])].sort((a, b) => {
    const ao = order[a.reviewStatus] ?? 1;
    const bo = order[b.reviewStatus] ?? 1;
    if (ao !== bo) return ao - bo;
    const ta = Date.parse(a.publishAt || '') || 0;
    const tb = Date.parse(b.publishAt || '') || 0;
    if (tb !== ta) return tb - ta;
    // 都无发布时间时，后采集的靠前
    const ca = Date.parse(a.crawledAt || '') || 0;
    const cb = Date.parse(b.crawledAt || '') || 0;
    if (cb !== ca) return cb - ca;
    return (b.leadScore || 0) - (a.leadScore || 0);
  });
}

export async function upsertLeads(newLeads) {
  const existing = await getLeads();
  const map = new Map(existing.map((lead) => [lead.noteId, lead]));

  for (const lead of newLeads) {
    const prev = map.get(lead.noteId);
    const next = { ...lead };
    // 人工复核状态优先保留
    if (prev?.reviewStatus === 'qualified' || prev?.reviewStatus === 'rejected') {
      next.reviewStatus = prev.reviewStatus;
      next.reviewedAt = prev.reviewedAt;
    } else if (!next.reviewStatus) {
      next.reviewStatus = 'pending';
    }
    if (prev?.collected) {
      next.collected = true;
      next.collectMessage = prev.collectMessage || next.collectMessage;
    }
    if (!prev || (next.leadScore || 0) >= (prev.leadScore || 0) || prev.reviewStatus === 'pending') {
      map.set(lead.noteId, { ...prev, ...next });
    }
  }

  const merged = sortLeadsByNewest(Array.from(map.values()));
  await chrome.storage.local.set({ [STORAGE_KEYS.LEADS]: merged });
  return merged;
}

export async function updateLeadReview(noteId, reviewStatus) {
  const leads = await getLeads();
  const next = sortLeadsByNewest(leads.map((lead) => {
    if (String(lead.noteId) !== String(noteId)) return lead;
    return {
      ...lead,
      reviewStatus,
      reviewedAt: new Date().toISOString(),
    };
  }));
  await chrome.storage.local.set({ [STORAGE_KEYS.LEADS]: next });
  return next;
}

export async function markAllPendingAs(reviewStatus) {
  const leads = await getLeads();
  const now = new Date().toISOString();
  const next = sortLeadsByNewest(leads.map((lead) => {
    if (lead.reviewStatus && lead.reviewStatus !== 'pending') return lead;
    return { ...lead, reviewStatus, reviewedAt: now };
  }));
  await chrome.storage.local.set({ [STORAGE_KEYS.LEADS]: next });
  return next;
}

export async function clearLeads() {
  await chrome.storage.local.set({ [STORAGE_KEYS.LEADS]: [] });
}

export async function getRunState() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.RUN_STATE);
  return result[STORAGE_KEYS.RUN_STATE] || { status: 'idle' };
}

export async function setRunState(state) {
  await chrome.storage.local.set({ [STORAGE_KEYS.RUN_STATE]: state });
}
