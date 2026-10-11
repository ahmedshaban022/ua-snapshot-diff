// Exercises the real worker pipeline against Chrome's screenshot quota.
// Run: node test/background-tests.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../shared/diffcore.js');

async function main() {
  let now = 10000;
  let listener;
  let restores = 0;
  let captures = [];
  let snapshots = [];
  let pageIsActive = true;
  let prepareError = false;
  let prepareGate = null;
  const noopEvent = { addListener() {} };
  const tab = { id: 7, windowId: 1, url: 'http://localhost/demo' };
  const sandbox = {
    self: { UADiffCore: core, UACaptureCore: require('../shared/capturecore.js') }, console,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, ms) { now += ms; queueMicrotask(fn); },
    Blob, Uint8Array, btoa, atob,
    createImageBitmap: async () => ({ width: 100, close() {} }),
    OffscreenCanvas: class {
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return new Blob(['png']); }
    },
    ctl: async (_id, action) => {
      if (action === 'prepare' && prepareGate) await prepareGate;
      if (action === 'prepare' && prepareError) throw new Error('Cannot access contents of the page.');
      if (action === 'prepare') return { ok: true, viewportWidth: 100, viewportHeight: 100,
        scrollHeight: 350, dom: { sig: [], count: 1 } };
      if (action === 'restore') restores++;
      return { ok: true };
    },
    chrome: {
      tabs: { query: async (options) => options.windowId && !pageIsActive ? [{ ...tab, id: 8 }] : [tab], get: async () => tab,
        captureVisibleTab: async () => {
          if (captures.filter(t => now - t < 1000).length >= 2) {
            throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota exceeded');
          }
          captures.push(now);
          return 'data:image/png;base64,cG5n';
        } },
      storage: { session: { set: async () => {}, get: async () => ({ captureState: { status:'idle' } }) }, local: { get: async () => ({ snapshots }),
        set: async (data) => { snapshots = data.snapshots; } } },
      runtime: { onInstalled: noopEvent, onMessage: { addListener(fn) { listener = fn; } } },
      commands: { onCommand: noopEvent }, contextMenus: { onClicked: noopEvent }
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8')
    .replace(/^import .*;\r?\n/gm, '');
  const context = vm.createContext(sandbox);
  const runtime = fs.readFileSync(path.join(__dirname, '../shared/runtime.js'), 'utf8')
    .replace(/^export /gm, '');
  vm.runInContext(runtime, context, { filename: 'runtime.js' });
  vm.runInContext(source, context, { filename: 'background.js' });
  const capture = () => new Promise(resolve => listener({ type: 'ua-sd:capture' }, {}, resolve));
  const first = await capture();
  assert.ok(first && first.id, 'A four-tile page must capture within Chrome screenshot quota');
  const second = await capture();
  assert.ok(second && second.id, 'A subsequent capture must also respect the shared quota');
  assert.equal(snapshots.length, 2);
  assert.equal(restores, 2, 'Both captures must restore the page');
  assert.equal(captures.length, 8, 'Both captures use the real captureVisibleTab boundary');
  console.log('PASS multi-tile and repeated captures respect Chrome quota and restore the page');
  pageIsActive = false;
  const switched = await capture();
  assert.match(switched.error, /Keep the page tab active/);
  assert.equal(captures.length, 8, 'Never capture a different active tab');
  assert.equal(restores, 3, 'Tab-switch failures restore the original page');
  pageIsActive = true;
  prepareError = true;
  const denied = await capture();
  assert.match(denied.error, /Cannot access/);
  assert.equal(restores, 4, 'Even a partially failed preparation is cleaned up');
  prepareError = false;
  let release;
  prepareGate = new Promise(resolve => { release = resolve; });
  const pending = capture();
  const overlapping = await capture();
  assert.match(overlapping.error, /already running/);
  release();
  assert.ok((await pending).id, 'The first capture must still finish');
  console.log('PASS switched tabs, denied access, and overlapping captures fail safely');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
