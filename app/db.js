/**
 * PastillasPapa — Base de datos local con IndexedDB
 * Sin dependencias externas, funciona offline, datos del paciente nunca salen del dispositivo
 */

const DB_NAME = 'pastillas-papa-v2';
const DB_VERSION = 1;

let db = null;

export function initDB() {
  return new Promise((resolve, reject) => {
    // Verificar que la conexión existente sigue viva
    if (db) {
      try {
        // Probar que la conexión no está cerrada
        db.transaction('medicamentos', 'readonly').abort();
        resolve(db);
        return;
      } catch {
        // Conexión inválida — resetear y abrir de nuevo
        db = null;
      }
    }

    // Timeout de seguridad: si IndexedDB no responde en 8s, recargar
    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        console.warn('IndexedDB no responde tras 8s — recargando...');
        location.reload();
      }
    }, 8000);

    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const database = e.target.result;

      // Tabla de medicamentos
      if (!database.objectStoreNames.contains('medicamentos')) {
        const med = database.createObjectStore('medicamentos', { keyPath: 'id', autoIncrement: true });
        med.createIndex('nombre', 'nombre', { unique: false });
      }

      // Tabla de tomas programadas (horarios)
      if (!database.objectStoreNames.contains('tomas')) {
        const toma = database.createObjectStore('tomas', { keyPath: 'id', autoIncrement: true });
        toma.createIndex('medicamento_id', 'medicamento_id', { unique: false });
        toma.createIndex('hora', 'hora', { unique: false });
      }

      // Tabla de registro de tomas (historial)
      if (!database.objectStoreNames.contains('registros')) {
        const reg = database.createObjectStore('registros', { keyPath: 'id', autoIncrement: true });
        reg.createIndex('fecha', 'fecha', { unique: false });
        reg.createIndex('toma_id', 'toma_id', { unique: false });
        reg.createIndex('fecha_toma', ['fecha', 'toma_id'], { unique: false });
      }
    };

    req.onsuccess = (e) => {
      resolved = true;
      clearTimeout(timeout);
      db = e.target.result;
      // Manejar cierre inesperado de la DB
      db.onclose = () => { db = null; };
      db.onerror = (event) => console.error('DB error:', event.target.error);
      resolve(db);
    };

    req.onerror = () => {
      resolved = true;
      clearTimeout(timeout);
      reject(req.error);
    };

    // Manejar bloqueo por otras tabs con la DB abierta
    req.onblocked = () => {
      console.warn('IndexedDB bloqueada — recargando...');
      resolved = true;
      clearTimeout(timeout);
      // Forzar recarga para limpiar estado
      setTimeout(() => location.reload(), 500);
    };
  });
}

async function getStoreAsync(name, mode = 'readonly') {
  if (!db) await initDB();
  const tx = db.transaction(name, mode);
  return tx.objectStore(name);
}

function getStore(name, mode = 'readonly') {
  if (!db) throw new Error('DB no inicializada — llama initDB() primero');
  const tx = db.transaction(name, mode);
  return tx.objectStore(name);
}

// ===== MEDICAMENTOS =====

export function getMedicamentos() {
  return new Promise((resolve, reject) => {
    const req = getStore('medicamentos').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function addMedicamento(med) {
  return new Promise((resolve, reject) => {
    const req = getStore('medicamentos', 'readwrite').add(med);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function updateMedicamento(med) {
  return new Promise((resolve, reject) => {
    const req = getStore('medicamentos', 'readwrite').put(med);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function deleteMedicamento(id) {
  return new Promise(async (resolve, reject) => {
    // Borrar tomas asociadas primero
    const tomas = await getTomasByMedicamento(id);
    for (const t of tomas) {
      await deleteToma(t.id);
    }
    const req = getStore('medicamentos', 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ===== TOMAS (horarios programados) =====

export function getTomas() {
  return new Promise((resolve, reject) => {
    const req = getStore('tomas').getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.hora.localeCompare(b.hora)));
    req.onerror = () => reject(req.error);
  });
}

export function getTomasByMedicamento(medId) {
  return new Promise((resolve, reject) => {
    const req = getStore('tomas').index('medicamento_id').getAll(medId);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function addToma(toma) {
  return new Promise((resolve, reject) => {
    const req = getStore('tomas', 'readwrite').add(toma);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function updateToma(toma) {
  return new Promise((resolve, reject) => {
    const req = getStore('tomas', 'readwrite').put(toma);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function deleteToma(id) {
  return new Promise((resolve, reject) => {
    const req = getStore('tomas', 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

// ===== REGISTROS (historial de tomas realizadas) =====

export function getRegistrosByFecha(fecha) {
  return new Promise((resolve, reject) => {
    const req = getStore('registros').index('fecha').getAll(fecha);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function addRegistro(registro) {
  // registro = { toma_id, medicamento_id, fecha (YYYY-MM-DD), hora_real, tomada: bool }
  return new Promise((resolve, reject) => {
    const req = getStore('registros', 'readwrite').add({
      ...registro,
      timestamp: Date.now()
    });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function deleteRegistro(id) {
  return new Promise((resolve, reject) => {
    const req = getStore('registros', 'readwrite').delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

export function getAllRegistros() {
  return new Promise((resolve, reject) => {
    const req = getStore('registros').getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Borrar solo medicamentos y tomas (conserva historial de registros)
export function clearScheduleLocal() {
  return new Promise((resolve, reject) => {
    if (!db) { reject(new Error('DB no inicializada')); return; }
    const tx = db.transaction(['medicamentos', 'tomas'], 'readwrite');
    tx.objectStore('medicamentos').clear();
    tx.objectStore('tomas').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Borrar TODOS los datos (para reinstalar datos reales)
export function clearAllData() {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['medicamentos', 'tomas', 'registros'], 'readwrite');
    tx.objectStore('medicamentos').clear();
    tx.objectStore('tomas').clear();
    tx.objectStore('registros').clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ===== DATOS REALES — Trasplante de pulmón =====
// Medicamentos del paciente según cuaderno de la madre (mayo 2026)

export async function seedDemoData() {
  const meds = await getMedicamentos();
  if (meds.length > 0) return; // Ya tiene datos

  // Índices: 0-Tacrolimus, 1-CellCept, 2-Prednisona, 3-Calcio, 4-Magnogene, 5-Amlodipino, 6-Bisoprolol, 7-Omeprazol, 8-Linezolid, 9-Tramadol
  const medicamentos = [
    {
      nombre: 'Tacrolimus (Prograf)',
      dosis: '6 mg',
      categoria: 'Inmunosupresor',
      indicaciones: 'En AYUNAS. Tomar y esperar 1 hora antes de desayunar. Siempre a la misma hora.',
      color: '#4fc3f7',
      notas: 'Inmunosupresor principal tras trasplante de pulmón. Evita el rechazo del pulmón trasplantado. Dosis exacta: 5 mg + 1 mg. NO tomar con zumo de pomelo. Niveles en sangre muy importantes — no faltar tomas.'
    },
    {
      nombre: 'CellCept (Micofenolato)',
      dosis: '1000 mg',
      categoria: 'Inmunosupresor',
      indicaciones: 'Con o sin comida. Tomar junto con Tacrolimus (misma hora).',
      color: '#a78bfa',
      notas: 'Inmunosupresor secundario. Tomar 2 comprimidos de 500 mg = 1000 mg. Junto con Tacrolimus forma el doble escudo anti-rechazo del trasplante.'
    },
    {
      nombre: 'Prednisona',
      dosis: '40 mg',
      categoria: 'Corticoide',
      indicaciones: 'Con el desayuno (con comida, nunca en ayunas). Por la mañana.',
      color: '#f59e0b',
      notas: 'Corticoide antiinflamatorio e inmunosupresor. Reduce la inflamación y evita el rechazo del trasplante. La dosis de 40 mg es alta — ir bajando con el tiempo según médico.'
    },
    {
      nombre: 'Calcio Mastical D',
      dosis: '1250 mg',
      categoria: 'Suplemento',
      indicaciones: 'Con comida (desayuno y cena). Masticar o disolver, no tragar entero.',
      color: '#fbbf24',
      notas: 'Suplemento de calcio con vitamina D. Protege los huesos frente a la osteoporosis causada por los corticoides (Prednisona) y la inmovilidad postoperatoria. Tomarlo con comida para mejor absorción.'
    },
    {
      nombre: 'Magnogene (Magnesio)',
      dosis: '53 mg',
      categoria: 'Suplemento',
      indicaciones: 'Con comida (desayuno y cena).',
      color: '#34d399',
      notas: 'Suplemento de magnesio. Compensa la pérdida de magnesio producida por el Tacrolimus (efecto secundario frecuente). El magnesio es esencial para el músculo cardíaco y los nervios.'
    },
    {
      nombre: 'Amlodipino',
      dosis: '5 mg',
      categoria: 'Antihipertensivo',
      indicaciones: 'Con comida (desayuno y cena).',
      color: '#60a5fa',
      notas: 'Bloqueante de los canales de calcio. Controla la tensión arterial elevada, un efecto secundario muy habitual del Tacrolimus. Ayuda también al corazón en el período postoperatorio.'
    },
    {
      nombre: 'Bisoprolol',
      dosis: '2,5 mg',
      categoria: 'Antihipertensivo',
      indicaciones: 'Con comida (desayuno y cena).',
      color: '#818cf8',
      notas: 'Betabloqueante. Reduce la frecuencia cardíaca y la tensión arterial. Protege el corazón durante la recuperación del trasplante. No dejar de tomarlo de golpe.'
    },
    {
      nombre: 'Omeprazol',
      dosis: '20 mg',
      categoria: 'Protector gástrico',
      indicaciones: 'Con el desayuno (por la mañana, antes o durante). También con cena si se prescribe.',
      color: '#10b981',
      notas: 'Protector gástrico. Protege el estómago de las úlceras y la acidez causadas por la Prednisona (corticoide). Obligatorio mientras se tomen corticoides.'
    },
    {
      nombre: 'Linezolid',
      dosis: '600 mg',
      categoria: 'Antibiótico profiláctico',
      indicaciones: 'Con o sin comida. Cada 12 horas (mañana y noche). Medicación temporal hospitalaria.',
      color: '#fb7185',
      notas: 'Antibiótico para infecciones bacterianas resistentes. Medicación temporal del período postoperatorio. Duración según indicación médica. NO tomar con alimentos ricos en tiramina (embutidos curados, quesos añejos, vino tinto).'
    },
    {
      nombre: 'Tramadol',
      dosis: '50 mg',
      categoria: 'Otro',
      indicaciones: 'Con o sin comida. Solo si hay dolor. Medicación temporal hospitalaria.',
      color: '#f97316',
      notas: 'Analgésico opioide para el dolor postoperatorio. Medicación temporal del período postoperatorio. No conducir ni manejar maquinaria. Puede producir mareo o somnolencia.'
    },
  ];

  const ids = [];
  for (const m of medicamentos) {
    const id = await addMedicamento(m);
    ids.push(id);
  }

  // Horarios reales según cuaderno de la madre
  // Índices: 0-Tacrolimus, 1-CellCept, 2-Prednisona, 3-Calcio, 4-Magnogene, 5-Amlodipino, 6-Bisoprolol, 7-Omeprazol, 8-Linezolid, 9-Tramadol
  const horarios = [
    {
      hora: '07:00',
      meds: [0, 1, 2], // Tacrolimus + CellCept + Prednisona — EN AYUNAS (esperar 1h antes de desayunar)
    },
    {
      hora: '08:00',
      meds: [3, 4, 5, 6, 7, 8], // Desayuno: Calcio + Magnesio + Amlodipino + Bisoprolol + Omeprazol + Linezolid
    },
    {
      hora: '19:00',
      meds: [0, 1], // Tacrolimus + CellCept en AYUNAS (esperar 1h antes de cenar)
    },
    {
      hora: '21:00',
      meds: [3, 4, 5, 6, 7, 8], // Cena: Calcio + Magnesio + Amlodipino + Bisoprolol + Omeprazol + Linezolid
    },
  ];

  for (const h of horarios) {
    for (const mi of h.meds) {
      await addToma({ medicamento_id: ids[mi], hora: h.hora, activa: true });
    }
  }
}
