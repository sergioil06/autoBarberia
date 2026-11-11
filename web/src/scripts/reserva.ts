// Reserva en 4 pasos: servicio → barbero → día y hora → tus datos.
// Con Supabase configurado usa huecos reales y guarda la cita.
// Sin configurar, funciona como demostración (horas según el horario, sin guardar).
import { rpc, mensajeDe, ErrorReserva, type Config } from './supabase';
import { diaGijon, etiquetaDia, numeroDia, hora, fechaLarga, escapar } from './fechas';

type Servicio = { id: string; nombre: string; descripcion?: string | null; minutos: number | null; precio: number | null };
type Barbero = { id: string; nombre: string };
type Datos = {
  servicios: Servicio[];
  equipo: Barbero[];
  franjas: { desde: string; hasta: string }[];
  diasAbierto: number[] | null;
  supabase: Config;
};
type Seleccion = { servicio?: string; barbero?: string; dia?: string; inicio?: string };

const CUALQUIERA = 'cualquiera';
const flecha = '<svg class="fila__flecha" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
const euros = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2).replace('.', ',')} €`;

export function reserva() {
  const raiz = document.querySelector<HTMLElement>('[data-reserva]');
  if (!raiz) return;
  const datos: Datos = JSON.parse(raiz.dataset.reserva!);
  const cfg = datos.supabase;
  const sel: Seleccion = {};
  let paso = 1;
  let peticion = 0; // descarta respuestas viejas si el usuario cambia rápido de día

  const $ = <T extends HTMLElement>(s: string) => raiz.querySelector<T>(s)!;
  const pasos = [...raiz.querySelectorAll<HTMLElement>('[data-paso]')];
  const inds = [...raiz.querySelectorAll<HTMLElement>('[data-paso-ind]')];
  const diasEl = $('[data-dias]');
  const horasEl = $('[data-horas]');
  const form = $<HTMLFormElement>('[data-form]');
  const errorEl = $('[data-error]');
  const enviar = $<HTMLButtonElement>('[data-enviar]');

  raiz.toggleAttribute('data-demo', !cfg);

  const ir = (n: number, enfocar = true) => {
    paso = n;
    pasos.forEach((p) => (p.hidden = Number(p.dataset.paso) !== n));
    inds.forEach((li) => {
      const i = Number(li.dataset.pasoInd);
      li.dataset.estado = n === 5 || i < n ? 'hecho' : i === n ? 'actual' : '';
      if (i === n) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    if (n === 3) pintaDias();
    if (n === 4) pintaResumen();
    if (enfocar) pasos.find((p) => Number(p.dataset.paso) === n)?.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
  };
  pasos.forEach((p) => p.querySelector('h3')?.setAttribute('tabindex', '-1'));

  const marca = (grupo: Element, valor: string) =>
    grupo.querySelectorAll<HTMLElement>('[data-opcion]').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.valor === valor)));

  raiz.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-opcion], [data-volver], [data-otra]');
    if (!t) return;
    if (t.hasAttribute('data-otra')) {
      Object.keys(sel).forEach((k) => delete sel[k as keyof Seleccion]);
      form.reset();
      raiz.querySelectorAll('[aria-pressed="true"]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
      return ir(1);
    }
    if (t.hasAttribute('data-volver')) return ir(Math.max(1, paso - 1));
    if (t.hasAttribute('disabled')) return;
    const tipo = t.dataset.opcion as 'servicio' | 'barbero' | 'dia' | 'hora';
    const valor = t.dataset.valor!;
    marca(t.closest('[role="group"]') ?? t.parentElement!, valor);
    if (tipo === 'servicio') { sel.servicio = valor; sel.dia = sel.inicio = undefined; setTimeout(() => ir(2), 160); }
    if (tipo === 'barbero') { sel.barbero = valor; sel.dia = sel.inicio = undefined; setTimeout(() => ir(3), 160); }
    if (tipo === 'dia') { sel.dia = valor; sel.inicio = undefined; pintaHoras(); }
    if (tipo === 'hora') { sel.inicio = valor; setTimeout(() => ir(4), 160); }
  });

  /* ── Catálogo real (servicios y barberos de la base de datos) ── */
  async function cargaCatalogo() {
    if (!cfg) return;
    try {
      const c = await rpc<{ servicios: Servicio[]; barberos: Barbero[] }>(cfg, 'catalogo');
      if (c.servicios?.length) {
        datos.servicios = c.servicios;
        $('[data-lista-servicios]').innerHTML = c.servicios.map((s) => `
          <li>
            <button class="fila" type="button" aria-pressed="false" data-opcion="servicio" data-valor="${escapar(s.id)}">
              <span class="fila__texto">
                <span class="fila__nombre">${escapar(s.nombre)}</span>
                ${s.descripcion ? `<span class="fila__desc">${escapar(s.descripcion)}</span>` : ''}
              </span>
              <span class="fila__datos">
                ${s.minutos ? `<span class="fila__dur">${s.minutos} min</span>` : ''}
                ${s.precio != null ? `<span class="fila__precio">${euros(s.precio)}</span>` : ''}
              </span>
              ${flecha}
            </button>
          </li>`).join('');
      }
      if (c.barberos?.length) {
        datos.equipo = c.barberos;
        $('[data-lista-barberos]').innerHTML = `
          <button class="opcion" type="button" aria-pressed="false" data-opcion="barbero" data-valor="${CUALQUIERA}">
            <span>Me da igual</span><small>El primero libre</small>
          </button>
          ${c.barberos.map((b) => `<button class="opcion" type="button" aria-pressed="false" data-opcion="barbero" data-valor="${escapar(b.id)}"><span>${escapar(b.nombre)}</span></button>`).join('')}`;
      }
    } catch {
      // Si falla, se quedan los datos de la página; los huecos darán el error al pedirlos.
    }
  }

  const barberoArg = () => (sel.barbero && sel.barbero !== CUALQUIERA ? sel.barbero : null);

  /* ── Paso 3: días ── */
  async function pintaDias() {
    const n = ++peticion;
    diasEl.innerHTML = '<p class="muted cargando">Buscando huecos…</p>';
    horasEl.innerHTML = '';
    let lista: { dia: string; huecos: number }[];
    if (cfg) {
      try {
        lista = await rpc(cfg, 'dias_con_huecos', {
          p_servicio: sel.servicio, p_desde: diaGijon(0), p_dias: 14, p_barbero: barberoArg(),
        });
      } catch (e) {
        if (n === peticion) diasEl.innerHTML = `<p class="error-reserva" role="alert">${mensajeDe(e)}</p>`;
        return;
      }
    } else {
      lista = Array.from({ length: 14 }, (_, i) => diaGijon(i)).map((dia) => ({
        dia, huecos: demoHoras(dia).length,
      }));
    }
    if (n !== peticion) return;
    // Quitamos los días cerrados del todo (sin huecos y no laborables) para no llenar de botones grises.
    const visibles = lista.filter((d) => d.huecos > 0 || esLaborable(d.dia)).slice(0, 10);
    diasEl.innerHTML = visibles.map((d) => `
      <button class="opcion" type="button" aria-pressed="false" data-opcion="dia" data-valor="${d.dia}" ${d.huecos ? '' : 'disabled aria-disabled="true"'}>
        <small>${etiquetaDia(d.dia)}</small><strong>${numeroDia(d.dia)}</strong>${d.huecos ? '' : '<small>Completo</small>'}
      </button>`).join('');
    const primero = sel.dia && visibles.some((d) => d.dia === sel.dia && d.huecos) ? sel.dia : visibles.find((d) => d.huecos)?.dia;
    if (!primero) {
      horasEl.innerHTML = '<p class="muted">No quedan huecos en las próximas dos semanas. Llámanos y te buscamos uno.</p>';
      return;
    }
    sel.dia = primero;
    marca(diasEl, primero);
    pintaHoras();
  }

  const esLaborable = (dia: string) => {
    const dow = new Date(`${dia}T12:00:00Z`).getUTCDay();
    return datos.diasAbierto ? datos.diasAbierto.includes(dow) : true;
  };

  /* ── Paso 3: horas ── */
  async function pintaHoras() {
    if (!sel.dia) return;
    const n = ++peticion;
    horasEl.innerHTML = '<p class="muted cargando">Cargando horas…</p>';
    let horas: string[];
    if (cfg) {
      try {
        const r = await rpc<{ inicio: string }[]>(cfg, 'huecos_libres', {
          p_servicio: sel.servicio, p_dia: sel.dia, p_barbero: barberoArg(),
        });
        horas = r.map((x) => x.inicio);
      } catch (e) {
        if (n === peticion) horasEl.innerHTML = `<p class="error-reserva" role="alert">${mensajeDe(e)}</p>`;
        return;
      }
    } else {
      horas = demoHoras(sel.dia);
    }
    if (n !== peticion) return;
    horasEl.innerHTML = horas.length
      ? horas.map((h) => `<button class="opcion opcion--hora" type="button" aria-pressed="${sel.inicio === h}" data-opcion="hora" data-valor="${h}"><span>${hora(h)}</span></button>`).join('')
      : '<p class="muted">Este día ya no quedan horas. Prueba otro.</p>';
  }

  /** Demostración sin base de datos: horas cada 30 min según el horario. */
  function demoHoras(dia: string) {
    if (!esLaborable(dia)) return [];
    const dur = datos.servicios.find((s) => s.id === sel.servicio)?.minutos ?? 30;
    const ahora = Date.now() + 2 * 3600e3;
    const out: string[] = [];
    for (const f of datos.franjas) {
      const [ha, ma] = f.desde.split(':').map(Number);
      const [hb, mb] = f.hasta.split(':').map(Number);
      for (let m = ha * 60 + ma; m + dur <= hb * 60 + mb; m += 30) {
        const local = `${dia}T${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
        const iso = aIsoGijon(local);
        if (new Date(iso).getTime() > ahora) out.push(iso);
      }
    }
    return out;
  }

  /* ── Paso 4: resumen y datos ── */
  function pintaResumen() {
    const s = datos.servicios.find((x) => x.id === sel.servicio);
    const b = sel.barbero === CUALQUIERA ? 'El primero libre' : datos.equipo.find((x) => x.id === sel.barbero)?.nombre;
    const filas: [string, string][] = [
      ['Servicio', s?.nombre ?? ''],
      ['Barbero', b ?? ''],
      ['Cuándo', sel.inicio ? `${fechaLarga(sel.inicio)}, ${hora(sel.inicio)}` : ''],
      ['Precio', s?.precio != null ? euros(s.precio) : '—'],
    ];
    $('[data-resumen]').innerHTML = filas.map(([k, v]) => `<div><dt>${k}</dt><dd>${escapar(v)}</dd></div>`).join('');
    errorEl.textContent = '';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    errorEl.textContent = '';
    if (!cfg) return;
    const fd = new FormData(form);
    if (String(fd.get('web') ?? '')) return; // campo trampa para bots
    const nombre = String(fd.get('nombre') ?? '').trim();
    const telefono = String(fd.get('telefono') ?? '').trim();
    if (nombre.length < 2) return mostrarError('Escribe tu nombre (mínimo 2 letras).', 'r-nombre');
    if (telefono.replace(/\D/g, '').length < 9) return mostrarError('Revisa el teléfono: por ejemplo 612 345 678.', 'r-tel');
    if (!fd.get('consentimiento')) return mostrarError('Marca la casilla para que podamos guardar tu cita.', 'r-ok');

    enviar.disabled = true;
    enviar.dataset.cargando = '';
    try {
      const r = await rpc<{ codigo: string; token: string; inicio: string; barbero: string; servicio: string }>(cfg, 'reservar', {
        p_servicio: sel.servicio, p_inicio: sel.inicio, p_nombre: nombre, p_telefono: telefono,
        p_consentimiento: true, p_barbero: barberoArg(),
      });
      exito(r);
    } catch (err) {
      if (err instanceof ErrorReserva && err.codigo === 'HUECO_OCUPADO') {
        sel.inicio = undefined;
        ir(3);
        horasEl.insertAdjacentHTML('beforebegin', `<p class="error-reserva" role="alert" data-aviso-hueco>${mensajeDe(err)}</p>`);
        setTimeout(() => raiz.querySelector('[data-aviso-hueco]')?.remove(), 6000);
      } else {
        mostrarError(mensajeDe(err));
      }
    } finally {
      enviar.disabled = false;
      delete enviar.dataset.cargando;
    }
  });

  function mostrarError(msg: string, campo?: string) {
    errorEl.textContent = msg;
    if (campo) document.getElementById(campo)?.focus();
  }

  /* ── Paso 5: cita guardada ── */
  function exito(r: { codigo: string; token: string; inicio: string; barbero: string; servicio: string }) {
    const enlace = `${location.origin}/cita/?t=${encodeURIComponent(r.token)}`;
    $('[data-exito-texto]').innerHTML =
      `<strong>${escapar(r.servicio)}</strong> con <strong>${escapar(r.barbero)}</strong>, el ${fechaLarga(r.inicio)} a las ${hora(r.inicio)}.`;
    $('[data-exito-codigo]').textContent = r.codigo;
    $<HTMLAnchorElement>('[data-exito-enlace]').href = enlace;
    ir(5);
  }

  cargaCatalogo();
  ir(1, false);
}

/** '2026-11-12T10:00:00' (hora de Gijón) → ISO UTC. */
function aIsoGijon(local: string) {
  const guess = new Date(`${local}Z`);
  const off = (d: Date) => {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', timeZoneName: 'shortOffset' })
      .formatToParts(d).find((x) => x.type === 'timeZoneName')!.value; // «GMT+1»
    const m = p.match(/GMT([+-]\d+)?/);
    return Number(m?.[1] ?? 0) * 60;
  };
  return new Date(guess.getTime() - off(guess) * 60e3).toISOString();
}
