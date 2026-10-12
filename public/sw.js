// Service worker: instalable (PWA) y recibe Web Push para mostrar la llamada con la app cerrada.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch {}
  // Con callId es una llamada (insistente); sin él es un aviso de agente (normal, no pisa la llamada).
  const call = d.callId != null;
  e.waitUntil(self.registration.showNotification(d.title || 'Jarvis', {
    body: d.body || 'Toca para contestar',
    tag: call ? 'jarvis-call' : `agente-${Date.now()}`, renotify: call, requireInteraction: call,
    vibrate: call ? [300, 150, 300, 150, 300] : [200], icon: 'icon.svg', badge: 'icon.svg',
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((cs) => (cs[0] ? cs[0].focus() : self.clients.openWindow('/assistant.html'))));
});
