import '../shared/capturecore.js';
const $ = id => document.getElementById(id);
let snapshots = [], selected = null;
let requestedId = new URLSearchParams(location.search).get('id');
function show(snapshot) {
  selected = snapshot || null;
  $('image-stage').hidden = !selected; $('empty').hidden = !!selected;
  $('download').setAttribute('aria-disabled', String(!selected));
  $('compare').disabled = !selected; $('fit').disabled = !selected; $('actual').disabled = !selected;
  if (!selected) { $('meta').textContent = 'Your captures stay on this device.'; $('notice').hidden = true; return; }
  const c = selected.capture;
  const size = !c || c.mode === 'full' ? 'Full page' : c.mode === 'viewport' ? 'One screen' : `${c.screens} screens`;
  $('meta').textContent = `${selected.label} · ${selected.w} × ${selected.h} px · ${size}`;
  $('meta').title = selected.url;
  $('image').src = selected.png; $('image').alt = 'Screenshot of ' + selected.label;
  $('download').href = selected.png; $('download').download = self.UACaptureCore.filename(selected);
  const missing = requestedId && !snapshots.some(s => s.id === requestedId);
  $('notice').hidden = !(missing || c && c.truncated);
  $('notice').textContent = missing ? 'That screenshot is no longer saved. Showing your latest capture.'
    : 'This screenshot reached the safe image limit. Use More screens to capture a smaller section.';
  for (const button of $('list').querySelectorAll('button')) button.setAttribute('aria-current', String(button.dataset.id === selected.id));
}
function list() {
  const query = $('filter').value.toLowerCase(); $('list').replaceChildren();
  for (const s of snapshots.filter(s => (s.label + ' ' + s.url).toLowerCase().includes(query)).slice().reverse()) {
    const button = document.createElement('button'); button.dataset.id = s.id;
    button.setAttribute('aria-current', String(selected && selected.id === s.id));
    const img = document.createElement('img'); img.src = s.png; img.alt = '';
    const span = document.createElement('span'); const name = document.createElement('strong'); name.textContent = s.label;
    const info = document.createElement('small'); info.textContent = new Date(s.at).toLocaleString([], { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' });
    span.append(name, info); button.append(img, span);
    button.addEventListener('click', () => { requestedId = s.id; show(s); history.replaceState(null, '', '?id=' + encodeURIComponent(s.id)); });
    $('list').appendChild(button);
  }
  if (!$('list').childElementCount) { const p = document.createElement('p'); p.textContent = snapshots.length ? 'No matching screenshots.' : 'No saved screenshots.'; $('list').appendChild(p); }
}
async function load() {
  const data = await chrome.storage.local.get({ snapshots:[] });
  snapshots = data.snapshots.filter(s => s && s.id && s.png);
  const id = selected && selected.id || requestedId;
  list(); show(snapshots.find(s => s.id === id) || snapshots[snapshots.length - 1]);
}
for (const [id, actual] of [['fit',false],['actual',true]]) $(id).addEventListener('click', () => {
  document.querySelector('main').classList.toggle('actual', actual);
  for (const mode of ['fit','actual']) { const pressed = mode === id; $(mode).classList.toggle('selected', pressed); $(mode).setAttribute('aria-pressed', String(pressed)); }
});
$('filter').addEventListener('input', list);
$('compare').addEventListener('click', () => selected && chrome.tabs.create({ url:chrome.runtime.getURL('pages/diff.html') + '?url=' + encodeURIComponent(selected.urlKey) }));
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.snapshots) load(); });
load().catch(() => { $('meta').textContent = 'Could not load screenshots. Reopen the library.'; });
