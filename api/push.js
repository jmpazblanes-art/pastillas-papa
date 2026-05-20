/**
 * PastillasPapa — Vercel Serverless Function
 * Endpoint que la app llama para registrar el token FCM y los horarios.
 * Un cron job de Vercel llama a este endpoint cada hora para mandar
 * las notificaciones push a la hora exacta.
 *
 * POST /api/push  { action: 'register', token, tomas: [{hora, nombres, cantidad}] }
 * POST /api/push  { action: 'send_test', token }
 * GET  /api/push  (llamado por cron — manda pushes de las tomas de ahora)
 */

import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';

// Inicializar Firebase Admin (solo una vez)
function getAdmin() {
  if (getApps().length > 0) return getApps()[0];

  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  return initializeApp({
    credential: cert(serviceAccount),
  });
}

// Almacenamiento simple en memoria para tokens y tomas
// En producción esto iría en Firestore, pero para una sola familia va bien
// Los tokens se guardan en la variable de entorno REGISTERED_TOKENS (JSON)
function getTokens() {
  try {
    return JSON.parse(process.env.REGISTERED_TOKENS || '[]');
  } catch {
    return [];
  }
}

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', 'https://pastillas-papa.vercel.app');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    getAdmin();
    const messaging = getMessaging();

    // GET — llamado por cron cada minuto (o cada hora)
    // Manda push a todos los tokens registrados si toca una alarma ahora
    if (req.method === 'GET') {
      const ahora = new Date();
      // Hora en España (Europe/Madrid)
      const horaEspana = new Intl.DateTimeFormat('es-ES', {
        timeZone: 'Europe/Madrid',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      }).format(ahora);

      // Horarios fijos del paciente
      const HORARIOS = {
        '07:00': { titulo: '💊 Tacrolimus + CellCept', cuerpo: 'En AYUNAS — esperar 1h antes de desayunar' },
        '08:00': { titulo: '💊 Pastillas del desayuno', cuerpo: 'Prednisona, Calcio, Magnesio, Amlodipino, Bisoprolol, Omeprazol, Linezolid' },
        '19:00': { titulo: '💊 Tacrolimus + CellCept', cuerpo: 'En AYUNAS — esperar 1h antes de cenar' },
        '21:00': { titulo: '💊 Pastillas de la cena', cuerpo: 'Calcio, Magnesio, Amlodipino, Bisoprolol, Omeprazol, Linezolid' },
      };

      const alarma = HORARIOS[horaEspana];
      if (!alarma) {
        return res.status(200).json({ ok: true, msg: `No hay alarma a las ${horaEspana}` });
      }

      const tokens = getTokens();
      if (tokens.length === 0) {
        return res.status(200).json({ ok: true, msg: 'Sin tokens registrados' });
      }

      // Mandar push a todos los dispositivos registrados
      const results = await Promise.allSettled(
        tokens.map(token =>
          messaging.send({
            token,
            notification: {
              title: alarma.titulo,
              body: alarma.cuerpo,
            },
            apns: {
              payload: {
                aps: {
                  sound: 'default',
                  badge: 1,
                  'content-available': 1,
                },
              },
            },
            android: {
              notification: {
                sound: 'default',
                priority: 'high',
              },
            },
          })
        )
      );

      const enviados = results.filter(r => r.status === 'fulfilled').length;
      return res.status(200).json({ ok: true, hora: horaEspana, enviados, total: tokens.length });
    }

    // POST — registrar token o mandar prueba
    if (req.method === 'POST') {
      const { action, token } = req.body;

      if (action === 'send_test') {
        if (!token) return res.status(400).json({ error: 'Token requerido' });
        await messaging.send({
          token,
          notification: {
            title: '💊 ¡Las alarmas funcionan!',
            body: 'Esta notificación llegó aunque la app estuviera cerrada ✅',
          },
          apns: {
            payload: { aps: { sound: 'default', badge: 1 } },
          },
        });
        return res.status(200).json({ ok: true });
      }

      return res.status(400).json({ error: 'Acción no reconocida' });
    }

    return res.status(405).json({ error: 'Método no permitido' });

  } catch (e) {
    console.error('Error en /api/push:', e);
    return res.status(500).json({ error: e.message });
  }
}
