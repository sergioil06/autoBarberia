-- ═══════════════════════════════════════════════════════════════════════════
-- Llano Peluqueros · WhatsApp (fases 2 y 3)
--
--   · Confirmación al crear (o mover) una cita, con botón para cambiarla o
--     cancelarla.
--   · Recordatorio 24 h antes, solo si la cita se pidió con más antelación.
--
-- Usa la API oficial de WhatsApp (Meta) con plantillas aprobadas. El token se
-- guarda cifrado en Supabase Vault con el nombre «whatsapp_token»:
--   select vault.create_secret('EAAG…', 'whatsapp_token');
-- No se envía nada hasta poner ajustes.whatsapp_activo = true.
-- ═══════════════════════════════════════════════════════════════════════════

-- pg_net (peticiones HTTP desde la base de datos) y pg_cron (tareas programadas).
do $$ begin
  create extension if not exists pg_net;
exception when others then raise notice 'pg_net no disponible: %', sqlerrm;
end $$;
do $$ begin
  create extension if not exists pg_cron;
exception when others then raise notice 'pg_cron no disponible: %', sqlerrm;
end $$;

alter table public.ajustes
  add column if not exists whatsapp_activo          boolean not null default false,
  add column if not exists whatsapp_phone_number_id text,
  add column if not exists whatsapp_version_api     text not null default 'v21.0',
  add column if not exists plantilla_confirmacion   text not null default 'confirmacion_cita',
  add column if not exists plantilla_recordatorio   text not null default 'recordatorio_cita',
  add column if not exists idioma_plantillas        text not null default 'es',
  add column if not exists web_url                  text not null default 'https://autobarberia.sergioil2906.workers.dev';

-- Registro de envíos (para saber qué se mandó y revisar errores).
create table if not exists public.whatsapp_envios (
  id          bigint generated always as identity primary key,
  cita_id     uuid references public.citas (id) on delete set null,
  tipo        text not null check (tipo in ('confirmacion', 'recordatorio')),
  telefono    text not null,
  peticion_id bigint,               -- id de net.http_post; la respuesta queda en net._http_response
  creado_en   timestamptz not null default now()
);
alter table public.whatsapp_envios enable row level security;
revoke all on public.whatsapp_envios from anon, authenticated;
grant select on public.whatsapp_envios to authenticated;
create policy personal_lee_envios on public.whatsapp_envios for select to authenticated using (public.es_personal());

-- Fecha en español sin depender del idioma del servidor: «jueves 12 de noviembre».
create or replace function public.fecha_es(p timestamptz, p_zona text default 'Europe/Madrid') returns text
language sql immutable as $$
  select (array['domingo','lunes','martes','miércoles','jueves','viernes','sábado'])[extract(dow from p at time zone p_zona)::int + 1]
      || ' ' || extract(day from p at time zone p_zona)::int
      || ' de ' || (array['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'])[extract(month from p at time zone p_zona)::int]
$$;

-- Envía una plantilla de WhatsApp. Devuelve el id de la petición (o null si no se envía).
create or replace function public._whatsapp_enviar(
  p_cita uuid, p_tipo text, p_telefono text, p_plantilla text, p_parametros text[], p_token_cita text
) returns bigint
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  a ajustes;
  tok text;
  pid bigint;
  cuerpo jsonb;
begin
  select * into a from ajustes where id = 1;
  if not a.whatsapp_activo or a.whatsapp_phone_number_id is null or p_telefono is null then
    return null;
  end if;
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'whatsapp_token' limit 1;
  if tok is null then
    raise warning 'WhatsApp: falta el secreto whatsapp_token en Vault';
    return null;
  end if;

  -- «hello_world» es la plantilla de prueba de Meta: va sin parámetros y en inglés.
  if p_plantilla = 'hello_world' then
    cuerpo := jsonb_build_object(
      'messaging_product', 'whatsapp',
      'to', regexp_replace(p_telefono, '\D', '', 'g'),
      'type', 'template',
      'template', jsonb_build_object('name', 'hello_world', 'language', jsonb_build_object('code', 'en_US'))
    );
  else
  cuerpo := jsonb_build_object(
    'messaging_product', 'whatsapp',
    'to', regexp_replace(p_telefono, '\D', '', 'g'),
    'type', 'template',
    'template', jsonb_build_object(
      'name', p_plantilla,
      'language', jsonb_build_object('code', a.idioma_plantillas),
      'components', jsonb_build_array(
        jsonb_build_object('type', 'body', 'parameters',
          (select jsonb_agg(jsonb_build_object('type', 'text', 'text', x)) from unnest(p_parametros) x)),
        -- Botón «Ver, cambiar o cancelar»: la plantilla tiene la URL …/cita/?t={{1}}
        jsonb_build_object('type', 'button', 'sub_type', 'url', 'index', '0', 'parameters',
          jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_token_cita)))
      )
    )
  );
  end if;

  select net.http_post(
    url := format('https://graph.facebook.com/%s/%s/messages', a.whatsapp_version_api, a.whatsapp_phone_number_id),
    headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'Content-Type', 'application/json'),
    body := cuerpo
  ) into pid;

  insert into whatsapp_envios (cita_id, tipo, telefono, peticion_id) values (p_cita, p_tipo, p_telefono, pid);
  return pid;
end $$;

-- Confirmación: al crear una cita activa con teléfono, o al cambiarla de hora.
create or replace function public.citas_whatsapp_confirmacion() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare a ajustes; s text; b text;
begin
  if new.estado <> 'confirmada' or new.cliente_telefono is null or new.inicio <= now() then return null; end if;
  if tg_op = 'UPDATE' and new.inicio is not distinct from old.inicio and new.barbero_id is not distinct from old.barbero_id then
    return null;
  end if;
  select * into a from ajustes where id = 1;
  if not a.whatsapp_activo then return null; end if;
  select nombre into s from servicios where id = new.servicio_id;
  select nombre into b from barberos where id = new.barbero_id;
  perform _whatsapp_enviar(
    new.id, 'confirmacion', new.cliente_telefono, a.plantilla_confirmacion,
    array[
      split_part(new.cliente_nombre, ' ', 1),                       -- {{1}} nombre
      s,                                                            -- {{2}} servicio
      fecha_es(new.inicio, a.zona),                                 -- {{3}} fecha
      to_char(new.inicio at time zone a.zona, 'HH24:MI'),           -- {{4}} hora
      b,                                                            -- {{5}} barbero
      new.codigo                                                    -- {{6}} código
    ],
    new.token
  );
  update citas set confirmacion_enviada_en = now() where id = new.id;
  return null;
end $$;

drop trigger if exists citas_whatsapp_confirmacion on public.citas;
create trigger citas_whatsapp_confirmacion
after insert or update of inicio, barbero_id on public.citas
for each row execute function public.citas_whatsapp_confirmacion();

-- Recordatorios: citas dentro de las próximas 24 h, pedidas con más de 24 h de antelación.
create or replace function public.enviar_recordatorios() returns int
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare a ajustes; c record; n int := 0;
begin
  select * into a from ajustes where id = 1;
  if not a.whatsapp_activo then return 0; end if;
  for c in
    select ci.*, s.nombre as servicio, b.nombre as barbero
    from citas ci
    join servicios s on s.id = ci.servicio_id
    join barberos b on b.id = ci.barbero_id
    where ci.estado = 'confirmada'
      and ci.cliente_telefono is not null
      and ci.recordatorio_enviado_en is null
      and ci.inicio > now()
      and ci.inicio <= now() + interval '24 hours'
      and ci.creada_en <= ci.inicio - interval '24 hours'
    for update of ci skip locked
  loop
    perform _whatsapp_enviar(
      c.id, 'recordatorio', c.cliente_telefono, a.plantilla_recordatorio,
      array[
        split_part(c.cliente_nombre, ' ', 1),                       -- {{1}} nombre
        c.servicio,                                                 -- {{2}} servicio
        fecha_es(c.inicio, a.zona),                                 -- {{3}} fecha
        to_char(c.inicio at time zone a.zona, 'HH24:MI'),           -- {{4}} hora
        c.barbero                                                   -- {{5}} barbero
      ],
      c.token
    );
    update citas set recordatorio_enviado_en = now() where id = c.id;
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public._whatsapp_enviar(uuid, text, text, text, text[], text) from public, anon, authenticated;
revoke all on function public.enviar_recordatorios() from public, anon, authenticated;
revoke all on function public.citas_whatsapp_confirmacion() from public, anon, authenticated;

-- Tarea cada 15 minutos (si pg_cron está disponible).
do $$ begin
  if exists (select 1 from pg_namespace where nspname = 'cron') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'recordatorios-whatsapp';
    perform cron.schedule('recordatorios-whatsapp', '*/15 * * * *', 'select public.enviar_recordatorios()');
  end if;
end $$;

-- Ver qué ha respondido Meta a los últimos envíos (para el SQL Editor):
--   select e.creado_en, e.tipo, e.telefono, r.status_code, r.content
--   from whatsapp_envios e left join net._http_response r on r.id = e.peticion_id
--   order by e.creado_en desc limit 20;
