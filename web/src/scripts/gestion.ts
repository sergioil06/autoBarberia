// Gestión del panel (solo admin): servicios, peluqueros, horarios y ajustes de reserva.
// Los permisos los comprueba la base de datos (funciones admin_*).
import type { SupabaseClient } from '@supabase/supabase-js';
import { escapar } from './fechas';

type Servicio = {
  id: string; nombre: string; descripcion: string | null; minutos: number;
  precio: number | null; activo: boolean; citas: number;
};
type Barbero = {
  id: string; nombre: string; email: string | null; activo: boolean; es_admin: boolean;
  tiene_cuenta: boolean; soy_yo: boolean; citas: number; citas_futuras: number;
};
type Franja = { barbero_id: string; dia: number; inicio: string; fin: string };
type Ajustes = {
  paso_min: number; antelacion_min: number; dias_max: number;
  limite_cambio_min: number; max_citas_por_telefono: number;
};
type Datos = { servicios: Servicio[]; barberos: Barbero[]; horarios: Franja[]; ajustes: Ajustes };

const ERRORES: Record<string, string> = {
  NOMBRE_NO_VALIDO: 'Escribe un nombre (mínimo 2 letras).',
  DURACION_NO_VALIDA: 'La duración tiene que estar entre 5 y 480 minutos.',
  PRECIO_NO_VALIDO: 'Revisa el precio.',
  EMAIL_NO_VALIDO: 'Revisa el email.',
  EMAIL_REPETIDO: 'Ese email ya lo usa otro peluquero.',
  NO_A_TI_MISMO: 'No puedes quitarte a ti mismo el acceso ni el permiso de gestión.',
  TIENE_CITAS: 'Tiene citas pendientes. Muévelas o cancélalas antes en la agenda.',
  FRANJAS_SOLAPADAS: 'Hay franjas que se pisan en el mismo día.',
  HORARIO_NO_VALIDO: 'Revisa las horas: el fin tiene que ser después del inicio.',
  VALOR_NO_VALIDO: 'Algún valor está fuera de rango.',
  NO_ENCONTRADO: 'Ya no existe. Recarga la página.',
  NO_AUTORIZADO: 'Tu cuenta no tiene permiso de gestión.',
};
const textoError = (e: { message?: string } | null) =>
  Object.entries(ERRORES).find(([k]) => e?.message?.includes(k))?.[1] ?? 'Algo ha fallado. Inténtalo de nuevo.';

// Lunes primero; 0 = domingo como en la base de datos.
const DIAS: [number, string][] = [[1, 'Lunes'], [2, 'Martes'], [3, 'Miércoles'], [4, 'Jueves'], [5, 'Viernes'], [6, 'Sábado'], [0, 'Domingo']];
const euros = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2).replace('.', ',')} €`;
const plural = (n: number, uno: string, varios: string) => `${n} ${n === 1 ? uno : varios}`;

export function gestion(sb: SupabaseClient, raiz: HTMLElement, alCambiarCatalogo: () => void) {
  const $ = <T extends HTMLElement>(s: string) => raiz.querySelector<T>(s)!;
  let d: Datos = { servicios: [], barberos: [], horarios: [], ajustes: {} as Ajustes };
  let pestana = 'servicios';
  let barberoHorario = '';
  let editServicio: Servicio | null = null;
  let editBarbero: Barbero | null = null;

  const err = $('[data-ge-error]');
  const aviso = $('[data-ge-aviso]');
  let avisoT: number | undefined;
  const avisa = (t: string) => {
    err.textContent = '';
    aviso.textContent = t;
    clearTimeout(avisoT);
    avisoT = window.setTimeout(() => (aviso.textContent = ''), 4000);
  };
  const falla = (e: { message?: string } | null) => { aviso.textContent = ''; err.textContent = textoError(e); };

  async function carga() {
    const { data, error } = await sb.rpc('admin_datos');
    if (error) return falla(error);
    d = data as Datos;
    if (!d.barberos.some((b) => b.id === barberoHorario)) barberoHorario = d.barberos.find((b) => b.activo)?.id ?? d.barberos[0]?.id ?? '';
    pinta();
  }

  /* ── Pintar ── */
  function pinta() {
    raiz.querySelectorAll<HTMLElement>('[data-pestana-ir]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.pestanaIr === pestana)));
    raiz.querySelectorAll<HTMLElement>('[data-pestana]').forEach((s) => (s.hidden = s.dataset.pestana !== pestana));
    pintaServicios();
    pintaBarberos();
    pintaHorario();
    pintaAjustes();
  }

  const flechas = (tipo: string, i: number, n: number) => `
    <div class="ge-orden">
      <button class="pa-mini" type="button" data-subir="${tipo}" data-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="Subir">↑</button>
      <button class="pa-mini" type="button" data-bajar="${tipo}" data-i="${i}" ${i === n - 1 ? 'disabled' : ''} aria-label="Bajar">↓</button>
    </div>`;

  function pintaServicios() {
    const l = d.servicios;
    $('[data-ge-servicios]').innerHTML = l.length ? l.map((s, i) => `
      <li class="pa-cita ge-fila" ${s.activo ? '' : 'data-inactivo'}>
        ${flechas('servicios', i, l.length)}
        <div class="pa-cita__cuerpo">
          <p class="pa-cita__nombre">${escapar(s.nombre)} ${s.activo ? '' : '<span class="pa-pill">Oculto</span>'}</p>
          <p class="small">${s.minutos} min · ${s.precio != null ? euros(s.precio) : '<span class="muted">sin precio</span>'}</p>
          ${s.descripcion ? `<p class="muted small">${escapar(s.descripcion)}</p>` : ''}
          <div class="pa-cita__acc">
            <button class="pa-mini" type="button" data-editar-servicio="${escapar(s.id)}">Editar</button>
            ${s.activo
              ? `<button class="pa-mini" type="button" data-visible-servicio="${escapar(s.id)}" data-valor="0">Ocultar</button>`
              : `<button class="pa-mini" type="button" data-visible-servicio="${escapar(s.id)}" data-valor="1">Mostrar</button>`}
            <button class="pa-mini pa-mini--peligro" type="button" data-borrar-servicio="${escapar(s.id)}">Eliminar</button>
          </div>
        </div>
      </li>`).join('') : '<li class="pa-vacio muted">Aún no hay servicios.</li>';
  }

  function pintaBarberos() {
    const l = d.barberos;
    $('[data-ge-barberos]').innerHTML = l.length ? l.map((b, i) => `
      <li class="pa-cita ge-fila" ${b.activo ? '' : 'data-inactivo'}>
        ${flechas('barberos', i, l.length)}
        <div class="pa-cita__cuerpo">
          <p class="pa-cita__nombre">${escapar(b.nombre)}${b.soy_yo ? ' <span class="muted small">(tú)</span>' : ''}
            ${b.activo ? '' : '<span class="pa-pill">De baja</span>'}
            ${b.es_admin ? '<span class="pa-pill">Admin</span>' : ''}</p>
          <p class="small ${b.email ? '' : 'muted'}">${b.email ? escapar(b.email) : 'Sin email de acceso'}
            ${b.email ? (b.tiene_cuenta ? ' · <span class="muted">puede entrar</span>' : ' · <span class="muted">falta crear su usuario</span>') : ''}</p>
          <p class="muted small">${b.citas_futuras ? plural(b.citas_futuras, 'cita pendiente', 'citas pendientes') : 'Sin citas pendientes'}</p>
          <div class="pa-cita__acc">
            <button class="pa-mini" type="button" data-editar-barbero="${b.id}">Editar</button>
            <button class="pa-mini" type="button" data-horario-de="${b.id}">Horario</button>
            ${b.soy_yo ? '' : `<button class="pa-mini pa-mini--peligro" type="button" data-borrar-barbero="${b.id}">Eliminar</button>`}
          </div>
        </div>
      </li>`).join('') : '<li class="pa-vacio muted">Aún no hay peluqueros.</li>';
  }

  /* ── Horario ── */
  const filaFranja = (inicio = '09:00', fin = '13:00') => `
    <div class="ge-franja">
      <input type="time" step="300" value="${inicio}" aria-label="Desde" data-f-inicio required />
      <span class="muted">a</span>
      <input type="time" step="300" value="${fin}" aria-label="Hasta" data-f-fin required />
      <button class="pa-mini" type="button" data-quitar-franja aria-label="Quitar franja">✕</button>
    </div>`;

  function pintaDia(li: HTMLElement, franjas: { inicio: string; fin: string }[]) {
    const cont = li.querySelector<HTMLElement>('.ge-dia__franjas')!;
    cont.innerHTML = (franjas.length ? franjas.map((f) => filaFranja(f.inicio, f.fin)).join('') : '<span class="ge-cerrado">Cerrado</span>')
      + '<button class="pa-mini" type="button" data-anadir-franja>+ Franja</button>';
  }

  function pintaHorario() {
    $<HTMLSelectElement>('[data-ge-h-barbero]').innerHTML = d.barberos.map((b) =>
      `<option value="${b.id}" ${b.id === barberoHorario ? 'selected' : ''}>${escapar(b.nombre)}${b.activo ? '' : ' (de baja)'}</option>`).join('');
    const lista = $('[data-ge-dias]');
    lista.innerHTML = DIAS.map(([n, nombre]) => `
      <li class="ge-dia" data-dia="${n}">
        <span class="ge-dia__nombre">${nombre}</span>
        <div class="ge-dia__franjas"></div>
      </li>`).join('');
    lista.querySelectorAll<HTMLElement>('[data-dia]').forEach((li) =>
      pintaDia(li, d.horarios.filter((h) => h.barbero_id === barberoHorario && h.dia === Number(li.dataset.dia))));
  }

  const leeDia = (li: HTMLElement) => [...li.querySelectorAll<HTMLElement>('.ge-franja')].map((f) => ({
    inicio: f.querySelector<HTMLInputElement>('[data-f-inicio]')!.value,
    fin: f.querySelector<HTMLInputElement>('[data-f-fin]')!.value,
  }));

  /* ── Ajustes ── */
  function pintaAjustes() {
    const a = d.ajustes;
    const f = $<HTMLFormElement>('[data-ge-ajustes]');
    if (!a) return;
    (f.elements.namedItem('paso_min') as HTMLSelectElement).value = String(a.paso_min);
    (f.elements.namedItem('antelacion_h') as HTMLInputElement).value = String(a.antelacion_min / 60);
    (f.elements.namedItem('dias_max') as HTMLInputElement).value = String(a.dias_max);
    (f.elements.namedItem('limite_cambio_h') as HTMLInputElement).value = String(a.limite_cambio_min / 60);
    (f.elements.namedItem('max_citas_por_telefono') as HTMLInputElement).value = String(a.max_citas_por_telefono);
  }

  /* ── Acciones ── */
  async function guardaServicio(s: Servicio, cambios: Partial<Servicio>) {
    const n = { ...s, ...cambios };
    return sb.rpc('admin_guardar_servicio', {
      p_id: n.id, p_nombre: n.nombre, p_descripcion: n.descripcion, p_minutos: n.minutos, p_precio: n.precio, p_activo: n.activo,
    });
  }

  async function ordena(tipo: 'servicios' | 'barberos', i: number, paso: number) {
    const lista = [...d[tipo]] as { id: string }[];
    const j = i + paso;
    if (j < 0 || j >= lista.length) return;
    [lista[i], lista[j]] = [lista[j], lista[i]];
    const { error } = await sb.rpc('admin_ordenar', { p_tipo: tipo, p_ids: lista.map((x) => x.id) });
    if (error) return falla(error);
    await carga();
    alCambiarCatalogo();
  }

  raiz.querySelector('[data-gestion]')!.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    const el = (s: string) => t.closest<HTMLElement>(s);
    const ir = el('[data-pestana-ir]')?.dataset.pestanaIr;
    if (ir) { pestana = ir; err.textContent = ''; return pinta(); }

    const ge = el('[data-ge]')?.dataset.ge;
    if (ge === 'nuevo-servicio') return abreServicio(null);
    if (ge === 'nuevo-barbero') return abreBarbero(null);
    if (ge === 'copiar-lunes') {
      const lunes = leeDia($('[data-dia="1"]'));
      for (const n of [2, 3, 4, 5, 6]) pintaDia($(`[data-dia="${n}"]`), lunes);
      return avisa('Copiado. Pulsa «Guardar horario» para aplicarlo.');
    }

    const sub = el('[data-subir]'); const baj = el('[data-bajar]');
    if (sub) return ordena(sub.dataset.subir as 'servicios', Number(sub.dataset.i), -1);
    if (baj) return ordena(baj.dataset.bajar as 'servicios', Number(baj.dataset.i), 1);

    // Servicios
    const es = el('[data-editar-servicio]')?.dataset.editarServicio;
    if (es) return abreServicio(d.servicios.find((s) => s.id === es) ?? null);
    const vis = el('[data-visible-servicio]');
    if (vis) {
      const s = d.servicios.find((x) => x.id === vis.dataset.visibleServicio)!;
      const { error } = await guardaServicio(s, { activo: vis.dataset.valor === '1' });
      if (error) return falla(error);
      avisa(vis.dataset.valor === '1' ? `«${s.nombre}» vuelve a salir en la web.` : `«${s.nombre}» ya no sale en la web.`);
      await carga(); return alCambiarCatalogo();
    }
    const bs = el('[data-borrar-servicio]')?.dataset.borrarServicio;
    if (bs) {
      const s = d.servicios.find((x) => x.id === bs)!;
      const msg = s.citas
        ? `«${s.nombre}» tiene citas en el historial, así que no se borra: se ocultará de la web. ¿Seguir?`
        : `¿Eliminar «${s.nombre}» para siempre?`;
      if (!confirm(msg)) return;
      const { data, error } = await sb.rpc('admin_borrar_servicio', { p_id: bs });
      if (error) return falla(error);
      avisa(data === 'oculto' ? `«${s.nombre}» oculto.` : `«${s.nombre}» eliminado.`);
      await carga(); return alCambiarCatalogo();
    }

    // Peluqueros
    const eb = el('[data-editar-barbero]')?.dataset.editarBarbero;
    if (eb) return abreBarbero(d.barberos.find((b) => b.id === eb) ?? null);
    const hd = el('[data-horario-de]')?.dataset.horarioDe;
    if (hd) { barberoHorario = hd; pestana = 'horarios'; return pinta(); }
    const bb = el('[data-borrar-barbero]')?.dataset.borrarBarbero;
    if (bb) {
      const b = d.barberos.find((x) => x.id === bb)!;
      if (b.citas_futuras) return falla({ message: 'TIENE_CITAS' });
      const msg = b.citas
        ? `${b.nombre} tiene citas en el historial, así que no se borra: quedará de baja y sin acceso. ¿Seguir?`
        : `¿Eliminar a ${b.nombre} y su horario para siempre?`;
      if (!confirm(msg)) return;
      const { data, error } = await sb.rpc('admin_borrar_barbero', { p_id: bb });
      if (error) return falla(error);
      avisa(data === 'de_baja' ? `${b.nombre} queda de baja.` : `${b.nombre} eliminado.`);
      await carga(); return alCambiarCatalogo();
    }

    // Horario
    if (el('[data-anadir-franja]')) {
      const li = el('.ge-dia')!;
      const actuales = leeDia(li);
      const ultima = actuales.at(-1);
      const sig = ultima ? { inicio: ultima.fin, fin: ultima.fin < '20:00' ? '20:00' : ultima.fin } : { inicio: '09:00', fin: '13:00' };
      return pintaDia(li, [...actuales, sig]);
    }
    if (el('[data-quitar-franja]')) {
      const li = el('.ge-dia')!;
      el('.ge-franja')!.remove();
      return pintaDia(li, leeDia(li));
    }
  });

  $<HTMLSelectElement>('[data-ge-h-barbero]').addEventListener('change', (e) => {
    barberoHorario = (e.target as HTMLSelectElement).value;
    pintaHorario();
  });

  $<HTMLFormElement>('[data-ge-horario]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const franjas = [...raiz.querySelectorAll<HTMLElement>('[data-ge-dias] [data-dia]')]
      .flatMap((li) => leeDia(li).map((f) => ({ dia: Number(li.dataset.dia), ...f })));
    if (franjas.some((f) => !f.inicio || !f.fin || f.fin <= f.inicio)) return falla({ message: 'HORARIO_NO_VALIDO' });
    const { error } = await sb.rpc('admin_guardar_horario', { p_barbero: barberoHorario, p_franjas: franjas });
    if (error) return falla(error);
    avisa(`Horario de ${d.barberos.find((b) => b.id === barberoHorario)?.nombre ?? ''} guardado. Las citas ya reservadas no cambian.`);
    carga();
  });

  $<HTMLFormElement>('[data-ge-ajustes]').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target as HTMLFormElement);
    const num = (k: string) => Number(f.get(k));
    const { error } = await sb.rpc('admin_guardar_ajustes', {
      p_paso_min: num('paso_min'),
      p_antelacion_min: Math.round(num('antelacion_h') * 60),
      p_dias_max: num('dias_max'),
      p_limite_cambio_min: Math.round(num('limite_cambio_h') * 60),
      p_max_citas_por_telefono: num('max_citas_por_telefono'),
    });
    if (error) return falla(error);
    avisa('Ajustes guardados.');
    carga();
  });

  /* ── Diálogo de servicio ── */
  const dlgS = $<HTMLDialogElement>('[data-dialogo="servicio"]');
  const formS = $<HTMLFormElement>('[data-form-servicio]');
  function abreServicio(s: Servicio | null) {
    editServicio = s;
    formS.reset();
    $('[data-servicio-error]').textContent = '';
    $('[data-servicio-titulo]').textContent = s ? `Editar «${s.nombre}»` : 'Nuevo servicio';
    const campo = (n: string) => formS.elements.namedItem(n) as HTMLInputElement;
    campo('nombre').value = s?.nombre ?? '';
    campo('descripcion').value = s?.descripcion ?? '';
    campo('minutos').value = String(s?.minutos ?? 30);
    campo('precio').value = s?.precio != null ? String(s.precio) : '';
    campo('activo').checked = s?.activo ?? true;
    dlgS.showModal();
  }
  formS.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(formS);
    const precio = String(f.get('precio') ?? '').replace(',', '.').trim();
    const { error } = await sb.rpc('admin_guardar_servicio', {
      p_id: editServicio?.id ?? null,
      p_nombre: String(f.get('nombre') ?? ''),
      p_descripcion: String(f.get('descripcion') ?? '') || null,
      p_minutos: Number(f.get('minutos')),
      p_precio: precio === '' ? null : Number(precio),
      p_activo: f.get('activo') === 'on',
    });
    if (error) { $('[data-servicio-error]').textContent = textoError(error); return; }
    dlgS.close();
    avisa(editServicio ? 'Servicio guardado.' : 'Servicio creado.');
    await carga();
    alCambiarCatalogo();
  });

  /* ── Diálogo de peluquero ── */
  const dlgB = $<HTMLDialogElement>('[data-dialogo="barbero"]');
  const formB = $<HTMLFormElement>('[data-form-barbero]');
  function abreBarbero(b: Barbero | null) {
    editBarbero = b;
    formB.reset();
    $('[data-barbero-error]').textContent = '';
    $('[data-barbero-titulo]').textContent = b ? `Editar a ${b.nombre}` : 'Nuevo peluquero';
    const campo = (n: string) => formB.elements.namedItem(n) as HTMLInputElement;
    campo('nombre').value = b?.nombre ?? '';
    campo('email').value = b?.email ?? '';
    campo('activo').checked = b?.activo ?? true;
    campo('es_admin').checked = b?.es_admin ?? false;
    // A uno mismo no se le deja quitarse el acceso.
    campo('activo').disabled = campo('es_admin').disabled = Boolean(b?.soy_yo);
    dlgB.showModal();
  }
  formB.addEventListener('submit', async (e) => {
    e.preventDefault();
    const campo = (n: string) => formB.elements.namedItem(n) as HTMLInputElement;
    const { error } = await sb.rpc('admin_guardar_barbero', {
      p_id: editBarbero?.id ?? null,
      p_nombre: campo('nombre').value,
      p_email: campo('email').value.trim() || null,
      p_activo: campo('activo').checked,
      p_es_admin: campo('es_admin').checked,
    });
    if (error) { $('[data-barbero-error]').textContent = textoError(error); return; }
    dlgB.close();
    avisa(editBarbero ? 'Peluquero guardado.' : 'Peluquero añadido con el horario del primero del equipo.');
    await carga();
    alCambiarCatalogo();
  });

  return { abrir: () => { err.textContent = ''; aviso.textContent = ''; return carga(); } };
}
