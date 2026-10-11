// Toolbar popups initially have a tiny viewport while Chrome measures content.
// Keep the CSS pixel dimensions until that measurement has produced a usable
// viewport; percentage/vh root sizing during bootstrap collapses the popup.
function fit() {
  if (window.innerWidth < 200 || window.innerHeight < 180) return;
  const root = document.documentElement.style;
  root.setProperty('--popup-width', Math.min(384, window.innerWidth) + 'px');
  root.setProperty('--popup-height', Math.min(600, window.innerHeight) + 'px');
}
window.addEventListener('resize', fit);
fit();
