import {
  getSharedFilterPreset,
  resetSharedFilterPreset,
  saveSharedFilterPreset,
} from '../lib/filter-preset-ui.js';

export function initLab() {
  const keywordEl = document.getElementById('labKeyword');
  const sessionEl = document.getElementById('labSessionStatus');
  const logEl = document.getElementById('labLog');
  if (!keywordEl || !sessionEl || !logEl) return;

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

  document.getElementById('labFilterResetBtn')?.addEventListener('click', () => {
    resetSharedFilterPreset();
    appendLog('resetPreset', getSharedFilterPreset());
  });

  document.getElementById('labFilterSaveBtn')?.addEventListener('click', async () => {
    const saved = await saveSharedFilterPreset();
    appendLog('savePreset', saved);
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
      await callLab('applyPresetFilters', { preset: getSharedFilterPreset() });
    } catch (error) {
      appendLog('applyPresetFilters', { ok: false, error: String(error?.message || error) });
    } finally {
      btn.disabled = false;
    }
  });

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
