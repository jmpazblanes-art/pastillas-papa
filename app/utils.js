/**
 * PastillasPapa — Utilidades
 */

export function fechaHoy() {
  return new Date().toISOString().split('T')[0];
}

export function formatearFecha(fecha) {
  const d = new Date(fecha + 'T12:00:00');
  return d.toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function horaActual() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

export function horaEnMinutos(hora) {
  const [h, m] = hora.split(':').map(Number);
  return h * 60 + m;
}

export function ahoraEnMinutos() {
  const now = new Date();
  return now.getHours() * 60 + now.getMinutes();
}

// Estado de una toma: 'pasada' | 'activa' | 'futura'
export function estadoToma(hora) {
  const tomaMin = horaEnMinutos(hora);
  const ahoraMin = ahoraEnMinutos();
  const diff = tomaMin - ahoraMin;

  if (diff < -30) return 'pasada';
  if (diff <= 90) return 'activa'; // ventana de 90 min
  return 'futura';
}

export function nombreDiaSemana(fecha) {
  const d = new Date(fecha + 'T12:00:00');
  return d.toLocaleDateString('es-ES', { weekday: 'long' });
}

export function formatearHora12(hora) {
  const [h, m] = hora.split(':').map(Number);
  const periodo = h < 12 ? 'AM' : 'PM';
  const h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, '0')} ${periodo}`;
}

export function emojiToma(hora) {
  const h = parseInt(hora.split(':')[0]);
  if (h === 0) return '🌙';   // medianoche
  if (h < 6)  return '🌙';   // madrugada
  if (h < 12) return '🌅';   // mañana
  if (h < 18) return '☀️';   // tarde
  if (h < 22) return '🌆';   // noche
  return '🌙';
}

export function etiquetaToma(hora) {
  const h = parseInt(hora.split(':')[0]);
  if (h === 0) return 'Medianoche';
  if (h < 6)  return 'Madrugada';
  if (h < 12) return 'Mañana';
  if (h < 14) return 'Mediodía';
  if (h < 18) return 'Tarde';
  if (h < 22) return 'Noche';
  return 'Madrugada';
}

export function porcentaje(hecho, total) {
  if (total === 0) return 0;
  return Math.round((hecho / total) * 100);
}

export function colorCategoria(categoria) {
  const mapa = {
    'Inmunosupresor': '#4fc3f7',
    'Corticoide': '#f59e0b',
    'Antibiótico profiláctico': '#fb7185',
    'Antiviral': '#fb923c',
    'Protector gástrico': '#34d399',
    'Antihipertensivo': '#60a5fa',
    'Suplemento': '#fbbf24',
    'Diurético': '#a78bfa',
    'Otro': '#9ca3af',
  };
  return mapa[categoria] || '#9ca3af';
}

export function iconoCategoria(categoria) {
  const mapa = {
    'Inmunosupresor': '🛡️',
    'Corticoide': '⚡',
    'Antibiótico profiláctico': '🦠',
    'Antiviral': '🔬',
    'Protector gástrico': '🛡️',
    'Antihipertensivo': '❤️',
    'Suplemento': '⭐',
    'Diurético': '💧',
    'Otro': '💊',
  };
  return mapa[categoria] || '💊';
}

// Generar días para historial (últimos N días)
export function ultimosDias(n = 7) {
  const dias = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dias.push(d.toISOString().split('T')[0]);
  }
  return dias;
}
