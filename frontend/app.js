const API_BASE = 'http://127.0.0.1:8000';
const urlList = document.querySelector('#url-list');
const rowTemplate = document.querySelector('#url-row-template');
const queueEl = document.querySelector('#queue');
const errorEl = document.querySelector('#input-error');
const cards = new Map();
let nextCardId = 1;

function makeUrlRow(value = '') {
  if (urlList.children.length >= 10) return showError('Maksimal 10 URL per batch untuk starter ini.');
  const row = rowTemplate.content.firstElementChild.cloneNode(true);
  row.querySelector('input').value = value;
  row.querySelector('.row-index').textContent = String(urlList.children.length + 1).padStart(2, '0');
  row.querySelector('.remove-url').addEventListener('click', () => {
    if (urlList.children.length === 1) row.querySelector('input').value = '';
    else row.remove();
    renumberRows();
  });
  row.querySelector('.paste-btn').addEventListener('click', async () => {
    const input = row.querySelector('input');
    try { input.value = await navigator.clipboard.readText(); input.focus(); }
    catch { input.focus(); input.select(); showError('Clipboard tidak tersedia di konteks ini. Tempel URL secara manual.'); }
  });
  urlList.append(row);
  renumberRows();
  row.querySelector('input').focus();
}
function renumberRows() { [...urlList.children].forEach((row, i) => row.querySelector('.row-index').textContent = String(i + 1).padStart(2, '0')); }
function showError(message) { errorEl.hidden = false; errorEl.textContent = message; }
function clearError() { errorEl.hidden = true; errorEl.textContent = ''; }
function fmtDuration(seconds) { if (!Number.isFinite(seconds)) return 'Duration unknown'; const m = Math.floor(seconds / 60); const s = Math.floor(seconds % 60); return `${m}:${String(s).padStart(2, '0')}`; }
function sourceName(item) { const e = (item.extractor || '').toLowerCase(); if (e.includes('youtube')) return 'YouTube'; if (e.includes('tiktok')) return 'TikTok'; if (e.includes('instagram')) return 'Instagram'; return item.extractor || 'Media source'; }
function qualityOptions(format, heights = []) {
  if (format === 'mp3') return [['320k','320 kbps'],['192k','192 kbps'],['128k','128 kbps']];
  const choices = [['best','Best available']];
  [2160,1440,1080,720,480,360].filter(h => !heights.length || heights.some(x => x >= h)).forEach(h => choices.push([`${h}p`, `${h}p${h >= 720 ? ' · HD' : ''}`]));
  return choices;
}
function makeSelect(options, value, aria) {
  const select = document.createElement('select'); select.className = 'select-control'; select.setAttribute('aria-label', aria);
  options.forEach(([v, label]) => { const opt = document.createElement('option'); opt.value = v; opt.textContent = label; select.append(opt); });
  select.value = value; return select;
}
function renderCard(item) {
  const id = `card-${nextCardId++}`;
  const card = document.createElement('article'); card.className = 'media-card'; card.dataset.cardId = id;
  const top = document.createElement('div'); top.className = 'card-top';
  const thumb = document.createElement('div'); thumb.className = 'thumbnail';
  if (item.thumbnail) { const img = document.createElement('img'); img.src = item.thumbnail; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; img.onerror = () => { thumb.textContent = 'NO PREVIEW'; }; thumb.append(img); } else thumb.textContent = 'NO PREVIEW';
  const meta = document.createElement('div'); meta.className = 'card-meta';
  const source = document.createElement('div'); source.className = 'source-label'; source.textContent = `${sourceName(item)} / SOURCE`;
  const title = document.createElement('div'); title.className = 'card-title'; title.textContent = item.title || 'Untitled media';
  const subtitle = document.createElement('div'); subtitle.className = 'card-subtitle'; subtitle.textContent = `${item.uploader || 'Unknown creator'} · ${fmtDuration(item.duration)}`;
  meta.append(source, title, subtitle);
  const remove = document.createElement('button'); remove.className = 'card-remove'; remove.type = 'button'; remove.textContent = '×'; remove.title = 'Remove from queue'; remove.addEventListener('click', () => { card.remove(); cards.delete(id); updateCounts(); showEmptyIfNeeded(); });
  top.append(thumb, meta, remove);
  const options = document.createElement('div'); options.className = 'card-options';
  const formatField = document.createElement('div'); formatField.className = 'field'; const formatLabel = document.createElement('label'); formatLabel.textContent = 'OUTPUT FORMAT';
  const format = makeSelect([['mp4','Video · MP4'],['mp3','Audio · MP3']], 'mp4', 'Output format'); formatField.append(formatLabel, format);
  const qualityField = document.createElement('div'); qualityField.className = 'field'; const qualityLabel = document.createElement('label'); qualityLabel.textContent = 'QUALITY';
  let quality = makeSelect(qualityOptions('mp4', item.available_heights), 'best', 'Output quality'); qualityField.append(qualityLabel, quality); options.append(formatField, qualityField);
  format.addEventListener('change', () => { const opts = qualityOptions(format.value, item.available_heights); quality.replaceChildren(); opts.forEach(([v,l]) => { const o = document.createElement('option'); o.value=v; o.textContent=l; quality.append(o); }); });
  const progressWrap = document.createElement('div'); progressWrap.className = 'progress-wrap'; const progress = document.createElement('div'); progress.className = 'progress-bar'; progressWrap.append(progress);
  const bottom = document.createElement('div'); bottom.className = 'card-bottom'; const status = document.createElement('div'); status.className = 'card-status'; const led = document.createElement('span'); led.className = 'status-led'; const statusText = document.createElement('span'); statusText.textContent = 'READY'; status.append(led, statusText);
  const download = document.createElement('button'); download.className = 'card-download'; download.type = 'button'; download.innerHTML = '↓ Download';
  const state = { id, item, card, format, quality, statusText, led, progress, download, jobId: null, timer: null };
  download.addEventListener('click', () => startDownload(state));
  bottom.append(status, download); card.append(top, options, progressWrap, bottom); queueEl.append(card); cards.set(id, state); updateCounts();
}
function setCardStatus(state, label, kind = '') { state.statusText.textContent = label; state.led.className = `status-led ${kind}`; }
async function startDownload(state) {
  if (state.jobId) return;
  state.download.disabled = true; state.download.textContent = 'Starting…'; setCardStatus(state, 'QUEUED');
  try {
    const response = await fetch(`${API_BASE}/api/downloads`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({url:state.item.url, format:state.format.value, quality:state.quality.value}) });
    const data = await response.json(); if (!response.ok) throw new Error(data.detail || 'Could not start download');
    state.jobId = data.id; setCardStatus(state, 'IN QUEUE', 'running'); state.download.textContent = 'In progress…'; pollJob(state);
  } catch (error) { state.download.disabled = false; state.download.textContent = '↻ Retry'; setCardStatus(state, 'FAILED', 'failed'); showError(`${state.item.title}: ${error.message}`); }
}
async function pollJob(state) {
  if (!state.jobId || !cards.has(state.id)) return;
  try {
    const response = await fetch(`${API_BASE}/api/downloads/${state.jobId}`); const job = await response.json(); if (!response.ok) throw new Error(job.detail || 'Job status unavailable');
    if (job.progress != null) state.progress.style.width = `${job.progress}%`;
    if (job.status === 'completed') { setCardStatus(state, 'COMPLETED', 'completed'); state.download.disabled = false; state.download.textContent = '↓ Save file'; state.download.onclick = () => {
      window.location.href = `${API_BASE}${job.download_url}`;
      state.download.textContent = 'Downloaded ✓';
    }; state.jobId = null; return; }
    if (job.status === 'failed') { setCardStatus(state, 'FAILED', 'failed'); state.download.disabled = false; state.download.textContent = '↻ Retry'; state.jobId = null; return; }
    setCardStatus(state, `${job.status.toUpperCase()}${job.progress != null ? ` · ${job.progress}%` : ''}`, 'running'); state.timer = setTimeout(() => pollJob(state), 1100);
  } catch { setCardStatus(state, 'STATUS ERROR', 'failed'); state.download.disabled = false; state.download.textContent = '↻ Retry'; state.jobId = null; }
}
function updateCounts() { const n = cards.size; document.querySelector('#queue-count').textContent = n; document.querySelector('#nav-count').textContent = n; document.querySelector('#clear-queue').disabled = n === 0; document.querySelector('#download-ready').disabled = n === 0; }
function showEmptyIfNeeded() { if (!cards.size) { queueEl.innerHTML = '<div class="empty-state"><div class="empty-icon">↳</div><strong>Your queue is empty</strong><p>Paste one or more links above, then inspect them to configure each file.</p><span class="mono">WAITING_FOR_INPUT</span></div>'; } }
async function inspectLinks() {
  clearError(); const urls = [...urlList.querySelectorAll('input')].map(i => i.value.trim()).filter(Boolean);
  if (!urls.length) return showError('Tambahkan setidaknya satu URL terlebih dahulu.');
  if (urls.length > 10) return showError('Maksimal 10 URL per batch.');
  const invalid = urls.find(url => { try { const u = new URL(url); return !['http:','https:'].includes(u.protocol); } catch { return true; } });
  if (invalid) return showError(`URL tidak valid: ${invalid}`);
  const button = document.querySelector('#inspect-btn'); button.disabled = true; button.textContent = 'Inspecting…';
  const results = await Promise.allSettled(urls.map(async url => { const res = await fetch(`${API_BASE}/api/inspect`, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})}); const data = await res.json(); if (!res.ok) throw new Error(data.detail || 'Metadata lookup failed'); return data; }));
  let failures = 0;
  results.forEach((result, i) => { if (result.status === 'fulfilled') renderCard(result.value); else { failures++; showError(`URL ${i + 1}: ${result.reason.message}. Pastikan backend berjalan dan sumber didukung.`); } });
  if (failures && !cards.size) showError('Tidak ada URL yang berhasil diperiksa. Jalankan backend dan periksa URL.');
  button.disabled = false; button.innerHTML = 'Inspect links <span>↗</span>'; if (cards.size) queueEl.scrollIntoView({behavior:'smooth',block:'start'});
}

document.querySelector('#add-url').addEventListener('click', () => makeUrlRow());
document.querySelector('#inspect-btn').addEventListener('click', inspectLinks);
document.querySelector('#clear-queue').addEventListener('click', () => { cards.forEach(s => clearTimeout(s.timer)); cards.clear(); queueEl.innerHTML=''; updateCounts(); showEmptyIfNeeded(); });
document.querySelector('#download-ready').addEventListener('click', () => cards.forEach(state => { if (!state.jobId && state.statusText.textContent !== 'COMPLETED') startDownload(state); }));
const themeToggle = document.querySelector('#theme-toggle');
try {
  if (localStorage.getItem('mediadrop-theme') === 'light') document.body.classList.add('light-mode');
} catch {}
themeToggle.addEventListener('click', () => {
  document.body.classList.toggle('light-mode');
  try { localStorage.setItem('mediadrop-theme', document.body.classList.contains('light-mode') ? 'light' : 'dark'); } catch {}
});
async function checkApi() { const state = document.querySelector('#api-state'); try { const r = await fetch(`${API_BASE}/api/health`, {signal:AbortSignal.timeout(1800)}); if (!r.ok) throw new Error(); state.textContent = 'connected'; state.style.color = 'var(--accent)'; } catch { state.textContent = 'offline'; state.style.color = 'var(--red)'; } }
makeUrlRow(); checkApi();
