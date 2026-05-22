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
import { randomUUID } from 'crypto';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL   = 'mailto:jmpazblanes@gmail.com';

// Horarios por defecto (se usan si el usuario no ha sincronizado los suyos)
const HORARIOS_DEFAULT = {
  '07:00': { titulo: '⚠️ Prograf + CellCept — EN AYUNAS', cuerpo: 'Prograf 6mg + CellCept 2x500mg · Sin haber comido nada · Esperar 1h antes de desayunar' },
  '08:00': { titulo: '💊 Prednisona + pastillas desayuno', cuerpo: 'Prednisona 40mg · Calcio 1250 · Magnesio 53mg · Amlodipino 5mg · Bisoprolol 2.5mg · Omeprazol 20mg' },
  '14:00': { titulo: '💊 Pastillas de la comida', cuerpo: 'Zitromax 250mg · Valganciclovir 900mg · Septrin Forte 160/800mg' },
  '19:00': { titulo: '⚠️ Prograf + CellCept — EN AYUNAS', cuerpo: 'Prograf 6mg + CellCept 2x500mg · Sin haber comido nada · Esperar 1h antes de cenar' },
  '22:00': { titulo: '💊 Pastillas antes de dormir', cuerpo: 'Magnesio 53mg · Calcio 1250 · Amlodipino 5mg · Bisoprolol 2.5mg · Omeprazol 20mg' },
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

async function enviarPush(subscription, titulo, cuerpo, tag = null) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  const endpointHost = subscription?.endpoint ? new URL(subscription.endpoint).host : 'endpoint-desconocido';
  const deliveryId = randomUUID();
  const response = await webpush.sendNotification(
    subscription,
    JSON.stringify({
      titulo,
      cuerpo,
      tag: tag || `pastillas-push-${Date.now()}`,
      timestamp: Date.now(),
      deliveryId,
    }),
    { TTL: 3600, urgency: 'high' }
  );
  console.log(`Push aceptado por ${endpointHost} con estado ${response.statusCode || 'OK'} (${deliveryId})`);
  return { response, deliveryId };
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

  // GET — diagnóstico rápido (?diag=1)
  if (req.method === 'GET' && req.query?.diag === '1') {
    const db = getDB();
    const snap = await db.collection('suscripciones').get();
    return res.status(200).json({
      vapid_public_set: !!VAPID_PUBLIC,
      vapid_private_set: !!VAPID_PRIVATE,
      firebase_set: !!process.env.FIREBASE_SERVICE_ACCOUNT,
      vapid_public_prefix: VAPID_PUBLIC ? VAPID_PUBLIC.slice(0, 12) + '...' : 'NO CONFIGURADA',
      expected_prefix: 'BCNgbW2waCXE',
      keys_match: VAPID_PUBLIC ? VAPID_PUBLIC.startsWith('BCNgbW2waCXE') : false,
      subscriptions: snap.size,
    });
  }

  // GET — cron cada minuto (o ?force=1 para probar)
  if (req.method === 'GET') {
    const hora = horaEspana();
    const forzar = req.query?.force === '1';
    const safeDiag = req.query?.force === 'safe'; // diagnóstico sin borrar suscripciones

    const db = getDB();

    // Leer horarios del usuario desde Firestore (si los ha sincronizado)
    // Busca en ventana de 5 min para tolerar retraso del cron externo
    let alarmasAEnviar = [];
    if (forzar || safeDiag) {
      alarmasAEnviar = [{ titulo: '💊 Prueba con app cerrada', cuerpo: '¡Funciona! Las alarmas llegarán aunque cierres la app ✅' }];
    } else {
      const ventana = horasEnVentana(5);
      const horariosDoc = await db.collection('config').doc('horarios').get();
      const horariosUsuario = horariosDoc.exists ? (horariosDoc.data()?.horarios || {}) : {};
      const disparadas = horariosDoc.exists ? (horariosDoc.data()?.disparadas || {}) : {};

      for (const h of ventana) {
        const alarma = horariosUsuario[h] || HORARIOS_DEFAULT[h] || null;
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
        snap.docs.map(doc => enviarPush(
          doc.data().subscription,
          alarma.titulo,
          alarma.cuerpo,
          alarma.claveDisparo ? `pastillas-${alarma.claveDisparo}` : null
        ))
      );

      // Limpiar suscripciones caducadas (skip en modo safe para diagnóstico)
      for (let i = 0; i < results.length; i++) {
        if (results[i].status === 'rejected') {
          const err = results[i].reason;
          console.error(`PUSH_FAIL_GET sub=${snap.docs[i].id} status=${err?.statusCode} msg=${err?.message} body=${err?.body}`);
          if (!safeDiag) await snap.docs[i].ref.delete();
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

    if (action === 'delivery-log') {
      const { deliveryId, tag, timestamp } = req.body || {};
      if (!deliveryId) return res.status(400).json({ error: 'deliveryId requerido' });
      const db = getDB();
      await db.collection('delivery_logs').doc(deliveryId).set({
        deliveryId,
        tag: tag || '',
        clientTimestamp: timestamp || Date.now(),
        receivedAt: Date.now(),
        userAgent: req.headers['user-agent'] || '',
      });
      return res.status(200).json({ ok: true });
    }

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

      const alarmasAEnviar = [];
      for (const h of ventana) {
        const alarma = horariosUsuario[h] || HORARIOS_DEFAULT[h] || null;
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
          snap.docs.map(doc => enviarPush(
            doc.data().subscription,
            alarma.titulo,
            alarma.cuerpo,
            alarma.claveDisparo ? `pastillas-${alarma.claveDisparo}` : null
          ))
        );
        for (let i = 0; i < results.length; i++) {
          if (results[i].status === 'rejected') {
            const err = results[i].reason;
            console.error(`PUSH_FAIL sub=${snap.docs[i].id} status=${err?.statusCode} msg=${err?.message} body=${err?.body}`);
            await snap.docs[i].ref.delete();
          }
        }
        totalEnviados += results.filter(r => r.status === 'fulfilled').length;
        if (alarma.claveDisparo) disparadasUpdate[`disparadas.${alarma.claveDisparo}`] = true;
      }

      if (Object.keys(disparadasUpdate).length > 0) {
        await db.collection('config').doc('horarios').set(disparadasUpdate, { merge: true });
      }

      return res.status(200).json({ ok: true, hora, enviados: totalEnviados, total: snap.size });
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

    // Debug push — devuelve error completo de Apple sin borrar suscripciones
    if (action === 'debug-push') {
      const db = getDB();
      const snap = await db.collection('suscripciones').get();
      if (snap.empty) return res.status(200).json({ ok: false, msg: 'Sin suscripciones en Firestore' });

      const results = [];
      for (const doc of snap.docs) {
        try {
          await enviarPush(doc.data().subscription, '🔔 Debug push', 'Si ves esto, el push funciona ✅');
          results.push({ id: doc.id, ok: true });
        } catch (e) {
          results.push({
            id: doc.id,
            ok: false,
            status: e?.statusCode,
            message: e?.message,
            body: e?.body,
            endpoint: doc.data().subscription?.endpoint ? new URL(doc.data().subscription.endpoint).host : 'unknown',
          });
        }
      }
      return res.status(200).json({ results });
    }

    // Push de prueba
    if (action === 'test') {
      if (!subscription) return res.status(400).json({ error: 'Suscripción requerida' });
      try {
        const result = await enviarPush(subscription, '💊 ¡Las alarmas funcionan!', 'Esta notificación llegó aunque la app estuviera cerrada ✅');
        return res.status(200).json({ ok: true, deliveryId: result.deliveryId });
      } catch (e) {
        const endpoint = subscription?.endpoint ? new URL(subscription.endpoint).host : 'unknown';
        console.error(`TEST_PUSH_FAIL endpoint=${endpoint} status=${e?.statusCode} msg=${e?.message} body=${e?.body}`);
        return res.status(500).json({ error: e.message, statusCode: e?.statusCode, body: e?.body });
      }
    }

    return res.status(400).json({ error: 'Acción no reconocida' });
  }

  return res.status(405).json({ error: 'Método no permitido' });
}

