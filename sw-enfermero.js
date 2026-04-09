// Service Worker para notificaciones push — RE IPS Enfermeros
const CACHE_NAME = 're-ips-sw-v1';

self.addEventListener('install', function(event) {
  self.skipWaiting();
});

self.addEventListener('activate', function(event) {
  event.waitUntil(clients.claim());
});

// Recibir notificación push
self.addEventListener('push', function(event) {
  let data = { title: 'Reina Elizabeth IPS', body: 'Nueva solicitud de servicio', icon: '/enfermeria/icon-192.png' };
  try {
    if (event.data) {
      data = Object.assign(data, event.data.json());
    }
  } catch(e) {}

  const options = {
    body: data.body,
    icon: data.icon || '/enfermeria/icon-192.png',
    badge: '/enfermeria/icon-72.png',
    vibrate: [200, 100, 200, 100, 200],
    requireInteraction: true,
    data: data.url ? { url: data.url } : {},
    actions: [
      { action: 'ver', title: '👀 Ver solicitud' },
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
    : 'https://rl-rikardolondono.github.io/enfermeria/app-enfermero.html';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (let i = 0; i < clientList.length; i++) {
        const client = clientList[i];
        if (client.url.includes('app-enfermero') && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) {
        return clients.openWindow(url);
      }
    })
  );
});
