import { defineConfig } from 'astro/config';

// Salida estática. Cuando llegue el sistema de reservas propio,
// se añade un adapter (Node, Vercel…) y endpoints en src/pages/api.
export default defineConfig({
  site: 'https://llanopeluqueros.example', // [PENDIENTE] dominio real
  output: 'static',
});
