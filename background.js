// Service worker: the capture pipeline. Orchestrates prepare → scroll
// steps → captureVisibleTab per tile → OffscreenCanvas stitch → store,
// plus the DOM snapshot collected at prepare time. Geometry math and
// diff/storage policies live in shared/diffcore.js (pure, unit-tested).
// This file only choreographs chrome APIs around them.

import './shared/diffcore.js';
import './shared/capturecore.js';
import { ctl } from './shared/inject.js';
import { pageTab, requirePage, failure } from './shared/runtime.js';

const C = () => self.UADiffCore;
const Capture = () => self.UACaptureCore;

const SETTLE_MS = 120; // allow lazy-loaded content to paint per tile
// Keep real screenshots within Chrome's two-calls-per-second quota.
const CAPTURE_INTERVAL_MS = 550;
let lastCaptureAt = 0;
let capturing = false;
let cancelled = false;
let state = { status: 'idle' };

async function progress(patch) {
  state = { ...state, ...patch, updatedAt: Date.now() };
  await chrome.storage.session.set({ captureState: state });
}

function checkCancelled() {
  if (cancelled) throw new Error('Capture cancelled. Your scroll position has been restored.');
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000; // fromCharCode caps at ~64k arguments
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return 'data:image/png;base64,' + btoa(bin);
}

function dataUrlToBlob(dataUrl) {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

async function stitch(tiles, plan, width) {
  const canvas = new OffscreenCanvas(width, plan.totalH);
  const ctx = canvas.getContext('2d');
  for (let i = 0; i < tiles.length; i++) {
    // createImageBitmap from a Blob: fetch('data:…') is not available in
    // service workers, so tiles are decoded via base64 instead
    const bmp = await createImageBitmap(dataUrlToBlob(tiles[i]));
    ctx.drawImage(bmp, 0, plan.ys[i]);
    bmp.close();
  }
  return blobToDataUrl(await canvas.convertToBlob({ type: 'image/png' }));
}

async function captureTab(tab, label, debugTiles, input) {
  // file: pages are supported too — they need the user's "Allow access to
  // file URLs" opt-in, which the popup surfaces when injection fails
  requirePage(tab, true);

  try {
    const options = Capture().options(input);
    const prep = await ctl(tab.id, 'prepare', options);
    if (!prep || prep.error || !prep.ok) throw new Error(prep && prep.error || 'Could not prepare this page for capture.');

    // Older tests can supply rendered tiles; normal captures always use Chrome.
    const tile = async (i) => {
      checkCancelled();
      if (debugTiles && debugTiles[i]) return debugTiles[i];
      const wait = CAPTURE_INTERVAL_MS - (Date.now() - lastCaptureAt);
      if (wait > 0) await sleep(wait);
      checkCancelled();
      const current = (await chrome.tabs.query({ active: true, windowId: tab.windowId }))[0];
      if (!current || current.id !== tab.id) throw new Error('Keep the page tab active until capture finishes.');
      lastCaptureAt = Date.now();
      return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    };

    const first = await tile(0);
    const bmp = await createImageBitmap(dataUrlToBlob(first));
    const width = bmp.width;
    bmp.close();
    const scale = width / prep.viewportWidth;

    const plan = Capture().plan(prep, options, scale, width);
    const { offsets, totalH } = plan;
    await progress({ completed: 1, total: offsets.length, message: `Captured screen 1 of ${offsets.length}` });
    const tiles = [first];
    for (let i = 1; i < offsets.length; i++) {
      checkCancelled();
      const step = await ctl(tab.id, 'step', [offsets[i], true]);
      if (step.error || Math.abs(step.y - offsets[i]) > 2) throw new Error('The page changed while scrolling. Try capturing fewer screens.');
      await sleep(SETTLE_MS);
      tiles.push(await tile(i));
      await progress({ completed: i + 1, message: `Captured screen ${i + 1} of ${offsets.length}` });
    }
    checkCancelled();
    await progress({ message: 'Saving your screenshot…' });
    const png = await stitch(tiles, plan, width);
    const dom = (prep.dom.sig || []).filter(e => e.r && e.r[1] + e.r[3] > plan.startY && e.r[1] < plan.end)
      .map(e => ({ ...e, r: [(e.r[0] - (prep.startX || 0)) * scale, (e.r[1] - plan.startY) * scale, e.r[2] * scale, e.r[3] * scale] }));

    return {
      id: 's-' + Date.now().toString(36),
      at: Date.now(),
      url: tab.url,
      urlKey: C().urlKey(tab.url),
      label: String(label || '').trim().slice(0, 60) || new Date().toLocaleString(),
      w: width,
      h: totalH,
      png,
      dom,
      domCount: dom.length,
      capture: { ...options, screens: plan.screens, startY: plan.startY,
        truncated: plan.truncated, reachedBottom: plan.reachedBottom },
      domTruncated: !!prep.dom.truncated
    };
  } finally {
    await ctl(tab.id, 'restore').catch(() => null);
  }
}

async function doCapture(tabId, label, debugTiles, input) {
  if (capturing) throw new Error('A capture is already running. Wait for it to finish.');
  capturing = true;
  cancelled = false;
  try {
    const options = Capture().options(input);
    await progress({ status: 'capturing', completed: 0, total: 1, message: 'Preparing your screenshot…', snapshotId: null });
    const tab = await pageTab(tabId);
    const snap = await captureTab(tab, label, debugTiles, options);
    checkCancelled();
    const { snapshots } = await chrome.storage.local.get({ snapshots: [] });
    await chrome.storage.local.set({ snapshots: C().appendSnapshot(snapshots, snap) });
    await progress({ status: 'saved', snapshotId: snap.id, message: 'Screenshot saved.' });
    return { id: snap.id, label: snap.label, urlKey: snap.urlKey, w: snap.w, h: snap.h, domCount: snap.domCount, capture: snap.capture };
  } catch (error) {
    await progress({ status: cancelled ? 'cancelled' : 'error', message: failure(error).error });
    throw error;
  } finally {
    capturing = false;
  }
}

// ---------- wiring ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ua-sd-capture',
    title: 'Capture full-page screenshot',
    contexts: ['page']
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture') chrome.storage.local.get({ captureOptions: Capture().DEFAULTS })
    .then(s => doCapture(null, '', null, s.captureOptions)).catch(console.error);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'ua-sd-capture') doCapture(tab && tab.id, '').catch(console.error);
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;
  const run = (p) =>
    p.then(sendResponse).catch((e) => {
      // surfaced in chrome://extensions → service worker → inspect
      console.error('ua-sd handler failed:', e && e.message);
      sendResponse(failure(e));
    });
  if (msg.type === 'ua-sd:capture') {
    run(doCapture(msg.tabId, msg.label, msg.debugTiles, msg.options));
    return true;
  }
  if (msg.type === 'ua-sd:cancel') {
    cancelled = capturing;
    sendResponse({ cancelling: capturing });
    return undefined;
  }
  if (msg.type === 'ua-sd:status') {
    run((async () => {
      const stored = await chrome.storage.session.get({ captureState: { status: 'idle' } });
      if (stored.captureState.status === 'capturing' && !capturing) {
        await progress({ ...stored.captureState, status: 'error', message: 'Capture was interrupted. You can capture again.' });
        return state;
      }
      return stored.captureState;
    })());
    return true;
  }
  return undefined;
});
