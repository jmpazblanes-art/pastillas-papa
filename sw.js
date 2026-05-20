/**
 * PastillasPapa — Service Worker v5
 * Web Push estándar con VAPID — iOS 16.4+ con PWA instalada
 * Sin Firebase, sin Apple Developer, gratis
 */

const CACHE_NAME = 'pastillas-papa-v5';

const STATIC_ASSETS = [
  '/app/styles.css',
  '/manifest.json',
  '/app/icons/icon-192.svg',
  '/app/icons/icon-512.svg',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const url = event.request.url;
  const isJS = url.includes('/app/') && url.endsWith('.js');
  const isHTML = url.endsWith('/') || url.endsWith('.html');

  if (isJS || isHTML) {
    event.respondWith(fetch(event.request));
  } else {
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  }
});

// Push recibido desde el servidor (Web Push estándar)
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data ? JSON.parse(event.data.text()) : {};
  } catch {
    data = { titulo: event.data?.text() || '💊 Hora de las pastillas' };
  }

  const titulo = data.titulo || '💊 Hora de las pastillas';
  const cuerpo = data.cuerpo || 'Es hora de tomar la medicación';
  const tag = data.tag || `pastillas-push-${Date.now()}`;
  const deliveryId = data.deliveryId || '';

  event.waitUntil(
    Promise.allSettled([
      self.registration.showNotification(titulo, {
        body: cuerpo,
        icon: '/app/icons/icon-192.svg',
        badge: '/app/icons/icon-72.svg',
        tag,
        requireInteraction: true,
        renotify: true,
        silent: false,
        timestamp: data.timestamp || Date.now(),
        vibrate: [200, 100, 200, 100, 200],
      }),
      deliveryId ? fetch('/api/push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'delivery-log',
          deliveryId,
          tag,
          timestamp: Date.now(),
        }),
      }).catch(() => {}) : Promise.resolve(),
    ])
  );
});

// Alarmas locales via postMessage (fallback cuando app está abierta)
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'PROGRAMAR_ALARMA') {
    const { hora, titulo, cuerpo, delayMs } = event.data;

    setTimeout(() => {
      self.registration.showNotification(titulo, {
        body: cuerpo,
        icon: '/app/icons/icon-192.svg',
        badge: '/app/icons/icon-72.svg',
        tag: `pastillas-${hora}`,
        requireInteraction: true,
        vibrate: [200, 100, 200, 100, 200],
      });

      let reintentos = 0;
      const intervalo = setInterval(() => {
        reintentos++;
        if (reintentos >= 3) { clearInterval(intervalo); return; }
        self.registration.showNotification(`🔔 Recordatorio — ${hora}`, {
          body: `¿Ya has tomado las pastillas? ${cuerpo}`,
          icon: '/app/icons/icon-192.svg',
          tag: `pastillas-recordatorio-${hora}`,
          requireInteraction: true,
        });
      }, 5 * 60 * 1000);
    }, delayMs);
  }
});

// Click en notificación — abrir la app
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow('/');
    })
  );
});
