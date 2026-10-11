// Pure capture sizing shared by the worker, popup, and regression tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UACaptureCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';
  const MAX_SCREENS = 20;
  const MAX_TILES = 40;
  const DEFAULTS = { mode: 'viewport', screenCount: 3, start: 'current' };

  function options(input, fallbackMode = 'full') {
    const o = input || {};
    const mode = o.mode || fallbackMode;
    if (!['viewport', 'screens', 'full'].includes(mode)) throw new Error('Choose a capture size.');
    const count = Number(o.screenCount == null ? DEFAULTS.screenCount : o.screenCount);
    if (mode === 'screens' && (!Number.isInteger(count) || count < 1 || count > MAX_SCREENS)) {
      throw new Error('Choose between 1 and 20 screens.');
    }
    return { mode, screenCount: mode === 'screens' ? count : DEFAULTS.screenCount,
      start: o.start === 'top' ? 'top' : 'current' };
  }

  function plan(prep, input, scale = 1, width = 1) {
    const o = options(input);
    const vh = Math.max(1, Math.floor(prep.viewportHeight));
    const sh = Math.max(vh, Math.floor(prep.scrollHeight));
    const startY = o.mode === 'full' || o.start === 'top' && o.mode !== 'viewport'
      ? 0 : Math.max(0, Math.min(Number(prep.startY) || 0, sh - vh));
    const desired = o.mode === 'viewport' ? vh : o.mode === 'screens' ? vh * o.screenCount : sh;
    const available = o.mode === 'viewport' ? vh : sh - startY;
    // Bound both dimensions and area before allocating an image canvas.
    const maxPixelsHigh = Math.min(32000, Math.floor(64000000 / Math.max(1, width)));
    const height = Math.max(1, Math.min(desired, available, MAX_TILES * vh, Math.floor(maxPixelsHigh / scale)));
    const end = startY + height;
    const offsets = [startY];
    while (offsets[offsets.length - 1] + vh < end && offsets.length < MAX_TILES) {
      const next = Math.min(offsets[offsets.length - 1] + vh, sh - vh);
      if (next <= offsets[offsets.length - 1]) break;
      offsets.push(next);
    }
    return { offsets, ys: offsets.map(y => Math.round((y - startY) * scale)),
      totalH: Math.round(height * scale), height, startY, end,
      screens: Math.ceil(height / vh), truncated: height < Math.min(desired, available),
      reachedBottom: o.mode === 'screens' && available < desired, ...o };
  }

  function filename(snapshot) {
    const name = String(snapshot.label || 'screenshot').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').slice(0, 80).trim() || 'screenshot';
    return name + '.png';
  }
  return { MAX_SCREENS, DEFAULTS, options, plan, filename };
});
