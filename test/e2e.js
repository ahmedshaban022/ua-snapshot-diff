// End-to-end tests, two parts:
//  A) page-level — inject the real serializer into the demo page, mutate,
//     re-serialize, and diff with the real pure diff (no extension needed).
//  B) full pipeline — load the actual extension (persistent context +
//     --load-extension), drive the real service worker capture on the demo
//     tab (a tall page: 3 stitched tiles), mutate, capture again, and diff
//     from the extension's own diff page context.
// Run: NODE_PATH="<workspace>/.devdeps/node_modules" node test/e2e.js
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DEMO = path.join(__dirname, 'demo');
const PORT = 3791;

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

function startServer() {
  const srv = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(DEMO, 'index.html')));
  });
  return new Promise((resolve) => srv.listen(PORT, '127.0.0.1', () => resolve(srv)));
}

async function findExtId(context) {
  // 1) an already-running service worker
  let sw = context.serviceWorkers().find((w) => w.url().startsWith('chrome-extension://'));
  if (sw) return new URL(sw.url()).host;
  // 2) one that starts while we wait
  try {
    sw = await context.waitForEvent('serviceworker', { timeout: 5000 });
    return new URL(sw.url()).host;
  } catch (_) {
    /* fall through */
  }
  // 3) MV3 workers go idle and vanish from the list — read the id from the
  //    profile's extension registry instead (prefs live under Default/)
  for (const rel of ['Default/Secure Preferences', 'Default/Preferences', 'Secure Preferences', 'Preferences']) {
    const file = path.join(__dirname, '.profile', ...rel.split('/'));
    if (!fs.existsSync(file)) continue;
    try {
      const prefs = JSON.parse(fs.readFileSync(file, 'utf8'));
      const settings = prefs.extensions && prefs.extensions.settings;
      for (const [id, meta] of Object.entries(settings || {})) {
        if (meta && typeof meta.path === 'string' && meta.path.replace(/\\/g, '/').endsWith('/uasb-testext')) {
          return id;
        }
      }
    } catch (_) {
      /* corrupt prefs: try the next file */
    }
  }
  return null;
}

async function partPageLevel() {
  const { chromium } = require('playwright-core');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });
    for (const f of ['shared/diffcore.js', 'content/domshot.js']) {
      await page.addScriptTag({ path: path.join(ROOT, f) });
    }
    const s1 = await page.evaluate(() => window.UASnapDom.serialize(document.body));
    check('page: serializer ran', s1.count > 10, `count=${s1.count}`);
    check('page: not truncated', !s1.truncated);
    const entry = s1.sig.find((e) => e.d.includes('hero-title'));
    check('page: entry has fields', !!entry && /^[0-9a-f]{8}$/.test(entry.x) && entry.r.length === 4);

    await page.evaluate(() => {
      window.__mutate.text();
      window.__mutate.geom();
      window.__mutate.add();
      window.__mutate.remove();
    });
    const s2 = await page.evaluate(() => window.UASnapDom.serialize(document.body));
    const diff = await page.evaluate(
      ({ a, b }) => window.UADiffCore.diffShots(a, b),
      { a: s1.sig, b: s2.sig }
    );
    check('diff: not clean', diff.clean === false);
    const changed = diff.changed.map((c) => c.d);
    check('diff: text change found', changed.some((d) => d.includes('hero-title') || d.includes('overdue')));
    check('diff: geom change found', diff.changed.some((c) => c.kinds.includes('geom') && c.d.includes('wobble')));
    check('diff: added toast', diff.added.some((a) => a.d.includes('toast')));
    check('diff: removed doomed', diff.removed.some((r) => r.d.includes('doomed')));
    const still = await page.evaluate(({ a, b }) => window.UADiffCore.diffShots(a, b).clean, { a: s1.sig, b: s1.sig });
    check('diff: identical clean', still === true);
  } finally {
    await browser.close();
  }
}

// Branded Google Chrome (137+) silently ignores --load-extension, so part
// B prefers a Playwright-managed Chromium build from the local cache and
// falls back to the installed Chrome channel.
//
// activeTab (the extension's whole permission model) is only granted on a
// real user gesture — toolbar click, Alt+Shift+S, context menu — which a
// headless run cannot synthesize. The e2e therefore loads a patched COPY
// of the extension whose manifest additionally grants host permission for
// the test origin only. The shipped manifest is never touched.
function findChromiumExe() {
  const root = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!fs.existsSync(root)) return null;
  const dirs = fs
    .readdirSync(root)
    .filter((d) => /^chromium-\d+$/.test(d))
    .sort()
    .reverse();
  for (const d of dirs) {
    for (const sub of ['chrome-win64', 'chrome-win', 'chrome-linux', 'chrome-mac']) {
      const p = path.join(root, d, sub, process.platform === 'win32' ? 'chrome.exe' : 'chrome');
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

const TEST_EXT = path.join(fs.realpathSync(require('node:os').tmpdir()), 'uasb-testext');

function buildTestExtension() {
  fs.rmSync(TEST_EXT, { recursive: true, force: true });
  fs.cpSync(ROOT, TEST_EXT, { recursive: true });
  // strip non-runtime dirs (kept out of the copy filter above when possible)
  for (const junk of ['test', '.git', '.mimosa', 'store', 'ua-snapshot-diff-v1.0.0.zip']) {
    fs.rmSync(path.join(TEST_EXT, junk), { recursive: true, force: true });
  }
  const manifestPath = path.join(TEST_EXT, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // captureVisibleTab accepts only <all_urls> or activeTab (per-origin host
  // permissions are not enough), so the test copy grants <all_urls>.
  manifest.host_permissions = ['<all_urls>'];
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return TEST_EXT;
}

async function partFullExtension() {
  const { chromium } = require('playwright-core');
  const exe = findChromiumExe();
  const extRoot = buildTestExtension();
  const launchOpts = {
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extRoot}`,
      `--load-extension=${extRoot}`,
      '--no-first-run',
      '--no-default-browser-check'
    ]
  };
  if (exe) launchOpts.executablePath = exe;
  else launchOpts.channel = 'chrome';
  const context = await chromium.launchPersistentContext(path.join(__dirname, '.profile'), launchOpts);
  try {
    const extId = await findExtId(context);
    if (!extId) throw new Error('extension id not found — extension failed to load?');
    if (process.env.UASB_DEBUG) {
      const logWorker = (w) => w.on('console', (m) => console.log('[sw]', m.type(), m.text().slice(0, 300)));
      context.serviceWorkers().forEach(logWorker);
      context.on('serviceworker', logWorker);
    }

    const page = (context.pages()[0] || (await context.newPage()));
    await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'load' });

    // captureVisibleTab's GPU readback is unavailable in the automation
    // sandbox, so tiles are pre-rendered via CDP at the exact planned
    // offsets and handed to the service worker; everything else (prepare,
    // real scrolling + fixed-element choreography, stitching, storage,
    // diffing) runs through the shipped code.
    const C = require(path.join(ROOT, 'shared', 'diffcore.js'));
    const cdp = await context.newCDPSession(page);
    const renderTiles = async () => {
      const scrollH = await page.evaluate(() => document.documentElement.scrollHeight);
      const vh = await page.evaluate(() => window.innerHeight);
      const offsets = C.tileOffsets(scrollH, vh);
      const tiles = [];
      for (const y of offsets) {
        await page.evaluate((yy) => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))), y);
        await page.evaluate((yy) => window.scrollTo(0, yy), y);
        await page.waitForTimeout(150);
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
        tiles.push('data:image/png;base64,' + shot.data);
      }
      await page.evaluate(() => window.scrollTo(0, 0));
      return { tiles, scrollH };
    };

    // The diff page doubles as our in-extension test driver.
    const extPage = await context.newPage();
    await extPage.goto(`chrome-extension://${extId}/pages/diff.html`);
    await page.bringToFront(); // the demo tab must stay the active tab

    const pre1 = await renderTiles();
    const cap1 = await extPage.evaluate(
      ({ label, tiles }) => chrome.runtime.sendMessage({ type: 'ua-sd:capture', label, debugTiles: tiles }),
      { label: 'pre-mutation', tiles: pre1.tiles }
    );
    check('ext: capture returned', !!cap1 && !!cap1.id, JSON.stringify(cap1));
    check(
      'ext: stitched height ≈ page height',
      cap1 && Math.abs(cap1.h - pre1.scrollH) <= pre1.scrollH * 0.1,
      `h=${cap1 && cap1.h} scrollH=${pre1.scrollH}`
    );
    check('ext: dom captured', cap1 && cap1.domCount > 10, `dom=${cap1 && cap1.domCount}`);

    const stored = await extPage.evaluate(() => chrome.storage.local.get({ snapshots: [] }));
    const snap1 = stored.snapshots.find((s) => s.id === cap1.id);
    check('ext: snapshot stored', !!snap1);
    check('ext: png is a data url', !!snap1 && snap1.png.startsWith('data:image/png;base64,'));
    check('ext: png is multi-tile sized', !!snap1 && snap1.png.length > 20000, `len=${snap1 && snap1.png.length}`);

    // Page must be exactly restored after capture.
    check('ext: capture restored page', await page.evaluate(() => !document.querySelector('[data-uasb-fixed]')));
    check('ext: scroll position restored', await page.evaluate(() => window.scrollY === 0), `scrollY=${await page.evaluate(() => window.scrollY)}`);

    await page.evaluate(() => {
      window.__mutate.text();
      window.__mutate.geom();
      window.__mutate.add();
      window.__mutate.remove();
    });
    const pre2 = await renderTiles();
    const cap2 = await extPage.evaluate(
      (tiles) => chrome.runtime.sendMessage({ type: 'ua-sd:capture', label: 'post-mutation', debugTiles: tiles }),
      pre2.tiles
    );
    check('ext: second capture ok', !!cap2 && cap2.id !== cap1.id);

    const diff = await extPage.evaluate(
      ({ a, b }) =>
        // dual-format module: ES import only sets self.UADiffCore
        import(chrome.runtime.getURL('shared/diffcore.js')).then(() => self.UADiffCore.diffShots(a, b)),
      {
        a: snap1.dom,
        b: await extPage.evaluate((id) => chrome.storage.local.get({ snapshots: [] }).then((s) => s.snapshots.find((x) => x.id === id).dom), cap2.id)
      }
    );
    check('ext diff: changed found', diff.changed.length > 0);
    check('ext diff: removed doomed', diff.removed.some((r) => r.d.includes('doomed')));
    check('ext diff: added toast', diff.added.some((a) => a.d.includes('toast')));

    const count = await extPage.evaluate(() => chrome.storage.local.get({ snapshots: [] }).then((s) => s.snapshots.length));
    eq2('ext: two snapshots stored', count, 2);
  } finally {
    await context.close();
  }

  function eq2(name, actual, expected) {
    check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
  }
}

(async () => {
  const srv = await startServer();
  try {
    await partPageLevel();
    await partFullExtension();
    console.log(`${pass} passed, ${fail} failed`);
  } finally {
    srv.close();
  }
  if (fail) {
    for (const f of failures) console.log('FAIL: ' + f);
    process.exit(1);
  }
})().catch((e) => {
  console.error('E2E crashed:', e);
  process.exit(1);
});
