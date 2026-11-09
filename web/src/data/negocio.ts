// Datos del negocio. Todo lo marcado con PENDIENTE se muestra en la web
// con un marcador visible hasta que se rellene. No inventar datos aquí.

export const PENDIENTE = null;

export type Servicio = {
  id: string;
  nombre: string;
  descripcion?: string;
  minutos: number | null; // PENDIENTE
  precio: number | null; // PENDIENTE (euros)
};

export type Barbero = {
  id: string;
  nombre: string | null; // PENDIENTE
  especialidad: string | null; // PENDIENTE
  foto: string | null; // ruta en /public, PENDIENTE
};

export const negocio = {
  nombre: 'Llano Peluqueros',
  calle: 'Calle Velázquez 48',
  ciudad: 'Gijón',
  mapa: 'https://www.google.com/maps/search/?api=1&query=' +
    encodeURIComponent('Llano Peluqueros, Calle Velázquez 48, Gijón'),

  // Teléfono en formato internacional sin espacios, p. ej. '+34600000000'.
  telefono: PENDIENTE as string | null,
  whatsapp: PENDIENTE as string | null,
  instagram: PENDIENTE as string | null, // sin @

  // Horario confirmado: 9–13 y 16–20.
  franjas: [
    { desde: '09:00', hasta: '13:00' },
    { desde: '16:00', hasta: '20:00' },
  ],
  // Días que abrís (0 = domingo … 6 = sábado). PENDIENTE: null = sin confirmar.
  diasAbierto: PENDIENTE as number[] | null,
};

// PENDIENTE: nombres orientativos; faltan precio y duración reales.
export const servicios: Servicio[] = [
  { id: 'corte', nombre: 'Corte', minutos: null, precio: null },
  { id: 'degradado', nombre: 'Degradado', minutos: null, precio: null },
  { id: 'barba', nombre: 'Arreglo de barba', minutos: null, precio: null },
  { id: 'corte-barba', nombre: 'Corte + barba', minutos: null, precio: null },
];

// PENDIENTE: nombres, especialidad y fotos del equipo.
export const equipo: Barbero[] = [
  { id: 'b1', nombre: null, especialidad: null, foto: null },
  { id: 'b2', nombre: null, especialidad: null, foto: null },
];
