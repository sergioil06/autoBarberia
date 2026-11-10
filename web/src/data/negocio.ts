// Datos del negocio. Todo lo que se ve en la web sale de aquí.
//
// ⚠️ PROVISIONAL: los datos marcados así son de ejemplo para que la web se vea
// terminada. Cambiadlos por los reales antes de anunciar la web.

export const PENDIENTE = null;

export type Servicio = {
  id: string;
  nombre: string;
  descripcion?: string;
  minutos: number | null;
  precio: number | null; // euros
};

export type Barbero = {
  id: string;
  nombre: string | null;
  especialidad: string | null;
  foto: string | null; // ruta en /public
};

export const negocio = {
  nombre: 'Llano Peluqueros',
  calle: 'Calle Velázquez 48',
  ciudad: 'Gijón',
  mapa: 'https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent('Llano Peluqueros, Calle Velázquez 48, Gijón'),

  // ⚠️ PROVISIONAL: teléfono de ejemplo. Formato internacional sin espacios.
  telefono: '+34985000000' as string | null,
  // Sin WhatsApp hasta tener el número real (no se enlaza un número inventado).
  whatsapp: PENDIENTE as string | null,
  // ⚠️ PROVISIONAL: usuario de Instagram (sin @).
  instagram: 'llanopeluqueros' as string | null,

  // Horario confirmado: 9–13 y 16–20.
  franjas: [
    { desde: '09:00', hasta: '13:00' },
    { desde: '16:00', hasta: '20:00' },
  ],
  // ⚠️ PROVISIONAL: de lunes a sábado (0 = domingo … 6 = sábado).
  diasAbierto: [1, 2, 3, 4, 5, 6] as number[] | null,
};

// ⚠️ PROVISIONAL: precios, duraciones y descripciones de ejemplo.
export const servicios: Servicio[] = [
  { id: 'corte', nombre: 'Corte', descripcion: 'Tijera y máquina, con lavado y peinado.', minutos: 30, precio: 14 },
  { id: 'degradado', nombre: 'Degradado', descripcion: 'Fade a máquina, tan bajo o alto como lo quieras.', minutos: 40, precio: 16 },
  { id: 'barba', nombre: 'Arreglo de barba', descripcion: 'Perfilado a navaja y acabado con aceite.', minutos: 20, precio: 9 },
  { id: 'corte-barba', nombre: 'Corte + barba', descripcion: 'El corte completo y la barba perfilada.', minutos: 50, precio: 21 },
];

// ⚠️ PROVISIONAL: nombres de ejemplo para el paso «¿Con quién?» de la reserva.
export const equipo: Barbero[] = [
  { id: 'b1', nombre: 'Álex', especialidad: null, foto: null },
  { id: 'b2', nombre: 'Dani', especialidad: null, foto: null },
];

/** '+34985000000' → '985 00 00 00' */
export function telefonoBonito(t: string) {
  const n = t.replace(/^\+34/, '').replace(/\D/g, '');
  return n.length === 9 ? `${n.slice(0, 3)} ${n.slice(3, 5)} ${n.slice(5, 7)} ${n.slice(7)}` : t;
}
