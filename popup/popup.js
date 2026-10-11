import '../shared/capturecore.js';
import './size.js';
import { request, errorMessage } from '../shared/runtime.js';
const C = self.UACaptureCore;
const $ = id => document.getElementById(id);
let targetId = null, urlKey = null, validPage = false, busy = false, latest = null;
let baselineId = null, snapshots = [];

function status(message = '', kind = '') {
  $('stats').textContent = message; $('stats').dataset.kind = kind;
}
function chosen() {
  return C.options({ mode: document.querySelector('[name="mode"]:checked').value,
    screenCount: $('count').value, start: $('start').value }, 'viewport');
}
function updateControls() {
  const mode = document.querySelector('[name="mode"]:checked').value;
  $('range').hidden = mode !== 'screens';
  const count = Number($('count').value);
  $('capture').textContent = busy ? 'Capturing…' : mode === 'viewport' ? 'Capture one screen'
    : mode === 'full' ? 'Capture full page' : `Capture ${count || '…'} screen${count === 1 ? '' : 's'}`;
  $('capture').disabled = !validPage || busy;
  $('diffbtn').disabled = !validPage || busy || !baselineId;
  for (const el of document.querySelectorAll('#sizes input,#range button,#range input,#range select,#label,#baseline')) el.disabled = busy || !validPage;
  $('less').disabled ||= count <= 1; $('more').disabled ||= count >= C.MAX_SCREENS;
}
async function saveOptions() {
  try { await chrome.storage.local.set({ captureOptions: chosen() }); }
  catch (e) { status(errorMessage(e), 'error'); }
}
function showResult(snapshot) {
  latest = snapshot || null; $('result').hidden = !latest;
  if (!latest) return;
  $('thumbnail').src = latest.png;
  $('dimensions').textContent = `${latest.w.toLocaleString()} × ${latest.h.toLocaleString()} px`;
  $('download').href = latest.png; $('download').download = C.filename(latest);
}
function openPreview(id) {
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/screenshot.html') + (id ? '?id=' + encodeURIComponent(id) : '') });
}
async function refresh() {
  const data = await chrome.storage.local.get({ snapshots: [], baselines: {} });
  snapshots = data.snapshots.filter(s => s && s.urlKey === urlKey);
  baselineId = snapshots.some(s => s.id === data.baselines[urlKey]) ? data.baselines[urlKey] : null;
  $('saved-count').textContent = snapshots.length;
  $('baseline').replaceChildren(new Option('Choose a baseline', ''));
  $('list').replaceChildren();
  for (const s of snapshots.slice().reverse()) {
    $('baseline').appendChild(new Option(s.label, s.id));
    const row = document.createElement('div'); row.className = 'saved-row';
    const open = document.createElement('button'); open.className = 'saved-open';
    const name = document.createElement('strong'); name.textContent = s.label;
    const info = document.createElement('small');
    info.textContent = `${new Date(s.at).toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })} · ${s.w} × ${s.h} px`;
    open.append(name, info); open.addEventListener('click', () => openPreview(s.id));
    const del = document.createElement('button'); del.className = 'delete'; del.textContent = '×'; del.setAttribute('aria-label', 'Delete ' + s.label);
    del.addEventListener('click', async () => {
      if (busy) return;
      const fresh = await chrome.storage.local.get({ snapshots: [], baselines: {} });
      if (fresh.baselines[urlKey] === s.id) delete fresh.baselines[urlKey];
      await chrome.storage.local.set({ snapshots: fresh.snapshots.filter(x => x.id !== s.id), baselines: fresh.baselines });
      await refresh();
    });
    row.append(open, del); $('list').appendChild(row);
  }
  if (!snapshots.length) {
    const empty = document.createElement('p'); empty.className = 'empty';
    empty.textContent = 'Your screenshots will appear here.'; $('list').appendChild(empty);
  }
  $('baseline').value = baselineId || ''; showResult(snapshots[snapshots.length - 1]); updateControls();
}
function renderProgress(state) {
  if (!state || state.status === 'idle') return;
  busy = state.status === 'capturing'; $('progress-box').hidden = !busy;
  $('progress-label').textContent = state.message || 'Preparing…';
  $('progress').max = state.total || 1; $('progress').value = state.completed || 0;
  if (state.status === 'error') status(state.message, 'error');
  else if (state.status === 'cancelled') status(state.message);
  else if (busy) status();
  updateControls();
}
async function capture(compare = false) {
  if (busy || !validPage) return;
  let options;
  try { options = chosen(); } catch (e) { status(errorMessage(e), 'error'); $('count').focus(); return; }
  busy = true; status(); updateControls();
  $('progress-box').hidden = false; $('progress-label').textContent = 'Preparing…'; $('progress').value = 0;
  try {
    await chrome.storage.local.set({ captureOptions: options });
    const res = await request('ua-sd:capture', { tabId: targetId, label: $('label').value || $('label').placeholder, options });
    if (res.error) { status(errorMessage(res), /^Capture cancelled/.test(res.error) ? '' : 'error'); return; }
    await refresh();
    const metadata = res.capture || latest && latest.id === res.id && latest.capture;
    const detail = metadata && metadata.truncated ? ' The page exceeded the safe image limit; capture fewer screens next time.'
      : metadata && metadata.reachedBottom ? ' Reached the bottom of the page.'
      : !metadata ? ' Reload this extension in chrome://extensions to activate the capture-size options.' : '';
    status('Screenshot saved.' + detail, 'success');
    $('result').scrollIntoView({ block:'nearest' });
    if (compare) {
      await chrome.tabs.create({ url: chrome.runtime.getURL('pages/diff.html') + '?url=' + encodeURIComponent(urlKey) }); window.close();
    }
  } catch (e) { status(errorMessage(e), 'error'); }
  finally { busy = false; $('progress-box').hidden = true; updateControls(); }
}
async function init() {
  const tab = (await chrome.tabs.query({ active:true, currentWindow:true }))[0];
  targetId = tab && tab.id; const url = tab && tab.url || '';
  validPage = /^(https?|file):/i.test(url);
  $('page').textContent = tab && tab.title || url || 'No page selected'; $('page').title = url;
  if (validPage) {
    const parsed = new URL(url); urlKey = parsed.origin + parsed.pathname + parsed.search;
    $('label').placeholder = (tab.title || parsed.hostname || 'Screenshot').slice(0, 60);
  } else status('Open a website or local HTML file to take a screenshot.', 'error');
  const { captureOptions } = await chrome.storage.local.get({ captureOptions:C.DEFAULTS });
  let saved; try { saved = C.options(captureOptions, 'viewport'); } catch { saved = C.DEFAULTS; }
  document.querySelector(`[name="mode"][value="${saved.mode}"]`).checked = true;
  $('count').value = saved.screenCount; $('start').value = saved.start;
  await refresh(); renderProgress(await request('ua-sd:status'));
}
for (const el of document.querySelectorAll('[name="mode"],#count,#start')) el.addEventListener('change', () => { updateControls(); saveOptions(); });
$('count').addEventListener('input', updateControls);
for (const [id, change] of [['less',-1],['more',1]]) $(id).addEventListener('click', () => {
  $('count').value = Math.min(C.MAX_SCREENS, Math.max(1, (Number($('count').value) || 1) + change)); updateControls(); saveOptions();
});
$('capture').addEventListener('click', () => capture()); $('diffbtn').addEventListener('click', () => capture(true));
$('cancel').addEventListener('click', async () => { await request('ua-sd:cancel'); $('progress-label').textContent = 'Cancelling…'; });
$('open').addEventListener('click', () => openPreview());
for (const id of ['preview','preview-thumb']) $(id).addEventListener('click', () => latest && openPreview(latest.id));
$('baseline').addEventListener('change', async () => {
  const data = await chrome.storage.local.get({ baselines:{} });
  if ($('baseline').value) data.baselines[urlKey] = $('baseline').value; else delete data.baselines[urlKey];
  await chrome.storage.local.set({ baselines:data.baselines }); baselineId = $('baseline').value || null; updateControls();
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.captureState) renderProgress(changes.captureState.newValue);
  if (area === 'local' && changes.snapshots) refresh().catch(e => status(errorMessage(e), 'error'));
});
init().catch(e => status(errorMessage(e), 'error'));
