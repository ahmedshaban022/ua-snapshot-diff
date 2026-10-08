// Service worker: the capture pipeline. Orchestrates prepare → scroll
// steps → captureVisibleTab per tile → OffscreenCanvas stitch → store,
// plus the DOM snapshot collected at prepare time. Geometry math and
// diff/storage policies live in shared/diffcore.js (pure, unit-tested).
// This file only choreographs chrome APIs around them.

import './shared/diffcore.js';
import { ctl } from './shared/inject.js';

const C = () => self.UADiffCore;

const SETTLE_MS = 120; // lazy-load/AI-slop paint settle per tile
const MAX_TILES = 40; // ~40 screens; beyond that the page is pathological

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] || null;
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

async function captureTab(tab, label, debugTiles) {
  if (!tab || tab.id == null || !tab.url || !/^https?:/i.test(tab.url)) return null;

  const prep = await ctl(tab.id, 'prepare').catch(() => null);
  if (!prep || prep.error || !prep.ok) return null;

  // One tile = one captureVisibleTab bitmap. The automation sandbox can't
  // do GPU readback, so the e2e may substitute pre-rendered tiles here
  // (same offsets, same count); interactive Chrome always uses the real
  // capture path.
  const tile = async (i) => {
    if (debugTiles && debugTiles[i]) return debugTiles[i];
    return chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  };

  try {
    const first = await tile(0);
    const bmp = await createImageBitmap(dataUrlToBlob(first));
    const width = bmp.width;
    bmp.close();
    const scale = width / prep.viewportWidth;

    const plan = C().stitchPlan(prep.scrollHeight, prep.viewportHeight, scale);
    const offsets = plan.offsets.slice(0, MAX_TILES);
    const tiles = [first];
    for (let i = 1; i < offsets.length; i++) {
      await ctl(tab.id, 'step', [offsets[i], true]);
      await sleep(SETTLE_MS);
      tiles.push(await tile(i));
    }
    const png = await stitch(tiles, { ...plan, offsets }, width);

    return {
      id: 's-' + Date.now().toString(36),
      at: Date.now(),
      url: tab.url,
      urlKey: C().urlKey(tab.url),
      label: String(label || '').trim().slice(0, 60) || new Date().toLocaleString(),
      w: width,
      h: plan.totalH,
      png,
      dom: prep.dom.sig,
      domCount: prep.dom.count,
      domTruncated: !!prep.dom.truncated
    };
  } finally {
    await ctl(tab.id, 'restore').catch(() => null);
  }
}

async function doCapture(tabId, label, debugTiles) {
  let tab = null;
  if (tabId != null) {
    tab = await chrome.tabs.get(tabId).catch(() => null);
  }
  if (!tab) tab = await activeTab();
  if (!tab) return null;
  const snap = await captureTab(tab, label, debugTiles).catch((e) => {
    console.error('ua-sd capture failed:', e && e.message); // chrome://extensions → inspect
    return null;
  });
  if (!snap) return null;
  const { snapshots } = await chrome.storage.local.get({ snapshots: [] });
  await chrome.storage.local.set({ snapshots: C().appendSnapshot(snapshots, snap) });
  return { id: snap.id, label: snap.label, urlKey: snap.urlKey, w: snap.w, h: snap.h, domCount: snap.domCount };
}

// ---------- wiring ----------

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'ua-sd-capture',
    title: 'Capture snapshot of this page',
    contexts: ['page']
  });
});

chrome.commands.onCommand.addListener((command) => {
  if (command === 'capture') doCapture(null, '');
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'ua-sd-capture') doCapture(null, '');
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;
  const run = (p) =>
    p.then(sendResponse).catch((e) => {
      // surfaced in chrome://extensions → service worker → inspect
      console.error('ua-sd handler failed:', e && e.message);
      sendResponse(null);
    });
  if (msg.type === 'ua-sd:capture') {
    run(doCapture(msg.tabId, msg.label, msg.debugTiles));
    return true;
  }
  if (msg.type === 'ua-sd:open-diff') {
    const q = msg.urlKey ? '?url=' + encodeURIComponent(msg.urlKey) : '';
    run(chrome.tabs.create({ url: chrome.runtime.getURL('pages/diff.html') + q }));
    return true;
  }
  return undefined;
});
