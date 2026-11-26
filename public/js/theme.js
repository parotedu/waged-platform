// Shared Parot/Waged Theme Engine (Dark default with Light override)
(function () {
  try {
    const saved = localStorage.getItem('waged-theme');
    const theme = (saved === 'light' || saved === 'dark') ? saved : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {}
})();

function toggleWagedTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  try {
    localStorage.setItem('waged-theme', next);
  } catch (e) {}
  updateThemeIcons();
}

function updateThemeIcons() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
    btn.textContent = current === 'dark' ? '☀️' : '🌙';
    btn.title = current === 'dark' ? 'تفعيل الوضع الفاتح' : 'تفعيل الوضع الداكن';
  });
}

document.addEventListener('DOMContentLoaded', () => {
  updateThemeIcons();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
