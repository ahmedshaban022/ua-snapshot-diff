// DOM serializer: walks the composed tree (open shadow roots included)
// and emits one signature per element — stable path, tag, short selector,
// page-absolute rect, text hash, style hash. Pure hashing and caps come
// from UADiffCore; this file only walks.
'use strict';
(function () {
  const C = window.UADiffCore;

  function directText(el) {
    let out = '';
    for (const n of el.childNodes) {
      if (n.nodeType === 3) out += n.nodeValue;
    }
    return out.trim();
  }

  function describe(el) {
    const tag = el.tagName.toLowerCase();
    const id = el.id ? '#' + el.id : '';
    const cls =
      (typeof el.className === 'string' ? el.className : '')
        .trim()
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((c) => '.' + c)
        .join('');
    const s = tag + id + cls;
    return s.length > 48 ? s.slice(0, 45) + '…' : s;
  }

  function visibleEnough(el, cs) {
    if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  }

  function serialize(root, cap) {
    const limit = cap || C.MAX_DOM_ENTRIES;
    const sig = [];
    let truncated = false;

    function walk(el, path) {
      if (sig.length >= limit) {
        truncated = true;
        return;
      }
      let cs;
      try {
        cs = getComputedStyle(el);
      } catch (_) {
        return; /* detached mid-walk */
      }
      if (visibleEnough(el, cs)) {
        const r = el.getBoundingClientRect();
        const text = directText(el);
        const styleString = C.STYLE_KEYS.map((k) => cs[k]).join('|');
        sig.push({
          p: path,
          t: el.tagName.toLowerCase(),
          d: describe(el),
          r: [Math.round(r.left + window.scrollX), Math.round(r.top + window.scrollY), Math.round(r.width), Math.round(r.height)],
          x: text ? C.fnv1a(text) : '',
          s: C.fnv1a(styleString)
        });
      }
      const kids = [];
      for (const child of el.children) kids.push(child);
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) kids.push(child); // composed walk, open roots
      }
      let idx = 0;
      for (const child of kids) {
        if (child.nodeType !== 1) continue;
        walk(child, path + '.' + idx);
        idx++;
      }
    }

    walk(root, '0');
    return { sig, count: sig.length, truncated };
  }

  window.UASnapDom = { serialize };
})();
