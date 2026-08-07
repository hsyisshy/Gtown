// Minimal service worker — exists only to satisfy PWA installability
// checks. Deliberately no offline caching: the controller is useless
// without a live connection to AirConsole anyway, and stale cached JS
// would desync it from the screen.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* network passthrough */ });
