# UA Change Snapshot

A Chrome extension (Manifest V3) for capturing webpages and comparing changes.
Capture one visible screen, a chosen number of screen heights, or the full
page. Preview saved images, download PNGs, and compare screenshots and DOM
signatures before and after a deploy. No runtime dependencies or build step.

## Install (unpacked)

1. Open `chrome://extensions`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder (`ua-snapshot-diff`)

## Use

1. Open the extension on the webpage you want to capture and choose:
   - **One screen**: exactly the current viewport, without scrolling.
   - **More screens**: 1–20 screen heights, starting at your current position
     or the top. The screens are joined into one PNG and stop at the page bottom.
   - **Full page**: from the top to the bottom, within the image safety limits.
2. Optionally name the image, then click **Capture**. The button stays visible
   while the rest of the popup scrolls. Keep the website tab active until the
   capture finishes; progress and **Cancel** stay visible. Reopening the popup
   resumes the progress display. The original scroll position is restored.
3. Click **Preview** or **Download PNG** when the image is ready. **Library**
   opens all saved screenshots with search, fit-width and actual-size views.
4. **Alt+Shift+S** uses your last capture size and start position. The page
   context menu's **Capture full-page screenshot** always captures the full page.
5. To compare a deploy, expand **Compare changes**, choose a baseline, then
   **Capture & compare** using the same size and start position as the baseline.
6. Diff viewer (`pages/diff.html`):
   - **Side by side** (synced scroll) or **Overlay** with a B-opacity slider
   - **visual** boxes (cyan) — pixel-changed regions the DOM walk can't see (images, canvas, CSS effects)
   - **DOM** boxes (violet/red) — added / changed / removed elements; click the sidebar entry to flash the region
   - **Copy summary** — markdown diff report for the ticket
   - **Export overlay PNG** — B composited over A with change boxes drawn

## How it works

| Stage | Mechanism |
|---|---|
| screenshot | scroll-and-stitch: the page steps by viewport heights (fixed/sticky elements hidden after the first tile so they don't repeat at seams), each tile captured with `captureVisibleTab`, stitched on an `OffscreenCanvas` in the service worker |
| DOM snapshot | composed walk (open shadow roots included, 3000-element cap) emitting per-element signatures: stable path, tag, short selector, FNV-1a hashes of direct text and 8 layout-visible computed styles; the worker retains elements intersecting the captured range and converts rectangles to image coordinates |
| DOM diff | two-phase matching: same path + tag + style + #id → precise text/geometry changes; everything else matched by content key (tag + text hash + #id + occurrence) so sibling index shifts from inserts/removals don't misclassify — unmatched sides are true removals/additions |
| pixel diff | both PNGs downscaled to 256px-wide grayscale, block-diffed (16px blocks, threshold 12), touching blocks merged into one region box |
| storage | `chrome.storage.local` (`unlimitedStorage`): max 20 snapshots / 40 MB, oldest-first eviction, grouped by URL (origin + path + query; hash ignored for SPAs) |

## What makes it careful

- **Permission footprint**: `activeTab` + `scripting` — nothing runs on a page until you capture it; no host permissions.
- **Restore**: capture saves the original scroll position and existing fixed-element markers and classes, then removes its temporary styles and restores them on success, failure, or cancellation.
- **Bounded images**: 40-tile cap, 32,000-pixel image-height cap, 64-million-pixel area cap, 3000-element serializer cap, storage budget with eviction. A notice explains when an image was truncated.
- **Visible feedback**: repeated clicks are disabled during capture; errors explain recovery, and progress survives popup closure.
- **Pure core**: geometry, diffing, pixel comparison, and eviction live in `shared/diffcore.js` (dual-format module, no chrome/DOM) and are unit-tested in plain Node.

## Structure

```
manifest.json          MV3 manifest (activeTab + scripting + storage + unlimitedStorage)
background.js          service worker: capture pipeline, stitching, storage, messages
shared/diffcore.js     pure geometry / diff / pixel / storage logic (fully unit-tested)
shared/capturecore.js  capture modes, screen limits, scroll planning, image filenames
shared/runtime.js      background requests, page targeting, readable errors
shared/inject.js       content-bundle injection helper
content/domshot.js     composed-tree DOM serializer
content/capturectl.js  capture choreography: prepare / scroll steps / restore
popup/                 capture size, range, progress, preview, saved images, baseline management
pages/screenshot.html  screenshot library, image preview, PNG download
pages/diff.html        diff viewer (side-by-side / overlay, boxes, export, summary)
icons/                 generated by tools/gen-icons.js
```

## Verify

```
node test/run-tests.js                       # unit tests (geometry, diff, pixel, storage)
node test/capture-options-tests.js           # capture range and image limit regression tests
node test/background-tests.js                # capture quota, repeated calls, failures, restore
NODE_PATH=… node test/e2e.js                 # real-Chrome e2e (see header comment)
node tools/gen-icons.js                      # regenerate icons
NODE_PATH=… node tools/make-screenshot.js    # regenerate the store screenshot
```

The original `test/e2e.js` checks serializer/diff behavior and uses supplied
tiles for deterministic image comparisons. The workspace-level browser test
`node ../.devdeps/verify-screenshot-ux.cjs` additionally loads a disposable
extension copy in Playwright Chromium and uses real `captureVisibleTab` PNGs.
It checks exact heights and pixels for all modes, a partial last screen,
smooth-scroll restoration, cancellation, saved preferences, responsive popup
layout, preview controls, and an actual PNG download. The test copy receives
host access because an automated extension page cannot grant toolbar-triggered
`activeTab`; the shipped manifest retains its existing permissions.

Regression modes reproduce a successful worker response without the optional
capture metadata and narrow/short popup sizing (including zoom-sized viewports):

```powershell
node ../.devdeps/verify-screenshot-ux.cjs --legacy-response
node ../.devdeps/verify-screenshot-ux.cjs --layout-regression
node ../.devdeps/verify-native-popup.cjs
node ../.devdeps/verify-native-popup.cjs --scaled
```

Version 1.1.1 accepts older saved screenshots and capture responses without
turning a successful capture into a `truncated` property error. Its popup fits
the available viewport height and keeps scrolling inside the content area.

Version 1.1.2 fixes native toolbar popup startup. Chrome initially measures the
popup in a tiny viewport, so the root starts with explicit 384 × 600 CSS-pixel
dimensions, then fits the available viewport once Chrome has sized it. The
native-popup test calls `chrome.action.openPopup()` and checks the actual popup
target, including a real Capture click; it does not open the popup HTML as a tab.

## Notes & limits

- Lazy-loading and animated content can differ between tiles on very long pages (each tile gets a settle delay, but infinite scrollers are capped at 40 screens).
- Elements without an `#id` and without direct text (plain containers) are matched by occurrence order within their content key — a removal among several *identical* siblings can attribute the upshift as a geometry move (which is visually true anyway).
- The pixel diff runs on downscaled grayscale; sub-perceptual changes below the block threshold are ignored by design.
- Snapshots include rendered pixels and DOM signatures — nothing leaves your machine (`chrome.storage.local` only).
