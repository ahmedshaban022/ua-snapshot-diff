// Shared injection helper used by the service worker: injects the capture
// bundle into the tab's top frame and invokes a controller action in the
// same isolated world. All files are idempotent.

export const CONTENT_FILES = ['shared/diffcore.js', 'content/domshot.js', 'content/capturectl.js'];

export async function ctl(tabId, action, arg) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_FILES
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (action, arg) => {
      const c = window.UASnapCtl;
      if (!c || !c[action]) return { error: 'not-loaded' };
      return Promise.resolve(c[action](arg)).catch(() => ({ error: 'action failed' }));
    },
    // undefined is not structured-cloneable — null is the neutral arg
    args: [action, arg === undefined ? null : arg]
  });
  const r = results && results[0];
  return r && typeof r.result === 'object' && r.result !== null ? r.result : { error: 'no-result' };
}
