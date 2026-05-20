/**
 * PastillasPapa — Service Worker
 * Permite notificaciones push reales en iOS (Safari 16.4+)
 * y hace la app instalable como PWA offline
 *
 * v4: Firebase Cloud Messaging para push aunque la app esté cerrada
 */

// Importar Firebase Messaging SW (necesario para FCM en background)
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAmz2TWKM3nBkADiqLDpvCazL1KfOm8AAU",
  authDomain: "pastillas-papa.firebaseapp.com",
  projectId: "pastillas-papa",
  storageBucket: "pastillas-papa.firebasestorage.app",
  messagingSenderId: "507224087875",
  appId: "1:507224087875:web:40d810b8ce8b2a5caae3f6",
});

const messaging = firebase.messaging();

// Manejar mensajes FCM en background (app cerrada o en segundo plano)
messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  return self.registration.showNotification(title || '💊 Hora de las pastillas', {
    body: body || 'Es hora de tomar la medicación',
    icon: '/app/icons/icon-192.svg',
    badge: '/app/icons/icon-72.svg',
    tag: 'pastillas-fcm',
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
  });
});

const CACHE_NAME = 'pastillas-papa-v4';

// Solo cacheamos recursos estáticos que NO cambian con el código
const STATIC_ASSETS = [
  '/app/styles.css',
  '/manifest.json',
  '/app/icons/icon-192.svg',
  '/app/icons/icon-512.svg',
];

// Instalación — solo cachear CSS e iconos
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activación — limpiar caches viejas y tomar control inmediato
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — JS y HTML siempre desde red; CSS/iconos desde cache
self.addEventListener('fetch', event => {
  const url = event.request.url;
  const isJS = url.includes('/app/') && url.endsWith('.js');
  const isHTML = url.endsWith('/') || url.endsWith('.html');

  if (isJS || isHTML) {
    // Código: siempre desde red (nunca desde cache)
    event.respondWith(fetch(event.request));
  } else {
    // Recursos estáticos: cache primero, fallback red
    event.respondWith(
      caches.match(event.request).then(cached => cached || fetch(event.request))
    );
  }
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
