// Popup logic: capture with a label, manage the per-URL snapshot list,
// pick the baseline, and jump into the diff viewer. Storage is read
// directly; captures go through the service worker.
const $ = (id) => document.getElementById(id);

let urlKey = null;
let snapshots = [];

function send(type, extra) {
  return chrome.runtime.sendMessage(Object.assign({ type }, extra || {})).catch(() => null);
}

async function init() {
  const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0] || null;
  const url = (tab && tab.url) || '';
  const okPage = /^https?:/i.test(url);
  $('page').textContent = okPage ? url : 'Not an http(s) page';
  $('capture').disabled = !okPage;
  $('diffbtn').disabled = !okPage;
  if (!okPage) {
    $('label').disabled = true;
    return;
  }
  urlKey = urlKeyOf(url);
  await refresh();
  const u = new URL(url);
  const def = u.hostname + u.pathname;
  $('label').value = def.length > 58 ? def.slice(0, 57) + '…' : def;
}

function urlKeyOf(url) {
  const u = new URL(url);
  return u.origin + u.pathname + u.search;
}

async function refresh() {
  const { snapshots: all = [], baselines = {} } = await chrome.storage.local.get({ snapshots: [], baselines: {} });
  snapshots = all.filter((s) => s && s.urlKey === urlKey);
  renderList(baselines[urlKey] || null);
  // diff needs a baseline (the fresh capture becomes side B)
  $('diffbtn').disabled = !baselines[urlKey];
}

function renderList(baselineId) {
  const box = $('list');
  box.textContent = '';
  if (!snapshots.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'No snapshots for this page yet.';
    box.appendChild(empty);
    return;
  }
  for (const s of snapshots.slice().reverse()) {
    const row = document.createElement('div');
    row.className = 'snap' + (s.id === baselineId ? ' sel' : '');
    const radio = document.createElement('span');
    radio.className = 'radio';
    radio.title = 'Set as baseline';
    row.appendChild(radio);
    const meta = document.createElement('div');
    meta.className = 'meta';
    const lbl = document.createElement('div');
    lbl.className = 'lbl';
    lbl.textContent = s.label;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = new Date(s.at || 0).toLocaleString() + ' · ' + s.domCount + ' elements · ' + Math.round(s.h) + 'px';
    meta.appendChild(lbl);
    meta.appendChild(sub);
    row.appendChild(meta);
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Delete snapshot';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      const { snapshots: all = [], baselines = {} } = await chrome.storage.local.get({ snapshots: [], baselines: {} });
      if (baselines[urlKey] === s.id) delete baselines[urlKey];
      await chrome.storage.local.set({ snapshots: all.filter((x) => x && x.id !== s.id), baselines });
      refresh();
    });
    row.appendChild(del);
    row.addEventListener('click', async () => {
      const { baselines = {} } = await chrome.storage.local.get({ baselines: {} });
      if (baselines[urlKey] === s.id) delete baselines[urlKey];
      else baselines[urlKey] = s.id;
      await chrome.storage.local.set({ baselines });
      refresh();
    });
    box.appendChild(row);
  }
}

$('capture').addEventListener('click', async () => {
  $('stats').textContent = 'Capturing…';
  const res = await send('ua-sd:capture', { label: $('label').value });
  if (res) {
    $('stats').innerHTML = 'Captured <b>' + res.domCount + '</b> elements, ' + res.h + 'px tall.';
    await refresh();
  } else {
    $('stats').textContent = 'Could not capture (try a normal http(s) page).';
  }
});

$('diffbtn').addEventListener('click', async () => {
  $('stats').textContent = 'Capturing…';
  const res = await send('ua-sd:capture', { label: 'after — ' + new Date().toLocaleTimeString() });
  if (res) {
    await chrome.tabs.create({ url: chrome.runtime.getURL('pages/diff.html') + '?url=' + encodeURIComponent(urlKey) });
    window.close();
  } else {
    $('stats').textContent = 'Could not capture (try a normal http(s) page).';
  }
});

$('open').addEventListener('click', () => {
  const q = urlKey ? '?url=' + encodeURIComponent(urlKey) : '';
  chrome.tabs.create({ url: chrome.runtime.getURL('pages/diff.html') + q });
});

init().catch(() => ($('stats').textContent = 'Popup failed to start — try reopening it.'));
