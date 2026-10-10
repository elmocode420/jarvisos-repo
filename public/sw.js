// Service worker: instalable (PWA) y recibe Web Push para mostrar la llamada con la app cerrada.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title || 'Jarvis', {
    body: d.body || 'Toca para contestar',
    tag: 'jarvis-call', renotify: true, requireInteraction: true,
    vibrate: [300, 150, 300, 150, 300], icon: 'icon.svg', badge: 'icon.svg',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('/assistant.html'))));
});
