import { reserva } from './reserva';

type Franja = { desde: string; hasta: string };
type Datos = {
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
  // Sin días confirmados no se afirma «abierto ahora»: se muestra solo el horario.
  if (datos.diasAbierto == null) return;
  const abreHoy = datos.diasAbierto.includes(dia);
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
  document.querySelectorAll<HTMLElement>('.horario [data-dias]').forEach((fila) => {
    if (fila.dataset.dias!.split(',').map(Number).includes(dia)) fila.setAttribute('data-hoy', '');
  });
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
  // Arriba del todo (hero) no se marca ninguna sección.
  const hero = document.querySelector('#inicio');
  if (hero) io.observe(hero);
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
