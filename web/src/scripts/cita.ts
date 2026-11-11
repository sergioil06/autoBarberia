// Página /cita/?t=<token>: ver, cambiar o cancelar una cita con su enlace secreto.
import { rpc, mensajeDe, type Config } from './supabase';
import { diaGijon, etiquetaDia, numeroDia, hora, fechaLarga, escapar } from './fechas';

type Cita = {
  codigo: string; estado: string; inicio: string; fin: string;
  servicio_id: string; servicio: string; precio: number | null;
  barbero_id: string; barbero: string; cliente: string;
  puede_cambiar: boolean; limite_cambio_min: number;
};

const ESTADOS: Record<string, string> = {
  confirmada: 'Confirmada',
  cancelada: 'Cancelada',
  completada: 'Completada',
  no_vino: 'No acudió',
};

export function cita() {
  const raiz = document.querySelector<HTMLElement>('[data-cita]');
  if (!raiz) return;
  const cfg = JSON.parse(raiz.dataset.cita!) as Config;
  const token = new URLSearchParams(location.search).get('t') ?? '';
  const $ = <T extends HTMLElement>(s: string) => raiz.querySelector<T>(s)!;
  const vista = (v: string) => raiz.querySelectorAll<HTMLElement>('[data-vista]').forEach((el) => (el.hidden = el.dataset.vista !== v));
  const error = $('[data-error]');
  let actual: Cita | null = null;
  let elegida: string | null = null;
  let peticion = 0;

  const falla = (msg: string) => {
    $('[data-error-texto]').textContent = msg;
    vista('error');
  };

  async function carga() {
    if (!cfg) return falla('Las reservas online todavía no están activas.');
    if (!/^[0-9a-f]{64}$/.test(token)) return falla('Este enlace no es válido. Revisa el que te enviamos por WhatsApp.');
    try {
      const c = await rpc<Cita | null>(cfg, 'ver_cita', { p_token: token });
      if (!c) return falla('No encontramos esta cita. Revisa el enlace que te enviamos.');
      pinta(c);
    } catch (e) {
      falla(mensajeDe(e));
    }
  }

  function pinta(c: Cita) {
    actual = c;
    const euros = c.precio != null ? `${Number.isInteger(c.precio) ? c.precio : c.precio.toFixed(2).replace('.', ',')} €` : '—';
    $('[data-estado-cita]').textContent = ESTADOS[c.estado] ?? c.estado;
    $('[data-estado-cita]').dataset.estado = c.estado;
    $('[data-resumen]').innerHTML = ([
      ['Servicio', c.servicio],
      ['Barbero', c.barbero],
      ['Cuándo', `${fechaLarga(c.inicio)}, ${hora(c.inicio)}`],
      ['Precio', euros],
      ['Código', c.codigo],
    ] as [string, string][]).map(([k, v]) => `<div><dt>${k}</dt><dd>${escapar(v)}</dd></div>`).join('');

    const horas = Math.round(c.limite_cambio_min / 60);
    $('[data-acciones]').hidden = !c.puede_cambiar;
    $('[data-plazo]').textContent = c.estado !== 'confirmada'
      ? ''
      : c.puede_cambiar
        ? `Puedes cambiarla o cancelarla hasta ${horas === 1 ? '1 hora' : `${horas} horas`} antes.`
        : `Falta poco para la cita y ya no se puede cambiar online. ${raiz.dataset.tel ? `Llámanos al ${raiz.dataset.telTexto}.` : ''}`;
    panel(null);
    vista('detalle');
  }

  const panel = (p: string | null) => {
    raiz.querySelectorAll<HTMLElement>('[data-panel]').forEach((el) => (el.hidden = el.dataset.panel !== p));
    $('[data-acciones]').hidden = p !== null || !actual?.puede_cambiar;
    error.textContent = '';
  };

  raiz.addEventListener('click', async (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-accion], [data-opcion]');
    if (!t || !cfg || !actual) return;
    if (t.dataset.opcion === 'dia') return eligeDia(t.dataset.valor!);
    if (t.dataset.opcion === 'hora') {
      elegida = t.dataset.valor!;
      t.parentElement!.querySelectorAll('[data-opcion]').forEach((b) => b.setAttribute('aria-pressed', String(b === t)));
      $<HTMLButtonElement>('[data-accion="confirmar-mover"]').disabled = false;
      return;
    }
    const accion = t.dataset.accion;
    if (accion === 'volver') return panel(null);
    if (accion === 'cancelar') return panel('cancelar');
    if (accion === 'cambiar') { panel('cambiar'); return pintaDias(); }

    const boton = t as HTMLButtonElement;
    boton.disabled = true;
    try {
      if (accion === 'confirmar-cancelar') pinta(await rpc<Cita>(cfg, 'cancelar_cita', { p_token: token }));
      if (accion === 'confirmar-mover' && elegida) pinta(await rpc<Cita>(cfg, 'mover_cita', { p_token: token, p_inicio: elegida, p_barbero: actual.barbero_id }));
    } catch (err) {
      error.textContent = mensajeDe(err);
      if (accion === 'confirmar-mover') pintaHoras();
    } finally {
      boton.disabled = accion === 'confirmar-mover' && !elegida;
    }
  });

  async function pintaDias() {
    const diasEl = $('[data-dias]');
    diasEl.innerHTML = '<p class="muted">Buscando huecos…</p>';
    try {
      const lista = await rpc<{ dia: string; huecos: number }[]>(cfg!, 'dias_con_huecos', {
        p_servicio: actual!.servicio_id, p_desde: diaGijon(0), p_dias: 14, p_barbero: actual!.barbero_id,
      });
      const con = lista.filter((d) => d.huecos > 0).slice(0, 10);
      diasEl.innerHTML = con.map((d) =>
        `<button class="opcion" type="button" aria-pressed="false" data-opcion="dia" data-valor="${d.dia}"><small>${etiquetaDia(d.dia)}</small><strong>${numeroDia(d.dia)}</strong></button>`).join('')
        || '<p class="muted">No quedan huecos con tu barbero en las próximas dos semanas.</p>';
      if (con[0]) eligeDia(con[0].dia);
    } catch (err) {
      diasEl.innerHTML = `<p class="error-reserva">${mensajeDe(err)}</p>`;
    }
  }

  let diaElegido = '';
  function eligeDia(dia: string) {
    diaElegido = dia;
    $('[data-dias]').querySelectorAll('[data-opcion]').forEach((b) => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.valor === dia)));
    pintaHoras();
  }

  async function pintaHoras() {
    const horasEl = $('[data-horas]');
    const n = ++peticion;
    elegida = null;
    $<HTMLButtonElement>('[data-accion="confirmar-mover"]').disabled = true;
    horasEl.innerHTML = '<p class="muted">Cargando horas…</p>';
    try {
      const r = await rpc<{ inicio: string }[]>(cfg!, 'huecos_para_mover', { p_token: token, p_dia: diaElegido, p_barbero: actual!.barbero_id });
      if (n !== peticion) return;
      const libres = r.filter((x) => new Date(x.inicio).getTime() !== new Date(actual!.inicio).getTime());
      horasEl.innerHTML = libres.length
        ? libres.map((x) => `<button class="opcion opcion--hora" type="button" aria-pressed="false" data-opcion="hora" data-valor="${x.inicio}"><span>${hora(x.inicio)}</span></button>`).join('')
        : '<p class="muted">Este día no quedan horas. Prueba otro.</p>';
    } catch (err) {
      if (n === peticion) horasEl.innerHTML = `<p class="error-reserva">${mensajeDe(err)}</p>`;
    }
  }

  carga();
}
