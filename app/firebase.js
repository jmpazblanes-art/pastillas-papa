/**
 * PastillasPapa — Firebase config
 * FCM para notificaciones push reales en iOS aunque la app esté cerrada
 */

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getMessaging, getToken, onMessage } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js';

const firebaseConfig = {
  apiKey: "AIzaSyAmz2TWKM3nBkADiqLDpvCazL1KfOm8AAU",
  authDomain: "pastillas-papa.firebaseapp.com",
  projectId: "pastillas-papa",
  storageBucket: "pastillas-papa.firebasestorage.app",
  messagingSenderId: "507224087875",
  appId: "1:507224087875:web:40d810b8ce8b2a5caae3f6",
  measurementId: "G-J9TEEEHR0T"
};

const VAPID_KEY = 'BBU0iTn9SHi3E_SewmuET_RI8wXwh7LacGwW0BgP637SbQYeKmt-TfDhuoH9NaZ09_UXnmSd-IhHtHOaLOFTUN0';

let app = null;
let messaging = null;

export function initFirebase() {
  if (app) return { app, messaging };
  app = initializeApp(firebaseConfig);
  try {
    messaging = getMessaging(app);
  } catch (e) {
    // getMessaging puede fallar en algunos contextos — no es crítico
    console.warn('FCM no disponible:', e.message);
  }
  return { app, messaging };
}

/**
 * Obtener o crear el token FCM del dispositivo.
 * Este token identifica este iPhone/navegador para mandarle pushes.
 * Se guarda en localStorage para no pedirlo cada vez.
 */
export async function obtenerTokenFCM() {
  if (!messaging) return null;
  try {
    const token = await getToken(messaging, { vapidKey: VAPID_KEY });
    if (token) {
      localStorage.setItem('fcm_token', token);
      return token;
    }
  } catch (e) {
    console.warn('No se pudo obtener token FCM:', e.message);
  }
  return null;
}

/**
 * Escuchar mensajes FCM cuando la app está en primer plano
 * (cuando está en segundo plano/cerrada, lo maneja el SW)
 */
export function escucharMensajesFCM(callback) {
  if (!messaging) return;
  onMessage(messaging, (payload) => {
    callback(payload);
  });
}

export { VAPID_KEY };
