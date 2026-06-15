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
  '07:00': { titulo: '⚠️ Prograf + CellCept — EN AYUNAS', cuerpo: 'Prograf 6mg + CellCept 2x500mg · Sin haber comido nada · Esperar 1h antes de desayunar' },
  '08:00': { titulo: '💊 Prednisona + pastillas desayuno', cuerpo: 'Prednisona 40mg · Calcio 1250 · Magnesio 53mg · Amlodipino 5mg · Bisoprolol 2.5mg · Omeprazol 20mg' },
  '14:00': { titulo: '💊 Pastillas de la comida', cuerpo: 'Zitromax 250mg · Valganciclovir 900mg · Septrin Forte 160/800mg' },
  '22:00': { titulo: '💊 Pastillas antes de dormir', cuerpo: 'Magnesio 53mg · Calcio 1250 · Amlodipino 5mg · Bisoprolol 2.5mg · Omeprazol 20mg' },
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

// Construye el mapa hora -> { titulo, cuerpo } a partir del schedule REAL que
// la app sincroniza en Firestore (config/schedule). Es la fuente de verdad:
// si el usuario quita o cambia una toma, las alarmas dejan de salir a esa hora.
// Devuelve null si no hay schedule utilizable (para poder caer al fallback).
function horariosDesdeSchedule(scheduleData) {
  const { medicamentos = [], tomas = [] } = scheduleData || {};
  if (medicamentos.length === 0 || tomas.length === 0) return null;

  const grupos = {};
  for (const toma of tomas) {
    if (toma.activa === false) continue;
    const med = medicamentos.find((m) => m.id === toma.medicamento_id);
    if (!med) continue;
    if (!grupos[toma.hora]) grupos[toma.hora] = [];
    grupos[toma.hora].push(med);
  }

  const horarios = {};
  for (const [hora, meds] of Object.entries(grupos)) {
    if (meds.length === 0) continue;
    const esAyunas = meds.some(
      (m) => m.indicaciones && m.indicaciones.toLowerCase().includes('ayunas')
    );
    const titulo = esAyunas ? `⚠️ Pastillas ${hora} — EN AYUNAS` : `💊 Pastillas ${hora}`;
    const partes = meds.map((m) => `${m.nombre} ${m.dosis || ''}`.trim());
    const instruccion = esAyunas ? ' · Sin haber comido · Esperar 1h' : '';
    horarios[hora] = { titulo, cuerpo: partes.join(' · ') + instruccion };
  }

  return Object.keys(horarios).length > 0 ? horarios : null;
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
  const [horariosDoc, scheduleDoc] = await Promise.all([
    db.collection('config').doc('horarios').get(),
    db.collection('config').doc('schedule').get(),
  ]);
  const horariosData = horariosDoc.exists ? horariosDoc.data() : {};
  const scheduleData = scheduleDoc.exists ? scheduleDoc.data() : null;
  const disparadas = horariosData?.disparadas || {};

  // Fuente de verdad: el schedule real que la app sincroniza (config/schedule).
  // Si no hay schedule, se usan los horarios sincronizados antiguos y, como
  // última red de seguridad para no perder ninguna toma, HORARIOS_DEFAULT.
  // FIXED_ONLY fuerza únicamente los horarios por defecto (modo manual).
  const horariosSchedule = horariosDesdeSchedule(scheduleData);
  const horariosSync = Object.keys(horariosData?.horarios || {}).length
    ? horariosData.horarios
    : null;
  let fuente;
  let horariosEfectivos;
  if (FIXED_ONLY) {
    fuente = 'horarios por defecto (FIXED_ONLY)';
    horariosEfectivos = HORARIOS_DEFAULT;
  } else if (horariosSchedule) {
    fuente = 'schedule real de la app';
    horariosEfectivos = horariosSchedule;
  } else if (horariosSync) {
    fuente = 'horarios sincronizados';
    horariosEfectivos = horariosSync;
  } else {
    fuente = 'horarios por defecto (sin schedule)';
    horariosEfectivos = HORARIOS_DEFAULT;
  }

  const alarmasAEnviar = [];

  if (FORCE_TEST) {
    alarmasAEnviar.push({
      titulo: '💊 Prueba de alarma',
      cuerpo: `Prueba manual enviada desde GitHub Actions a las ${ahora}`,
      claveDisparo: null,
    });
  } else {
    for (const hora of horasEnVentana()) {
      const alarma = horariosEfectivos[hora];
      if (!alarma) continue;

      const claveDisparo = `${hoy}_${hora}`;
      if (disparadas[claveDisparo]) continue;

      alarmasAEnviar.push({ ...alarma, claveDisparo });
    }
  }

  console.log(`Hora España: ${ahora}`);
  console.log(`Minuto revisado: ${horasEnVentana().join(', ')}`);
  console.log(`Fuente de horarios: ${fuente} (${Object.keys(horariosEfectivos).join(', ')})`);
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

