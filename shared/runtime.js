// Chrome failures must reach the popup instead of becoming silent nulls.
export function errorMessage(error) {
  const message = String(error && (error.message || error.error) || error || 'The action failed.');
  const known = {
    'name-required': 'Enter a profile name first.',
    'not-a-page': 'Open a normal website or localhost first.',
    'snapshot-failed': 'Could not read this page storage.',
    'apply-failed': 'Could not apply storage to this page.',
    'not-found': 'The saved profile was not found. Reopen the popup.',
    'nothing-to-undo': 'There is no profile change to undo.',
    'not-loaded': 'The page script did not load. Reload the extension and reopen the popup.',
    'no-result': 'The page script returned no result. Reload the page and reopen the popup.'
  };
  if (known[message]) return known[message];
  if (/Receiving end does not exist|message port closed|Could not establish connection/i.test(message)) {
    return 'Reload this extension in chrome://extensions, then reopen its popup on the page.';
  }
  if (/Cannot access|Missing host permission|extensions gallery|not allowed|cannot be scripted/i.test(message)) {
    return message + ' Open a normal website and click the extension icon again. For local HTML, enable Allow access to file URLs in the extension Details.';
  }
  return message;
}

export function failure(error) {
  return { error: errorMessage(error) };
}

export async function request(type, extra) {
  try {
    const response = await chrome.runtime.sendMessage({ type, ...extra });
    return response || failure('No response from the extension. Reload it in chrome://extensions and reopen the popup.');
  } catch (error) {
    return failure(error);
  }
}

export async function pageTab(tabId) {
  const tab = tabId != null
    ? await chrome.tabs.get(tabId)
    : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!tab || tab.id == null) throw new Error('Open a page and click the extension icon again.');
  return tab;
}

export function requirePage(tab, allowFile = false) {
  const pattern = allowFile ? /^(https?|file):/i : /^https?:/i;
  if (!tab.url || !pattern.test(tab.url)) {
    throw new Error(allowFile
      ? 'Chrome blocks actions on this page. Open a website, localhost, or a local HTML file.'
      : 'Open a website or localhost first. Environment switching needs an http(s) URL.');
  }
}

export function showError(element, response, fallback) {
  if (response && !response.error) return false;
  element.textContent = response && response.error ? errorMessage(response) : fallback;
  return true;
}
