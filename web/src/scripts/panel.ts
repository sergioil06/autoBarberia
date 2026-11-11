// Panel de barberos: agenda del día, citas a mano, mover, estados y bloqueos.
// Usa el inicio de sesión de Supabase; los permisos los comprueba la base de datos.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { diaGijon, hora, escapar, aIsoGijon, partesGijon } from './fechas';

type Cfg = { url: string; key: string } | null;
type Barbero = { id: string; nombre: string };
type Servicio = { id: string; nombre: string; minutos: number; precio: number | null };
type Cita = {
  id: string; codigo: string; inicio: string; fin: string; barbero_id: string;
  servicio_id: string; servicio: string; cliente: string; telefono: string | null;
  estado: 'confirmada' | 'cancelada' | 'completada' | 'no_vino'; origen: string; notas: string | null;
};
type Bloqueo = { id: number; barbero_id: string | null; inicio: string; fin: string; motivo: string | null };

const ESTADO: Record<Cita['estado'], string> = {
  confirmada: 'Confirmada', completada: 'Hecha', no_vino: 'No vino', cancelada: 'Cancelada',
};
const ERRORES: Record<string, string> = {
  HUECO_OCUPADO: 'Ese barbero ya tiene una cita a esa hora.',
  TELEFONO_NO_VALIDO: 'Revisa el teléfono.',
  NOMBRE_NO_VALIDO: 'Escribe el nombre del cliente.',
  CITA_NO_ACTIVA: 'Esa cita ya no está activa.',
  FECHAS_NO_VALIDAS: 'La hora de fin tiene que ser posterior a la de inicio.',
  NO_AUTORIZADO: 'Tu cuenta no tiene acceso a la agenda.',
};
const textoError = (e: { message?: string } | null) =>
  Object.entries(ERRORES).find(([k]) => e?.message?.includes(k))?.[1] ?? 'Algo ha fallado. Inténtalo de nuevo.';

const sumaDias = (dia: string, n: number) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const lunesDe = (dia: string) => {
  const dow = new Date(`${dia}T12:00:00Z`).getUTCDay();
  return sumaDias(dia, dow === 0 ? -6 : 1 - dow);
};
const fmtTitulo = new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
const fmtCorto = new Intl.DateTimeFormat('es-ES', { weekday: 'short', timeZone: 'UTC' });

export function panel() {
  const raiz = document.querySelector<HTMLElement>('[data-panel-app]');
  if (!raiz) return;
  const cfg = JSON.parse(raiz.dataset.panelApp!) as Cfg;
  const $ = <T extends HTMLElement>(s: string) => raiz.querySelector<T>(s)!;
  const vista = (v: string) => raiz.querySelectorAll<HTMLElement>('[data-vista]').forEach((el) => (el.hidden = el.dataset.vista !== v));
  if (!cfg) return vista('sin-config');

  const sb: SupabaseClient = createClient(cfg.url, cfg.key, { auth: { persistSession: true, storageKey: 'llano-panel' } });
  let barberos: Barbero[] = [];
  let servicios: Servicio[] = [];
  let dia = diaGijon(0);
  let filtro = 'todos';
  let citas: Cita[] = [];
  let bloqueos: Bloqueo[] = [];
  let semana: Record<string, number> = {};
  let editando: Cita | null = null;

  /* ── Acceso ── */
  async function arranca() {
    const { data } = await sb.auth.getSession();
    if (!data.session) return vista('acceso');
    const { data: yo, error } = await sb.rpc('panel_yo');
    if (error) {
      await sb.auth.signOut();
      $('[data-login-error]').textContent = textoError(error);
      return vista('acceso');
    }
    barberos = yo.barberos ?? [];
    servicios = yo.servicios ?? [];
    $('[data-yo]').textContent = yo.yo?.nombre ?? '';
    rellenaSelects();
    vista('agenda');
    await carga();
  }

  $<HTMLFormElement>('[data-login]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    const err = $('[data-login-error]');
    err.textContent = '';
    const { error } = await sb.auth.signInWithPassword({ email: String(f.get('email')), password: String(f.get('password')) });
    if (error) { err.textContent = 'Email o contraseña incorrectos.'; return; }
    arranca();
  });

  /* ── Datos ── */
  async function carga() {
    const lunes = lunesDe(dia);
    const { data, error } = await sb.rpc('panel_agenda', { p_desde: lunes, p_hasta: sumaDias(lunes, 6) });
    if (error) { $('[data-error]').textContent = textoError(error); return; }
    $('[data-error]').textContent = '';
    const todas: Cita[] = data.citas ?? [];
    semana = {};
    for (const c of todas) {
      if (c.estado === 'cancelada') continue;
      const d = partesGijon(c.inicio).dia;
      semana[d] = (semana[d] ?? 0) + 1;
    }
    citas = todas.filter((c) => partesGijon(c.inicio).dia === dia);
    const ini = new Date(aIsoGijon(`${dia}T00:00:00`)).getTime();
    const fin = ini + 864e5;
    bloqueos = (data.bloqueos ?? []).filter((b: Bloqueo) => new Date(b.inicio).getTime() < fin && new Date(b.fin).getTime() > ini);
    pinta();
  }

  /* ── Pintar ── */
  const nombreBarbero = (id: string | null) => (id ? barberos.find((b) => b.id === id)?.nombre ?? '—' : 'Todos');

  function pinta() {
    const titulo = fmtTitulo.format(new Date(`${dia}T12:00:00Z`));
    $('[data-titulo-dia]').textContent = dia === diaGijon(0) ? `Hoy, ${titulo}` : titulo[0].toUpperCase() + titulo.slice(1);
    $('[data-ir-hoy]').hidden = dia === diaGijon(0);

    const lunes = lunesDe(dia);
    $('[data-semana]').innerHTML = Array.from({ length: 7 }, (_, i) => sumaDias(lunes, i)).map((d) => `
      <button class="pa-semana__dia" type="button" data-ir-dia="${d}" aria-pressed="${d === dia}" ${d === diaGijon(0) ? 'data-hoy' : ''}>
        <small>${fmtCorto.format(new Date(`${d}T12:00:00Z`)).replace('.', '')}</small>
        <strong>${Number(d.slice(8))}</strong>
        <span>${semana[d] ? `${semana[d]}` : '·'}</span>
      </button>`).join('');

    $('[data-filtros]').innerHTML = [{ id: 'todos', nombre: 'Todos' }, ...barberos].map((b) =>
      `<button class="pa-chip" type="button" data-filtro="${b.id}" aria-pressed="${filtro === b.id}">${escapar(b.nombre)}</button>`).join('');

    type Item = { t: number; html: string };
    const items: Item[] = [];
    for (const c of citas) {
      if (filtro !== 'todos' && c.barbero_id !== filtro) continue;
      const activa = c.estado === 'confirmada';
      const tel = c.telefono ? `<a class="link" href="tel:${c.telefono}">${c.telefono.replace(/^\+34/, '')}</a> · <a class="link" href="https://wa.me/${c.telefono.replace('+', '')}" target="_blank" rel="noopener">WhatsApp</a>` : '<span class="muted">Sin teléfono</span>';
      items.push({
        t: new Date(c.inicio).getTime(),
        html: `
        <li class="pa-cita" data-estado="${c.estado}">
          <div class="pa-cita__hora"><strong>${hora(c.inicio)}</strong><small>${hora(c.fin)}</small></div>
          <div class="pa-cita__cuerpo">
            <p class="pa-cita__nombre">${escapar(c.cliente)} <span class="pa-pill" data-estado="${c.estado}">${ESTADO[c.estado]}</span></p>
            <p class="muted small">${escapar(c.servicio)} · ${escapar(nombreBarbero(c.barbero_id))}${c.origen === 'panel' ? ' · añadida a mano' : ''}</p>
            <p class="small">${tel}</p>
            ${c.notas ? `<p class="small muted">${escapar(c.notas)}</p>` : ''}
            <div class="pa-cita__acc">
              ${activa ? `
                <button class="pa-mini" type="button" data-cita-accion="completada" data-id="${c.id}">Hecha</button>
                <button class="pa-mini" type="button" data-cita-accion="no_vino" data-id="${c.id}">No vino</button>
                <button class="pa-mini" type="button" data-cita-accion="mover" data-id="${c.id}">Mover</button>
                <button class="pa-mini pa-mini--peligro" type="button" data-cita-accion="cancelada" data-id="${c.id}">Cancelar</button>`
              : `<button class="pa-mini" type="button" data-cita-accion="confirmada" data-id="${c.id}">Volver a activar</button>`}
            </div>
          </div>
        </li>`,
      });
    }
    for (const b of bloqueos) {
      if (filtro !== 'todos' && b.barbero_id && b.barbero_id !== filtro) continue;
      items.push({
        t: new Date(b.inicio).getTime(),
        html: `
        <li class="pa-cita pa-cita--bloqueo">
          <div class="pa-cita__hora"><strong>${hora(b.inicio)}</strong><small>${hora(b.fin)}</small></div>
          <div class="pa-cita__cuerpo">
            <p class="pa-cita__nombre">Bloqueado · ${escapar(nombreBarbero(b.barbero_id))}</p>
            ${b.motivo ? `<p class="muted small">${escapar(b.motivo)}</p>` : ''}
            <div class="pa-cita__acc"><button class="pa-mini" type="button" data-quitar-bloqueo="${b.id}">Quitar bloqueo</button></div>
          </div>
        </li>`,
      });
    }
    items.sort((a, b) => a.t - b.t);
    $('[data-lista]').innerHTML = items.length
      ? items.map((i) => i.html).join('')
      : '<li class="pa-vacio muted">No hay citas este día.</li>';
  }

  /* ── Acciones ── */
  raiz.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const accion = t.closest<HTMLElement>('[data-accion]')?.dataset.accion;
    const irDia = t.closest<HTMLElement>('[data-ir-dia]')?.dataset.irDia;
    const fil = t.closest<HTMLElement>('[data-filtro]')?.dataset.filtro;
    const citaBtn = t.closest<HTMLElement>('[data-cita-accion]');
    const quitar = t.closest<HTMLElement>('[data-quitar-bloqueo]')?.dataset.quitarBloqueo;
    if (t.closest('[data-cerrar]')) return (t.closest('dialog') as HTMLDialogElement).close();

    if (accion === 'salir') { await sb.auth.signOut(); return vista('acceso'); }
    if (accion === 'dia-menos') { dia = sumaDias(dia, -1); return carga(); }
    if (accion === 'dia-mas') { dia = sumaDias(dia, 1); return carga(); }
    if (accion === 'hoy') { dia = diaGijon(0); return carga(); }
    if (accion === 'nueva') return abreCita(null);
    if (accion === 'bloquear') return abreBloqueo();
    if (irDia) { dia = irDia; return carga(); }
    if (fil) { filtro = fil; return pinta(); }
    if (quitar) {
      const { error } = await sb.rpc('panel_quitar_bloqueo', { p_id: Number(quitar) });
      if (error) $('[data-error]').textContent = textoError(error);
      return carga();
    }
    if (citaBtn) {
      const c = citas.find((x) => x.id === citaBtn.dataset.id)!;
      const que = citaBtn.dataset.citaAccion!;
      if (que === 'mover') return abreCita(c);
      const { error } = await sb.rpc('panel_estado_cita', { p_id: c.id, p_estado: que });
      if (error) $('[data-error]').textContent = textoError(error);
      return carga();
    }
  });

  /* ── Formularios ── */
  function rellenaSelects() {
    const opB = barberos.map((b) => `<option value="${b.id}">${escapar(b.nombre)}</option>`).join('');
    $<HTMLSelectElement>('#c-barbero').innerHTML = opB;
    $<HTMLSelectElement>('#b-barbero').innerHTML = `<option value="">Toda la barbería</option>${opB}`;
    $<HTMLSelectElement>('#c-servicio').innerHTML = servicios.map((s) => `<option value="${s.id}">${escapar(s.nombre)} (${s.minutos} min)</option>`).join('');
  }

  const dlgCita = $<HTMLDialogElement>('[data-dialogo="cita"]');
  const formCita = $<HTMLFormElement>('[data-form-cita]');
  function abreCita(c: Cita | null) {
    editando = c;
    formCita.reset();
    $('[data-dialogo-error]').textContent = '';
    $('[data-dialogo-titulo]').textContent = c ? `Mover cita de ${c.cliente}` : 'Nueva cita';
    formCita.querySelectorAll<HTMLElement>('[data-solo-nueva]').forEach((el) => (el.hidden = Boolean(c)));
    $<HTMLSelectElement>('#c-servicio').disabled = Boolean(c);
    const p = c ? partesGijon(c.inicio) : { dia, hora: '' };
    $<HTMLInputElement>('#c-dia').value = p.dia;
    $<HTMLInputElement>('#c-hora').value = p.hora;
    $<HTMLSelectElement>('#c-barbero').value = c?.barbero_id ?? (filtro !== 'todos' ? filtro : barberos[0]?.id ?? '');
    if (c) $<HTMLSelectElement>('#c-servicio').value = c.servicio_id;
    dlgCita.showModal();
  }

  formCita.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(formCita);
    const inicio = aIsoGijon(`${f.get('dia')}T${f.get('hora')}:00`);
    const err = $('[data-dialogo-error]');
    const { error } = editando
      ? await sb.rpc('panel_mover_cita', { p_id: editando.id, p_inicio: inicio, p_barbero: f.get('barbero') })
      : await sb.rpc('panel_crear_cita', {
          p_barbero: f.get('barbero'), p_servicio: f.get('servicio'), p_inicio: inicio,
          p_nombre: String(f.get('nombre') ?? ''), p_telefono: String(f.get('telefono') ?? '') || null,
          p_notas: String(f.get('notas') ?? '') || null,
        });
    if (error) { err.textContent = textoError(error); return; }
    dlgCita.close();
    dia = String(f.get('dia'));
    carga();
  });

  const dlgBloq = $<HTMLDialogElement>('[data-dialogo="bloqueo"]');
  const formBloq = $<HTMLFormElement>('[data-form-bloqueo]');
  function abreBloqueo() {
    formBloq.reset();
    $('[data-bloqueo-error]').textContent = '';
    $<HTMLInputElement>('#b-desde-dia').value = dia;
    $<HTMLInputElement>('#b-hasta-dia').value = dia;
    $<HTMLSelectElement>('#b-barbero').value = filtro !== 'todos' ? filtro : '';
    dlgBloq.showModal();
  }
  formBloq.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(formBloq);
    const { error } = await sb.rpc('panel_bloquear', {
      p_inicio: aIsoGijon(`${f.get('desde_dia')}T${f.get('desde_hora')}:00`),
      p_fin: aIsoGijon(`${f.get('hasta_dia')}T${f.get('hasta_hora')}:00`),
      p_barbero: f.get('barbero') || null,
      p_motivo: String(f.get('motivo') ?? '') || null,
    });
    if (error) { $('[data-bloqueo-error]').textContent = textoError(error); return; }
    dlgBloq.close();
    carga();
  });

  // Mantener la agenda al día.
  setInterval(() => { if (!document.hidden && !$('[data-vista="agenda"]').hidden) carga(); }, 60_000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && !$('[data-vista="agenda"]').hidden) carga(); });

  arranca();
}
