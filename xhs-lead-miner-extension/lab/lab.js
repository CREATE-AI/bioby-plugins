import { XHS_FILTER_GROUPS, DEFAULT_XHS_FILTER_PRESET } from '../lib/constants.js';

export function initLab() {
  const keywordEl = document.getElementById('labKeyword');
  const sessionEl = document.getElementById('labSessionStatus');
  const logEl = document.getElementById('labLog');
  const copyEl = document.getElementById('labFilterCopy');
  if (!keywordEl || !sessionEl || !logEl) return;

  const preset = { ...DEFAULT_XHS_FILTER_PRESET };

  function appendLog(title, payload) {
    const time = new Date().toLocaleTimeString();
    const body = payload == null
      ? ''
      : (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
    const block = `[${time}] ${title}${body ? `\n${body}` : ''}`;
    const prev = logEl.textContent === '等待操作…' ? '' : `${logEl.textContent}\n\n`;
    logEl.textContent = `${prev}${block}`;
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderFilterCopy() {
    if (!copyEl) return;
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
  }

  copyEl?.addEventListener('click', (event) => {
    const chip = event.target.closest('.xhs-chip');
    if (!chip) return;
    const group = chip.dataset.group;
    const value = chip.dataset.value;
    if (!group || !value) return;
    preset[group] = value;
    renderFilterCopy();
  });

  document.getElementById('labFilterResetBtn')?.addEventListener('click', () => {
    Object.assign(preset, DEFAULT_XHS_FILTER_PRESET);
    renderFilterCopy();
    appendLog('resetPreset', { ...preset });
  });

  async function callLab(step, extra = {}) {
    const response = await Promise.race([
      chrome.runtime.sendMessage({
        type: 'TEST_LAB_STEP',
        payload: { step, keyword: keywordEl.value.trim(), ...extra },
      }),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error('等待超时（40秒）。请重新加载扩展后再试')), 40000);
      }),
    ]);
    if (response?.session) sessionEl.textContent = response.session;
    appendLog(step, response);
    return response;
  }

  function bind(id, step) {
    document.getElementById(id)?.addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      try {
        await callLab(step);
      } catch (error) {
        appendLog(step, { ok: false, error: String(error?.message || error) });
      } finally {
        btn.disabled = false;
      }
    });
  }

  document.getElementById('applyPresetFilterBtn')?.addEventListener('click', async (event) => {
    const btn = event.currentTarget;
    btn.disabled = true;
    try {
      await callLab('applyPresetFilters', { preset: { ...preset } });
    } catch (error) {
      appendLog('applyPresetFilters', { ok: false, error: String(error?.message || error) });
    } finally {
      btn.disabled = false;
    }
  });

  renderFilterCopy();

  bind('openSearchBtn', 'openSearch');
  bind('openFilterBtn', 'openFilter');
  bind('clickNewestBtn', 'clickNewest');
  bind('clickWeekBtn', 'clickWeek');
  bind('leaveFilterBtn', 'leaveFilter');
  bind('scrollOnceBtn', 'scrollOnce');
  bind('extractBtn', 'extractCards');
  bind('openDetailBtn', 'openNoteDetail');
  bind('clickDetailBtn', 'clickNoteDetail');
  bind('enrichDetailBtn', 'enrichNoteDetail');
  bind('closeDetailBtn', 'closeNoteDetail');
  bind('endSessionBtn', 'endSession');
}
