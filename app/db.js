/**
 * PastillasPapa — Base de datos local con IndexedDB
 * Sin dependencias externas, funciona offline, datos del paciente nunca salen del dispositivo
 */

const DB_NAME = 'pastillas-papa';
const DB_VERSION = 1;

let db = null;

export function initDB() {
  return new Promise((resolve, reject) => {
    if (db) { resolve(db); return; }

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
      db = e.target.result;
      resolve(db);
    };

    req.onerror = () => reject(req.error);
  });
}

function getStore(name, mode = 'readonly') {
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

// ===== DATOS DE EJEMPLO para primera vez =====

export async function seedDemoData() {
  const meds = await getMedicamentos();
  if (meds.length > 0) return; // Ya tiene datos

  const medicamentos = [
    { nombre: 'Tacrolimus', dosis: '1 mg', categoria: 'Inmunosupresor', indicaciones: 'Con agua, en ayunas', color: '#4fc3f7', notas: 'Inmunosupresor principal tras trasplante' },
    { nombre: 'Prednisona', dosis: '5 mg', categoria: 'Corticoide', indicaciones: 'Con comida', color: '#f59e0b', notas: 'Antiinflamatorio corticoide' },
    { nombre: 'Micofenolato', dosis: '500 mg', categoria: 'Inmunosupresor', indicaciones: 'Con o sin comida', color: '#a78bfa', notas: 'Inmunosupresor secundario' },
    { nombre: 'Omeprazol', dosis: '20 mg', categoria: 'Protector gástrico', indicaciones: 'En ayunas, 30min antes de comer', color: '#34d399', notas: 'Protector del estómago' },
    { nombre: 'Cotrimoxazol', dosis: '400 mg', categoria: 'Antibiótico profiláctico', indicaciones: 'Con agua', color: '#fb7185', notas: 'Prevención de infecciones' },
    { nombre: 'Valganciclovir', dosis: '450 mg', categoria: 'Antiviral', indicaciones: 'Con comida', color: '#fb923c', notas: 'Prevención de CMV' },
    { nombre: 'Amlodipino', dosis: '5 mg', categoria: 'Antihipertensivo', indicaciones: 'A cualquier hora', color: '#60a5fa', notas: 'Control de tensión arterial' },
    { nombre: 'Calcio + Vit D', dosis: '500 mg', categoria: 'Suplemento', indicaciones: 'Con comida', color: '#fbbf24', notas: 'Suplemento óseo' },
  ];

  const ids = [];
  for (const m of medicamentos) {
    const id = await addMedicamento(m);
    ids.push(id);
  }

  // Tomas: 08:00, 16:00, 24:00
  const horarios = [
    { hora: '08:00', meds: [0,1,2,3,4,5,6,7] },
    { hora: '16:00', meds: [0,2,3,5] },
    { hora: '24:00', meds: [0,1,2,4,6] },
  ];

  for (const h of horarios) {
    for (const mi of h.meds) {
      await addToma({ medicamento_id: ids[mi], hora: h.hora, activa: true });
    }
  }
}
