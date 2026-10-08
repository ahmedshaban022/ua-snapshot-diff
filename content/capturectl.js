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

  UAS.prepare = function () {
    if (UAS.state) UAS.restore(); // defensive: never double-prepare
    const doc = document.documentElement;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    (document.head || doc).appendChild(style);

    let fixedCount = 0;
    const all = document.querySelectorAll('body *');
    for (let i = 0; i < all.length && fixedCount < 4000; i++) {
      const el = all[i];
      const cs = getComputedStyle(el);
      if (cs.position === 'fixed' || cs.position === 'sticky') {
        el.setAttribute('data-uasb-fixed', '1');
        fixedCount++;
      }
    }

    UAS.state = { scrollTop: window.scrollY, scrollLeft: window.scrollX, style };
    doc.classList.add('uasb-capture');
    const dom = window.UASnapDom ? window.UASnapDom.serialize(document.body) : { sig: [], count: 0, truncated: false };
    return {
      ok: true,
      scrollHeight: doc.scrollHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      fixed: fixedCount,
      dom
    };
  };

  UAS.step = function (y, hideFixed) {
    const doc = document.documentElement;
    doc.classList.toggle('uasb-hide-fixed', !!hideFixed);
    window.scrollTo(0, y);
    return new Promise((resolve) =>
      // two rAFs: one for the scroll, one for the paint
      requestAnimationFrame(() => requestAnimationFrame(() => resolve({ y: window.scrollY })))
    );
  };

  UAS.restore = function () {
    const s = UAS.state;
    if (!s) return { ok: true };
    document.documentElement.classList.remove('uasb-capture', 'uasb-hide-fixed');
    if (s.style && s.style.isConnected) s.style.remove();
    for (const el of document.querySelectorAll('[data-uasb-fixed]')) el.removeAttribute('data-uasb-fixed');
    window.scrollTo(s.scrollLeft, s.scrollTop);
    UAS.state = null;
    return { ok: true };
  };
})();
