// Unit tests: pure logic from shared/diffcore.js — capture geometry,
// pixel block diff, DOM diff classification, markdown, storage policy.
// Run: node test/run-tests.js
'use strict';

const path = require('node:path');

const C = require(path.join(__dirname, '..', 'shared', 'diffcore.js'));

let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(name + (detail ? ` :: ${detail}` : ''));
  }
}
function eq(name, actual, expected) {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}
function deep(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
}

// ---------- fnv1a ----------
eq('fnv: stable', C.fnv1a('hello'), C.fnv1a('hello'));
check('fnv: distinct', C.fnv1a('hello') !== C.fnv1a('hellp'));
eq('fnv: 8 hex chars', C.fnv1a('x').length, 8);
check('fnv: empty ok', /^[0-9a-f]{8}$/.test(C.fnv1a('')));

// ---------- tileOffsets / stitchPlan ----------
deep('tiles: short page', C.tileOffsets(800, 800), [0]);
deep('tiles: even split', C.tileOffsets(1600, 800), [0, 800]);
deep('tiles: multi with pinned last', C.tileOffsets(3000, 800), [0, 800, 1600, 2200]);
deep('tiles: near-duplicate snapped', C.tileOffsets(1601, 800), [0, 801]);
deep('tiles: tiny viewport guard', C.tileOffsets(0, 0), [0]);
const plan = C.stitchPlan(3000, 800, 2);
deep('plan: offsets', plan.offsets, [0, 800, 1600, 2200]);
deep('plan: ys at scale 2', plan.ys, [0, 1600, 3200, 4400]);
eq('plan: total height', plan.totalH, 6000);
const plan1 = C.stitchPlan(1200, 800, 1);
deep('plan: scale 1', plan1.ys, [0, 400]);
eq('plan: bad scale guarded', C.stitchPlan(100, 50, NaN).ys[1], 50);

// ---------- blockDiff ----------
const W = 64;
const H = 32;
const grayA = new Uint8Array(W * H).fill(100);
const graySame = new Uint8Array(W * H).fill(100);
eq('blockDiff: identical → empty', C.blockDiff(grayA, graySame, W, H).length, 0);
const grayB = new Uint8Array(W * H).fill(100);
for (let y = 8; y < 12; y++) for (let x = 20; x < 30; x++) grayB[y * W + x] = 240;
const boxes = C.blockDiff(grayA, grayB, W, H, { block: 16, threshold: 12 });
check('blockDiff: detects region', boxes.length >= 1, JSON.stringify(boxes));
const b0 = boxes[0];
check('blockDiff: box covers change', b0.x <= 20 && b0.y <= 8 && b0.x + b0.w >= 30 && b0.y + b0.h >= 12, JSON.stringify(b0));
eq('blockDiff: sub-threshold ignored', C.blockDiff(grayA, new Uint8Array(W * H).fill(110), W, H).length, 0);
eq('blockDiff: size mismatch → empty', C.blockDiff(grayA, new Uint8Array(10), W, H).length, 0);

// ---------- mergeBoxes ----------
deep(
  'merge: touching boxes union',
  C.mergeBoxes([
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 10, y: 0, w: 10, h: 10 }
  ]),
  [{ x: 0, y: 0, w: 20, h: 10 }]
);
eq('merge: separate boxes kept', C.mergeBoxes([
  { x: 0, y: 0, w: 5, h: 5 },
  { x: 50, y: 50, w: 5, h: 5 }
]).length, 2);

// ---------- diffShots ----------
const el = (p, over) =>
  Object.assign({ p, t: 'div', d: 'div#' + p, r: [10, 20, 100, 40], x: 'aaaa1111', s: 'bbbb2222' }, over || {});
const base = [el('0'), el('0.0'), el('0.1'), el('0.2')];

deep('diff: identical clean', C.diffShots(base, base.map((e) => ({ ...e }))), { removed: [], added: [], changed: [], clean: true });

let d = C.diffShots(base, base.map((e) => (e.p === '0.1' ? { ...e, x: 'cccc3333' } : { ...e })));
eq('diff: text kind', d.changed[0].kinds.join(), 'text');
check('diff: not clean', d.clean === false);

d = C.diffShots(base, base.map((e) => (e.p === '0.1' ? { ...e, s: 'dddd4444' } : { ...e })));
eq('diff: style kind', d.changed[0].kinds.join(), 'style');

d = C.diffShots(base, base.map((e) => (e.p === '0.2' ? { ...e, r: [20, 30, 100, 40] } : { ...e })));
eq('diff: geom kind', d.changed[0].kinds.join(), 'geom');

d = C.diffShots(base, base.map((e) => (e.p === '0.0' ? { ...e, x: 'zzzz9999', r: [10, 20, 150, 40] } : { ...e })));
eq('diff: combined kinds', d.changed[0].kinds.join(), 'text,geom');

d = C.diffShots(base, base.map((e) => (e.p === '0.0' ? { ...e, r: [12, 22, 100, 40] } : { ...e })));
eq('diff: within tolerance ignored', d.clean, true);

d = C.diffShots(base, base.slice(0, 3));
eq('diff: removed', d.removed.length, 1);
eq('diff: removed keeps descriptor', d.removed[0].p, '0.2');

// middle removal with sibling shift: named container must be reported
// removed, not content-matched onto the anonymous sibling that slid into
// its path (the demo-page failure this guards against)
const cards = (ids) =>
  ids.map((id, i) => ({
    p: '0.' + (i + 1),
    t: 'div',
    d: id ? 'div#' + id + '.card' : 'div.card',
    r: [10, 100 * (i + 1), 500, 80],
    x: '',
    s: 'aaaa0000'
  }));
const before = cards(['hero', 'doomed', null, null]);
const after = cards(['hero', null, null]); // doomed removed, indices shift
d = C.diffShots(before, after);
check('diff: middle removal detected', d.removed.some((r) => r.d.includes('doomed')), JSON.stringify({ r: d.removed.map((x) => x.d), c: d.changed.map((x) => x.d) }));
eq('diff: middle removal adds nothing', d.added.length, 0);
// survivors below the removed card genuinely shift up — geom-only entries
check('diff: middle removal leaves only geom moves', d.changed.every((c) => c.kinds.join(',') === 'geom'), JSON.stringify(d.changed));

d = C.diffShots(base, base.concat([el('0.3')]));
eq('diff: added', d.added.length, 1);

eq('diff: null lists', C.diffShots(null, null).clean, true);
eq('diff: rect missing treated as change', C.diffShots([el('0')], [el('0', { r: null })]).changed[0].kinds.includes('geom'), true);

// ---------- urlKey ----------
eq('key: strips hash keeps query', C.urlKey('https://a.com/x?y=1#z'), 'https://a.com/x?y=1');
eq('key: junk passthrough', C.urlKey('not a url'), 'not a url');

// ---------- appendSnapshot ----------
const snap = (n, kb) => ({ id: 's' + n, png: 'p'.repeat(kb * 1024), dom: [] });
let list = [];
for (let i = 0; i < 25; i++) list = C.appendSnapshot(list, snap(i, 1));
eq('storage: capped at 20', list.length, 20);
check('storage: oldest evicted', !list.some((s) => s.id === 's0') && list.some((s) => s.id === 's24'));
list = [];
for (let i = 0; i < 3; i++) list = C.appendSnapshot(list, snap(i, 500), { max: 20, budget: 1024 * 1024 });
check('storage: budget respected', list.length <= 2, `len=${list.length}`);
eq('storage: never drops the last one', C.appendSnapshot([snap(0, 9000)], snap(1, 1), { max: 20, budget: 1000 }).length, 1);

// ---------- diffMarkdown ----------
const md = C.diffMarkdown(
  {
    changed: [{ d: 'div.card-title', t: 'div', kinds: ['text', 'geom'] }],
    removed: [{ d: 'button#save', t: 'button' }],
    added: [{ d: 'div.toast', t: 'div' }],
    clean: false
  },
  [{ x: 0.1, y: 0.2, w: 0.3, h: 0.1 }],
  { url: 'https://a.com/x', labelA: 'pre-deploy', labelB: 'post-deploy' }
);
check('md: header labels', md.includes('# Change diff — post-deploy vs pre-deploy'));
check('md: counts line', md.includes('1 changed, 1 removed, 1 added') && md.includes('1 changed region'));
check('md: removed section', md.includes('## Removed elements (1)') && md.includes('button#save'));
check('md: changed kinds', md.includes('text + geom'));
check('md: clean report', C.diffMarkdown({ changed: [], removed: [], added: [], clean: true }, [], {}).includes('No differences found'));

console.log(`${pass} passed, ${fail} failed`);
if (fail) {
  for (const f of failures) console.log('FAIL: ' + f);
  process.exit(1);
}
