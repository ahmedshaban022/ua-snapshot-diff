// Pure diff/geometry/storage logic shared by the service worker, popup,
// viewer page, content scripts (as the global UADiffCore), and Node unit
// tests (CommonJS). No chrome.* or DOM access lives here.

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.UADiffCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const MAX_SNAPSHOTS = 20;
  const STORAGE_BUDGET = 40 * 1024 * 1024; // bytes of stored PNGs + DOM data
  const MAX_DOM_ENTRIES = 3000; // serializer cap per snapshot
  const GEOM_TOLERANCE = 4; // px of rect movement before it counts as changed
  const STYLE_KEYS = [
    'display',
    'visibility',
    'fontSize',
    'fontWeight',
    'color',
    'backgroundColor',
    'textAlign',
    'opacity'
  ];

  // ---------- hashing ----------

  // FNV-1a 32-bit: tiny, fast, stable across sessions (unlike anything
  // keyed on iteration order or identity).
  function fnv1a(str) {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h * 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  // ---------- capture geometry ----------

  // Scroll offsets for scroll-and-stitch: full viewport steps, with the
  // final step pinned to the page bottom so nothing is missed. A last
  // regular step within 10% of the pinned offset is snapped to it instead
  // of capturing a near-duplicate tile.
  function tileOffsets(scrollHeight, viewportHeight) {
    const vh = Math.max(1, Math.floor(viewportHeight) || 1);
    const sh = Math.max(1, Math.floor(scrollHeight) || 1);
    if (sh <= vh) return [0];
    const offsets = [];
    for (let y = 0; y < sh - vh; y += vh) offsets.push(y);
    const bottom = sh - vh;
    if (!offsets.length || bottom - offsets[offsets.length - 1] > vh * 0.1) offsets.push(bottom);
    else offsets[offsets.length - 1] = bottom;
    return offsets;
  }

  // Where each tile is drawn in the stitched (physical-pixel) canvas.
  // scale = captured bitmap width / CSS viewport width (device pixel ratio).
  function stitchPlan(scrollHeight, viewportHeight, scale) {
    const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
    const offsets = tileOffsets(scrollHeight, viewportHeight);
    const ys = offsets.map((o) => Math.round(o * k));
    return { offsets, ys, totalH: Math.round(scrollHeight * k) };
  }

  // ---------- pixel block diff ----------

  // Compares two same-size grayscale buffers block-wise. Returns boxes (in
  // image coordinates) whose blocks differ by more than the threshold.
  // Runs on downscaled copies — the caller maps boxes back to full size.
  function blockDiff(grayA, grayB, w, h, opts) {
    const block = (opts && opts.block) || 16;
    const threshold = (opts && opts.threshold) || 12;
    if (!grayA || !grayB || grayA.length !== grayB.length || w <= 0 || h <= 0) return [];
    const boxes = [];
    const bw = Math.ceil(w / block);
    const bh = Math.ceil(h / block);
    for (let by = 0; by < bh; by++) {
      for (let bx = 0; bx < bw; bx++) {
        let diff = 0;
        const x0 = bx * block;
        const y0 = by * block;
        const x1 = Math.min(x0 + block, w);
        const y1 = Math.min(y0 + block, h);
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            diff = Math.max(diff, Math.abs(grayA[y * w + x] - grayB[y * w + x]));
          }
        }
        if (diff > threshold) boxes.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
      }
    }
    return mergeBoxes(boxes);
  }

  // Union-merge touching boxes so a changed region reads as one rectangle.
  function mergeBoxes(boxes) {
    const out = [];
    const overlaps = (a, b) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
    const queue = boxes.slice();
    let merged = true;
    while (merged) {
      merged = false;
      outer: for (let i = 0; i < queue.length; i++) {
        for (let j = i + 1; j < queue.length; j++) {
          if (overlaps(queue[i], queue[j])) {
            const a = queue[i];
            const b = queue[j];
            queue[j] = {
              x: Math.min(a.x, b.x),
              y: Math.min(a.y, b.y),
              w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x),
              h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y)
            };
            queue.splice(i, 1);
            merged = true;
            break outer;
          }
        }
      }
    }
    return queue;
  }

  // ---------- DOM diff ----------

  function rectDelta(a, b) {
    if (!a || !b || a.length !== 4 || b.length !== 4) return Infinity;
    return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]), Math.abs(a[3] - b[3]));
  }

  // Signature lists in, classified changes out. Two-phase matching built
  // for sibling index shifts (inserts/removes renumber paths):
  // 1) same path + same tag + same style hash → the same component in
  //    place; report text and geometry changes precisely;
  // 2) everything else (shifted, inserted, removed, or restyled) is matched
  //    by content key — tag + text hash + occurrence index — so identical
  //    repeated elements stay distinguishable. Matched pairs report style
  //    and geometry changes; unmatched sides are true removals/additions.
  function diffShots(a, b) {
    const mapA = new Map();
    for (const e of a || []) mapA.set(e.p, e);
    const mapB = new Map();
    for (const e of b || []) mapB.set(e.p, e);

    const changed = [];
    const removed = [];
    const added = [];
    const usedA = new Set();
    const usedB = new Set();

    const idOf = (d) => {
      const m = /#[\w-]+/.exec(d || '');
      return m ? m[0] : '';
    };
    for (const [p, ea] of mapA) {
      const eb = mapB.get(p);
      // "same component in place": same path, tag, style — and, when either
      // side is named, the same #id (an id must never silently transfer to
      // whichever sibling slid into the path)
      if (!eb || eb.t !== ea.t || eb.s !== ea.s || idOf(eb.d) !== idOf(ea.d)) continue;
      usedA.add(p);
      usedB.add(p);
      const kinds = [];
      if (ea.x !== eb.x) kinds.push('text');
      if (rectDelta(ea.r, eb.r) > GEOM_TOLERANCE) kinds.push('geom');
      if (kinds.length) changed.push({ p, t: eb.t, d: eb.d || '', kinds, rA: ea.r, rB: eb.r });
    }

    const leftA = (a || []).filter((e) => !usedA.has(e.p));
    const leftB = (b || []).filter((e) => !usedB.has(e.p));
    // Key on tag + text hash + #id. Container elements carry no direct
    // text, so without the id they'd all collide into one anonymous pool —
    // and occurrence-order matching shifts exactly like paths do.
    const keyOf = (e) => e.t + '|' + (e.x || '') + '|' + idOf(e.d);
    const withOcc = (list) => {
      const seen = new Map();
      return list.map((e) => {
        const k = keyOf(e);
        const occ = seen.get(k) || 0;
        seen.set(k, occ + 1);
        return { e, k: k + '#' + occ };
      });
    };
    const occA = withOcc(leftA);
    const occB = withOcc(leftB);
    const bByKey = new Map(occB.map((o) => [o.k, o.e]));
    const aKeys = new Set(occA.map((o) => o.k));

    for (const { e: ea, k } of occA) {
      const eb = bByKey.get(k);
      if (eb) {
        const kinds = [];
        if (ea.s !== eb.s) kinds.push('style');
        if (rectDelta(ea.r, eb.r) > GEOM_TOLERANCE) kinds.push('geom');
        if (kinds.length) changed.push({ p: eb.p, t: eb.t, d: eb.d || '', kinds, rA: ea.r, rB: eb.r });
      } else {
        removed.push({ p: ea.p, t: ea.t, d: ea.d || '', r: ea.r });
      }
    }
    for (const { e: eb, k } of occB) {
      if (!aKeys.has(k)) added.push({ p: eb.p, t: eb.t, d: eb.d || '', r: eb.r });
    }

    const order = { text: 0, style: 1, geom: 2 };
    changed.sort((u, v) => order[u.kinds[0]] - order[v.kinds[0]] || u.p.localeCompare(v.p, undefined, { numeric: true }));
    return { removed, added, changed, clean: !removed.length && !added.length && !changed.length };
  }

  // ---------- report ----------

  function diffMarkdown(diff, pixelBoxes, meta) {
    const m = meta || {};
    const lines = [];
    lines.push(`# Change diff — ${m.labelB || 'snapshot'} vs ${m.labelA || 'baseline'}`);
    lines.push('');
    lines.push(`URL: ${m.url || ''}`);
    lines.push(
      `DOM: ${diff.changed.length} changed, ${diff.removed.length} removed, ${diff.added.length} added` +
        (pixelBoxes && pixelBoxes.length ? ` · visual: ${pixelBoxes.length} changed region(s)` : '')
    );
    lines.push('');
    if (diff.clean && !(pixelBoxes && pixelBoxes.length)) {
      lines.push('No differences found. 🎉');
      return lines.join('\n');
    }
    const section = (title, list, fmt) => {
      if (!list.length) return;
      lines.push(`## ${title} (${list.length})`, '');
      for (const item of list.slice(0, 50)) lines.push('- ' + fmt(item));
      if (list.length > 50) lines.push(`- … ${list.length - 50} more`);
      lines.push('');
    };
    section('Removed elements', diff.removed, (e) => `\`${e.d || e.t}\``);
    section('Added elements', diff.added, (e) => `\`${e.d || e.t}\``);
    section('Changed elements', diff.changed, (e) => `\`${e.d || e.t}\` — ${e.kinds.join(' + ')}`);
    lines.push('_Generated by UA Change Snapshot._');
    return lines.join('\n');
  }

  // ---------- storage ----------

  // Identity of a page for grouping: origin + path + query (hash excluded —
  // SPAs change it constantly).
  function urlKey(url) {
    try {
      const u = new URL(url);
      return u.origin + u.pathname + u.search;
    } catch (_) {
      return String(url || '');
    }
  }

  function snapshotSize(s) {
    return ((s.png && s.png.length) || 0) * 2 + JSON.stringify(s.dom || []).length * 2;
  }

  function appendSnapshot(list, snap, limits) {
    const max = (limits && limits.max) || MAX_SNAPSHOTS;
    const budget = (limits && limits.budget) || STORAGE_BUDGET;
    const next = (list || []).slice();
    next.push(snap);
    let total = next.reduce((acc, s) => acc + snapshotSize(s), 0);
    while (next.length > max || (total > budget && next.length > 1)) {
      total -= snapshotSize(next.shift()); // oldest first
    }
    return next;
  }

  return {
    MAX_SNAPSHOTS,
    MAX_DOM_ENTRIES,
    GEOM_TOLERANCE,
    STYLE_KEYS,
    fnv1a,
    tileOffsets,
    stitchPlan,
    blockDiff,
    mergeBoxes,
    rectDelta,
    diffShots,
    diffMarkdown,
    urlKey,
    snapshotSize,
    appendSnapshot
  };
});
