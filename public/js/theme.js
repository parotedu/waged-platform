// Shared Waged Theme & Icon Helper (Clean White-First UI)
(function () {
  try {
    document.documentElement.setAttribute('data-theme', 'light');
  } catch (e) {}
})();

function refreshIcons(root) {
  if (window.lucide && typeof window.lucide.createIcons === 'function') {
    window.lucide.createIcons(root ? { root } : undefined);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  refreshIcons();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
