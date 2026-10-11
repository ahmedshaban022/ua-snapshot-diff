// Capture controller (isolated world): prepares the page for a
// scroll-and-stitch capture (tags fixed/sticky elements, hides the
// scrollbar), answers scroll-step requests from the service worker, and
// restores everything exactly afterward. All state lives on the namespace
// so re-injection is safe.
'use strict';
(function () {
  const UAS = (window.UASnapCtl = window.UASnapCtl || {});
  const STYLE_ID = 'uasb-capture-style';

  const CSS = [
    // scrollbar space is captured by captureVisibleTab; hiding it keeps
    // tiles seamless
    'html.uasb-capture::-webkit-scrollbar { width: 0 !important; height: 0 !important; }',
    'html.uasb-capture { scrollbar-width: none !important; }',
    // fixed/sticky chrome belongs to the first tile only — hidden during
    // subsequent tiles so it doesn't repeat down the seam
    'html.uasb-hide-fixed [data-uasb-fixed] { visibility: hidden !important; }'
  ].join('\n');

  UAS.state = UAS.state || null;

  UAS.prepare = function (options) {
    if (UAS.state) UAS.restore(); // defensive: never double-prepare
    const o = options || { mode: 'full' };
    const doc = document.documentElement;
    const style = o.mode === 'viewport' ? null : document.createElement('style');
    if (style) {
      style.id = STYLE_ID;
      style.textContent = CSS;
      (document.head || doc).appendChild(style);
    }

    let fixedCount = 0;
    const fixed = [];
    const all = o.mode === 'viewport' ? [] : document.querySelectorAll('body *');
    for (let i = 0; i < all.length && fixedCount < 4000; i++) {
      const el = all[i];
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'sticky') {
        fixed.push([el, el.getAttribute('data-uasb-fixed')]);
        el.setAttribute('data-uasb-fixed', '1');
        fixedCount++;
      }
    }

    UAS.state = { scrollTop: window.scrollY, scrollLeft: window.scrollX, style, fixed,
      hadCapture: doc.classList.contains('uasb-capture'), hadHidden: doc.classList.contains('uasb-hide-fixed') };
    if (style) doc.classList.add('uasb-capture');
    if (o.mode !== 'viewport') {
      const y = o.mode === 'full' || o.start === 'top' ? 0 : UAS.state.scrollTop;
      window.scrollTo({ left: 0, top: y, behavior: 'instant' });
    }
    return new Promise((resolve) =>
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const dom = window.UASnapDom
            ? window.UASnapDom.serialize(document.body)
            : { sig: [], count: 0, truncated: false };
          resolve({
            ok: true,
            scrollHeight: doc.scrollHeight,
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            startY: window.scrollY,
            startX: window.scrollX,
            fixed: fixedCount,
            dom
          });
        })
      )
    );
  };

  UAS.step = function (y, hideFixed) {
    const doc = document.documentElement;
    doc.classList.toggle('uasb-hide-fixed', !!hideFixed);
    window.scrollTo({ left: 0, top: y, behavior: 'instant' });
    return new Promise((resolve) =>
      // two rAFs: one for the scroll, one for the paint
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ y: window.scrollY })))
    );
  };

  UAS.restore = function () {
    const s = UAS.state;
    if (!s) return { ok: true };
    document.documentElement.classList.toggle('uasb-capture', s.hadCapture);
    document.documentElement.classList.toggle('uasb-hide-fixed', s.hadHidden);
    if (s.style && s.style.isConnected) s.style.remove();
    for (const [el, previous] of s.fixed) {
      if (previous == null) el.removeAttribute('data-uasb-fixed');
      else el.setAttribute('data-uasb-fixed', previous);
    }
    window.scrollTo({ left: s.scrollLeft, top: s.scrollTop, behavior: 'instant' });
    UAS.state = null;
    return { ok: true };
  };
})();
