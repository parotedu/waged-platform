// Waged Minimal Service Worker (PWA Support + Instant Network Freshness)
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Pass through to network so real-time chat and scans stay fresh
});
