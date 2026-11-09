type Franja = { desde: string; hasta: string };
type Datos = {
  servicios: { id: string; nombre: string; minutos: number | null; precio: number | null }[];
  equipo: { id: string; nombre: string }[];
  franjas: Franja[];
  diasAbierto: number[] | null;
};

const ZONA = 'Europe/Madrid';
const aMin = (h: string) => {
  const [a, b] = h.split(':').map(Number);
  return a * 60 + b;
};
const aHora = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

/** Fecha y minuto actuales en Gijón, independientemente de la zona del visitante. */
function ahoraEnGijon() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date());
  const get = (t: string) => p.find((x) => x.type === t)?.value ?? '';
  const dias = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return { dia: dias.indexOf(get('weekday')), min: Number(get('hour')) * 60 + Number(get('minute')) };
}

/* ───────── Abierto ahora ───────── */
function estado(datos: Datos) {
  const { dia, min } = ahoraEnGijon();
  const abreHoy = datos.diasAbierto == null || datos.diasAbierto.includes(dia);
  const franjas = datos.franjas.map((f) => ({ a: aMin(f.desde), b: aMin(f.hasta) }));
  const actual = abreHoy ? franjas.find((f) => min >= f.a && min < f.b) : undefined;
  const siguiente = abreHoy ? franjas.find((f) => min < f.a) : undefined;

  let html: string;
  if (actual) html = `<strong>Abierto ahora</strong> · cierra a las ${aHora(actual.b)}`;
  else if (siguiente) html = `<strong>Cerrado</strong> · abre a las ${aHora(siguiente.a)}`;
  else html = `<strong>Cerrado</strong> por hoy`;

  document.querySelectorAll<HTMLElement>('[data-estado]').forEach((el) => {
    el.toggleAttribute('data-abierto', Boolean(actual));
    const t = el.querySelector('[data-estado-texto]');
    if (t) t.innerHTML = html;
  });
  document.querySelector(`.horario [data-dia="${dia}"]`)?.setAttribute('data-hoy', '');
}

/* ───────── Navegación y menú ───────── */
function navegacion() {
  const nav = document.querySelector<HTMLElement>('[data-nav]');
  const marca = () => nav?.toggleAttribute('data-scrolled', window.scrollY > 8);
  marca();
  window.addEventListener('scroll', marca, { passive: true });

  const menu = document.querySelector<HTMLElement>('[data-menu]');
  const abrir = document.querySelector<HTMLButtonElement>('[data-menu-abrir]');
  const cerrar = document.querySelector<HTMLButtonElement>('[data-menu-cerrar]');
  if (!menu || !abrir || !cerrar) return;

  const set = (open: boolean) => {
    menu.toggleAttribute('data-open', open);
    abrir.setAttribute('aria-expanded', String(open));
    document.body.style.overflow = open ? 'hidden' : '';
    (open ? cerrar : abrir).focus();
  };
  abrir.addEventListener('click', () => set(true));
  cerrar.addEventListener('click', () => set(false));
  menu.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => set(false)));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && menu.hasAttribute('data-open')) set(false);
  });

  // Marca la sección visible en la navegación de escritorio.
  const enlaces = [...document.querySelectorAll<HTMLAnchorElement>('.nav__links a:not(.btn)')];
  const io = new IntersectionObserver(
    (entradas) => {
      entradas.forEach((en) => {
        if (!en.isIntersecting) return;
        enlaces.forEach((a) => a.setAttribute('aria-current', String(a.hash === `#${en.target.id}`)));
      });
    },
    { rootMargin: '-45% 0px -50% 0px' },
  );
  enlaces.forEach((a) => {
    const s = document.querySelector(a.hash);
    if (s) io.observe(s);
  });
}

/* ───────── Barra fija en móvil ───────── */
function barra() {
  const barra = document.querySelector<HTMLElement>('[data-barra]');
  const cta = document.querySelector('[data-cta-hero]');
  const reserva = document.querySelector('#reserva');
  if (!barra || !cta || !reserva) return;
  let ctaVisible = true;
  let reservaVisible = false;
  const pinta = () => barra.toggleAttribute('data-visible', !ctaVisible && !reservaVisible);
  new IntersectionObserver(([e]) => { ctaVisible = e.isIntersecting; pinta(); }).observe(cta);
  new IntersectionObserver(([e]) => { reservaVisible = e.isIntersecting; pinta(); }, { threshold: 0.15 }).observe(reserva);
}

/* ───────── Reserva ───────── */
function reserva() {
  const raiz = document.querySelector<HTMLElement>('[data-reserva]');
  if (!raiz) return;
  const datos: Datos = JSON.parse(raiz.dataset.reserva!);
  const sel: { servicio?: string; barbero?: string; dia?: string; hora?: string } = {};
  let paso = 1;

  const pasos = [...raiz.querySelectorAll<HTMLElement>('[data-paso]')];
  const inds = [...raiz.querySelectorAll<HTMLElement>('[data-paso-ind]')];

  const ir = (n: number, enfocar = true) => {
    paso = n;
    pasos.forEach((p) => (p.hidden = Number(p.dataset.paso) !== n));
    inds.forEach((li) => {
      const i = Number(li.dataset.pasoInd);
      li.dataset.estado = i < n ? 'hecho' : i === n ? 'actual' : '';
      if (i === n) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    if (n === 3) pintaDias();
    if (n === 4) pintaResumen();
    if (enfocar) pasos[n - 1].querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
  };
  pasos.forEach((p) => p.querySelector('h3')?.setAttribute('tabindex', '-1'));

  const marca = (grupo: Element, valor: string) =>
    grupo.querySelectorAll<HTMLElement>('.opcion').forEach((b) =>
      b.setAttribute('aria-pressed', String(b.dataset.valor === valor)));

  raiz.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-opcion], [data-volver]');
    if (!t) return;
    if (t.hasAttribute('data-volver')) return ir(Math.max(1, paso - 1));
    const tipo = t.dataset.opcion as 'servicio' | 'barbero' | 'dia' | 'hora';
    const valor = t.dataset.valor!;
    sel[tipo] = valor;
    marca(t.parentElement!, valor);
    // Pequeña pausa para que se vea la elección antes de avanzar.
    if (tipo === 'servicio') setTimeout(() => ir(2), 160);
    if (tipo === 'barbero') setTimeout(() => ir(3), 160);
    if (tipo === 'dia') { sel.hora = undefined; pintaHoras(); }
    if (tipo === 'hora') setTimeout(() => ir(4), 160);
  });

  // Desde la lista de servicios: elegir y saltar a la reserva.
  document.querySelectorAll<HTMLElement>('[data-elegir-servicio]').forEach((b) =>
    b.addEventListener('click', () => {
      sel.servicio = b.dataset.elegirServicio!;
      marca(pasos[0], sel.servicio);
      ir(2, false);
      document.querySelector('#reserva')?.scrollIntoView({ block: 'start' });
      setTimeout(() => pasos[1].querySelector<HTMLElement>('h3')?.focus({ preventScroll: true }), 400);
    }));

  const diasEl = raiz.querySelector<HTMLElement>('[data-dias]')!;
  const horasEl = raiz.querySelector<HTMLElement>('[data-horas]')!;

  function pintaDias() {
    const fmtDia = new Intl.DateTimeFormat('es-ES', { weekday: 'short', timeZone: ZONA });
    const fmtNum = new Intl.DateTimeFormat('es-ES', { day: 'numeric', timeZone: ZONA });
    const hoy = new Date();
    const lista: { id: string; dia: string; num: string }[] = [];
    for (let i = 0; lista.length < 7 && i < 14; i++) {
      const d = new Date(hoy.getTime() + i * 864e5);
      const dow = new Date(d.toLocaleString('en-US', { timeZone: ZONA })).getDay();
      if (datos.diasAbierto && !datos.diasAbierto.includes(dow)) continue;
      lista.push({
        id: d.toISOString().slice(0, 10),
        dia: i === 0 ? 'Hoy' : i === 1 ? 'Mañana' : fmtDia.format(d).replace('.', ''),
        num: fmtNum.format(d),
      });
    }
    diasEl.innerHTML = lista.map((d) =>
      `<button class="opcion" type="button" aria-pressed="${sel.dia === d.id}" data-opcion="dia" data-valor="${d.id}">
        <small>${d.dia}</small><strong>${d.num}</strong></button>`).join('');
    if (!sel.dia) {
      sel.dia = lista[0]?.id;
      marca(diasEl, sel.dia ?? '');
    }
    pintaHoras();
  }

  function pintaHoras() {
    const paso = datos.servicios.find((s) => s.id === sel.servicio)?.minutos ?? 30;
    const esHoy = sel.dia === new Date().toISOString().slice(0, 10);
    const ahora = ahoraEnGijon().min;
    const horas: string[] = [];
    datos.franjas.forEach((f) => {
      for (let m = aMin(f.desde); m + paso <= aMin(f.hasta); m += 30) {
        if (!esHoy || m > ahora + 15) horas.push(aHora(m));
      }
    });
    horasEl.innerHTML = horas.length
      ? horas.map((h) => `<button class="opcion" type="button" aria-pressed="${sel.hora === h}" data-opcion="hora" data-valor="${h}"><span>${h}</span></button>`).join('')
      : '<p class="muted">No quedan horas hoy. Elige otro día.</p>';
  }

  function pintaResumen() {
    const s = datos.servicios.find((x) => x.id === sel.servicio);
    const b = sel.barbero === 'cualquiera' ? 'El primero libre' : datos.equipo.find((x) => x.id === sel.barbero)?.nombre;
    const fecha = sel.dia
      ? new Intl.DateTimeFormat('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date(`${sel.dia}T12:00:00`))
      : '';
    const filas: [string, string][] = [
      ['Servicio', s?.nombre ?? ''],
      ['Barbero', b ?? ''],
      ['Cuándo', `${fecha}, ${sel.hora ?? ''}`],
      ['Precio', s?.precio != null ? `${s.precio} €` : '[PENDIENTE]'],
    ];
    raiz!.querySelector('[data-resumen]')!.innerHTML = filas
      .map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');
  }

  ir(1, false);
}

export function iniciar() {
  const raiz = document.querySelector<HTMLElement>('[data-reserva]');
  const datos: Datos | null = raiz ? JSON.parse(raiz.dataset.reserva!) : null;
  if (datos) {
    estado(datos);
    setInterval(() => estado(datos), 60_000);
  }
  navegacion();
  barra();
  reserva();
}
