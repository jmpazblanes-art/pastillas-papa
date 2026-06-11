/**
 * PastillasPapa — Vercel Serverless Function
 * Web Push con VAPID + Firebase Firestore para guardar suscripciones y horarios
 *
 * POST /api/push { action: 'subscribe', subscription }          → guarda suscripción en Firestore
 * POST /api/push { action: 'sync-horarios', horarios: [...] }   → guarda horarios reales del usuario
 * POST /api/push { action: 'test', subscription }               → push de prueba inmediato
 * GET  /api/push                                                 → cron: manda push si toca ahora
 */

import webpush from 'web-push';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = 'mailto:jmpazblanes@gmail.com';

// Horarios por defecto (se usan si el usuario no ha sincronizado los suyos)
const HORARIOS_DEFAULT = {
  '07:00': { titulo: '💊 Tacrolimus + CellCept', cuerpo: 'En AYUNAS — esperar 1h antes de desayunar' },
  '08:00': { titulo: '💊 Pastillas del desayuno', cuerpo: 'Prednisona, Calcio, Magnesio, Amlodipino, Bisoprolol, Omeprazol, Linezolid' },
  '19:00': { titulo: '💊 Tacrolimus + CellCept', cuerpo: 'En AYUNAS — esperar 1h antes de cenar' },
  '21:00': { titulo: '💊 Pastillas de la cena', cuerpo: 'Calcio, Magnesio, Amlodipino, Bisoprolol, Omeprazol, Linezolid' },
};

function getDB() {
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

function horaEspana() {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date());
}

// Devuelve todas las horas HH:MM de los últimos `ventanaMinutos` minutos en hora española
// Para que si el cron dispara a las 08:03 y la alarma es 08:00, se mande igual
function horasEnVentana(ventanaMinutos = 5) {
  const ahora = new Date();
  const horas = [];
  for (let i = 0; i < ventanaMinutos; i++) {
    const t = new Date(ahora.getTime() - i * 60000);
    const h = new Intl.DateTimeFormat('es-ES', {
      timeZone: 'Europe/Madrid',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).format(t);
    horas.push(h);
  }
  return [...new Set(horas)]; // sin duplicados
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

  // Bypass de protección Vercel para llamadas del cron externo
  const cronSecret = process.env.CRON_SECRET;
  if (req.method === 'GET' && cronSecret && req.query?.secret !== cronSecret) {
    // Solo bloquear si viene sin secret Y no es una petición del browser (tiene Accept: text/html)
    const accept = req.headers['accept'] || '';
    if (!accept.includes('text/html')) {
      return res.status(401).json({ error: 'No autorizado' });
    }
  }

  // GET — cron cada minuto (o ?force=1 para probar)
  if (req.method === 'GET') {
    const hora = horaEspana();
    const forzar = req.query?.force === '1';

    const db = getDB();

    // Leer horarios del usuario desde Firestore (si los ha sincronizado)
    // Busca en ventana de 5 min para tolerar retraso del cron externo
    let alarmasAEnviar = [];
    if (forzar) {
      alarmasAEnviar = [{ titulo: '💊 Prueba con app cerrada', cuerpo: '¡Funciona! Las alarmas llegarán aunque cierres la app ✅' }];
    } else {
      const ventana = horasEnVentana(5);
      const horariosDoc = await db.collection('config').doc('horarios').get();
      const horariosUsuario = horariosDoc.exists ? (horariosDoc.data()?.horarios || {}) : {};
      const disparadas = horariosDoc.exists ? (horariosDoc.data()?.disparadas || {}) : {};

      // Si el usuario ha sincronizado sus horarios, usar SOLO los suyos (sin fallback a defaults)
      // Si nunca ha sincronizado, usar los defaults
      const horariosFinal = horariosDoc.exists ? horariosUsuario : HORARIOS_DEFAULT;

      for (const h of ventana) {
        const alarma = horariosFinal[h] || null;
        if (!alarma) continue;
        // Evitar mandar la misma alarma dos veces en la misma ventana
        const hoy = new Date().toISOString().slice(0, 10);
        const claveDisparo = `${hoy}_${h}`;
        if (disparadas[claveDisparo]) continue;
        alarmasAEnviar.push({ ...alarma, claveDisparo });
      }
    }

    if (alarmasAEnviar.length === 0) {
      return res.status(200).json({ ok: true, msg: `Sin alarma en esta ventana (hora España: ${hora})` });
    }

    const snap = await db.collection('suscripciones').get();
    if (snap.empty) {
      return res.status(200).json({ ok: true, msg: 'Sin suscripciones' });
    }

    let totalEnviados = 0;
    const disparadasUpdate = {};

    for (const alarma of alarmasAEnviar) {
      const results = await Promise.allSettled(
        snap.docs.map(doc => enviarPush(doc.data().subscription, alarma.titulo, alarma.cuerpo))
      );

      // Limpiar suscripciones caducadas
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          await snap.docs[i].ref.delete();
        }
      }

      totalEnviados += results.filter(r => r.status === 'fulfilled').length;

      // Marcar como disparada para no repetir
      if (alarma.claveDisparo) {
        disparadasUpdate[`disparadas.${alarma.claveDisparo}`] = true;
      }
    }

    // Guardar claves disparadas en Firestore
    if (Object.keys(disparadasUpdate).length > 0) {
      await db.collection('config').doc('horarios').set(disparadasUpdate, { merge: true });
    }

    return res.status(200).json({ ok: true, hora, enviados: totalEnviados, alarmas: alarmasAEnviar.length });
  }

  // POST
  if (req.method === 'POST') {
    const { action, subscription } = req.body || {};

    // Guardar suscripción en Firestore
    if (action === 'subscribe') {
      if (!subscription) return res.status(400).json({ error: 'Suscripción requerida' });
      const db = getDB();
      // Usar endpoint como ID para evitar duplicados del mismo dispositivo
      const id = Buffer.from(subscription.endpoint).toString('base64').slice(-20);
      await db.collection('suscripciones').doc(id).set({ subscription, updatedAt: Date.now() });
      return res.status(200).json({ ok: true });
    }

    // Cron externo via POST (para evitar WAF de Vercel en GET)
    if (action === 'cron') {
      const db = getDB();
      const hora = horaEspana();
      const ventana = horasEnVentana(5);
      const horariosDoc = await db.collection('config').doc('horarios').get();
      const horariosUsuario = horariosDoc.exists ? (horariosDoc.data()?.horarios || {}) : {};
      const disparadas = horariosDoc.exists ? (horariosDoc.data()?.disparadas || {}) : {};

      const horariosFinal = horariosDoc.exists ? horariosUsuario : HORARIOS_DEFAULT;

      const alarmasAEnviar = [];
      for (const h of ventana) {
        const alarma = horariosFinal[h] || null;
        if (!alarma) continue;
        const hoy = new Date().toISOString().slice(0, 10);
        const claveDisparo = `${hoy}_${h}`;
        if (disparadas[claveDisparo]) continue;
        alarmasAEnviar.push({ ...alarma, claveDisparo });
      }

      if (alarmasAEnviar.length === 0) {
        return res.status(200).json({ ok: true, msg: `Sin alarma (hora España: ${hora})` });
      }

      const snap = await db.collection('suscripciones').get();
      if (snap.empty) return res.status(200).json({ ok: true, msg: 'Sin suscripciones' });

      let totalEnviados = 0;
      const disparadasUpdate = {};
      for (const alarma of alarmasAEnviar) {
        const results = await Promise.allSettled(
          snap.docs.map(doc => enviarPush(doc.data().subscription, alarma.titulo, alarma.cuerpo))
        );
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === 'rejected') await snap.docs[i].ref.delete();
        }
        totalEnviados += results.filter(r => r.status === 'fulfilled').length;
        if (alarma.claveDisparo) disparadasUpdate[`disparadas.${alarma.claveDisparo}`] = true;
      }

      if (Object.keys(disparadasUpdate).length > 0) {
        await db.collection('config').doc('horarios').set(disparadasUpdate, { merge: true });
      }

      return res.status(200).json({ ok: true, hora, enviados: totalEnviados });
    }

    // Sincronizar horarios reales del usuario
    if (action === 'sync-horarios') {
      const { horarios } = req.body || {};
      if (!horarios || typeof horarios !== 'object') {
        return res.status(400).json({ error: 'Horarios requeridos' });
      }
      const db = getDB();
      await db.collection('config').doc('horarios').set({ horarios, updatedAt: Date.now() });
      return res.status(200).json({ ok: true });
    }

    // Push de prueba
    if (action === 'test') {
      if (!subscription) return res.status(400).json({ error: 'Suscripción requerida' });
      try {
        await enviarPush(subscription, '💊 ¡Las alarmas funcionan!', 'Esta notificación llegó aunque la app estuviera cerrada ✅');
        return res.status(200).json({ ok: true });
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}
