import { resolveLeadPublishAt } from './publish-time.js';

function extractAuthorIdFromUrl(url) {
  if (!url) return '';
  const match = String(url).match(/\/user\/profile\/([a-f0-9]{24})/i);
  return match ? match[1] : '';
}

/** 从「昨天 14:14」等文案推算北京时间 Date */
function parseRelativeClockText(raw, now = new Date()) {
  const text = String(raw || '');
  const m = text.match(/(昨天|前天|今天)\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const dayOffset = m[1] === '昨天' ? -1 : (m[1] === '前天' ? -2 : 0);
  const d = new Date(now);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(Number(m[2]), Number(m[3]), 0, 0);
  return d;
}

function cleanAuthorName(name) {
  return String(name || '')
    .replace(/(昨天|前天|今天)\s*\d{1,2}:\d{2}/g, '')
    .replace(/\d+\s*(分钟前|小时前|天前|周前|个月前|年前)/g, '')
    .replace(/\b\d{1,2}:\d{2}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 补全 authorId / authorUrl，便于导出唯一定位 */
export function normalizeLeadAuthor(lead) {
  const authorId = lead.authorId || extractAuthorIdFromUrl(lead.authorUrl) || '';
  const authorUrl = lead.authorUrl
    || (authorId ? `https://www.xiaohongshu.com/user/profile/${authorId}` : '');
  return {
    ...lead,
    authorId,
    authorUrl,
    authorName: cleanAuthorName(lead.authorName),
  };
}

/** 导出展示用：优先小红书号 */
export function displayRedId(lead) {
  const red = String(lead.redId || '').trim();
  if (red && !/^[a-f0-9]{24}$/i.test(red)) return red;
  return '';
}

/**
 * 发帖时间展示：优先用已存 publishAt；
 * 若像「昨天 14:14」被误解析成中午，可从昵称/原文案回修
 */
export function resolvePublishDisplay(lead) {
  const blob = `${lead.publishTimeText || ''} ${lead.authorName || ''}`;
  const fromClock = parseRelativeClockText(blob);
  if (fromClock) return formatPublishAtLocal(fromClock);

  const resolved = resolveLeadPublishAt(lead);
  const local = formatPublishAtLocal(resolved.publishAt || lead.publishAt);
  if (local) return local;
  return lead.publishTimeText || '';
}

/** Asia/Shanghai → YYYY-MM-DD HH:mm（导出/展示，避免 UTC ISO 差 8 小时） */
export function formatPublishAtLocal(dateOrIso) {
  if (!dateOrIso) return '';
  const d = dateOrIso instanceof Date ? dateOrIso : new Date(dateOrIso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d);
    const get = (type) => parts.find((p) => p.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}`;
  } catch {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
}

export function leadsToCsv(leads) {
  // 用户ID / 主页优先；publishAt 导出为北京时间可读字符串
  const headers = [
    'redId', 'authorId', 'authorUrl', 'authorName',
    'noteId', 'noteUrl', 'title', 'desc', 'coverImageUrl',
    'likes', 'publishTimeText', 'publishAt', 'matchedKeyword',
    'leadScore', 'leadTier', 'filterMode', 'filterReason',
    'aiConfidence', 'aiReason', 'reviewStatus', 'reviewSource',
    'collected', 'collectMessage',
    'mustHavePath', 'matchedSignals', 'crawledAt',
  ];

  const escape = (value) => {
    const str = String(value ?? '');
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const rows = leads.map((raw) => {
    const lead = normalizeLeadAuthor(raw);
    return headers.map((key) => {
      if (key === 'publishAt') {
        return escape(resolvePublishDisplay(raw) || lead.publishTimeText || '');
      }
      if (key === 'crawledAt') {
        return escape(formatPublishAtLocal(lead.crawledAt) || lead.crawledAt || '');
      }
      return escape(lead[key]);
    }).join(',');
  });
  return [headers.join(','), ...rows].join('\n');
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function downloadCsv(leads, filename = 'xhs-leads.csv') {
  const csv = `\uFEFF${leadsToCsv(leads)}`;
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  triggerDownload(blob, filename);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function leadsToReachHtml(leads) {
  const rows = leads.map((raw) => {
    const lead = normalizeLeadAuthor(raw);
    const rowId = escapeHtml(lead.noteId || lead.authorId || Math.random().toString(36).slice(2));
    const cover = lead.coverImageUrl
      ? `<img class="cover" src="${escapeHtml(lead.coverImageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
      : '<span class="no-cover">无封面</span>';
    const title = String(lead.title || '').slice(0, 120);
    const publishLocal = resolvePublishDisplay(raw) || '未知';
    // 导出时：不符合默认不勾「符合」；其余默认勾选
    const isOkDefault = lead.reviewStatus !== 'rejected';
    return `<tr data-row-id="${rowId}" class="${isOkDefault ? '' : 'is-rejected'}">
  <td class="check">
    <label class="chk"><input type="checkbox" class="js-ok" ${isOkDefault ? 'checked' : ''} /><span>符合</span></label>
  </td>
  <td class="check">
    <label class="chk"><input type="checkbox" class="js-contacted" /><span>已建联</span></label>
  </td>
  <td class="thumb">${cover}</td>
  <td><a href="${escapeHtml(lead.authorUrl)}" target="_blank" rel="noopener">主页</a></td>
  <td>${escapeHtml(lead.authorName)}</td>
  <td class="time">${escapeHtml(publishLocal)}</td>
  <td>${escapeHtml(title)}</td>
  <td><a href="${escapeHtml(lead.noteUrl)}" target="_blank" rel="noopener">帖子</a></td>
  <td>${escapeHtml(lead.aiReason || lead.filterReason || '')}</td>
</tr>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>小红书线索预览</title>
<style>
  body { font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; margin: 24px; background: #f6f4f1; color: #1a1a1a; }
  h1 { font-size: 20px; margin: 0 0 8px; }
  .meta { color: #666; font-size: 13px; margin-bottom: 8px; }
  .hint { color: #888; font-size: 12px; margin-bottom: 16px; }
  .stats { font-size: 13px; margin-bottom: 12px; color: #444; }
  table { border-collapse: collapse; width: 100%; background: #fff; }
  th, td { border: 1px solid #e5e1db; padding: 8px 10px; vertical-align: top; font-size: 13px; }
  th { background: #efeae3; text-align: left; position: sticky; top: 0; z-index: 1; }
  .thumb { width: 96px; }
  .cover { width: 88px; height: 88px; object-fit: cover; border-radius: 6px; background: #eee; }
  .no-cover { color: #999; font-size: 12px; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; word-break: break-all; }
  .time { white-space: nowrap; color: #333; }
  .check { width: 72px; text-align: center; white-space: nowrap; }
  .chk { display: inline-flex; flex-direction: column; align-items: center; gap: 2px; cursor: pointer; font-size: 11px; color: #555; user-select: none; }
  .chk input { width: 16px; height: 16px; cursor: pointer; }
  a { color: #c2410c; }
  tr.is-contacted { background: #f0f7f0; }
  tr.is-rejected td {
    filter: blur(1.2px);
    opacity: 0.45;
    text-decoration: line-through;
    text-decoration-thickness: 1.5px;
    text-decoration-color: #a33;
  }
  tr.is-rejected td.check {
    filter: none;
    opacity: 1;
    text-decoration: none;
  }
  tr.is-rejected .cover { filter: grayscale(1) blur(1px); }
</style>
</head>
<body>
  <h1>小红书线索触达预览</h1>
  <p class="meta">共 ${leads.length} 条 · 发帖时间为北京时间 · ${formatPublishAtLocal(new Date())}</p>
  <p class="hint">取消勾选「符合」→ 该行模糊+删除线；勾选「已建联」标记已联系。触达请点「主页」。勾选状态保存在本机浏览器。</p>
  <p class="stats" id="opsStats"></p>
  <table>
    <thead>
      <tr>
        <th>是否符合</th>
        <th>是否已建联</th>
        <th>封面</th>
        <th>主页</th>
        <th>昵称</th>
        <th>发帖时间</th>
        <th>标题</th>
        <th>帖子</th>
        <th>判定理由</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>
<script>
(function () {
  var STORAGE_KEY = 'xhs-reach-ops-v1';

  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') || {}; }
    catch (e) { return {}; }
  }

  function saveState(state) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) {}
  }

  function updateRow(tr) {
    var ok = tr.querySelector('.js-ok');
    var contacted = tr.querySelector('.js-contacted');
    tr.classList.toggle('is-rejected', !(ok && ok.checked));
    tr.classList.toggle('is-contacted', !!(contacted && contacted.checked));
  }

  function refreshStats() {
    var rows = document.querySelectorAll('tbody tr[data-row-id]');
    var okN = 0, rejectN = 0, contactN = 0;
    rows.forEach(function (tr) {
      var ok = tr.querySelector('.js-ok');
      var contacted = tr.querySelector('.js-contacted');
      if (ok && ok.checked) okN += 1; else rejectN += 1;
      if (contacted && contacted.checked) contactN += 1;
    });
    var el = document.getElementById('opsStats');
    if (el) {
      el.textContent = '符合 ' + okN + ' · 不符合 ' + rejectN + ' · 已建联 ' + contactN;
    }
  }

  function persistAll() {
    var state = loadState();
    document.querySelectorAll('tbody tr[data-row-id]').forEach(function (tr) {
      var id = tr.getAttribute('data-row-id');
      var ok = tr.querySelector('.js-ok');
      var contacted = tr.querySelector('.js-contacted');
      state[id] = {
        ok: !!(ok && ok.checked),
        contacted: !!(contacted && contacted.checked),
      };
    });
    saveState(state);
    refreshStats();
  }

  var saved = loadState();
  document.querySelectorAll('tbody tr[data-row-id]').forEach(function (tr) {
    var id = tr.getAttribute('data-row-id');
    var ok = tr.querySelector('.js-ok');
    var contacted = tr.querySelector('.js-contacted');
    if (saved[id]) {
      if (ok) ok.checked = !!saved[id].ok;
      if (contacted) contacted.checked = !!saved[id].contacted;
    }
    updateRow(tr);
    if (ok) ok.addEventListener('change', function () { updateRow(tr); persistAll(); });
    if (contacted) contacted.addEventListener('change', function () { updateRow(tr); persistAll(); });
  });
  refreshStats();
})();
</script>
</body>
</html>`;
}

/** 导出带缩略图的 HTML，方便运营扫一眼是否广告 */
export function downloadReachHtml(leads, filename = 'xhs-reach-preview.html') {
  const html = leadsToReachHtml(leads);
  const blob = new Blob([html], { type: 'text/html;charset=utf-8;' });
  triggerDownload(blob, filename);
}
