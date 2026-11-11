// Llamadas a las funciones públicas de Supabase (sin librería: solo fetch).
// La web pública nunca toca tablas; solo llama a estas funciones.

export type Config = { url: string; key: string } | null;

export class ErrorReserva extends Error {
  constructor(public codigo: string, mensaje: string) {
    super(mensaje);
  }
}

const MENSAJES: Record<string, string> = {
  HUECO_OCUPADO: 'Esa hora se acaba de ocupar. Elige otra, por favor.',
  SIN_CONSENTIMIENTO: 'Marca la casilla para que podamos guardar tu cita.',
  NOMBRE_NO_VALIDO: 'Escribe tu nombre (mínimo 2 letras).',
  TELEFONO_NO_VALIDO: 'Revisa el teléfono: por ejemplo 612 345 678.',
  DEMASIADAS_CITAS: 'Ya tienes varias citas pendientes con este teléfono. Si necesitas otra, llámanos.',
  CITA_NO_ENCONTRADA: 'No encontramos esta cita. Revisa el enlace que te enviamos.',
  CITA_NO_ACTIVA: 'Esta cita ya no está activa.',
  FUERA_DE_PLAZO: 'Ya no se puede cambiar online porque falta poco para la cita. Llámanos y lo vemos.',
  RED: 'No hemos podido conectar. Revisa tu conexión e inténtalo de nuevo.',
};

export const mensajeDe = (e: unknown) =>
  e instanceof ErrorReserva ? e.message : MENSAJES.RED;

export async function rpc<T>(cfg: NonNullable<Config>, fn: string, args: Record<string, unknown> = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, {
      method: 'POST',
      headers: {
        apikey: cfg.key,
        Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
  } catch {
    throw new ErrorReserva('RED', MENSAJES.RED);
  }
  if (!r.ok) {
    const cuerpo = await r.json().catch(() => ({}));
    const codigo = Object.keys(MENSAJES).find((c) => String(cuerpo?.message ?? '').includes(c)) ?? 'RED';
    throw new ErrorReserva(codigo, MENSAJES[codigo]);
  }
  return r.json() as Promise<T>;
}
