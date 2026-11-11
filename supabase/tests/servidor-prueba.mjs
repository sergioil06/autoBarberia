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
  create function auth.uid() returns uuid language sql stable
    as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
`);
await db.exec(readFileSync(`${raiz}migrations/20261111000000_reservas.sql`, 'utf8'));
await db.exec(`
  create schema net;
  create table net.peticiones (id bigserial primary key, url text, headers jsonb, body jsonb);
  create function net.http_post(url text, headers jsonb, body jsonb) returns bigint language sql
    as $$ insert into net.peticiones (url, headers, body) values (url, headers, body) returning id $$;
  create schema vault;
  create table vault.decrypted_secrets (name text, decrypted_secret text);
`);
await db.exec(readFileSync(`${raiz}migrations/20261112000000_whatsapp.sql`, 'utf8'));
await db.exec(readFileSync(`${raiz}seed.sql`, 'utf8'));

// Usuario de prueba del panel: alex@llano.test / prueba123 → barbero Álex (admin).
const UID = '11111111-1111-1111-1111-111111111111';
await db.query('insert into auth.users (id) values ($1)', [UID]);
await db.query(`update barberos set user_id = $1 where nombre = 'Álex'`, [UID]);
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const usuario = { id: UID, aud: 'authenticated', role: 'authenticated', email: 'alex@llano.test', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
const sesion = () => {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: UID, role: 'authenticated', email: usuario.email, exp, aud: 'authenticated' })}.firma`,
    token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: 'refresco', user: usuario,
  };
};
const uidDe = (req) => {
  const t = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).sub ?? null; } catch { return null; }
};

const PERMITIDAS = new Set(['catalogo', 'huecos_libres', 'dias_con_huecos', 'reservar', 'ver_cita', 'cancelar_cita', 'mover_cita', 'huecos_para_mover',
  'panel_yo', 'panel_agenda', 'panel_crear_cita', 'panel_mover_cita', 'panel_estado_cita', 'panel_bloquear', 'panel_quitar_bloqueo']);
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info, x-supabase-api-version, accept-profile, content-profile, prefer',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  const json = (code, o) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url?.startsWith('/auth/v1/token')) {
    let c = ''; for await (const x of req) c += x;
    const { email, password } = JSON.parse(c || '{}');
    if (req.url.includes('grant_type=refresh_token') || (email === 'alex@llano.test' && password === 'prueba123')) return json(200, sesion());
    return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
  }
  if (req.url?.startsWith('/auth/v1/user')) return uidDe(req) ? json(200, usuario) : json(401, {});
  if (req.url?.startsWith('/auth/v1/logout')) { res.writeHead(204, cors); return res.end(); }
  const fn = req.url?.match(/^\/rest\/v1\/rpc\/([a-z_]+)$/)?.[1];
  if (!fn || !PERMITIDAS.has(fn)) { res.writeHead(404, cors); return res.end('{}'); }
  let cuerpo = '';
  for await (const c of req) cuerpo += c;
  const args = cuerpo ? JSON.parse(cuerpo) : {};
  const nombres = Object.keys(args);
  const sql = `select * from public.${fn}(${nombres.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
  try {
    const uid = uidDe(req);
    await db.exec(uid ? `set role authenticated; set test.uid = '${uid.replace(/[^0-9a-f-]/g, '')}'` : `set role anon; reset test.uid`);
    const r = await db.query(sql, nombres.map((n) => args[n]));
    await db.exec('reset role; reset test.uid');
    const filas = r.rows;
    // Funciones que devuelven un valor (jsonb) → ese valor; las de tabla → lista.
    const escalar = filas.length === 1 && Object.keys(filas[0]).length === 1 && Object.keys(filas[0])[0] === fn;
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(escalar ? filas[0][fn] : filas));
  } catch (e) {
    await db.exec('reset role; reset test.uid').catch(() => {});
    res.writeHead(400, { ...cors, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ message: e.message }));
  }
}).listen(puerto, () => console.log(`API de prueba en http://localhost:${puerto}`));
