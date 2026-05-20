/**
 * PastillasPapa — Vercel Serverless Function
 * Web Push estándar con VAPID — sin Firebase, sin Apple Developer
 * Funciona en iOS 16.4+ con PWA instalada
 *
 * POST /api/push { action: 'subscribe', subscription }  → guarda suscripción
 * POST /api/push { action: 'test', subscription }       → manda push de prueba
 * GET  /api/push                                         → cron: manda push si toca ahora
 */

import webpush from 'web-push';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = 'mailto:jmpazblanes@gmail.com';

// Horarios del paciente (hora España)
const HORARIOS = {
  '07:00': { titulo: '💊 Tacrolimus + CellCept', cuerpo: 'En AYUNAS — esperar 1h antes de desayunar' },
  '08:00': { titulo: '💊 Pastillas del desayuno', cuerpo: 'Prednisona, Calcio, Magnesio, Amlodipino, Bisoprolol, Omeprazol, Linezolid' },
  '19:00': { titulo: '💊 Tacrolimus + CellCept', cuerpo: 'En AYUNAS — esperar 1h antes de cenar' },
  '21:00': { titulo: '💊 Pastillas de la cena', cuerpo: 'Calcio, Magnesio, Amlodipino, Bisoprolol, Omeprazol, Linezolid' },
};

function horaEspana() {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

// Suscripciones guardadas en env var como JSON array
// (para una sola familia es suficiente — no necesitamos DB)
function getSuscripciones() {
  try {
    return JSON.parse(process.env.PUSH_SUBSCRIPTIONS || '[]');
  } catch {
    return [];
  }
}

async function enviarPush(subscription, titulo, cuerpo) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  return webpush.sendNotification(
    subscription,
    JSON.stringify({ titulo, cuerpo }),
    { TTL: 3600 }
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  if (!VAPID_PUBLIC || !VAPID_PRIVATE) {
    return res.status(500).json({ error: 'VAPID keys no configuradas en Vercel' });
  }

  // GET — llamado por cron cada hora en punto
  if (req.method === 'GET') {
    const hora = horaEspana();
    const alarma = HORARIOS[hora];
    if (!alarma) {
      return res.status(200).json({ ok: true, msg: `Sin alarma a las ${hora}` });
    }

    const suscripciones = getSuscripciones();
    if (suscripciones.length === 0) {
      return res.status(200).json({ ok: true, msg: 'Sin suscripciones registradas' });
    }

    const results = await Promise.allSettled(
      suscripciones.map(sub => enviarPush(sub, alarma.titulo, alarma.cuerpo))
    );

    const enviados = results.filter(r => r.status === 'fulfilled').length;
    return res.status(200).json({ ok: true, hora, enviados, total: suscripciones.length });
  }

  // POST
  if (req.method === 'POST') {
    const { action, subscription } = req.body || {};

    // Guardar suscripción (la app la manda al suscribirse)
    if (action === 'subscribe') {
      if (!subscription) return res.status(400).json({ error: 'Suscripción requerida' });
      // Devolvemos la suscripción para que el usuario la añada a PUSH_SUBSCRIPTIONS en Vercel
      // (solución simple para familia pequeña)
      console.log('Nueva suscripción:', JSON.stringify(subscription));
      return res.status(200).json({ ok: true, subscription });
    }

    // Push de prueba
    if (action === 'test') {
      if (!subscription) return res.status(400).json({ error: 'Suscripción requerida' });
      try {
        await enviarPush(
          subscription,
          '💊 ¡Las alarmas funcionan!',
          'Esta notificación llegó aunque la app estuviera cerrada ✅'
        );
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
