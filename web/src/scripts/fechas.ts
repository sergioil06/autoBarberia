// Fechas siempre en la hora de Gijón, esté donde esté el visitante.
export const ZONA = 'Europe/Madrid';

/** 'YYYY-MM-DD' de hoy (o dentro de n días) en Gijón. */
export function diaGijon(masDias = 0) {
  const d = new Date(Date.now() + masDias * 864e5);
  return new Intl.DateTimeFormat('en-CA', { timeZone: ZONA }).format(d);
}

const fmtHora = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, hour: '2-digit', minute: '2-digit' });
const fmtLargo = new Intl.DateTimeFormat('es-ES', { timeZone: ZONA, weekday: 'long', day: 'numeric', month: 'long' });

export const hora = (iso: string) => fmtHora.format(new Date(iso));
export const fechaLarga = (iso: string) => fmtLargo.format(new Date(iso));

/** Etiqueta corta de un día 'YYYY-MM-DD': «Hoy», «Mañana», «jue». */
export function etiquetaDia(dia: string) {
  if (dia === diaGijon(0)) return 'Hoy';
  if (dia === diaGijon(1)) return 'Mañana';
  return new Intl.DateTimeFormat('es-ES', { weekday: 'short', timeZone: 'UTC' })
    .format(new Date(`${dia}T12:00:00Z`)).replace('.', '');
}
export const numeroDia = (dia: string) => String(Number(dia.slice(8, 10)));

export const escapar = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
