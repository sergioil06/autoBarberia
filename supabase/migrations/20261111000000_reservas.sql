-- ═══════════════════════════════════════════════════════════════════════════
-- Llano Peluqueros · Sistema de reservas (fase 1)
--
-- Toda la lógica delicada vive aquí, en la base de datos:
--   · los huecos libres se calculan con el horario de cada barbero, la duración
--     del servicio, las citas existentes y los bloqueos;
--   · una restricción de exclusión impide guardar dos citas solapadas del mismo
--     barbero, aunque lleguen a la vez;
--   · la web pública solo puede llamar a funciones (no lee ni escribe tablas).
-- ═══════════════════════════════════════════════════════════════════════════

create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

-- ─── Ajustes generales (una sola fila) ──────────────────────────────────────
create table public.ajustes (
  id                      smallint primary key default 1 check (id = 1),
  zona                    text not null default 'Europe/Madrid',
  paso_min                int  not null default 15  check (paso_min between 5 and 60),
  antelacion_min          int  not null default 120 check (antelacion_min >= 0),   -- reservar con al menos X min
  dias_max                int  not null default 30  check (dias_max between 1 and 365),
  limite_cambio_min       int  not null default 120 check (limite_cambio_min >= 0), -- cambiar/cancelar hasta X min antes
  max_citas_por_telefono  int  not null default 3   check (max_citas_por_telefono >= 1)
);
insert into public.ajustes default values;

-- ─── Catálogo ───────────────────────────────────────────────────────────────
create table public.servicios (
  id           text primary key check (id ~ '^[a-z0-9-]+$'),
  nombre       text not null,
  descripcion  text,
  minutos      int  not null check (minutos between 5 and 480),
  precio_cents int  check (precio_cents >= 0),
  activo       boolean not null default true,
  orden        int not null default 0
);

create table public.barberos (
  id        uuid primary key default gen_random_uuid(),
  nombre    text not null,
  activo    boolean not null default true,
  orden     int not null default 0,
  user_id   uuid unique references auth.users (id) on delete set null, -- su cuenta del panel
  es_admin  boolean not null default false
);

-- Horario semanal de cada barbero (varias franjas por día).
create table public.horarios (
  id          bigint generated always as identity primary key,
  barbero_id  uuid not null references public.barberos (id) on delete cascade,
  dia_semana  smallint not null check (dia_semana between 0 and 6), -- 0 = domingo
  inicio      time not null,
  fin         time not null,
  check (fin > inicio)
);
create index on public.horarios (barbero_id, dia_semana);

-- Vacaciones, festivos, médico… barbero_id null = toda la barbería.
create table public.bloqueos (
  id          bigint generated always as identity primary key,
  barbero_id  uuid references public.barberos (id) on delete cascade,
  inicio      timestamptz not null,
  fin         timestamptz not null,
  motivo      text,
  check (fin > inicio)
);
create index on public.bloqueos using gist (tstzrange(inicio, fin, '[)'));

-- ─── Citas ──────────────────────────────────────────────────────────────────
create or replace function public.nuevo_token() returns text
language sql volatile as $$
  select replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '')
$$;

create or replace function public.nuevo_codigo() returns text
language sql volatile as $$
  select upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6))
$$;

create table public.citas (
  id                       uuid primary key default gen_random_uuid(),
  codigo                   text not null unique default public.nuevo_codigo(), -- para hablar con el cliente
  token                    text not null unique default public.nuevo_token(),  -- enlace secreto para cambiar/cancelar
  barbero_id               uuid not null references public.barberos (id),
  servicio_id              text not null references public.servicios (id),
  inicio                   timestamptz not null,
  fin                      timestamptz not null,
  cliente_nombre           text not null check (char_length(cliente_nombre) between 2 and 60),
  cliente_telefono         text check (cliente_telefono ~ '^\+[0-9]{9,15}$'), -- puede faltar en citas creadas en el panel
  estado                   text not null default 'confirmada'
                           check (estado in ('confirmada', 'cancelada', 'completada', 'no_vino')),
  origen                   text not null default 'web' check (origen in ('web', 'panel')),
  notas                    text,
  consentimiento_en        timestamptz,
  creada_en                timestamptz not null default now(),
  cancelada_en             timestamptz,
  confirmacion_enviada_en  timestamptz, -- fase 2: WhatsApp
  recordatorio_enviado_en  timestamptz, -- fase 3: recordatorio 24 h
  check (fin > inicio),
  -- La garantía: un barbero no puede tener dos citas que se pisen.
  constraint citas_sin_solapes exclude using gist (
    barbero_id with =,
    tstzrange(inicio, fin, '[)') with &&
  ) where (estado <> 'cancelada')
);
create index on public.citas (inicio);
create index on public.citas (cliente_telefono, inicio);

-- La hora de fin siempre sale de la duración del servicio.
create or replace function public.citas_calcula_fin() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' or new.inicio is distinct from old.inicio or new.servicio_id is distinct from old.servicio_id or new.fin is null then
    select new.inicio + make_interval(mins => s.minutos) into new.fin
    from public.servicios s where s.id = new.servicio_id;
  end if;
  if new.estado = 'cancelada' and old is distinct from null and old.estado <> 'cancelada' then
    new.cancelada_en := coalesce(new.cancelada_en, now());
  end if;
  return new;
end $$;

create trigger citas_calcula_fin
before insert or update on public.citas
for each row execute function public.citas_calcula_fin();

-- ═══════════════════════════════════════════════════════════════════════════
-- Funciones
-- ═══════════════════════════════════════════════════════════════════════════

-- Teléfono → formato internacional (+34…). Devuelve null si no es válido.
create or replace function public.normaliza_telefono(p text) returns text
language plpgsql immutable as $$
declare t text := regexp_replace(coalesce(p, ''), '[\s().-]', '', 'g');
begin
  if t ~ '^00[0-9]+$' then t := '+' || substr(t, 3); end if;
  if t ~ '^[6789][0-9]{8}$' then t := '+34' || t; end if;
  if t ~ '^\+[0-9]{9,15}$' then return t; end if;
  return null;
end $$;

-- Huecos libres de un día (núcleo). p_ignorar: cita que se está moviendo.
create or replace function public._huecos(
  p_servicio text, p_barbero uuid, p_dia date, p_ignorar uuid default null
) returns table (inicio timestamptz, barbero_id uuid)
language sql stable security definer set search_path = public, pg_temp as $$
  with a as (select * from ajustes where id = 1),
  s as (select minutos from servicios where id = p_servicio and activo),
  candidatos as (
    select b.id as barbero_id, b.orden,
           gs as inicio,
           gs + make_interval(mins => (select minutos from s)) as fin
    from barberos b
    join horarios h on h.barbero_id = b.id
                   and h.dia_semana = extract(dow from p_dia)::int
    cross join a
    cross join lateral generate_series(
      (p_dia + h.inicio) at time zone a.zona,
      (p_dia + h.fin) at time zone a.zona - make_interval(mins => (select minutos from s)),
      make_interval(mins => a.paso_min)
    ) gs
    where b.activo
      and (p_barbero is null or b.id = p_barbero)
      and exists (select 1 from s)
  )
  select c.inicio, c.barbero_id
  from candidatos c, a
  where c.inicio >= now() + make_interval(mins => a.antelacion_min)
    and c.inicio <  now() + make_interval(days => a.dias_max)
    and not exists (
      select 1 from citas x
      where x.barbero_id = c.barbero_id
        and x.estado <> 'cancelada'
        and (p_ignorar is null or x.id <> p_ignorar)
        and tstzrange(x.inicio, x.fin, '[)') && tstzrange(c.inicio, c.fin, '[)')
    )
    and not exists (
      select 1 from bloqueos k
      where (k.barbero_id is null or k.barbero_id = c.barbero_id)
        and tstzrange(k.inicio, k.fin, '[)') && tstzrange(c.inicio, c.fin, '[)')
    )
  order by c.inicio, c.orden
$$;

-- Catálogo público para la web: servicios y barberos activos + ajustes útiles.
create or replace function public.catalogo() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'servicios', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'nombre', nombre, 'descripcion', descripcion,
        'minutos', minutos, 'precio', precio_cents / 100.0) order by orden)
      from servicios where activo), '[]'::jsonb),
    'barberos', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre) order by orden)
      from barberos where activo), '[]'::jsonb),
    'dias_max', (select dias_max from ajustes where id = 1),
    'zona', (select zona from ajustes where id = 1)
  )
$$;

-- Huecos para la web. Sin barbero = «me da igual»: una fila por hora libre.
create or replace function public.huecos_libres(
  p_servicio text, p_dia date, p_barbero uuid default null
) returns table (inicio timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct h.inicio from public._huecos(p_servicio, p_barbero, p_dia) h order by 1
$$;

-- Qué días tienen algún hueco (para atenuar los días completos en la web).
create or replace function public.dias_con_huecos(
  p_servicio text, p_desde date, p_dias int default 14, p_barbero uuid default null
) returns table (dia date, huecos int)
language sql stable security definer set search_path = public, pg_temp as $$
  select d::date, (select count(distinct h.inicio)::int from public._huecos(p_servicio, p_barbero, d::date) h)
  from generate_series(p_desde, p_desde + least(greatest(p_dias, 1), 60) - 1, interval '1 day') d
$$;

-- Reservar desde la web.
create or replace function public.reservar(
  p_servicio text,
  p_inicio timestamptz,
  p_nombre text,
  p_telefono text,
  p_consentimiento boolean,
  p_barbero uuid default null
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  a ajustes;
  tel text := normaliza_telefono(p_telefono);
  nom text := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  dia date;
  cand uuid;
  nueva citas;
begin
  select * into a from ajustes where id = 1;
  if not coalesce(p_consentimiento, false) then raise exception 'SIN_CONSENTIMIENTO' using errcode = 'P0001'; end if;
  if char_length(nom) < 2 or char_length(nom) > 60 then raise exception 'NOMBRE_NO_VALIDO' using errcode = 'P0001'; end if;
  if tel is null then raise exception 'TELEFONO_NO_VALIDO' using errcode = 'P0001'; end if;
  if (select count(*) from citas where cliente_telefono = tel and estado = 'confirmada' and inicio > now())
     >= a.max_citas_por_telefono then
    raise exception 'DEMASIADAS_CITAS' using errcode = 'P0001';
  end if;

  dia := (p_inicio at time zone a.zona)::date;

  -- Barberos libres a esa hora (el elegido, o el que menos citas tenga ese día).
  for cand in
    select h.barbero_id
    from _huecos(p_servicio, p_barbero, dia) h
    where h.inicio = p_inicio
    order by (select count(*) from citas c
              where c.barbero_id = h.barbero_id and c.estado <> 'cancelada'
                and (c.inicio at time zone a.zona)::date = dia),
             (select orden from barberos where id = h.barbero_id)
  loop
    begin
      insert into citas (barbero_id, servicio_id, inicio, cliente_nombre, cliente_telefono, origen, consentimiento_en)
      values (cand, p_servicio, p_inicio, nom, tel, 'web', now())
      returning * into nueva;
      exit;
    exception when exclusion_violation then
      -- Alguien ha cogido ese hueco en el mismo instante: probamos el siguiente barbero.
      continue;
    end;
  end loop;

  if nueva.id is null then raise exception 'HUECO_OCUPADO' using errcode = 'P0001'; end if;

  return jsonb_build_object(
    'codigo', nueva.codigo, 'token', nueva.token,
    'inicio', nueva.inicio, 'fin', nueva.fin,
    'barbero', (select nombre from barberos where id = nueva.barbero_id),
    'servicio', (select nombre from servicios where id = nueva.servicio_id)
  );
end $$;

-- Ver una cita con su enlace secreto.
create or replace function public.ver_cita(p_token text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'codigo', c.codigo, 'estado', c.estado,
    'inicio', c.inicio, 'fin', c.fin,
    'servicio_id', c.servicio_id, 'servicio', s.nombre,
    'precio', s.precio_cents / 100.0,
    'barbero_id', c.barbero_id, 'barbero', b.nombre,
    'cliente', c.cliente_nombre,
    'puede_cambiar', c.estado = 'confirmada' and now() < c.inicio - make_interval(mins => a.limite_cambio_min),
    'limite_cambio_min', a.limite_cambio_min
  )
  from citas c
  join servicios s on s.id = c.servicio_id
  join barberos b on b.id = c.barbero_id
  cross join ajustes a
  where c.token = p_token and a.id = 1
$$;

create or replace function public._cita_modificable(p_token text) returns citas
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare c citas; lim int;
begin
  select limite_cambio_min into lim from ajustes where id = 1;
  select * into c from citas where token = p_token for update;
  if c.id is null then raise exception 'CITA_NO_ENCONTRADA' using errcode = 'P0001'; end if;
  if c.estado <> 'confirmada' then raise exception 'CITA_NO_ACTIVA' using errcode = 'P0001'; end if;
  if now() >= c.inicio - make_interval(mins => lim) then raise exception 'FUERA_DE_PLAZO' using errcode = 'P0001'; end if;
  return c;
end $$;

-- Cancelar con el enlace secreto.
create or replace function public.cancelar_cita(p_token text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare c citas;
begin
  c := _cita_modificable(p_token);
  update citas set estado = 'cancelada', cancelada_en = now() where id = c.id;
  return public.ver_cita(p_token);
end $$;

-- Cambiar de hora (mismo servicio; mismo barbero o «me da igual»).
create or replace function public.mover_cita(
  p_token text, p_inicio timestamptz, p_barbero uuid default null
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare c citas; z text; nuevo uuid;
begin
  c := _cita_modificable(p_token);
  select zona into z from ajustes where id = 1;
  select h.barbero_id into nuevo
  from _huecos(c.servicio_id, p_barbero, (p_inicio at time zone z)::date, c.id) h
  where h.inicio = p_inicio
  order by (h.barbero_id = c.barbero_id) desc
  limit 1;
  if nuevo is null then raise exception 'HUECO_OCUPADO' using errcode = 'P0001'; end if;
  begin
    update citas
       set inicio = p_inicio, barbero_id = nuevo,
           confirmacion_enviada_en = null, recordatorio_enviado_en = null
     where id = c.id;
  exception when exclusion_violation then
    raise exception 'HUECO_OCUPADO' using errcode = 'P0001';
  end;
  return public.ver_cita(p_token);
end $$;

-- Huecos para mover una cita (no cuenta su propio hueco como ocupado).
create or replace function public.huecos_para_mover(p_token text, p_dia date, p_barbero uuid default null)
returns table (inicio timestamptz)
language sql stable security definer set search_path = public, pg_temp as $$
  select distinct h.inicio
  from citas c, public._huecos(c.servicio_id, p_barbero, p_dia, c.id) h
  where c.token = p_token and c.estado = 'confirmada'
  order by 1
$$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Panel de barberos (solo personal con cuenta)
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public._exige_personal() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from barberos where user_id = auth.uid() and activo) then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
end $$;

-- Quién soy y el catálogo completo para los formularios del panel.
create or replace function public.panel_yo() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform _exige_personal();
  return jsonb_build_object(
    'yo', (select jsonb_build_object('id', id, 'nombre', nombre, 'es_admin', es_admin) from barberos where user_id = auth.uid()),
    'barberos', (select jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre) order by orden) from barberos where activo),
    'servicios', (select jsonb_agg(jsonb_build_object('id', id, 'nombre', nombre, 'minutos', minutos, 'precio', precio_cents / 100.0) order by orden) from servicios where activo),
    'zona', (select zona from ajustes where id = 1)
  );
end $$;

-- Citas y bloqueos entre dos días (incluidos), en hora de la barbería.
create or replace function public.panel_agenda(p_desde date, p_hasta date) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare z text; a timestamptz; b timestamptz;
begin
  perform _exige_personal();
  select zona into z from ajustes where id = 1;
  a := p_desde::timestamp at time zone z;
  b := (p_hasta + 1)::timestamp at time zone z;
  return jsonb_build_object(
    'citas', coalesce((select jsonb_agg(jsonb_build_object(
        'id', c.id, 'codigo', c.codigo, 'inicio', c.inicio, 'fin', c.fin,
        'barbero_id', c.barbero_id, 'servicio_id', c.servicio_id, 'servicio', s.nombre,
        'cliente', c.cliente_nombre, 'telefono', c.cliente_telefono,
        'estado', c.estado, 'origen', c.origen, 'notas', c.notas) order by c.inicio)
      from citas c join servicios s on s.id = c.servicio_id
      where c.inicio >= a and c.inicio < b), '[]'::jsonb),
    'bloqueos', coalesce((select jsonb_agg(jsonb_build_object(
        'id', k.id, 'barbero_id', k.barbero_id, 'inicio', k.inicio, 'fin', k.fin, 'motivo', k.motivo) order by k.inicio)
      from bloqueos k where k.inicio < b and k.fin > a), '[]'::jsonb)
  );
end $$;

-- Cita creada a mano (teléfono, en persona). Sin límites de horario ni antelación;
-- solo la regla de no solapar.
create or replace function public.panel_crear_cita(
  p_barbero uuid, p_servicio text, p_inicio timestamptz,
  p_nombre text, p_telefono text default null, p_notas text default null
) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare tel text; nueva citas;
begin
  perform _exige_personal();
  if nullif(btrim(coalesce(p_telefono, '')), '') is not null then
    tel := normaliza_telefono(p_telefono);
    if tel is null then raise exception 'TELEFONO_NO_VALIDO' using errcode = 'P0001'; end if;
  end if;
  if char_length(btrim(coalesce(p_nombre, ''))) < 2 then raise exception 'NOMBRE_NO_VALIDO' using errcode = 'P0001'; end if;
  begin
    insert into citas (barbero_id, servicio_id, inicio, cliente_nombre, cliente_telefono, origen, notas)
    values (p_barbero, p_servicio, p_inicio, btrim(p_nombre), tel, 'panel', nullif(btrim(coalesce(p_notas, '')), ''))
    returning * into nueva;
  exception when exclusion_violation then
    raise exception 'HUECO_OCUPADO' using errcode = 'P0001';
  end;
  return jsonb_build_object('id', nueva.id, 'codigo', nueva.codigo, 'token', nueva.token);
end $$;

create or replace function public.panel_mover_cita(p_id uuid, p_inicio timestamptz, p_barbero uuid default null)
returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform _exige_personal();
  begin
    update citas set inicio = p_inicio, barbero_id = coalesce(p_barbero, barbero_id),
                     recordatorio_enviado_en = null
     where id = p_id and estado = 'confirmada';
    if not found then raise exception 'CITA_NO_ACTIVA' using errcode = 'P0001'; end if;
  exception when exclusion_violation then
    raise exception 'HUECO_OCUPADO' using errcode = 'P0001';
  end;
end $$;

create or replace function public.panel_estado_cita(p_id uuid, p_estado text) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform _exige_personal();
  if p_estado not in ('confirmada', 'cancelada', 'completada', 'no_vino') then
    raise exception 'ESTADO_NO_VALIDO' using errcode = 'P0001';
  end if;
  begin
    update citas set estado = p_estado where id = p_id;
  exception when exclusion_violation then
    -- Reactivar una cancelada cuyo hueco ya está ocupado.
    raise exception 'HUECO_OCUPADO' using errcode = 'P0001';
  end;
end $$;

create or replace function public.panel_bloquear(
  p_inicio timestamptz, p_fin timestamptz, p_barbero uuid default null, p_motivo text default null
) returns bigint
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare nuevo bigint;
begin
  perform _exige_personal();
  if p_fin <= p_inicio then raise exception 'FECHAS_NO_VALIDAS' using errcode = 'P0001'; end if;
  insert into bloqueos (barbero_id, inicio, fin, motivo)
  values (p_barbero, p_inicio, p_fin, nullif(btrim(coalesce(p_motivo, '')), ''))
  returning id into nuevo;
  return nuevo;
end $$;

create or replace function public.panel_quitar_bloqueo(p_id bigint) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform _exige_personal();
  delete from bloqueos where id = p_id;
end $$;

-- ═══════════════════════════════════════════════════════════════════════════
-- Seguridad
-- ═══════════════════════════════════════════════════════════════════════════

-- Personal del panel: cualquier barbero activo con cuenta.
create or replace function public.es_personal() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from barberos where user_id = auth.uid() and activo)
$$;

create or replace function public.es_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from barberos where user_id = auth.uid() and activo and es_admin)
$$;

alter table public.ajustes   enable row level security;
alter table public.servicios enable row level security;
alter table public.barberos  enable row level security;
alter table public.horarios  enable row level security;
alter table public.bloqueos  enable row level security;
alter table public.citas     enable row level security;

-- La web pública no toca tablas: solo funciones.
revoke all on all tables in schema public from anon;
revoke all on all functions in schema public from public, anon;
grant execute on function
  public.catalogo(),
  public.huecos_libres(text, date, uuid),
  public.dias_con_huecos(text, date, int, uuid),
  public.reservar(text, timestamptz, text, text, boolean, uuid),
  public.ver_cita(text),
  public.cancelar_cita(text),
  public.mover_cita(text, timestamptz, uuid),
  public.huecos_para_mover(text, date, uuid)
to anon, authenticated;
grant execute on function
  public.panel_yo(),
  public.panel_agenda(date, date),
  public.panel_crear_cita(uuid, text, timestamptz, text, text, text),
  public.panel_mover_cita(uuid, timestamptz, uuid),
  public.panel_estado_cita(uuid, text),
  public.panel_bloquear(timestamptz, timestamptz, uuid, text),
  public.panel_quitar_bloqueo(bigint)
to authenticated;
grant execute on function public.es_personal(), public.es_admin(), public.normaliza_telefono(text),
  public.nuevo_token(), public.nuevo_codigo()
to authenticated;

-- El personal (panel) lee y gestiona todo; solo el admin toca catálogo, horarios y ajustes.
grant select, insert, update on public.citas to authenticated;
grant select, insert, update, delete on public.bloqueos to authenticated;
grant select on public.servicios, public.barberos, public.horarios, public.ajustes to authenticated;
grant insert, update, delete on public.servicios, public.horarios to authenticated;
grant update on public.barberos, public.ajustes to authenticated;

create policy personal_lee_citas      on public.citas     for select to authenticated using (public.es_personal());
create policy personal_crea_citas     on public.citas     for insert to authenticated with check (public.es_personal());
create policy personal_cambia_citas   on public.citas     for update to authenticated using (public.es_personal()) with check (public.es_personal());

create policy personal_lee_bloqueos   on public.bloqueos  for select to authenticated using (public.es_personal());
create policy personal_crea_bloqueos  on public.bloqueos  for insert to authenticated with check (public.es_personal());
create policy personal_cambia_bloqueos on public.bloqueos for update to authenticated using (public.es_personal());
create policy personal_borra_bloqueos on public.bloqueos  for delete to authenticated using (public.es_personal());

create policy personal_lee_servicios  on public.servicios for select to authenticated using (public.es_personal());
create policy admin_servicios         on public.servicios for all    to authenticated using (public.es_admin()) with check (public.es_admin());
create policy personal_lee_barberos   on public.barberos  for select to authenticated using (public.es_personal());
create policy admin_barberos          on public.barberos  for update to authenticated using (public.es_admin()) with check (public.es_admin());
create policy personal_lee_horarios   on public.horarios  for select to authenticated using (public.es_personal());
create policy admin_horarios          on public.horarios  for all    to authenticated using (public.es_admin()) with check (public.es_admin());
create policy personal_lee_ajustes    on public.ajustes   for select to authenticated using (public.es_personal());
create policy admin_ajustes           on public.ajustes   for update to authenticated using (public.es_admin()) with check (public.es_admin());
