// Imita la API REST de Supabase (/rest/v1/rpc/<función>) con PGlite, para
// probar la web de punta a punta sin un proyecto real.
// Uso: node servidor-prueba.mjs [puerto]
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const raiz = fileURLToPath(new URL('../', import.meta.url));
const puerto = Number(process.argv[2] ?? 54321);
// Fechas (tipo date, OID 1082) como texto, igual que la API de Supabase.
const db = await PGlite.create({ extensions: { btree_gist }, parsers: { 1082: (v) => v } });
await db.exec(`
  create role anon nologin; create role authenticated nologin;
  create schema auth; create table auth.users (id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
`);
await db.exec(readFileSync(`${raiz}migrations/20261111000000_reservas.sql`, 'utf8'));
await db.exec(readFileSync(`${raiz}seed.sql`, 'utf8'));

const PERMITIDAS = new Set(['catalogo', 'huecos_libres', 'dias_con_huecos', 'reservar', 'ver_cita', 'cancelar_cita', 'mover_cita', 'huecos_para_mover']);
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const fn = req.url?.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1];
  if (!fn || !PERMITIDAS.has(fn)) { res.writeHead(404, cors); return res.end('{}'); }
  let cuerpo = '';
  for await (const c of req) cuerpo += c;
  const args = cuerpo ? JSON.parse(cuerpo) : {};
  const nombres = Object.keys(args);
  const sql = `select * from public.${fn}(${nombres.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
  try {
    await db.exec('set role anon');
    const r = await db.query(sql, nombres.map((n) => args[n]));
    await db.exec('reset role');
    const filas = r.rows;
    // Funciones que devuelven un valor (jsonb) → ese valor; las de tabla → lista.
    const escalar = filas.length === 1 && Object.keys(filas[0]).length === 1 && Object.keys(filas[0])[0] === fn;
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(escalar ? filas[0][fn] : filas));
  } catch (e) {
    await db.exec('reset role').catch(() => {});
    res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: e.message }));
  }
}).listen(puerto, () => console.log(`API de prueba en http://localhost:${puerto}`));
