import {
  XHS_FILTER_GROUPS,
  DEFAULT_XHS_FILTER_PRESET,
  normalizeXhsFilterPreset,
  xhsFilterPresetSummary,
} from './constants.js';
import { getFilterPreset, setFilterPreset } from './storage.js';

const preset = { ...DEFAULT_XHS_FILTER_PRESET };
const renders = new Set();
const hintEls = new Set();
let lastSaved = null;

function refresh() {
  for (const render of renders) render();
  for (const el of hintEls) writeFilterSaveHint(el, lastSaved);
}

export function getSharedFilterPreset() {
  return normalizeXhsFilterPreset(preset);
}

export function applySharedFilterPreset(next) {
  Object.assign(preset, normalizeXhsFilterPreset(next));
  refresh();
}

export function mountFilterPresetCopy(copyEl) {
  if (!copyEl) return () => {};

  const render = () => {
    copyEl.innerHTML = XHS_FILTER_GROUPS.map((group) => {
      const chips = group.labels.map((label) => {
        const active = preset[group.key] === label ? ' active' : '';
        return `<button type="button" class="xhs-chip${active}" data-group="${group.key}" data-value="${label}">${label}</button>`;
      }).join('');
      return `<div class="xhs-fg" data-group="${group.key}">
        <div class="xhs-fg-title">${group.title}</div>
        <div class="xhs-chips">${chips}</div>
      </div>`;
    }).join('');
  };

  const onClick = (event) => {
    const chip = event.target.closest('.xhs-chip');
    if (!chip) return;
    const group = chip.dataset.group;
    const value = chip.dataset.value;
    if (!group || !value) return;
    preset[group] = value;
    refresh();
  };

  copyEl.addEventListener('click', onClick);
  renders.add(render);
  render();
  return () => {
    copyEl.removeEventListener('click', onClick);
    renders.delete(render);
  };
}

export function mountFilterSaveHint(el) {
  if (!el) return () => {};
  hintEls.add(el);
  writeFilterSaveHint(el, lastSaved);
  return () => hintEls.delete(el);
}

export function writeFilterSaveHint(el, saved) {
  if (!el) return;
  el.textContent = saved
    ? `已保存：${xhsFilterPresetSummary(saved)}（仅一套，再保存会覆盖）`
    : '尚未保存方案';
}

export async function loadSavedFilterPreset() {
  const saved = await getFilterPreset();
  lastSaved = saved;
  if (saved) applySharedFilterPreset(saved);
  else refresh();
  return saved;
}

export async function saveSharedFilterPreset() {
  const saved = await setFilterPreset(preset);
  lastSaved = saved;
  applySharedFilterPreset(saved);
  return saved;
}

export function resetSharedFilterPreset() {
  applySharedFilterPreset(DEFAULT_XHS_FILTER_PRESET);
}
