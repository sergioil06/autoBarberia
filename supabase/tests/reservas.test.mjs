// Pruebas del sistema de reservas con un Postgres en memoria (PGlite).
// Ejecutar: cd supabase/tests && npm install && npm test
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { btree_gist } from '@electric-sql/pglite/contrib/btree_gist';

const raiz = fileURLToPath(new URL('../', import.meta.url));
const migracion = readFileSync(`${raiz}migrations/20261111000000_reservas.sql`, 'utf8');
const semilla = readFileSync(`${raiz}seed.sql`, 'utf8');
const whatsapp = readFileSync(`${raiz}migrations/20261112000000_whatsapp.sql`, 'utf8');
const telefonoEs = readFileSync(`${raiz}migrations/20261112010000_telefono_es.sql`, 'utf8');
const greenapi = readFileSync(`${raiz}migrations/20261112020000_greenapi.sql`, 'utf8');

let db;
const uno = async (sql, p = []) => (await db.query(sql, p)).rows[0];
const filas = async (sql, p = []) => (await db.query(sql, p)).rows;
const falla = async (sql, p, codigo) => {
  await assert.rejects(db.query(sql, p), (e) => {
    assert.match(String(e.message), new RegExp(codigo));
    return true;
  });
};

// Próximo día laborable (lunes–sábado) al menos a 3 días vista, como 'YYYY-MM-DD'.
function diaLaborable(desplazar = 3) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + desplazar);
  while (d.getUTCDay() === 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
function domingo() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 3);
  while (d.getUTCDay() !== 0) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const madrid = async (dia, hora) => (await uno(`select ($1::date + $2::time) at time zone 'Europe/Madrid' as t`, [dia, hora])).t;

before(async () => {
  db = await PGlite.create({ extensions: { btree_gist } });
  // Lo que Supabase ya trae: esquema auth, auth.uid() y los roles.
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable
      as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
  `);
  await db.exec(migracion);
  // Simulación de pg_net y Vault (en Supabase son reales).
  await db.exec(`
    create schema net;
    create table net.peticiones (id bigserial primary key, url text, headers jsonb, body jsonb);
    create function net.http_post(url text, headers jsonb, body jsonb) returns bigint language sql
      as $$ insert into net.peticiones (url, headers, body) values (url, headers, body) returning id $$;
    create schema vault;
    create table vault.decrypted_secrets (name text, decrypted_secret text);
  `);
  await db.exec(whatsapp);
  await db.exec(telefonoEs);
  await db.exec(greenapi);
  await db.exec(semilla);
});

test('catálogo: 4 servicios y 2 barberos', async () => {
  const c = (await uno('select public.catalogo() c')).c;
  assert.equal(c.servicios.length, 4);
  assert.equal(c.barberos.length, 2);
});

test('huecos según horario y duración (corte 30 min, paso 15)', async () => {
  const dia = diaLaborable();
  const h = await filas(`select to_char(inicio at time zone 'Europe/Madrid','HH24:MI') t from public.huecos_libres('corte', $1)`, [dia]);
  const t = h.map((r) => r.t);
  assert.equal(t[0], '09:00');
  assert.ok(t.includes('12:30'), 'último hueco de mañana 12:30');
  assert.ok(!t.includes('12:45'), '12:45 + 30 min pasaría de las 13:00');
  assert.ok(!t.includes('13:00'));
  assert.ok(t.includes('16:00') && t.includes('19:30') && !t.includes('19:45'));
  assert.equal(t.length, 30); // 15 por la mañana + 15 por la tarde
});

test('domingo cerrado: sin huecos', async () => {
  const h = await filas(`select * from public.huecos_libres('corte', $1)`, [domingo()]);
  assert.equal(h.length, 0);
});

test('reservar y no permitir solapes con el mismo barbero', async () => {
  const dia = diaLaborable(4);
  const alex = (await uno(`select id from barberos where nombre = 'Álex'`)).id;
  const r = (await uno(`select public.reservar('corte', $1, 'Javier', '600 111 222', true, $2) r`, [await madrid(dia, '10:00'), alex])).r;
  assert.equal(r.barbero, 'Álex');
  assert.match(r.codigo, /^[0-9A-F]{6}$/);
  assert.equal(r.token.length, 64);

  // Mismo barbero, 10:15 (se pisa con 10:00–10:30): no aparece como hueco y no se puede reservar.
  const libres = await filas(`select to_char(inicio at time zone 'Europe/Madrid','HH24:MI') t from public.huecos_libres('corte', $1, $2)`, [dia, alex]);
  assert.ok(!libres.some((x) => ['09:45', '10:00', '10:15'].includes(x.t)));
  assert.ok(libres.some((x) => x.t === '10:30'));
  await falla(`select public.reservar('corte', $1, 'Pedro', '600 333 444', true, $2)`, [await madrid(dia, '10:15'), alex], 'HUECO_OCUPADO');

  // La restricción de la base de datos lo impide aunque se salten las funciones.
  await falla(
    `insert into citas (barbero_id, servicio_id, inicio, cliente_nombre, cliente_telefono) values ($1, 'corte', $2, 'Directo', '+34600000000')`,
    [alex, await madrid(dia, '10:15')],
    'citas_sin_solapes|exclusion|conflicting key',
  );
});

test('«me da igual» asigna el otro barbero si el primero está ocupado', async () => {
  const dia = diaLaborable(5);
  const t = await madrid(dia, '11:00');
  const a = (await uno(`select public.reservar('corte', $1, 'Uno', '611111111', true) r`, [t])).r;
  const b = (await uno(`select public.reservar('corte', $1, 'Dos', '622222222', true) r`, [t])).r;
  assert.notEqual(a.barbero, b.barbero);
  // Ya no queda nadie a esa hora.
  const quedan = await filas(`select 1 from public.huecos_libres('corte', $1) where inicio = $2`, [dia, t]);
  assert.equal(quedan.length, 0);
  await falla(`select public.reservar('corte', $1, 'Tres', '633333333', true)`, [t], 'HUECO_OCUPADO');
});

test('un servicio largo no cabe si pisa otra cita', async () => {
  const dia = diaLaborable(6);
  const dani = (await uno(`select id from barberos where nombre = 'Dani'`)).id;
  await uno(`select public.reservar('barba', $1, 'Luis', '644444444', true, $2)`, [await madrid(dia, '17:00'), dani]);
  const libres = (await filas(`select to_char(inicio at time zone 'Europe/Madrid','HH24:MI') t from public.huecos_libres('corte-barba', $1, $2)`, [dia, dani])).map((r) => r.t);
  // Corte + barba dura 50 min: 16:15 terminaría 17:05 → no; 16:00 → 16:50 sí.
  assert.ok(libres.includes('16:00'));
  assert.ok(!libres.includes('16:15'));
  assert.ok(libres.includes('17:30'));
});

test('bloqueos de toda la barbería quitan huecos', async () => {
  const dia = diaLaborable(7);
  await db.query(`insert into bloqueos (inicio, fin, motivo) values ($1, $2, 'Festivo')`, [await madrid(dia, '00:00'), await madrid(dia, '23:59')]);
  const h = await filas(`select * from public.huecos_libres('corte', $1)`, [dia]);
  assert.equal(h.length, 0);
});

test('antelación mínima: no se puede reservar dentro de las próximas 2 horas', async () => {
  const dentroDeUnaHora = (await uno(`select date_trunc('hour', now()) + interval '1 hour' t`)).t;
  await falla(`select public.reservar('corte', $1, 'Prisa', '655555555', true)`, [dentroDeUnaHora], 'HUECO_OCUPADO');
});

test('validaciones: consentimiento, teléfono, nombre y máximo de citas', async () => {
  const dia = diaLaborable(8);
  const t = await madrid(dia, '09:00');
  await falla(`select public.reservar('corte', $1, 'Ana', '600123123', false)`, [t], 'SIN_CONSENTIMIENTO');
  await falla(`select public.reservar('corte', $1, 'Ana', '123', true)`, [t], 'TELEFONO_NO_VALIDO');
  await falla(`select public.reservar('corte', $1, 'A', '600123123', true)`, [t], 'NOMBRE_NO_VALIDO');
  for (const h of ['09:00', '09:30', '10:00']) {
    await uno(`select public.reservar('corte', $1, 'Repetidor', '+34 699 000 000', true)`, [await madrid(dia, h)]);
  }
  await falla(`select public.reservar('corte', $1, 'Repetidor', '699000000', true)`, [await madrid(dia, '11:00')], 'DEMASIADAS_CITAS');
});

test('ver, mover y cancelar con el enlace secreto', async () => {
  const dia = diaLaborable(9);
  const r = (await uno(`select public.reservar('degradado', $1, 'Mario', '677777777', true) r`, [await madrid(dia, '16:00')])).r;
  const v = (await uno(`select public.ver_cita($1) v`, [r.token])).v;
  assert.equal(v.estado, 'confirmada');
  assert.equal(v.puede_cambiar, true);

  // Mover 15 min más tarde: se solapa con ella misma, pero eso está permitido.
  const m = (await uno(`select public.mover_cita($1, $2) m`, [r.token, await madrid(dia, '16:15')])).m;
  assert.equal(m.estado, 'confirmada');
  const fin = (await uno(`select to_char(fin at time zone 'Europe/Madrid','HH24:MI') f from citas where token = $1`, [r.token])).f;
  assert.equal(fin, '16:55');

  // Mover a un domingo: no hay hueco.
  await falla(`select public.mover_cita($1, $2)`, [r.token, await madrid(domingo(), '10:00')], 'HUECO_OCUPADO');

  const c = (await uno(`select public.cancelar_cita($1) c`, [r.token])).c;
  assert.equal(c.estado, 'cancelada');
  await falla(`select public.cancelar_cita($1)`, [r.token], 'CITA_NO_ACTIVA');
  // Su hueco vuelve a estar libre para el mismo barbero.
  const otra = (await uno(`select public.reservar('degradado', $1, 'Nuevo', '688888888', true) r`, [await madrid(dia, '16:15')])).r;
  assert.ok(otra.codigo);
});

test('token desconocido', async () => {
  const v = (await uno(`select public.ver_cita('nope') v`)).v;
  assert.equal(v, null);
  await falla(`select public.cancelar_cita('nope')`, [], 'CITA_NO_ENCONTRADA');
});

test('seguridad: el rol anónimo no puede leer tablas', async () => {
  await db.exec('set role anon');
  try {
    await falla('select * from citas', [], 'permission denied');
    // Pero sí puede usar las funciones públicas.
    const c = (await uno('select public.catalogo() c')).c;
    assert.equal(c.servicios.length, 4);
  } finally {
    await db.exec('reset role');
  }
});

test('panel: el personal ve citas; un usuario sin barbero no', async () => {
  const uid = '11111111-1111-1111-1111-111111111111';
  await db.query('insert into auth.users (id) values ($1)', [uid]);
  await db.exec('set role authenticated');
  try {
    await db.exec(`set test.uid = '${uid}'`);
    assert.equal((await filas('select * from citas')).length, 0, 'sin barbero asociado no ve nada');
  } finally {
    await db.exec('reset role');
  }
  await db.query(`update barberos set user_id = $1 where nombre = 'Álex'`, [uid]);
  await db.exec('set role authenticated');
  try {
    assert.ok((await filas('select * from citas')).length > 0, 'el barbero ve la agenda');
  } finally {
    await db.exec('reset role');
    await db.exec(`reset test.uid`);
  }
});

test('panel: funciones solo para el personal', async () => {
  const intruso = '22222222-2222-2222-2222-222222222222';
  await db.query('insert into auth.users (id) values ($1)', [intruso]);
  await db.exec(`set test.uid = '${intruso}'`);
  await db.exec('set role authenticated');
  try {
    await falla(`select public.panel_yo()`, [], 'NO_AUTORIZADO');
  } finally {
    await db.exec('reset role');
    await db.exec('reset test.uid');
  }
});

test('panel: crear, mover, estados y bloqueos', async () => {
  const uid = '11111111-1111-1111-1111-111111111111'; // Álex (asociado en la prueba anterior)
  await db.exec(`set test.uid = '${uid}'`);
  await db.exec('set role authenticated');
  try {
    const yo = (await uno('select public.panel_yo() r')).r;
    assert.equal(yo.yo.nombre, 'Álex');
    assert.equal(yo.barberos.length, 2);
    const alex = yo.yo.id;
    const dia = diaLaborable(10);

    // Cita a mano sin teléfono, incluso fuera de horario (13:30).
    const c = (await uno(`select public.panel_crear_cita($1, 'corte', $2, 'Cliente sin móvil') r`, [alex, await madrid(dia, '13:30')])).r;
    assert.ok(c.codigo);
    await falla(`select public.panel_crear_cita($1, 'corte', $2, 'Otro')`, [alex, await madrid(dia, '13:45')], 'HUECO_OCUPADO');
    await falla(`select public.panel_crear_cita($1, 'corte', $2, 'Otro', '12')`, [alex, await madrid(dia, '15:00')], 'TELEFONO_NO_VALIDO');

    const ag = (await uno('select public.panel_agenda($1, $1) r', [dia])).r;
    assert.equal(ag.citas.length, 1);
    assert.equal(ag.citas[0].cliente, 'Cliente sin móvil');

    await uno('select public.panel_mover_cita($1, $2)', [c.id, await madrid(dia, '10:00')]);
    await uno(`select public.panel_estado_cita($1, 'no_vino')`, [c.id]);
    const ag2 = (await uno('select public.panel_agenda($1, $1) r', [dia])).r;
    assert.equal(ag2.citas[0].estado, 'no_vino');

    const b = (await uno(`select public.panel_bloquear($1, $2, $3, 'Médico') r`, [await madrid(dia, '16:00'), await madrid(dia, '18:00'), alex])).r;
    const ag3 = (await uno('select public.panel_agenda($1, $1) r', [dia])).r;
    assert.equal(ag3.bloqueos.length, 1);
    await uno('select public.panel_quitar_bloqueo($1)', [b]);
  } finally {
    await db.exec('reset role');
    await db.exec('reset test.uid');
  }
  // El bloqueo de Álex quitaba huecos; ya quitado, vuelven.
  const libres = await filas(`select 1 from public.huecos_libres('corte', $1, (select id from barberos where nombre='Álex')) h where to_char(h.inicio at time zone 'Europe/Madrid','HH24:MI') = '16:30'`, [diaLaborable(10)]);
  assert.equal(libres.length, 1);
});


test('whatsapp: sin activar no se envía nada', async () => {
  const antes = (await uno('select count(*)::int n from net.peticiones')).n;
  await uno(`select public.reservar('corte', $1, 'Silencio', '611222333', true)`, [await madrid(diaLaborable(11), '12:00')]);
  assert.equal((await uno('select count(*)::int n from net.peticiones')).n, antes);
});

test('whatsapp: confirmación al reservar y al mover', async () => {
  await db.exec(`insert into vault.decrypted_secrets values ('whatsapp_token', 'TOKEN-DE-PRUEBA')`);
  await db.exec(`update ajustes set whatsapp_activo = true, whatsapp_phone_number_id = '123456'`);
  const dia = diaLaborable(12);
  const r = (await uno(`select public.reservar('corte-barba', $1, 'Javier Martín', '612 345 678', true) r`, [await madrid(dia, '17:30')])).r;
  const env = await filas('select * from net.peticiones order by id desc limit 1');
  const b = env[0].body;
  assert.equal(env[0].url, 'https://graph.facebook.com/v21.0/123456/messages');
  assert.equal(env[0].headers.Authorization, 'Bearer TOKEN-DE-PRUEBA');
  assert.equal(b.to, '34612345678');
  assert.equal(b.template.name, 'confirmacion_cita');
  const p = b.template.components[0].parameters.map((x) => x.text);
  assert.equal(p[0], 'Javier');
  assert.equal(p[1], 'Corte + barba');
  assert.match(p[2], /^(lunes|martes|miércoles|jueves|viernes|sábado) \d+ de [a-z]+$/);
  assert.equal(p[3], '17:30');
  assert.equal(p[5], r.codigo);
  assert.equal(b.template.components[1].parameters[0].text, r.token);
  assert.ok((await uno('select confirmacion_enviada_en from citas where token = $1', [r.token])).confirmacion_enviada_en);

  const n = (await uno('select count(*)::int n from net.peticiones')).n;
  await uno('select public.mover_cita($1, $2)', [r.token, await madrid(dia, '18:00')]);
  assert.equal((await uno('select count(*)::int n from net.peticiones')).n, n + 1, 'nueva confirmación al mover');
  const ult = (await uno('select body from net.peticiones order by id desc limit 1')).body;
  assert.equal(ult.template.components[0].parameters[3].text, '18:00');
  // Cancelar no envía confirmación.
  await uno('select public.cancelar_cita($1)', [r.token]);
  assert.equal((await uno('select count(*)::int n from net.peticiones')).n, n + 1);
});

test('whatsapp: recordatorio solo si se pidió con más de 24 h', async () => {
  const alex = (await uno(`select id from barberos where nombre = 'Álex'`)).id;
  // Cita dentro de 20 h, creada hace 3 días (directa en la tabla para simular el pasado).
  const vieja = (await uno(`insert into citas (barbero_id, servicio_id, inicio, cliente_nombre, cliente_telefono)
    values ($1, 'barba', now() + interval '20 hours', 'Antigua Reserva', '+34655000111') returning id`, [alex])).id;
  await db.query(`update citas set creada_en = now() - interval '3 days' where id = $1`, [vieja]);
  // Cita dentro de 21 h, pedida ahora mismo: no lleva recordatorio.
  await db.query(`insert into citas (barbero_id, servicio_id, inicio, cliente_nombre, cliente_telefono)
    values ($1, 'barba', now() + interval '21 hours', 'Reserva Reciente', '+34655000222')`, [alex]);
  assert.equal((await uno('select public.enviar_recordatorios() n')).n, 1);
  const ult = (await uno('select body from net.peticiones order by id desc limit 1')).body;
  assert.equal(ult.template.name, 'recordatorio_cita');
  assert.equal(ult.to, '34655000111');
  assert.equal((await uno('select public.enviar_recordatorios() n')).n, 0, 'no se repite');
  await db.exec(`update ajustes set whatsapp_activo = false`);
});


test('whatsapp: plantilla de prueba hello_world sin parámetros', async () => {
  await db.exec(`update ajustes set whatsapp_activo = true, plantilla_confirmacion = 'hello_world'`);
  await uno(`select public.reservar('barba', $1, 'Prueba Hola', '699111222', true)`, [await madrid(diaLaborable(13), '10:00')]);
  const b = (await uno('select body from net.peticiones order by id desc limit 1')).body;
  assert.deepEqual(b.template, { name: 'hello_world', language: { code: 'en_US' } });
  await db.exec(`update ajustes set whatsapp_activo = false, plantilla_confirmacion = 'confirmacion_cita'`);
});


test('teléfonos de España: exactamente 9 cifras', async () => {
  const n = async (t) => (await uno('select public.normaliza_telefono($1) t', [t])).t;
  assert.equal(await n('671 38 12 94'), '+34671381294');
  assert.equal(await n('+34 671 38 12 94'), '+34671381294');
  assert.equal(await n('0034671381294'), '+34671381294');
  assert.equal(await n('34671381294'), '+34671381294');
  assert.equal(await n('+34 671 38 12 9'), null, 'falta una cifra');
  assert.equal(await n('+34 671 38 12 945'), null, 'sobra una cifra');
  assert.equal(await n('+44 7911 123456'), '+447911123456', 'extranjero');
});


test('whatsapp por Green-API: texto libre con el enlace de la cita', async () => {
  await db.exec(`insert into vault.decrypted_secrets values ('greenapi_token', 'TOKEN-GREEN')`);
  await db.exec(`update ajustes set whatsapp_proveedor = 'greenapi', greenapi_url = 'https://7105.api.greenapi.com/',
    greenapi_instancia = '7105000001', whatsapp_activo = true, plantilla_confirmacion = 'confirmacion_cita'`);
  const r = (await uno(`select public.reservar('degradado', $1, 'Pablo García', '671 38 12 94', true) r`, [await madrid(diaLaborable(14), '11:00')])).r;
  const env = (await uno('select url, body from net.peticiones order by id desc limit 1'));
  assert.equal(env.url, 'https://7105.api.greenapi.com/waInstance7105000001/sendMessage/TOKEN-GREEN');
  assert.equal(env.body.chatId, '34671381294@c.us');
  assert.match(env.body.message, /^Hola Pablo/);
  assert.match(env.body.message, /\*Llano Peluqueros\*/);
  assert.match(env.body.message, /Degradado/);
  assert.match(env.body.message, /a las 11:00/);
  assert.ok(env.body.message.includes(`/cita/?t=${r.token}`));
  assert.ok(env.body.message.includes(r.codigo));

  // Recordatorio por Green-API
  const alex = (await uno(`select id from barberos where nombre = 'Álex'`)).id;
  const v = (await uno(`insert into citas (barbero_id, servicio_id, inicio, cliente_nombre, cliente_telefono)
    values ($1, 'corte', now() + interval '22 hours', 'Recordar Green', '+34611000999') returning id`, [alex])).id;
  await db.query(`update citas set creada_en = now() - interval '2 days' where id = $1`, [v]);
  assert.equal((await uno('select public.enviar_recordatorios() n')).n, 1);
  const rec = (await uno('select body from net.peticiones order by id desc limit 1')).body;
  assert.equal(rec.chatId, '34611000999@c.us');
  assert.match(rec.message, /te recordamos tu cita/);
  await db.exec(`update ajustes set whatsapp_activo = false, whatsapp_proveedor = 'meta'`);
});
