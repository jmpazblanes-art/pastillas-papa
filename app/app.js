/**
 * PastillasPapa — Lógica principal de la aplicación
 */

import {
  initDB, seedDemoData, clearAllData, clearScheduleLocal,
  getMedicamentos, addMedicamento, updateMedicamento, deleteMedicamento,
  getTomas, addToma, updateToma, deleteToma,
  getRegistrosByFecha, addRegistro, deleteRegistro, getAllRegistros
} from './db.js';

import {
  pedirPermisoNotificaciones, tienePermiso,
  registrarServiceWorker, programarAlarmasHoy, proximaToma, reproducirSonidoAlarma,
  mostrarNotificacion, iniciarFCM, probarPushFCM, sincronizarHorariosServidor,
  resetearWebPush, diagnosticoWebPush
} from './alarmas.js';
// firebase.js eliminado — usamos Web Push estándar sin Firebase

import {
  fechaHoy, formatearFecha, emojiToma, etiquetaToma,
  estadoToma, porcentaje, colorCategoria, iconoCategoria,
  ultimosDias, formatearHora12
} from './utils.js';

// ===== Estado global =====
let state = {
  medicamentos: [],
  tomas: [],
  registros: [],
  fechaActual: fechaHoy(),
  paginaActual: 'hoy',
  editandoMed: null,
  horariosNuevoMed: [],
  infoData: { comidas: [], habitos: [] },
};

// ===== SYNC CON SERVIDOR (Firestore como fuente de verdad) =====
const SYNC_TS_KEY = 'schedule_server_ts';

async function cargarDesdeServidor() {
  try {
    const res = await fetch('/api/push?schedule=1');
    if (!res.ok) return false;
    const { schedule } = await res.json();
    if (!schedule || !Array.isArray(schedule.medicamentos)) return false;

    const localTs = Number(localStorage.getItem(SYNC_TS_KEY) || 0);
    if (schedule.updatedAt <= localTs) return false; // ya estamos al día

    // Servidor tiene datos más recientes — reemplazar datos locales
    await clearScheduleLocal();
    for (const med of schedule.medicamentos) {
      await updateMedicamento(med); // put() = upsert con ID fijo
    }
    for (const toma of schedule.tomas) {
      await updateToma(toma); // put() = upsert con ID fijo
    }
    localStorage.setItem(SYNC_TS_KEY, String(schedule.updatedAt));
    console.log(`Schedule cargado desde servidor (${schedule.medicamentos.length} meds, ${schedule.tomas.length} tomas)`);
    return true;
  } catch (e) {
    console.warn('Error al cargar schedule desde servidor:', e);
    return false;
  }
}

async function guardarEnServidor() {
  try {
    const medicamentos = await getMedicamentos();
    const tomas = await getTomas();
    const updatedAt = Date.now();
    localStorage.setItem(SYNC_TS_KEY, String(updatedAt));
    await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save-schedule', medicamentos, tomas, updatedAt }),
    });
    mostrarIndicadorSync('✅ Sincronizado');
  } catch (e) {
    console.warn('Error al guardar schedule en servidor:', e);
  }
}

function mostrarIndicadorSync(msg) {
  let el = document.getElementById('sync-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'sync-indicator';
    el.style.cssText = 'position:fixed;bottom:80px;right:12px;background:#1a2f1a;color:#34d399;font-size:11px;padding:4px 10px;border-radius:20px;border:1px solid #34d39944;z-index:9999;transition:opacity 0.5s';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

// ===== INIT =====
async function init() {
  await initDB();
  await seedDemoData();

  // Cargar desde servidor si hay datos más recientes
  const hayDatosNuevos = await cargarDesdeServidor();
  // Si no había datos en servidor, subir los locales
  if (!hayDatosNuevos) {
    const meds = await getMedicamentos();
    if (meds.length > 0 && !localStorage.getItem(SYNC_TS_KEY)) {
      await guardarEnServidor();
    }
  }

  await cargarDatos();
  await registrarServiceWorker();
  await pedirPermisoNotificaciones();
  iniciarFCM();
  renderNav();
  renderPaginaHoy();
  actualizarClock();
  setInterval(actualizarClock, 60000);
  setInterval(async () => {
    if (state.paginaActual === 'hoy') {
      await cargarDatos();
      renderPaginaHoy();
    }
  }, 60000);
  // Comprobar cambios remotos cada 2 minutos
  setInterval(async () => {
    const actualizado = await cargarDesdeServidor();
    if (actualizado) {
      await cargarDatos();
      if (state.paginaActual === 'hoy') renderPaginaHoy();
      else if (state.paginaActual === 'pastillas') renderPaginaPastillas();
      else if (state.paginaActual === 'alarmas') renderPaginaAlarmas();
      mostrarIndicadorSync('🔄 Actualizado desde otro dispositivo');
    }
  }, 2 * 60 * 1000);
}

async function cargarDatos() {
  state.medicamentos = await getMedicamentos();
  state.tomas = await getTomas();
  state.registros = await getRegistrosByFecha(state.fechaActual);
  programarAlarmasHoy(state.tomas, state.medicamentos);
}

// ===== NAVEGACIÓN =====
function renderNav() {
  const nav = document.getElementById('bottom-nav');
  const items = [
    { id: 'hoy',      icon: '💊', label: 'Hoy' },
    { id: 'pastillas', icon: '⚙️', label: 'Pastillas' },
    { id: 'alarmas',   icon: '🔔', label: 'Alarmas' },
    { id: 'cuidados',  icon: '🥗', label: 'Cuidados' },
    { id: 'info',      icon: '📖', label: 'Guía' },
  ];

  nav.innerHTML = items.map(it => `
    <button class="nav-item ${state.paginaActual === it.id ? 'active' : ''}"
            data-page="${it.id}" onclick="navegarA('${it.id}')">
      <span class="nav-icon">${it.icon}</span>
      <span>${it.label}</span>
    </button>
  `).join('');
}

window.navegarA = async function(pagina) {
  state.paginaActual = pagina;
  await cargarDatos();
  renderNav();
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  switch (pagina) {
    case 'hoy':       renderPaginaHoy();       break;
    case 'pastillas': renderPaginaPastillas(); break;
    case 'alarmas':   renderPaginaAlarmas();   break;
    case 'cuidados':  renderPaginaCuidados();  break;
    case 'info':      renderPaginaInfo();      break;
  }
  document.getElementById(`page-${pagina}`).classList.add('active');
  window.scrollTo(0, 0);
};

// ===== PÁGINA HOY =====
function renderPaginaHoy() {
  const page = document.getElementById('page-hoy');
  const hoy = state.fechaActual;
  const { medicamentos, tomas, registros } = state;

  // Calcular progreso total
  const totalTomas = tomas.filter(t => t.activa).length;
  const tomadasIds = new Set(registros.filter(r => r.tomada).map(r => r.toma_id));
  const totalTomadas = tomadasIds.size;
  const pct = porcentaje(totalTomadas, totalTomas);

  // Agrupar tomas por hora
  const grupos = {};
  for (const toma of tomas) {
    if (!toma.activa) continue;
    if (!grupos[toma.hora]) grupos[toma.hora] = [];
    grupos[toma.hora].push(toma);
  }

  // Próxima toma
  const proxima = proximaToma(tomas);
  const todasHoras = [...new Set(tomas.filter(t => t.activa).map(t => t.hora))].sort();

  let html = `
    <div class="app-header">
      <div class="header-left">
        <div class="greeting" id="greeting-text">Buenos días</div>
        <div class="title">Mis pastillas 💊</div>
        <div class="subtitle">${formatearFecha(hoy)}</div>
      </div>
      <div class="header-avatar" title="Menú">👴</div>
    </div>
    <div class="content">
  `;

  // Banner permiso notificaciones
  if (!tienePermiso()) {
    html += `
      <div class="permiso-banner" onclick="solicitarPermisos()">
        <span style="font-size:20px">🔔</span>
        <p>Activa las alarmas para no olvidar ninguna pastilla</p>
        <span style="color:var(--warning)">→</span>
      </div>
    `;
  }

  // Progreso
  html += `
    <div class="progress-card">
      <div class="progress-row">
        <span class="progress-label">Progreso de hoy</span>
        <span class="progress-count">${totalTomadas} / ${totalTomas} tomadas</span>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width:${pct}%"></div>
      </div>
    </div>
  `;

  // Próxima toma
  if (proxima) {
    const medProxima = tomas
      .filter(t => t.activa && t.hora === proxima)
      .map(t => medicamentos.find(m => m.id === t.medicamento_id)?.nombre)
      .filter(Boolean);
    const nMeds = medProxima.length;
    const nombresCortos = medProxima.slice(0, 2).join(', ') + (nMeds > 2 ? ` +${nMeds - 2} más` : '');

    html += `
      <div class="section-label">Próxima toma</div>
      <div class="proxima-card">
        <div class="proxima-icon">🔔</div>
        <div class="proxima-info">
          <div class="proxima-label">${emojiToma(proxima)} ${etiquetaToma(proxima)}</div>
          <div class="proxima-meds">${nombresCortos}</div>
        </div>
        <div class="proxima-hora">${proxima}</div>
      </div>
    `;
  } else if (pct === 100) {
    html += `
      <div class="proxima-card" style="border-color:rgba(52,211,153,0.4);background:linear-gradient(135deg,#0d2b1e,#0d1f2b)">
        <div class="proxima-icon">🎉</div>
        <div class="proxima-info">
          <div class="proxima-label" style="color:var(--success)">¡Todo tomado!</div>
          <div class="proxima-meds">Has completado todas las pastillas de hoy</div>
        </div>
      </div>
    `;
  }

  // Bloques de toma por hora
  html += `<div class="section-label" style="margin-top:4px">Tomas del día</div>`;

  for (const hora of todasHoras) {
    const tomasDeEstaHora = grupos[hora] || [];
    const estado = estadoToma(hora);
    const todasTomadas = tomasDeEstaHora.every(t => tomadasIds.has(t.id));
    const algunaTomada = tomasDeEstaHora.some(t => tomadasIds.has(t.id));

    let badgeClass, badgeText, dotColor, btnTomaClass, btnTomaText;

    if (todasTomadas) {
      badgeClass = 'badge-completada'; badgeText = '✓ Completada';
      dotColor = 'var(--success)';
      btnTomaClass = 'btn-toma-done'; btnTomaText = '✓ Toma completada';
    } else if (estado === 'activa') {
      badgeClass = 'badge-ahora'; badgeText = '⏰ Ahora';
      dotColor = 'var(--warning)';
      btnTomaClass = 'btn-toma-now'; btnTomaText = `✓ Marcar toda la toma de las ${hora}`;
    } else if (estado === 'futura') {
      badgeClass = 'badge-pendiente'; badgeText = 'Pendiente';
      dotColor = 'var(--text3)';
      btnTomaClass = 'btn-toma-future'; btnTomaText = `Toma a las ${hora}`;
    } else {
      // Pasada sin tomar
      badgeClass = 'badge-pendiente'; badgeText = '⚠️ Olvidada';
      dotColor = 'var(--danger)';
      btnTomaClass = 'btn-toma-now'; btnTomaText = `✓ Marcar como tomada`;
    }

    const opacity = estado === 'futura' ? 'opacity:0.6' : '';

    html += `
      <div class="toma-block" style="${opacity}">
        <div class="toma-header">
          <div class="toma-dot" style="background:${dotColor}"></div>
          <div class="toma-hora">${emojiToma(hora)} ${hora} — ${etiquetaToma(hora)}</div>
          <div class="toma-spacer"></div>
          <span class="toma-badge ${badgeClass}">${badgeText}</span>
        </div>
        <div class="pastillas-list">
    `;

    for (const toma of tomasDeEstaHora) {
      const med = medicamentos.find(m => m.id === toma.medicamento_id);
      if (!med) continue;
      const estaTomada = tomadasIds.has(toma.id);
      const reg = registros.find(r => r.toma_id === toma.id && r.tomada);
      const color = med.color || colorCategoria(med.categoria);
      const icono = iconoCategoria(med.categoria);

      html += `
        <div class="pastilla-card ${estaTomada ? 'tomada' : ''}"
             style="border-left-color:${color}"
             onclick="toggleToma(${toma.id}, ${med.id}, '${hora}', ${estaTomada ? `${reg?.id}` : 'null'})">
          <div class="pastilla-icono" style="background:${color}22">${icono}</div>
          <div class="pastilla-info">
            <div class="pastilla-nombre">${med.nombre}</div>
            <div class="pastilla-dosis">${med.dosis}${med.indicaciones ? ' · ' + med.indicaciones : ''}</div>
            <span class="pastilla-tag" style="background:${color}22;color:${color}">${med.categoria || 'Medicamento'}</span>
          </div>
          <div class="pastilla-btn ${estaTomada ? 'ok' : ''}">${estaTomada ? '✓' : '○'}</div>
        </div>
      `;
    }

    html += `</div>`; // pastillas-list

    if (!todasTomadas || estado !== 'futura') {
      const onclick = !todasTomadas
        ? `marcarTomaCompleta('${hora}', ${todasTomadas})`
        : '';
      html += `<button class="btn-toma ${btnTomaClass}" ${onclick ? `onclick="${onclick}"` : ''}>${btnTomaText}</button>`;
    }

    html += `</div>`; // toma-block
  }

  if (todasHoras.length === 0) {
    html += `
      <div class="empty-state">
        <div class="empty-icon">💊</div>
        <h3>Sin pastillas configuradas</h3>
        <p>Ve a la pestaña "Pastillas" para añadir tu medicación</p>
      </div>
    `;
  }

  html += `</div>`; // content
  page.innerHTML = html;
  page.classList.add('active');
  actualizarGreeting();
}

function actualizarGreeting() {
  const h = new Date().getHours();
  const el = document.getElementById('greeting-text');
  if (!el) return;
  if (h < 12) el.textContent = 'Buenos días 🌅';
  else if (h < 18) el.textContent = 'Buenas tardes ☀️';
  else el.textContent = 'Buenas noches 🌙';
}

function actualizarClock() {
  actualizarGreeting();
}

// ===== ACCIONES TOMA =====
window.toggleToma = async function(tomaId, medId, hora, registroId) {
  if (registroId && registroId !== 'null') {
    // Desmarcar
    await deleteRegistro(Number(registroId));
    mostrarToast('Desmarcada ↩️');
  } else {
    // Marcar como tomada
    await addRegistro({
      toma_id: tomaId,
      medicamento_id: medId,
      fecha: state.fechaActual,
      hora_real: new Date().toTimeString().slice(0, 5),
      tomada: true,
    });
    reproducirSonidoAlarma();
    mostrarToast('✓ ¡Pastilla tomada!');
  }
  await cargarDatos();
  renderPaginaHoy();
};

window.marcarTomaCompleta = async function(hora, yaCompleta) {
  if (yaCompleta) return;
  const tomasDeEstaHora = state.tomas.filter(t => t.activa && t.hora === hora);
  const tomadasIds = new Set(state.registros.filter(r => r.tomada).map(r => r.toma_id));

  for (const toma of tomasDeEstaHora) {
    if (!tomadasIds.has(toma.id)) {
      await addRegistro({
        toma_id: toma.id,
        medicamento_id: toma.medicamento_id,
        fecha: state.fechaActual,
        hora_real: new Date().toTimeString().slice(0, 5),
        tomada: true,
      });
    }
  }
  reproducirSonidoAlarma();
  mostrarToast(`✓ Toma de las ${hora} completada`);
  await cargarDatos();
  renderPaginaHoy();
};

window.solicitarPermisos = async function() {
  const ok = await pedirPermisoNotificaciones();
  if (!ok) {
    mostrarToast('Sin permiso — actívalo en ajustes');
    await cargarDatos();
    renderPaginaHoy();
    return;
  }

  const suscripcion = await iniciarFCM();
  if (suscripcion) {
    mostrarToast('🔔 Alarmas activadas y registradas');
  } else {
    mostrarToast('Permiso OK, pero falta registrar el iPhone');
  }

  await cargarDatos();
  renderPaginaHoy();
};

// ===== PÁGINA HISTORIAL =====
async function renderPaginaHistorial() {
  const page = document.getElementById('page-historial');
  const dias = ultimosDias(14);
  const todosRegistros = await getAllRegistros();
  const { tomas } = state;
  const totalPorDia = tomas.filter(t => t.activa).length;

  let html = `
    <div class="app-header">
      <div class="header-left">
        <div class="greeting">Registro</div>
        <div class="title">Historial 📅</div>
        <div class="subtitle">Últimos 14 días</div>
      </div>
    </div>
    <div class="content">
  `;

  // Estadísticas globales
  const totalDias = dias.length;
  let diasPerfectos = 0;
  let totalTomadasHistorial = 0;
  let totalPosibles = 0;

  const dataDias = dias.map(fecha => {
    const regsDelDia = todosRegistros.filter(r => r.fecha === fecha && r.tomada);
    const tomadas = regsDelDia.length;
    const posibles = totalPorDia;
    totalTomadasHistorial += tomadas;
    totalPosibles += posibles;
    if (tomadas >= posibles && posibles > 0) diasPerfectos++;
    return { fecha, tomadas, posibles, pct: porcentaje(tomadas, posibles) };
  });

  const adherencia = porcentaje(totalTomadasHistorial, totalPosibles);

  html += `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px">
      <div style="background:var(--bg2);border-radius:var(--radius);padding:16px;border:1px solid var(--border);text-align:center">
        <div style="font-size:32px;font-weight:800;color:var(--primary)">${adherencia}%</div>
        <div style="font-size:12px;color:var(--text3);margin-top:4px">Adherencia total</div>
      </div>
      <div style="background:var(--bg2);border-radius:var(--radius);padding:16px;border:1px solid var(--border);text-align:center">
        <div style="font-size:32px;font-weight:800;color:var(--success)">${diasPerfectos}</div>
        <div style="font-size:12px;color:var(--text3);margin-top:4px">Días perfectos</div>
      </div>
    </div>
  `;

  // Días
  for (const { fecha, tomadas, posibles, pct } of [...dataDias].reverse()) {
    const esHoy = fecha === fechaHoy();
    const color = pct >= 100 ? 'var(--success)' : pct >= 70 ? 'var(--warning)' : 'var(--danger)';
    const fechaLabel = esHoy ? 'Hoy' : new Date(fecha + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'short' });

    html += `
      <div class="historial-dia">
        <div class="historial-dia-header">
          <div class="historial-fecha" style="${esHoy ? 'color:var(--primary)' : ''}">${fechaLabel}</div>
          <div class="historial-pct" style="color:${color}">${tomadas}/${posibles}</div>
        </div>
        <div class="historial-bar">
          <div class="historial-fill" style="width:${pct}%;background:${color}"></div>
        </div>
      </div>
    `;
  }

  html += `</div>`; // content
  page.innerHTML = html;
}

// ===== PÁGINA PASTILLAS =====
async function renderPaginaPastillas() {
  const page = document.getElementById('page-pastillas');
  const { medicamentos, tomas } = state;

  let html = `
    <div class="app-header">
      <div class="header-left">
        <div class="greeting">Gestión</div>
        <div class="title">Pastillas ⚙️</div>
        <div class="subtitle">${medicamentos.length} medicamento${medicamentos.length !== 1 ? 's' : ''} configurado${medicamentos.length !== 1 ? 's' : ''}</div>
      </div>
    </div>
    <div class="content">
  `;

  if (medicamentos.length === 0) {
    html += `
      <div class="empty-state">
        <div class="empty-icon">💊</div>
        <h3>Sin medicamentos</h3>
        <p>Pulsa el botón + para añadir el primero</p>
      </div>
    `;
  }

  for (const med of medicamentos) {
    const tomasMed = tomas.filter(t => t.medicamento_id === med.id && t.activa);
    const horariosMed = tomasMed.map(t => t.hora).sort().join(' · ');
    const color = med.color || colorCategoria(med.categoria);
    const icono = iconoCategoria(med.categoria);

    html += `
      <div class="med-card">
        <div class="med-color" style="background:${color}22">${icono}</div>
        <div class="med-info">
          <div class="med-nombre" style="color:${color}">${med.nombre}</div>
          <div class="med-dosis">${med.dosis}${med.indicaciones ? ' · ' + med.indicaciones : ''}</div>
          <span class="med-cat" style="background:${color}22;color:${color}">${med.categoria || 'Medicamento'}</span>
          ${med.notas ? `<div class="med-notas">${med.notas}</div>` : ''}
          ${horariosMed ? `<div class="med-horarios">🕐 ${horariosMed}</div>` : '<div class="med-horarios" style="color:var(--danger)">⚠️ Sin horario asignado</div>'}
        </div>
        <div class="med-actions">
          <button class="btn-icon" onclick="abrirEditarMed(${med.id})" title="Editar">✏️</button>
          <button class="btn-icon danger" onclick="confirmarBorrarMed(${med.id}, '${med.nombre.replace(/'/g, "\\'")}')" title="Eliminar">🗑️</button>
        </div>
      </div>
    `;
  }

  // Botón para restablecer si hay datos viejos de demo
  html += `
    <div class="content" style="padding-top:0">
      <button onclick="restablecerDatosReales()" style="
        width:100%; padding:12px 16px; margin-top:8px;
        background:var(--bg3); border:1.5px dashed var(--border);
        border-radius:12px; color:var(--text2); font-size:13px;
        cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px
      ">
        🔄 Restablecer medicamentos originales del trasplante
      </button>
    </div>
  `;

  html += `</div>`; // content

  // FAB
  html += `<button class="fab" onclick="abrirNuevoMed()" title="Añadir pastilla">+</button>`;

  page.innerHTML = html;
}

// Restablecer datos reales (borrar todo y volver a cargar los medicamentos del padre)
window.restablecerDatosReales = async function() {
  if (!confirm('⚠️ ¿Restablecer todos los medicamentos a la configuración original del trasplante?\n\nEsto borrará todos los cambios manuales y el historial de tomas.')) return;
  await clearAllData();
  await seedDemoData();
  await cargarDatos();
  await renderPaginaPastillas();
  guardarEnServidor();
  mostrarToast('✅ Medicamentos restablecidos a la configuración original');
};

// ===== PÁGINA ALARMAS =====
async function renderPaginaAlarmas() {
  const page = document.getElementById('page-alarmas');
  const { tomas, medicamentos } = state;

  // Agrupar por hora
  const grupos = {};
  for (const toma of tomas) {
    if (!grupos[toma.hora]) grupos[toma.hora] = [];
    const med = medicamentos.find(m => m.id === toma.medicamento_id);
    if (med) grupos[toma.hora].push({ ...toma, med });
  }

  const horasOrdenadas = Object.keys(grupos).sort();

  let html = `
    <div class="app-header">
      <div class="header-left">
        <div class="greeting">Recordatorios</div>
        <div class="title">Alarmas 🔔</div>
        <div class="subtitle">${horasOrdenadas.length} toma${horasOrdenadas.length !== 1 ? 's' : ''} programada${horasOrdenadas.length !== 1 ? 's' : ''}</div>
      </div>
    </div>
    <div class="content">
  `;

  // Estado permisos
  if (!tienePermiso()) {
    html += `
      <div class="permiso-banner" onclick="solicitarPermisos()" style="margin-bottom:16px">
        <span style="font-size:20px">🔕</span>
        <p>Toca aquí para activar las notificaciones de alarma</p>
        <span>→</span>
      </div>
    `;
  } else {
    // Detectar si está instalada como PWA (standalone) o abierta en Safari
    const esPWA = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
    html += `
      <div style="background:var(--success-dim);border:1px solid var(--success);border-radius:var(--radius-sm);padding:12px 14px;margin-bottom:12px;display:flex;align-items:center;gap:10px">
        <span style="font-size:20px">✅</span>
        <p style="font-size:13px;color:var(--success);font-weight:600">Alarmas activadas — recibirás notificaciones</p>
      </div>
      <button onclick="probarNotificacion()" style="width:100%;padding:12px;margin-bottom:${esPWA ? '12' : '8'}px;background:var(--card-bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">
        🔔 Probar notificación ahora
      </button>
      <button onclick="repararNotificaciones()" style="width:100%;padding:12px;margin-bottom:12px;background:var(--bg2);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text2);font-size:14px;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px">
        🔧 Reparar notificaciones de este iPhone
      </button>
      ${!esPWA ? `
      <div style="background:#2a1f00;border:1px solid #f59e0b55;border-radius:var(--radius-sm);padding:12px 14px;margin-bottom:16px;display:flex;align-items:flex-start;gap:10px">
        <span style="font-size:18px;flex-shrink:0">📱</span>
        <p style="font-size:12px;color:#f59e0b;line-height:1.5">
          <strong>Para que las alarmas suenen cuando el iPhone esté bloqueado:</strong><br>
          Abre esta web en Safari → toca el botón compartir (□↑) → "Añadir a pantalla de inicio"
        </p>
      </div>
      ` : ''}
    `;
  }

  html += `<div class="section-label">Horarios de toma</div>`;

  if (horasOrdenadas.length === 0) {
    html += `<div class="empty-state"><div class="empty-icon">🔔</div><h3>Sin alarmas</h3><p>Añade medicamentos con horarios para ver las alarmas</p></div>`;
  }

  for (const hora of horasOrdenadas) {
    const items = grupos[hora];
    const activas = items.filter(t => t.activa);
    const todosIds = items.map(t => t.id);
    const nombres = items.map(t => t.med.nombre).join(', ');
    const extra = items.length > 3 ? ` +${items.length - 3} más` : '';
    const nombresCortos = items.map(t => t.med.nombre).slice(0, 3).join(', ');

    html += `
      <div class="alarma-card alarma-card-editable">
        <div class="alarma-top">
          <div class="alarma-hora-wrap">
            <input type="time" class="alarma-time-input" value="${hora}"
              data-hora-original="${hora}"
              onchange="cambiarHoraSlot('${hora}', this.value, this)">
          </div>
          <div class="alarma-info">
            <div class="alarma-meds">${nombresCortos}${extra ? ` +${items.length - 3} más` : ''}</div>
            <div class="alarma-count">${items.length} pastilla${items.length !== 1 ? 's' : ''} · ${etiquetaToma(hora)}</div>
          </div>
          <div class="toggle ${activas.length > 0 ? 'on' : ''}" onclick="toggleHora('${hora}')"></div>
        </div>
        <div class="alarma-meds-list">
          ${items.map(t => `<span class="alarma-med-chip" style="background:${colorCategoria(t.med.categoria)}22;color:${colorCategoria(t.med.categoria)}">${iconoCategoria(t.med.categoria)} ${t.med.nombre}</span>`).join('')}
        </div>
      </div>
    `;
  }

  html += `</div>`;
  page.innerHTML = html;
}

window.cambiarHoraSlot = async function(horaOriginal, horaNueva, inputEl) {
  if (!horaNueva || horaNueva === horaOriginal) return;
  // Verificar que no exista ya ese slot
  const yaExiste = state.tomas.some(t => t.hora === horaNueva && t.hora !== horaOriginal);
  if (yaExiste) {
    mostrarToast('⚠️ Ya hay un horario a esa hora');
    inputEl.value = horaOriginal;
    return;
  }
  // Actualizar todas las tomas de ese slot
  const tomasSlot = state.tomas.filter(t => t.hora === horaOriginal);
  for (const toma of tomasSlot) {
    await deleteToma(toma.id);
    await addToma({ medicamento_id: toma.medicamento_id, hora: horaNueva, activa: toma.activa });
  }
  mostrarToast(`⏰ Horario cambiado a ${horaNueva}`);
  await cargarDatos();
  await renderPaginaAlarmas();
  await programarAlarmasHoy(state.tomas, state.medicamentos);
  guardarEnServidor();
};

window.toggleHora = async function(hora) {
  const tomasDeHora = state.tomas.filter(t => t.hora === hora);
  const activas = tomasDeHora.filter(t => t.activa);
  const nuevaActiva = activas.length === 0; // si ninguna activa → activar; si hay activas → desactivar
  for (const toma of tomasDeHora) {
    await updateToma({ ...toma, activa: nuevaActiva });
  }
  mostrarToast(nuevaActiva ? '🔔 Toma activada' : '🔕 Toma desactivada');
  await cargarDatos();
  await renderPaginaAlarmas();
};

window.probarNotificacion = async function() {
  if (!tienePermiso()) {
    mostrarToast('Sin permiso de notificaciones');
    return;
  }
  mostrarToast('🔔 Enviando prueba...');

  const suscripcion = await iniciarFCM();
  if (!suscripcion) {
    mostrarToast('No se pudo registrar este iPhone en el servidor');
    return;
  }

  // Intentar via FCM (llega aunque la app esté cerrada)
  const okFCM = await probarPushFCM();
  if (okFCM) {
    mostrarToast('✅ Push enviado — llegará en segundos aunque cierres la app');
    return;
  }
  // Fallback: SW local (solo funciona con app abierta)
  let enviado = false;
  if ('serviceWorker' in navigator) {
    const swReg = await navigator.serviceWorker.ready.catch(() => null);
    if (swReg && swReg.active) {
      swReg.active.postMessage({
        type: 'PROGRAMAR_ALARMA',
        hora: 'prueba',
        titulo: '💊 ¡Las alarmas funcionan!',
        cuerpo: 'Esta es una notificación de prueba de PastillasPapa',
        delayMs: 1000,
      });
      enviado = true;
    }
  }
  if (!enviado) {
    setTimeout(() => {
      mostrarNotificacion('💊 ¡Las alarmas funcionan!', 'Esta es una notificación de prueba', 'prueba');
    }, 1000);
  }
  mostrarToast('🔔 Notificación local — cierra la app para probar FCM');
};

window.repararNotificaciones = async function() {
  if (!tienePermiso()) {
    mostrarToast('Activa primero las notificaciones');
    return;
  }

  mostrarToast('Reparando registro del iPhone...');
  const suscripcion = await resetearWebPush();
  if (!suscripcion) {
    mostrarToast('No se pudo reparar el registro');
    return;
  }

  const estado = await diagnosticoWebPush();
  const detalle = estado.endpoint ? ` (${estado.endpoint})` : '';
  mostrarToast(`iPhone registrado de nuevo${detalle}`);
  setTimeout(() => probarNotificacion(), 700);
};

// ===== MODAL MEDICAMENTO =====
window.abrirNuevoMed = function() {
  state.editandoMed = null;
  state.horariosNuevoMed = [];
  abrirModalMed();
};

window.abrirEditarMed = function(id) {
  state.editandoMed = id;
  const med = state.medicamentos.find(m => m.id === id);
  const tomasMed = state.tomas.filter(t => t.medicamento_id === id && t.activa);
  state.horariosNuevoMed = tomasMed.map(t => ({ id: t.id, hora: t.hora }));
  abrirModalMed(med);
};

function abrirModalMed(med = null) {
  const overlay = document.getElementById('modal-overlay');
  const colores = ['#4fc3f7','#34d399','#f59e0b','#fb7185','#a78bfa','#fb923c','#60a5fa','#fbbf24'];
  const categorias = ['Inmunosupresor','Corticoide','Antibiótico profiláctico','Antiviral','Protector gástrico','Antihipertensivo','Suplemento','Diurético','Otro'];

  const colorActual = med?.color || '#4fc3f7';

  document.getElementById('modal-content').innerHTML = `
    <div class="modal">
      <div class="modal-title">${med ? '✏️ Editar pastilla' : '➕ Nueva pastilla'}</div>

      <div class="form-group">
        <label class="form-label">Nombre del medicamento *</label>
        <input class="form-input" id="med-nombre" placeholder="Ej: Tacrolimus" value="${med?.nombre || ''}">
      </div>

      <div class="form-group">
        <label class="form-label">Dosis *</label>
        <input class="form-input" id="med-dosis" placeholder="Ej: 1 mg, 500 mg, 2 comprimidos" value="${med?.dosis || ''}">
      </div>

      <div class="form-group">
        <label class="form-label">Categoría</label>
        <select class="form-select" id="med-categoria">
          ${categorias.map(c => `<option value="${c}" ${med?.categoria === c ? 'selected' : ''}>${c}</option>`).join('')}
        </select>
      </div>

      <div class="form-group">
        <label class="form-label">Instrucciones de toma</label>
        <input class="form-input" id="med-indicaciones" placeholder="Ej: Con agua, en ayunas, con comida..." value="${med?.indicaciones || ''}">
      </div>

      <div class="form-group">
        <label class="form-label">Notas del médico</label>
        <textarea class="form-textarea" id="med-notas" placeholder="Observaciones, efectos secundarios a vigilar...">${med?.notas || ''}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label">Color identificador</label>
        <div class="color-selector" id="color-selector">
          ${colores.map(c => `<div class="color-opt ${c === colorActual ? 'selected' : ''}" style="background:${c}" data-color="${c}" onclick="seleccionarColor('${c}')"></div>`).join('')}
        </div>
      </div>

      <div class="form-group">
        <label class="form-label">Horarios de toma</label>
        <div class="horarios-tags" id="horarios-tags">
          ${renderHorariosTags()}
        </div>
        <div class="add-horario-row">
          <input type="time" id="nueva-hora" value="08:00">
          <button class="btn-add-hora" onclick="agregarHorario()">+ Añadir hora</button>
        </div>
      </div>

      <div class="modal-btns">
        <button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
        <button class="btn-primary" onclick="guardarMed()">
          ${med ? 'Guardar cambios' : 'Añadir pastilla'}
        </button>
      </div>
    </div>
  `;

  overlay.classList.add('visible');
}

function renderHorariosTags() {
  return state.horariosNuevoMed.map((h, i) => `
    <span class="horario-tag">
      🕐 ${h.hora}
      <button onclick="quitarHorario(${i})">×</button>
    </span>
  `).join('');
}

window.seleccionarColor = function(color) {
  document.querySelectorAll('.color-opt').forEach(el => {
    el.classList.toggle('selected', el.dataset.color === color);
  });
};

window.agregarHorario = function() {
  const input = document.getElementById('nueva-hora');
  const hora = input.value;
  if (!hora) return;
  if (state.horariosNuevoMed.some(h => h.hora === hora)) {
    mostrarToast('Esa hora ya está añadida');
    return;
  }
  state.horariosNuevoMed.push({ hora });
  document.getElementById('horarios-tags').innerHTML = renderHorariosTags();
};

window.quitarHorario = function(i) {
  state.horariosNuevoMed.splice(i, 1);
  document.getElementById('horarios-tags').innerHTML = renderHorariosTags();
};

window.guardarMed = async function() {
  const nombre = document.getElementById('med-nombre').value.trim();
  const dosis = document.getElementById('med-dosis').value.trim();
  const categoria = document.getElementById('med-categoria').value;
  const indicaciones = document.getElementById('med-indicaciones').value.trim();
  const notas = document.getElementById('med-notas').value.trim();
  const colorEl = document.querySelector('.color-opt.selected');
  const color = colorEl ? colorEl.dataset.color : '#4fc3f7';

  if (!nombre) { document.getElementById('med-nombre').classList.add('shake'); mostrarToast('El nombre es obligatorio'); return; }
  if (!dosis)  { document.getElementById('med-dosis').classList.add('shake');  mostrarToast('La dosis es obligatoria');  return; }

  const medData = { nombre, dosis, categoria, indicaciones, notas, color };

  if (state.editandoMed) {
    medData.id = state.editandoMed;
    await updateMedicamento(medData);
    // Borrar tomas viejas y recrear
    const tomasViejas = state.tomas.filter(t => t.medicamento_id === state.editandoMed);
    for (const t of tomasViejas) await deleteToma(t.id);
  } else {
    const id = await addMedicamento(medData);
    medData.id = id;
    state.editandoMed = id;
  }

  // Añadir tomas nuevas
  for (const h of state.horariosNuevoMed) {
    if (!h.id) { // solo si es nueva
      await addToma({ medicamento_id: medData.id, hora: h.hora, activa: true });
    }
  }

  cerrarModal();
  await cargarDatos();
  await renderPaginaPastillas();
  guardarEnServidor();
  mostrarToast(`✓ ${nombre} guardado`);
};

window.confirmarBorrarMed = function(id, nombre) {
  const overlay = document.getElementById('modal-overlay');
  document.getElementById('modal-content').innerHTML = `
    <div class="modal">
      <div class="modal-title">🗑️ Eliminar pastilla</div>
      <p style="color:var(--text2);font-size:15px;margin-bottom:8px">¿Seguro que quieres eliminar <strong style="color:var(--text)">${nombre}</strong>?</p>
      <p style="color:var(--text3);font-size:13px;margin-bottom:20px">Se borrarán también todos sus horarios. El historial se conserva.</p>
      <div class="modal-btns">
        <button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
        <button class="btn-primary" style="background:var(--danger)" onclick="borrarMed(${id})">Eliminar</button>
      </div>
    </div>
  `;
  overlay.classList.add('visible');
};

window.borrarMed = async function(id) {
  const med = state.medicamentos.find(m => m.id === id);
  await deleteMedicamento(id);
  cerrarModal();
  await cargarDatos();
  await renderPaginaPastillas();
  guardarEnServidor();
  mostrarToast(`🗑️ ${med?.nombre} eliminado`);
};

window.cerrarModal = function() {
  document.getElementById('modal-overlay').classList.remove('visible');
};

// Cerrar modal al tocar el overlay
function setupModalOverlay() {
  const overlay = document.getElementById('modal-overlay');
  if (overlay) {
    overlay.addEventListener('click', function(e) {
      if (e.target === this) cerrarModal();
    });
  }
}

// ===== PÁGINA INFO =====
function esc(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function cargarInfo() {
  try {
    const res = await fetch('/api/push?info=1');
    if (!res.ok) return;
    const { info } = await res.json();
    if (info) state.infoData = { comidas: info.comidas || [], habitos: info.habitos || [] };
  } catch {}
}

async function guardarInfo() {
  try {
    await fetch('/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save-info', ...state.infoData }),
    });
    mostrarIndicadorSync('✅ Sincronizado');
  } catch {}
}

async function renderPaginaInfo() {
  const page = document.getElementById('page-info');

  let html = `
    <div class="app-header">
      <div class="header-left">
        <div class="greeting">Ayuda</div>
        <div class="title">Guía 📖</div>
        <div class="subtitle">Cómo usar la app</div>
      </div>
    </div>
    <div class="content">
    <div style="background:var(--bg2);border-radius:var(--radius);border:1px solid var(--border);overflow:hidden;margin-bottom:32px">
  `;
  const pasos = [
    ['💊', 'Marcar pastillas', 'En "Hoy" toca cada pastilla para marcarla como tomada. O toca el botón de abajo para marcar toda una toma de golpe.'],
    ['🔔', 'Activar alarmas', 'En "Alarmas" debe aparecer ✅ Alarmas activadas. Si no, toca el banner. Las alarmas llegan aunque el iPhone esté bloqueado.'],
    ['⚙️', 'Cambiar horarios', 'En "Alarmas" toca la hora de cada toma para cambiarla. Se guarda y sincroniza a todos los móviles automáticamente.'],
    ['➕', 'Añadir pastilla nueva', 'En "Pastillas" toca el botón + abajo a la derecha. Rellena nombre, dosis y añade las horas.'],
    ['✏️', 'Editar o borrar pastilla', 'En "Pastillas" usa los botones ✏️ (editar) y 🗑️ (borrar) que hay a la derecha de cada medicamento.'],
    ['🔄', 'Volver al horario original', 'En "Pastillas" baja al final y toca "🔄 Restablecer medicamentos originales". Vuelve al horario completo del trasplante del hospital.'],
    ['📱', 'Sincronización automática', 'Los cambios en cualquier móvil se sincronizan solos en todos los demás en menos de 2 minutos.'],
    ['🥗', 'Comidas y hábitos', 'En la pestaña "Cuidados" puedes añadir comidas prohibidas y hábitos importantes para recordar.'],
    ['🔧', 'Las alarmas no llegan', 'Ve a "Alarmas" y toca "🔧 Reparar notificaciones de este iPhone". Luego prueba con "🔔 Probar notificación ahora".'],
  ];
  pasos.forEach(([icon, titulo, desc]) => {
    html += `<div style="padding:14px 16px;border-bottom:1px solid var(--border)">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:4px">
        <span style="font-size:18px">${icon}</span>
        <span style="font-weight:700;font-size:14px;color:var(--text)">${titulo}</span>
      </div>
      <p style="font-size:13px;color:var(--text2);margin:0;padding-left:28px;line-height:1.5">${desc}</p>
    </div>`;
  });
  html += `</div></div>`;
  page.innerHTML = html;
}

async function renderPaginaCuidados() {
  const page = document.getElementById('page-cuidados');
  await cargarInfo();
  const { comidas, habitos } = state.infoData;

  let html = `
    <div class="app-header">
      <div class="header-left">
        <div class="greeting">Trasplante de pulmón</div>
        <div class="title">Cuidados 🥗</div>
        <div class="subtitle">Comidas y hábitos del paciente</div>
      </div>
    </div>
    <div class="content">
  `;

  // ---- COMIDAS PROHIBIDAS ----
  html += `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div class="section-label" style="margin:0">🚫 Comidas prohibidas</div>
    <button onclick="anadirItem('comidas')" style="background:var(--primary);color:#000;border:none;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:700;cursor:pointer">+ Añadir</button>
  </div>
  <div style="background:var(--bg2);border-radius:var(--radius);border:1px solid var(--border);overflow:hidden;margin-bottom:16px">`;
  if (comidas.length === 0) {
    html += `<div style="padding:16px;text-align:center;color:var(--text3);font-size:13px">Sin comidas registradas — toca + para añadir</div>`;
  } else {
    comidas.forEach((item, i) => {
      html += `<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
        <span style="font-size:16px">🚫</span>
        <span style="flex:1;font-size:14px;color:var(--text)">${esc(item)}</span>
        <button onclick="editarItem('comidas',${i})" style="background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:0 4px">✏️</button>
        <button onclick="borrarItem('comidas',${i})" style="background:none;border:none;color:var(--danger);font-size:18px;cursor:pointer;padding:0 4px">×</button>
      </div>`;
    });
  }
  html += `</div>`;

  // ---- HÁBITOS ----
  html += `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
    <div class="section-label" style="margin:0">✅ Hábitos y cuidados</div>
    <button onclick="anadirItem('habitos')" style="background:var(--primary);color:#000;border:none;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:700;cursor:pointer">+ Añadir</button>
  </div>
  <div style="background:var(--bg2);border-radius:var(--radius);border:1px solid var(--border);overflow:hidden;margin-bottom:32px">`;
  if (habitos.length === 0) {
    html += `<div style="padding:16px;text-align:center;color:var(--text3);font-size:13px">Sin hábitos registrados — toca + para añadir</div>`;
  } else {
    habitos.forEach((item, i) => {
      html += `<div style="padding:12px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px">
        <span style="font-size:16px">✅</span>
        <span style="flex:1;font-size:14px;color:var(--text)">${esc(item)}</span>
        <button onclick="editarItem('habitos',${i})" style="background:none;border:none;color:var(--text3);font-size:16px;cursor:pointer;padding:0 4px">✏️</button>
        <button onclick="borrarItem('habitos',${i})" style="background:none;border:none;color:var(--danger);font-size:18px;cursor:pointer;padding:0 4px">×</button>
      </div>`;
    });
  }
  html += `</div></div>`;

  page.innerHTML = html;
}

window.anadirItem = function(tipo) {
  const overlay = document.getElementById('modal-overlay');
  document.getElementById('modal-content').innerHTML = `
    <div class="modal">
      <div class="modal-title">${tipo === 'comidas' ? '🚫 Nueva comida prohibida' : '✅ Nuevo hábito'}</div>
      <div class="form-group">
        <label class="form-label">${tipo === 'comidas' ? 'Describe la comida prohibida' : 'Describe el hábito o cuidado'}</label>
        <input class="form-input" id="item-texto" placeholder="${tipo === 'comidas' ? 'Ej: Pomelo — interacciona con Prograf' : 'Ej: Evitar sol directo en cicatrices'}">
      </div>
      <div class="modal-btns">
        <button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
        <button class="btn-primary" onclick="confirmarAnadirItem('${tipo}')">Añadir</button>
      </div>
    </div>
  `;
  overlay.classList.add('visible');
  setTimeout(() => document.getElementById('item-texto')?.focus(), 100);
};

window.confirmarAnadirItem = async function(tipo) {
  const el = document.getElementById('item-texto');
  const texto = el?.value.trim();
  if (!texto) { mostrarToast('Escribe algo primero'); return; }
  state.infoData[tipo].push(texto);
  cerrarModal();
  await guardarInfo();
  await renderPaginaInfo();
  mostrarToast('✓ Añadido');
};

window.editarItem = function(tipo, indice) {
  const textoActual = state.infoData[tipo][indice];
  const overlay = document.getElementById('modal-overlay');
  document.getElementById('modal-content').innerHTML = `
    <div class="modal">
      <div class="modal-title">${tipo === 'comidas' ? '🚫 Editar comida prohibida' : '✅ Editar hábito'}</div>
      <div class="form-group">
        <label class="form-label">${tipo === 'comidas' ? 'Describe la comida prohibida' : 'Describe el hábito o cuidado'}</label>
        <input class="form-input" id="item-texto" value="${esc(textoActual)}">
      </div>
      <div class="modal-btns">
        <button class="btn-secondary" onclick="cerrarModal()">Cancelar</button>
        <button class="btn-primary" onclick="confirmarEditarItem('${tipo}',${indice})">Guardar</button>
      </div>
    </div>
  `;
  overlay.classList.add('visible');
  setTimeout(() => {
    const input = document.getElementById('item-texto');
    if (input) { input.focus(); input.select(); }
  }, 100);
};

window.confirmarEditarItem = async function(tipo, indice) {
  const el = document.getElementById('item-texto');
  const texto = el?.value.trim();
  if (!texto) { mostrarToast('Escribe algo primero'); return; }
  state.infoData[tipo][indice] = texto;
  cerrarModal();
  await guardarInfo();
  await renderPaginaCuidados();
  mostrarToast('✓ Guardado');
};

window.borrarItem = async function(tipo, indice) {
  state.infoData[tipo].splice(indice, 1);
  await guardarInfo();
  await renderPaginaCuidados();
  mostrarToast('🗑️ Eliminado');
};

// ===== TOAST =====
let toastTimer = null;
function mostrarToast(msg) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = msg;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2500);
}

// ===== ARRANCAR =====
// Los módulos ES6 se cargan diferido — el DOM ya está listo cuando llega aquí
async function arrancar() {
  try {
    setupModalOverlay();
    await init();
  } catch (err) {
    console.error('Error al arrancar:', err);
    const page = document.getElementById('page-hoy');
    if (page) {
      page.innerHTML = `
        <div style="padding:40px 20px;text-align:center;color:#f87171">
          <div style="font-size:48px;margin-bottom:16px">⚠️</div>
          <h3 style="font-size:18px;margin-bottom:8px">Error al cargar</h3>
          <p style="font-size:13px;color:#8b949e;margin-bottom:16px">${err.message}</p>
          <button onclick="location.reload()" style="background:#4fc3f7;color:#000;border:none;padding:10px 20px;border-radius:8px;font-weight:700;cursor:pointer">Reintentar</button>
        </div>
      `;
    }
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', arrancar);
} else {
  arrancar();
}
