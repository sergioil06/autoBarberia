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

/** '2026-11-12T10:00:00' (hora de Gijón) → ISO UTC. */
export function aIsoGijon(local: string) {
  const guess = new Date(`${local}Z`);
  const off = (d: Date) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', timeZoneName: 'shortOffset' })
      .formatToParts(d).find((x) => x.type === 'timeZoneName')!.value; // «GMT+1»
    const m = p.match(/GMT([+-]\d+)?/);
    return Number(m?.[1] ?? 0) * 60;
  };
  return new Date(guess.getTime() - off(guess) * 60e3).toISOString();
}

/** ISO → 'YYYY-MM-DD' y 'HH:MM' en Gijón (para rellenar formularios). */
export function partesGijon(iso: string) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(iso));
  const g = (t: string) => p.find((x) => x.type === t)!.value;
  return { dia: `${g('year')}-${g('month')}-${g('day')}`, hora: `${g('hour')}:${g('minute')}` };
}
