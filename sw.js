/**
 * PastillasPapa — Service Worker
 * Permite notificaciones push reales en iOS (Safari 16.4+)
 * y hace la app instalable como PWA offline
 */

const CACHE_NAME = 'pastillas-papa-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/app/styles.css',
  '/app/app.js',
  '/app/db.js',
  '/app/alarmas.js',
  '/app/utils.js',
  '/manifest.json',
  '/app/icons/icon-192.svg',
  '/app/icons/icon-512.svg',
];

// Instalación — cachear todos los assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

// Activación — limpiar caches viejas
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch — servir desde cache, fallback a red
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request))
  );
});

// Push notification — recibida desde servidor (para futuras integraciones)
self.addEventListener('push', event => {
  const data = event.data ? event.data.json() : {};
  const title = data.title || '💊 Hora de las pastillas';
  const options = {
    body: data.body || 'Es hora de tomar la medicación',
    icon: '/app/icons/icon-192.svg',
    badge: '/app/icons/icon-72.svg',
    tag: data.tag || 'pastillas',
    requireInteraction: true,
    data: data,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

// Alarmas programadas localmente via postMessage
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

      // Recordatorios cada 5 min × 3 veces
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
