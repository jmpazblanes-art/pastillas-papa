/**
 * PastillasPapa — Sistema de Alarmas
 * Web Push estándar con VAPID — funciona en iOS 16.4+ con PWA instalada
 * Sin Firebase, sin Apple Developer, gratis
 */

// Clave pública VAPID (la privada solo está en el servidor)
const VAPID_PUBLIC_KEY = 'BCNgbW2waCXEtCaJfSohMJ07anmJpVnXnwfwtU8uqU6kU0LNQ_Lz4o0nsSSxhcTjqJviPkW9uynNVZ5bjv7_-8M';
const PUSH_CLIENT_VERSION = '2026-05-20-2';

export async function pedirPermisoNotificaciones() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  const result = await Notification.requestPermission();
  return result === 'granted';
}

export function tienePermiso() {
  return 'Notification' in window && Notification.permission === 'granted';
}

// Registrar el Service Worker
export async function registrarServiceWorker() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    return reg;
  } catch (e) {
    console.warn('SW no registrado:', e);
    return null;
  }
}

// Suscribir al push del servidor via Web Push estándar
export async function suscribirWebPush() {
  if (!tienePermiso()) return null;
  if (!('PushManager' in window)) {
    console.warn('PushManager no disponible en este navegador');
    return null;
  }

  try {
    const swReg = await navigator.serviceWorker.ready;
    const suscripcionExistente = await swReg.pushManager.getSubscription();
    if (suscripcionExistente) {
      const versionRegistrada = localStorage.getItem('push_client_version');
      if (versionRegistrada !== PUSH_CLIENT_VERSION) {
        await suscripcionExistente.unsubscribe().catch(() => {});
        localStorage.removeItem('push_subscription');
      } else {
        localStorage.setItem('push_subscription', JSON.stringify(suscripcionExistente));
        // Siempre re-registrar en Firestore por si se perdió
        const res = await fetch('/api/push', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'subscribe', subscription: suscripcionExistente }),
        });
        if (!res.ok) throw new Error(`Servidor push respondió ${res.status}`);
        localStorage.setItem('push_client_version', PUSH_CLIENT_VERSION);
        return suscripcionExistente;
      }
    }

    // Crear nueva suscripción
    const suscripcion = await swReg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });

    localStorage.setItem('push_subscription', JSON.stringify(suscripcion));

    // Registrar en el servidor (para que Vercel pueda mandarle push)
    const res = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'subscribe', subscription: suscripcion }),
    });
    if (!res.ok) throw new Error(`Servidor push respondió ${res.status}`);

    localStorage.setItem('push_client_version', PUSH_CLIENT_VERSION);
    console.log('Web Push suscrito ✅');
    return suscripcion;

  } catch (e) {
    console.warn('Error al suscribir Web Push:', e);
    return null;
  }
}

export async function resetearWebPush() {
  if (!tienePermiso()) return null;
  if (!('PushManager' in window)) return null;

  try {
    const swReg = await navigator.serviceWorker.ready;
    const suscripcionExistente = await swReg.pushManager.getSubscription();
    if (suscripcionExistente) {
      await suscripcionExistente.unsubscribe().catch(() => {});
    }
    localStorage.removeItem('push_subscription');
    return await suscribirWebPush();
  } catch (e) {
    console.warn('Error al reparar Web Push:', e);
    return null;
  }
}

export async function diagnosticoWebPush() {
  const estado = {
    permiso: 'Notification' in window ? Notification.permission : 'no disponible',
    pwa: window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches,
    serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window,
    suscripcion: false,
    endpoint: '',
  };

  if (!estado.serviceWorker || !estado.pushManager) return estado;

  try {
    const swReg = await navigator.serviceWorker.ready;
    const sub = await swReg.pushManager.getSubscription();
    estado.suscripcion = Boolean(sub);
    estado.endpoint = sub?.endpoint ? new URL(sub.endpoint).host : '';
  } catch (e) {
    estado.error = e.message || String(e);
  }

  return estado;
}

// Mandar push de prueba desde el servidor
export async function probarPushFCM() {
  const subStr = localStorage.getItem('push_subscription');
  if (!subStr) return false;
  try {
    const subscription = JSON.parse(subStr);
    const res = await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'test', subscription }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Programar alarmas locales (fallback para cuando la app está abierta)
export async function programarAlarmasHoy(tomas, medicamentos) {
  if (!tienePermiso()) return;

  const ahora = new Date();

  if (window._alarmaTimers) {
    window._alarmaTimers.forEach(t => clearTimeout(t));
  }
  window._alarmaTimers = [];

  const grupos = {};
  for (const toma of tomas) {
    if (!toma.activa) continue;
    if (!grupos[toma.hora]) grupos[toma.hora] = [];
    const med = medicamentos.find(m => m.id === toma.medicamento_id);
    if (med) grupos[toma.hora].push(med);
  }

  let swReg = null;
  if ('serviceWorker' in navigator) {
    swReg = await navigator.serviceWorker.ready.catch(() => null);
  }

  for (const [hora, meds] of Object.entries(grupos)) {
    const [h, m] = hora.split(':').map(Number);
    const objetivo = new Date();
    objetivo.setHours(h, m, 0, 0);
    const diff = objetivo - ahora;
    if (diff <= 0) continue;

    const nombres = meds.map(med => med.nombre).join(', ');
    const cantidad = meds.length;
    const titulo = `💊 Hora de tomar tus pastillas`;
    const cuerpo = `${hora} — ${cantidad} pastilla${cantidad > 1 ? 's' : ''}: ${nombres}`;

    if (swReg && swReg.active) {
      swReg.active.postMessage({ type: 'PROGRAMAR_ALARMA', hora, titulo, cuerpo, delayMs: diff });
    } else {
      const timer = setTimeout(() => mostrarNotificacion(titulo, cuerpo, hora), diff);
      window._alarmaTimers.push(timer);
    }
  }
}

export function mostrarNotificacion(titulo, cuerpo, hora) {
  if (!tienePermiso()) return;
  const n = new Notification(titulo, {
    body: cuerpo,
    icon: '/app/icons/icon-192.svg',
    tag: `pastillas-${hora}`,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
  });
  n.onclick = () => { window.focus(); n.close(); };
}

export function proximaToma(tomas) {
  const ahora = new Date();
  const horaActual = ahora.getHours() * 60 + ahora.getMinutes();
  const horas = [...new Set(tomas.filter(t => t.activa).map(t => t.hora))].sort();
  for (const hora of horas) {
    const [h, m] = hora.split(':').map(Number);
    if (h * 60 + m > horaActual) return hora;
  }
  return horas[0] || null;
}

export function reproducirSonidoAlarma() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notas = [523, 659, 784, 659, 784];
    notas.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = freq;
      osc.type = 'sine';
      gain.gain.setValueAtTime(0.3, ctx.currentTime + i * 0.25);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + i * 0.25 + 0.2);
      osc.start(ctx.currentTime + i * 0.25);
      osc.stop(ctx.currentTime + i * 0.25 + 0.25);
    });
  } catch (e) {}
}

// Utilidad para convertir VAPID key
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  return Uint8Array.from([...rawData].map(char => char.charCodeAt(0)));
}

/**
 * Sincronizar los horarios reales del usuario al servidor (Firestore)
 * para que el cron sepa a qué horas mandar push aunque cambie los horarios.
 * tomas: array de { hora, activa }
 * medicamentos: array de { id, nombre }
 */
export async function sincronizarHorariosServidor(tomas, medicamentos) {
  if (!tienePermiso()) return;
  try {
    // Agrupar tomas activas por hora
    const grupos = {};
    for (const toma of tomas) {
      if (!toma.activa) continue;
      if (!grupos[toma.hora]) grupos[toma.hora] = [];
      const med = medicamentos.find(m => m.id === toma.medicamento_id);
      if (med) grupos[toma.hora].push(med.nombre);
    }

    // Construir objeto horarios para el servidor
    const horarios = {};
    for (const [hora, nombres] of Object.entries(grupos)) {
      horarios[hora] = {
        titulo: '💊 Hora de las pastillas',
        cuerpo: nombres.join(', '),
      };
    }

    await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'sync-horarios', horarios }),
    }).catch(() => {});

    console.log('Horarios sincronizados con el servidor:', Object.keys(horarios));
  } catch (e) {
    console.warn('Error al sincronizar horarios:', e);
  }
}

// Alias para compatibilidad
export const iniciarFCM = suscribirWebPush;
