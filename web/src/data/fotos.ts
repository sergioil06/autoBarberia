// Fotos de Unsplash (licencia Unsplash: uso libre, también comercial).
// Son de ARCHIVO, no de Llano Peluqueros: cambiarlas por fotos propias en cuanto las haya.
// Las directrices de la API de Unsplash piden enlazar la imagen desde images.unsplash.com
// y citar al fotógrafo (lo hace el pie de la página).

export type FotoStock = {
  base: string; // URL de images.unsplash.com sin parámetros de tamaño
  alt: string;
  autor: string;
  autorUrl: string;
};

const u = (path: string) => `https://images.unsplash.com/${path}`;

export const fotos = {
  hero: {
    base: u('photo-1585581905588-9e91f63bdd47'),
    alt: 'Barbero con gorra perfilando un corte con la máquina',
    autor: 'André Reis',
    autorUrl: 'https://unsplash.com/@andrereispt',
  },
  servicios: {
    base: u('photo-1647140655214-e4a2d914971f'),
    alt: 'Barbero cortando a tijera sobre peine a un cliente con barba',
    autor: 'Nate Johnston',
    autorUrl: 'https://unsplash.com/@natejohnston',
  },
  trabajo1: {
    base: u('photo-1640301133543-41fe25ad6450'),
    alt: 'Degradado corto recién terminado, de perfil',
    autor: 'Mitchell Orr',
    autorUrl: 'https://unsplash.com/@mitchorr',
  },
  trabajo2: {
    base: u('photo-1669568921948-f0346e0ee73e'),
    alt: 'Perfilado de la línea del pelo con máquina',
    autor: 'William Argueta',
    autorUrl: 'https://unsplash.com/@willarguetamedia',
  },
  trabajo3: {
    base: u('photo-1705976062088-5433328c2dcd'),
    alt: 'Arreglo de barba con máquina en el sillón',
    autor: 'César Badilla Miranda',
    autorUrl: 'https://unsplash.com/@xbmpro',
  },
} satisfies Record<string, FotoStock>;

/** srcset de Unsplash recortado a la proporción pedida. */
export function srcset(f: FotoStock, ratio: number, anchos = [480, 800, 1200, 1600]) {
  return anchos
    .map((w) => `${f.base}?w=${w}&h=${Math.round(w / ratio)}&fit=crop&crop=faces,edges&auto=format&q=72 ${w}w`)
    .join(', ');
}
export function src(f: FotoStock, ratio: number, w = 1200) {
  return `${f.base}?w=${w}&h=${Math.round(w / ratio)}&fit=crop&crop=faces,edges&auto=format&q=72`;
}
