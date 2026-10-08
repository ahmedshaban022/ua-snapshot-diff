// Diff viewer: loads two snapshots, computes the DOM diff and (on demand)
// the pixel diff, renders side-by-side or overlay with highlighted boxes,
// and offers markdown summary + overlay PNG export.

const $ = (id) => document.getElementById(id);

let all = [];
let snapA = null;
let snapB = null;
let diff = null;
let pixelBoxes = []; // unit-space boxes {x,y,w,h} in 0..1 of image size
let mode = 'side';

const DOWNSCALE_W = 256; // pixel-diff working width (blocks scale back up)

let _C = null;
// diffcore is a dual-format module (globals for classic scripts, CJS for
// Node) — as an ES module it only sets self.UADiffCore as a side effect.
async function core() {
  if (!_C) {
    await import(chrome.runtime.getURL('shared/diffcore.js'));
    _C = self.UADiffCore;
  }
  return _C;
}

async function load() {
  const { snapshots = [], baselines = {} } = await chrome.storage.local.get({ snapshots: [], baselines: {} });
  all = (snapshots || []).filter((s) => s && s.id && s.png);
  const groups = [...new Set(all.map((s) => s.urlKey))];
  const groupSel = $('group');
  groupSel.textContent = '';
  if (!groups.length) {
    $('sum').textContent = 'No snapshots yet — capture one from the popup.';
    return;
  }
  for (const g of groups) {
    const opt = document.createElement('option');
    opt.value = g;
    opt.textContent = g.replace(/^https?:\/\//, '');
    groupSel.appendChild(opt);
  }
  const wanted = new URLSearchParams(location.search).get('url');
  groupSel.value = groups.includes(wanted) ? wanted : groups[0];
  groupSel.onchange = () => pickDefaults(baselines);
  pickDefaults(baselines);
  $('pickA').onchange = render;
  $('pickB').onchange = render;
}

function pickDefaults(baselines) {
  const group = $('group').value;
  const mine = all.filter((s) => s.urlKey === group).sort((a, b) => a.at - b.at);
  const aSel = $('pickA');
  const bSel = $('pickB');
  aSel.textContent = '';
  bSel.textContent = '';
  for (const s of mine) {
    for (const sel of [aSel, bSel]) {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.label + ' — ' + new Date(s.at).toLocaleTimeString();
      sel.appendChild(opt);
    }
  }
  const baseId = baselines[group];
  aSel.value = mine.some((s) => s.id === baseId) ? baseId : mine[0].id;
  bSel.value = mine[mine.length - 1].id;
  if (aSel.value === bSel.value && mine.length > 1) aSel.value = mine[0].id === bSel.value ? mine[1].id : mine[0].id;
  render();
}

async function computePixelDiff() {
  if (!snapA || !snapB) return [];
  // Decode both PNGs, downscale to DOWNSCALE_W grayscale, block-diff.
  const load = async (dataUrl) => {
    const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
    const h = Math.max(1, Math.round((bmp.height / bmp.width) * DOWNSCALE_W));
    const canvas = document.createElement('canvas');
    canvas.width = DOWNSCALE_W;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bmp, 0, 0, DOWNSCALE_W, h);
    const { data } = ctx.getImageData(0, 0, DOWNSCALE_W, h);
    const gray = new Uint8Array(DOWNSCALE_W * h);
    for (let i = 0; i < gray.length; i++) {
      gray[i] = Math.round((data[i * 4] * 299 + data[i * 4 + 1] * 587 + data[i * 4 + 2] * 114) / 1000);
    }
    bmp.close();
    return { gray, w: DOWNSCALE_W, h };
  };
  let a;
  let b;
  try {
    a = await load(snapA.png);
    b = await load(snapB.png);
  } catch (_) {
    return []; // decode failed; DOM diff still meaningful
  }
  if (a.h !== b.h) return []; // height mismatch (page grew): DOM diff covers it
  const C = await core();
  const boxes = C.blockDiff(a.gray, b.gray, a.w, a.h, { block: 16, threshold: 12 });
  // scale to unit space of the full-size image
  return boxes.map((bx) => ({ x: bx.x / a.w, y: bx.y / a.h, w: bx.w / a.w, h: bx.h / a.h }));
}

async function render() {
  snapA = all.find((s) => s.id === $('pickA').value) || null;
  snapB = all.find((s) => s.id === $('pickB').value) || null;
  if (!snapA || !snapB) return;
  const C = await core();
  diff = C.diffShots(snapA.dom || [], snapB.dom || []);
  pixelBoxes = await computePixelDiff();

  const stage = $('stage');
  stage.textContent = '';

  const mkFig = (snap, capText) => {
    const fig = document.createElement('div');
    fig.className = 'fig';
    const img = document.createElement('img');
    img.src = snap.png;
    img.onload = () => drawBoxes(fig, snap);
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = capText;
    const boxes = document.createElement('div');
    boxes.className = 'boxes';
    fig.appendChild(img);
    fig.appendChild(boxes);
    fig.appendChild(cap);
    return fig;
  };

  if (mode === 'side') {
    stage.appendChild(mkFig(snapA, 'A — ' + snapA.label));
    stage.appendChild(mkFig(snapB, 'B — ' + snapB.label));
  } else {
    const fig = mkFig(snapB, 'B over A — ' + snapB.label);
    const under = fig.querySelector('img');
    under.style.opacity = $('opacity').value / 100;
    fig.insertBefore(Object.assign(document.createElement('img'), { src: snapA.png, style: 'position:absolute;inset:0' }), under);
    stage.appendChild(fig);
  }

  const s = diff;
  $('sum').innerHTML =
    `DOM: <b>${s.changed.length}</b> changed, <b>${s.removed.length}</b> removed, <b>${s.added.length}</b> added` +
    (pixelBoxes.length ? ` · visual: <b>${pixelBoxes.length}</b> region(s)` : ' · no visual regions');

  const issues = $('issues');
  issues.textContent = '';
  const addIssue = (kind, text, box) => {
    const row = document.createElement('div');
    row.className = 'issue';
    const k = document.createElement('div');
    k.className = 'k ' + kind;
    k.textContent = kind;
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = text;
    row.appendChild(k);
    row.appendChild(d);
    row.addEventListener('click', () => flashBox(box));
    issues.appendChild(row);
  };
  if ($('showDom').checked) {
    for (const e of diff.removed) addIssue('removed', e.d || e.t, { fig: 0, rect: e.r });
    for (const e of diff.changed) addIssue(e.kinds[0], `${e.d || e.t} (${e.kinds.join(' + ')})`, { fig: 1, rect: e.rB });
    for (const e of diff.added) addIssue('added', e.d || e.t, { fig: 1, rect: e.r });
  }
  if ($('showPixel').checked) {
    pixelBoxes.forEach((b, i) => addIssue('pixel', `visual region ${i + 1} — ${Math.round(b.w * 100)}% × ${Math.round(b.h * 100)}%`, { fig: 1, unit: b }));
  }
  if (!issues.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = diff.clean && !pixelBoxes.length ? 'No differences. 🎉' : 'Boxes hidden — enable the toggles above.';
    issues.appendChild(empty);
  }
}

function drawBoxes(fig, snap) {
  const boxes = fig.querySelector('.boxes');
  boxes.textContent = '';
  const img = fig.querySelector('img');
  const place = (rect, cls, title) => {
    const b = document.createElement('div');
    b.className = 'b ' + cls;
    b.title = title;
    b.style.left = (rect[0] / snap.w) * 100 + '%';
    b.style.top = (rect[1] / snap.h) * 100 + '%';
    b.style.width = (rect[2] / snap.w) * 100 + '%';
    b.style.height = (rect[3] / snap.h) * 100 + '%';
    boxes.appendChild(b);
    return b;
  };
  const isA = snap === snapA;
  if ($('showDom').checked) {
    if (isA) for (const e of diff.removed) place(e.r, 'removed', 'removed: ' + (e.d || e.t));
    else {
      for (const e of diff.added) place(e.r, 'dom', 'added: ' + (e.d || e.t));
      for (const e of diff.changed) place(e.rB, 'dom', e.kinds.join(' + ') + ': ' + (e.d || e.t));
    }
  }
  if ($('showPixel').checked) {
    for (const u of pixelBoxes) {
      const b = document.createElement('div');
      b.className = 'b pixel';
      b.title = 'visual change region';
      b.style.left = u.x * 100 + '%';
      b.style.top = u.y * 100 + '%';
      b.style.width = u.w * 100 + '%';
      b.style.height = u.h * 100 + '%';
      boxes.appendChild(b);
    }
  }
}

function flashBox(box) {
  if (!box) return;
  const stage = $('stage');
  const figs = [...stage.querySelectorAll('.fig')];
  const fig = figs[box.fig] || figs[figs.length - 1];
  if (!fig) return;
  fig.scrollIntoView({ behavior: 'smooth', block: 'center' });
  for (const b of fig.querySelectorAll('.b')) b.classList.remove('flash');
  let target = null;
  if (box.rect) {
    const snap = box.fig === 0 ? snapA : snapB;
    target = [...fig.querySelectorAll('.b')].find((b) => b.style.left === (box.rect[0] / snap.w) * 100 + '%');
  }
  if (!target) target = fig.querySelector('.b');
  if (target) {
    target.classList.add('flash');
    setTimeout(() => target.classList.remove('flash'), 1200);
  }
}

// ---------- controls ----------

$('side').addEventListener('click', () => {
  mode = 'side';
  $('side').classList.add('sel');
  $('overlay').classList.remove('sel');
  render();
});
$('overlay').addEventListener('click', () => {
  mode = 'overlay';
  $('overlay').classList.add('sel');
  $('side').classList.remove('sel');
  render();
});
$('opacity').addEventListener('input', () => {
  const img = $('stage').querySelector('.fig img:not([style*="absolute"])');
  if (img) img.style.opacity = $('opacity').value / 100;
});
for (const id of ['showPixel', 'showDom']) {
  $(id).addEventListener('change', render);
}

$('copymd').addEventListener('click', async () => {
  const C = await core();
  const md = C.diffMarkdown(diff, pixelBoxes, { url: snapB.url, labelA: snapA.label, labelB: snapB.label });
  try {
    await navigator.clipboard.writeText(md);
    $('copymd').textContent = 'Copied ✓';
  } catch (_) {
    $('copymd').textContent = 'Copy failed';
  }
  setTimeout(() => ($('copymd').textContent = 'Copy summary'), 1500);
});

$('export').addEventListener('click', async () => {
  if (!snapA || !snapB) return;
  const imgA = new Image();
  const imgB = new Image();
  await new Promise((res, rej) => {
    imgA.onload = imgB.onload = res;
    imgA.onerror = imgB.onerror = rej;
    imgA.src = snapA.png;
    imgB.src = snapB.png;
  });
  const canvas = document.createElement('canvas');
  canvas.width = imgB.width;
  canvas.height = imgB.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(imgB, 0, 0);
  ctx.globalAlpha = 0.4;
  ctx.drawImage(imgA, 0, 0);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = '#22d3ee';
  ctx.lineWidth = Math.max(2, Math.round(canvas.width / 500));
  for (const u of pixelBoxes) {
    ctx.strokeRect(u.x * canvas.width, u.y * canvas.height, u.w * canvas.width, u.h * canvas.height);
  }
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = 'diff-overlay.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
});

load().catch(() => {
  $('sum').textContent = 'Failed to load snapshots.';
});
