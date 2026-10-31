// Service Worker para notificaciones push — Salud en Casa · Pacientes
const CACHE_NAME = 'salud-paciente-sw-v1';

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

// Recibir notificación push
self.addEventListener('push', function(event) {
  let data = { title: 'Salud en Casa', body: 'Novedad en su servicio', icon: 'icon-192.png' };
  try {
    if (event.data) {
      data = Object.assign(data, event.data.json());
    }
  } catch(e) {}

  const options = {
    body: data.body,
    icon: data.icon || 'icon-192.png',
    badge: 'icon-72.png',
    vibrate: [200, 100, 200, 100, 200],
    requireInteraction: false,
    data: data.url ? { url: data.url } : {},
    actions: [
      { action: 'ver', title: '👀 Ver' },
      { action: 'cerrar', title: 'Cerrar' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Click en la notificación
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  if (event.action === 'cerrar') return;

  const url = (event.notification.data && event.notification.data.url)
    ? event.notification.data.url
    : 'https://saludencasa.skynetgenesis.com/app-paciente.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url.includes('app-paciente') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
