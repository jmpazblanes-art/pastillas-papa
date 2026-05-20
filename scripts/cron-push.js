import webpush from 'web-push';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { randomUUID } from 'crypto';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = 'mailto:jmpazblanes@gmail.com';
const WINDOW_MINUTES = Number(process.env.WINDOW_MINUTES || 15);
const FORCE_TEST = process.env.FORCE_TEST === 'true';
const FIXED_ONLY = process.env.FIXED_ONLY === 'true';

const HORARIOS_DEFAULT = {
  '07:00': { titulo: '💊 Tacrolimus + CellCept', cuerpo: 'En AYUNAS — esperar 1h antes de desayunar' },
  '08:00': { titulo: '💊 Pastillas del desayuno', cuerpo: 'Prednisona, Calcio, Magnesio, Amlodipino, Bisoprolol, Omeprazol, Linezolid' },
  '19:00': { titulo: '💊 Tacrolimus + CellCept', cuerpo: 'En AYUNAS — esperar 1h antes de cenar' },
  '21:00': { titulo: '💊 Pastillas de la cena', cuerpo: 'Calcio, Magnesio, Amlodipino, Bisoprolol, Omeprazol, Linezolid' },
};

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Falta el secreto ${name}`);
  return value;
}

function getDB() {
  if (getApps().length === 0) {
    const serviceAccount = JSON.parse(requireEnv('FIREBASE_SERVICE_ACCOUNT'));
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

function formatEspana(date, options) {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    ...options,
  }).format(date);
}

function horaEspana(date = new Date()) {
  return formatEspana(date, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function fechaEspana(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function horasEnVentana(ventanaMinutos = WINDOW_MINUTES) {
  const ahora = new Date();
  const horas = [];
  for (let i = 0; i < ventanaMinutos; i++) {
    horas.push(horaEspana(new Date(ahora.getTime() - i * 60000)));
  }
  return [...new Set(horas)];
}

async function enviarPush(subscription, alarma) {
  webpush.setVapidDetails(VAPID_EMAIL, requireEnv('VAPID_PUBLIC_KEY'), requireEnv('VAPID_PRIVATE_KEY'));
  const endpointHost = subscription?.endpoint ? new URL(subscription.endpoint).host : 'endpoint-desconocido';
  const deliveryId = randomUUID();
  const response = await webpush.sendNotification(
    subscription,
    JSON.stringify({
      titulo: alarma.titulo,
      cuerpo: alarma.cuerpo,
      tag: alarma.claveDisparo ? `pastillas-${alarma.claveDisparo}` : `pastillas-test-${Date.now()}`,
      timestamp: Date.now(),
      deliveryId,
    }),
    { TTL: 3600, urgency: 'high' }
  );
  return { deliveryId, endpointHost, statusCode: response.statusCode };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function comprobarRecepciones(db, deliveryIds) {
  if (deliveryIds.length === 0) return;

  await sleep(12000);

  for (const deliveryId of deliveryIds) {
    const doc = await db.collection('delivery_logs').doc(deliveryId).get();
    if (doc.exists) {
      const data = doc.data();
      console.log(`iPhone confirmó recepción: ${deliveryId} (${data?.tag || 'sin-tag'})`);
    } else {
      console.warn(`Sin confirmación del iPhone para: ${deliveryId}`);
    }
  }
}

async function main() {
  requireEnv('VAPID_PUBLIC_KEY');
  requireEnv('VAPID_PRIVATE_KEY');

  const db = getDB();
  const ahora = horaEspana();
  const hoy = fechaEspana();
  const horariosDoc = await db.collection('config').doc('horarios').get();
  const horariosData = horariosDoc.exists ? horariosDoc.data() : {};
  const horariosUsuario = FIXED_ONLY ? {} : (horariosData?.horarios || {});
  const disparadas = horariosData?.disparadas || {};

  const alarmasAEnviar = [];

  if (FORCE_TEST) {
    alarmasAEnviar.push({
      titulo: '💊 Prueba de alarma',
      cuerpo: `Prueba manual enviada desde GitHub Actions a las ${ahora}`,
      claveDisparo: null,
    });
  } else {
    for (const hora of horasEnVentana()) {
      const alarma = horariosUsuario[hora] || HORARIOS_DEFAULT[hora] || null;
      if (!alarma) continue;

      const claveDisparo = `${hoy}_${hora}`;
      if (disparadas[claveDisparo]) continue;

      alarmasAEnviar.push({ ...alarma, claveDisparo });
    }
  }

  console.log(`Hora España: ${ahora}`);
  console.log(`Ventana revisada: ${horasEnVentana().join(', ')}`);
  console.log(`Modo: ${FIXED_ONLY ? '4 alarmas fijas' : 'horarios sincronizados desde app'}`);
  console.log(`Alarmas candidatas: ${alarmasAEnviar.length}`);

  if (alarmasAEnviar.length === 0) {
    console.log('Sin alarma en esta ventana');
    return;
  }

  const snap = await db.collection('suscripciones').get();
  console.log(`Suscripciones encontradas: ${snap.size}`);

  if (snap.empty) {
    console.log('Sin suscripciones push registradas');
    return;
  }

  let totalEnviados = 0;
  let totalEliminados = 0;
  const deliveryIds = [];
  const disparadasUpdate = {};

  for (const alarma of alarmasAEnviar) {
    const results = await Promise.allSettled(
      snap.docs.map((doc) => enviarPush(doc.data().subscription, alarma))
    );

    for (let i = 0; i < results.length; i++) {
      if (results[i].status === 'fulfilled') {
        console.log(`Push aceptado por ${results[i].value.endpointHost} con estado ${results[i].value.statusCode || 'OK'}`);
        deliveryIds.push(results[i].value.deliveryId);
      }

      if (results[i].status === 'rejected') {
        console.warn(`Error push ${snap.docs[i].id}:`, results[i].reason?.statusCode || results[i].reason?.message || results[i].reason);
        totalEliminados += 1;
        await snap.docs[i].ref.delete();
      }
    }

    totalEnviados += results.filter((result) => result.status === 'fulfilled').length;

    if (alarma.claveDisparo) {
      disparadasUpdate[`disparadas.${alarma.claveDisparo}`] = true;
    }
  }

  if (Object.keys(disparadasUpdate).length > 0) {
    await db.collection('config').doc('horarios').set(disparadasUpdate, { merge: true });
  }

  console.log(`Push enviados: ${totalEnviados}`);
  console.log(`Suscripciones caducadas eliminadas: ${totalEliminados}`);
  await comprobarRecepciones(db, deliveryIds);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
