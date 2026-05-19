/**
 * PastillasPapa — Sistema de Alarmas
 * Usa la Notifications API del navegador + ServiceWorker para alarmas fiables
 */

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

// Registrar el Service Worker (necesario para notificaciones en iOS)
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

// Programar alarmas para el día de hoy
// Usa Service Worker si está disponible (iOS), fallback a setTimeout
export async function programarAlarmasHoy(tomas, medicamentos) {
  if (!tienePermiso()) return;

  const ahora = new Date();

  // Limpiar timers anteriores (fallback)
  if (window._alarmaTimers) {
    window._alarmaTimers.forEach(t => clearTimeout(t));
  }
  window._alarmaTimers = [];

  // Agrupar tomas por hora
  const grupos = {};
  for (const toma of tomas) {
    if (!toma.activa) continue;
    if (!grupos[toma.hora]) grupos[toma.hora] = [];
    const med = medicamentos.find(m => m.id === toma.medicamento_id);
    if (med) grupos[toma.hora].push(med);
  }

  // Obtener SW si está disponible
  let swReg = null;
  if ('serviceWorker' in navigator) {
    swReg = await navigator.serviceWorker.ready.catch(() => null);
  }

  for (const [hora, meds] of Object.entries(grupos)) {
    const [h, m] = hora.split(':').map(Number);
    const objetivo = new Date();
    objetivo.setHours(h, m, 0, 0);

    const diff = objetivo - ahora;
    if (diff <= 0) continue; // Ya pasó esta hora hoy

    const nombres = meds.map(med => med.nombre).join(', ');
    const cantidad = meds.length;
    const titulo = `💊 Hora de tomar tus pastillas`;
    const cuerpo = `${hora} — ${cantidad} pastilla${cantidad > 1 ? 's' : ''}: ${nombres}`;

    if (swReg && swReg.active) {
      // iOS / PWA: usar Service Worker (funciona en segundo plano)
      swReg.active.postMessage({
        type: 'PROGRAMAR_ALARMA',
        hora,
        titulo,
        cuerpo,
        delayMs: diff,
      });
    } else {
      // Fallback: setTimeout en el main thread (Mac/Chrome)
      const timer = setTimeout(() => {
        mostrarNotificacion(titulo, cuerpo, hora);
        let reintentos = 0;
        const intervalo = setInterval(() => {
          reintentos++;
          if (reintentos >= 3) { clearInterval(intervalo); return; }
          mostrarNotificacion(
            `🔔 Recordatorio — Pastillas de las ${hora}`,
            `¿Ya las has tomado? ${nombres}`,
            hora
          );
        }, 5 * 60 * 1000);
        window._alarmaTimers.push(intervalo);
      }, diff);
      window._alarmaTimers.push(timer);
    }
  }
}

export function mostrarNotificacion(titulo, cuerpo, hora) {
  if (!tienePermiso()) return;

  const n = new Notification(titulo, {
    body: cuerpo,
    icon: '/app/icons/icon-192.png',
    badge: '/app/icons/icon-72.png',
    tag: `pastillas-${hora}`,
    requireInteraction: true,
    vibrate: [200, 100, 200, 100, 200],
  });

  n.onclick = () => {
    window.focus();
    n.close();
  };
}

// Calcular próxima toma
export function proximaToma(tomas) {
  const ahora = new Date();
  const horaActual = ahora.getHours() * 60 + ahora.getMinutes();

  const horas = [...new Set(tomas.filter(t => t.activa).map(t => t.hora))].sort();

  for (const hora of horas) {
    const [h, m] = hora.split(':').map(Number);
    const minutos = h * 60 + m;
    if (minutos > horaActual) return hora;
  }

  return horas[0] || null; // Si ya pasaron todas, la primera de mañana
}

// Sonido de alarma (Web Audio API — sin archivos externos)
export function reproducirSonidoAlarma() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const notas = [523, 659, 784, 659, 784]; // Do Mi Sol Mi Sol

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
  } catch (e) {
    // Silencio si no hay soporte
  }
}
