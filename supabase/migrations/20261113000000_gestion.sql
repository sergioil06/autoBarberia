-- ═══════════════════════════════════════════════════════════════════════════
-- Gestión desde el panel (solo el dueño / administradores)
--
--   · servicios: crear, editar nombre, descripción, duración y precio,
--     ordenar, ocultar y borrar;
--   · barberos: dar de alta, cambiar nombre, email de acceso, admin,
--     ordenar, dar de baja y borrar;
--   · horario semanal de cada barbero;
--   · ajustes de reserva (antelación, días vista, plazo para cambiar…).
--
-- Borrar algo que ya tiene citas no se puede (se perdería el historial):
-- en ese caso se desactiva y deja de salir en la web.
--
-- Cuentas: cada barbero tiene un email de acceso. Cuando existe (o se crea
-- después) un usuario de Supabase con ese email, se enlaza solo.
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.barberos add column if not exists email text;
create unique index if not exists barberos_email_unico on public.barberos (lower(email));

-- Los barberos que ya tenían cuenta reciben su email.
update public.barberos b set email = lower(u.email)
from auth.users u
where u.id = b.user_id and b.email is null and u.email is not null;

-- Enlace automático: usuario de Supabase ↔ barbero con el mismo email.
create or replace function public._enlaza_cuenta() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.email is not null and not exists (select 1 from public.barberos where user_id = new.id) then
    update public.barberos set user_id = new.id
     where lower(email) = lower(new.email) and user_id is null;
  end if;
  return new;
end $$;

drop trigger if exists llano_enlaza_cuenta on auth.users;
create trigger llano_enlaza_cuenta
after insert or update of email on auth.users
for each row execute function public._enlaza_cuenta();

-- ─── Utilidades ─────────────────────────────────────────────────────────────
create or replace function public._exige_admin() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not exists (select 1 from barberos where user_id = auth.uid() and activo and es_admin) then
    raise exception 'NO_AUTORIZADO' using errcode = '42501';
  end if;
end $$;

create or replace function public._slug(p text) returns text
language sql immutable as $$
  select coalesce(nullif(trim(both '-' from regexp_replace(
    translate(lower(coalesce(p, '')), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc'),
    '[^a-z0-9]+', '-', 'g')), ''), 'servicio')
$$;

-- ─── Lectura ────────────────────────────────────────────────────────────────
create or replace function public.admin_datos() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform _exige_admin();
  return jsonb_build_object(
    'servicios', coalesce((select jsonb_agg(jsonb_build_object(
        'id', s.id, 'nombre', s.nombre, 'descripcion', s.descripcion,
        'minutos', s.minutos, 'precio', s.precio_cents / 100.0, 'activo', s.activo,
        'citas', (select count(*) from citas c where c.servicio_id = s.id)) order by s.orden, s.nombre)
      from servicios s), '[]'::jsonb),
    'barberos', coalesce((select jsonb_agg(jsonb_build_object(
        'id', b.id, 'nombre', b.nombre, 'email', b.email, 'activo', b.activo,
        'es_admin', b.es_admin, 'tiene_cuenta', b.user_id is not null,
        'soy_yo', b.user_id = auth.uid(),
        'citas', (select count(*) from citas c where c.barbero_id = b.id),
        'citas_futuras', (select count(*) from citas c where c.barbero_id = b.id and c.estado = 'confirmada' and c.inicio > now())
      ) order by b.orden, b.nombre)
      from barberos b), '[]'::jsonb),
    'horarios', coalesce((select jsonb_agg(jsonb_build_object(
        'barbero_id', h.barbero_id, 'dia', h.dia_semana,
        'inicio', to_char(h.inicio, 'HH24:MI'), 'fin', to_char(h.fin, 'HH24:MI')) order by h.dia_semana, h.inicio)
      from horarios h), '[]'::jsonb),
    'ajustes', (select jsonb_build_object(
        'paso_min', paso_min, 'antelacion_min', antelacion_min, 'dias_max', dias_max,
        'limite_cambio_min', limite_cambio_min, 'max_citas_por_telefono', max_citas_por_telefono)
      from ajustes where id = 1)
  );
end $$;

-- ─── Servicios ──────────────────────────────────────────────────────────────
-- p_id null = servicio nuevo. Devuelve el id.
create or replace function public.admin_guardar_servicio(
  p_id text, p_nombre text, p_descripcion text, p_minutos int, p_precio numeric, p_activo boolean default true
) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  nom text := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  base text; nuevo text; n int := 1;
begin
  perform _exige_admin();
  if char_length(nom) < 2 or char_length(nom) > 60 then raise exception 'NOMBRE_NO_VALIDO' using errcode = 'P0001'; end if;
  if p_minutos is null or p_minutos < 5 or p_minutos > 480 then raise exception 'DURACION_NO_VALIDA' using errcode = 'P0001'; end if;
  if p_precio is not null and (p_precio < 0 or p_precio > 10000) then raise exception 'PRECIO_NO_VALIDO' using errcode = 'P0001'; end if;

  if p_id is null then
    base := left(_slug(nom), 40);
    nuevo := base;
    while exists (select 1 from servicios where id = nuevo) loop
      n := n + 1; nuevo := base || '-' || n;
    end loop;
    insert into servicios (id, nombre, descripcion, minutos, precio_cents, activo, orden)
    values (nuevo, nom, nullif(btrim(coalesce(p_descripcion, '')), ''), p_minutos,
            round(p_precio * 100)::int, coalesce(p_activo, true),
            coalesce((select max(orden) from servicios), 0) + 1);
    return nuevo;
  end if;

  -- La duración nueva vale para las citas que se pidan a partir de ahora;
  -- las ya reservadas conservan su hora de fin.
  update servicios
     set nombre = nom,
         descripcion = nullif(btrim(coalesce(p_descripcion, '')), ''),
         minutos = p_minutos,
         precio_cents = round(p_precio * 100)::int,
         activo = coalesce(p_activo, activo)
   where id = p_id;
  if not found then raise exception 'NO_ENCONTRADO' using errcode = 'P0001'; end if;
  return p_id;
end $$;

-- Borra el servicio; si ya tiene citas, solo lo oculta. Devuelve 'borrado' u 'oculto'.
create or replace function public.admin_borrar_servicio(p_id text) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform _exige_admin();
  if exists (select 1 from citas where servicio_id = p_id) then
    update servicios set activo = false where id = p_id;
    return 'oculto';
  end if;
  delete from servicios where id = p_id;
  if not found then raise exception 'NO_ENCONTRADO' using errcode = 'P0001'; end if;
  return 'borrado';
end $$;

-- ─── Barberos ───────────────────────────────────────────────────────────────
-- p_id null = barbero nuevo (empieza con el mismo horario que el primero del equipo).
create or replace function public.admin_guardar_barbero(
  p_id uuid, p_nombre text, p_email text default null, p_activo boolean default true, p_es_admin boolean default false
) returns uuid
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  nom text := btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g'));
  mail text := nullif(lower(btrim(coalesce(p_email, ''))), '');
  b barberos;
  cuenta uuid;
  nueva_cuenta uuid;
  nuevo uuid;
  modelo uuid;
begin
  perform _exige_admin();
  if char_length(nom) < 2 or char_length(nom) > 40 then raise exception 'NOMBRE_NO_VALIDO' using errcode = 'P0001'; end if;
  if mail is not null and mail !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'EMAIL_NO_VALIDO' using errcode = 'P0001'; end if;
  if mail is not null and exists (select 1 from barberos where lower(email) = mail and id is distinct from p_id) then
    raise exception 'EMAIL_REPETIDO' using errcode = 'P0001';
  end if;

  -- Cuenta de Supabase con ese email que aún no esté enlazada a otro barbero.
  if mail is not null then
    select u.id into cuenta from auth.users u
     where lower(u.email) = mail
       and not exists (select 1 from barberos x where x.user_id = u.id and x.id is distinct from p_id)
     limit 1;
  end if;

  if p_id is null then
    select id into modelo from barberos b2
     where exists (select 1 from horarios h where h.barbero_id = b2.id)
     order by b2.activo desc, b2.orden limit 1;
    insert into barberos (nombre, email, activo, es_admin, user_id, orden)
    values (nom, mail, coalesce(p_activo, true), coalesce(p_es_admin, false), cuenta,
            coalesce((select max(orden) from barberos), 0) + 1)
    returning id into nuevo;
    if modelo is not null then
      insert into horarios (barbero_id, dia_semana, inicio, fin)
      select nuevo, dia_semana, inicio, fin from horarios where barbero_id = modelo;
    end if;
    return nuevo;
  end if;

  select * into b from barberos where id = p_id for update;
  if b.id is null then raise exception 'NO_ENCONTRADO' using errcode = 'P0001'; end if;

  -- Si cambia el email, cambia la cuenta enlazada.
  nueva_cuenta := case when mail is not distinct from lower(b.email) then coalesce(b.user_id, cuenta) else cuenta end;

  -- Nadie puede quitarse a sí mismo el acceso o el permiso de admin.
  if b.user_id = auth.uid() and (not coalesce(p_activo, true) or not coalesce(p_es_admin, false)
                                 or nueva_cuenta is distinct from b.user_id) then
    raise exception 'NO_A_TI_MISMO' using errcode = 'P0001';
  end if;
  if not coalesce(p_activo, true) and b.activo and exists (
       select 1 from citas where barbero_id = p_id and estado = 'confirmada' and inicio > now()) then
    raise exception 'TIENE_CITAS' using errcode = 'P0001';
  end if;

  update barberos
     set nombre = nom,
         email = mail,
         activo = coalesce(p_activo, true),
         es_admin = coalesce(p_es_admin, false),
         user_id = nueva_cuenta
   where id = p_id;
  return p_id;
end $$;

-- Borra el barbero; si ya tiene citas, lo da de baja. Devuelve 'borrado' o 'de_baja'.
create or replace function public.admin_borrar_barbero(p_id uuid) returns text
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform _exige_admin();
  if exists (select 1 from barberos where id = p_id and user_id = auth.uid()) then
    raise exception 'NO_A_TI_MISMO' using errcode = 'P0001';
  end if;
  if exists (select 1 from citas where barbero_id = p_id and estado = 'confirmada' and inicio > now()) then
    raise exception 'TIENE_CITAS' using errcode = 'P0001';
  end if;
  if exists (select 1 from citas where barbero_id = p_id) then
    update barberos set activo = false, user_id = null where id = p_id;
    return 'de_baja';
  end if;
  delete from barberos where id = p_id;
  if not found then raise exception 'NO_ENCONTRADO' using errcode = 'P0001'; end if;
  return 'borrado';
end $$;

-- ─── Orden (servicios o barberos) ───────────────────────────────────────────
create or replace function public.admin_ordenar(p_tipo text, p_ids text[]) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform _exige_admin();
  if p_tipo = 'servicios' then
    update servicios s set orden = o.n from unnest(p_ids) with ordinality o(id, n) where s.id = o.id;
  elsif p_tipo = 'barberos' then
    update barberos b set orden = o.n from unnest(p_ids) with ordinality o(id, n) where b.id::text = o.id;
  else
    raise exception 'TIPO_NO_VALIDO' using errcode = 'P0001';
  end if;
end $$;

-- ─── Horario semanal de un barbero ──────────────────────────────────────────
-- p_franjas: [{"dia": 1, "inicio": "09:00", "fin": "13:00"}, …] (sustituye la semana entera).
create or replace function public.admin_guardar_horario(p_barbero uuid, p_franjas jsonb) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform _exige_admin();
  if not exists (select 1 from barberos where id = p_barbero) then raise exception 'NO_ENCONTRADO' using errcode = 'P0001'; end if;
  delete from horarios where barbero_id = p_barbero;
  begin
    insert into horarios (barbero_id, dia_semana, inicio, fin)
    select p_barbero, (f->>'dia')::smallint, (f->>'inicio')::time, (f->>'fin')::time
    from jsonb_array_elements(coalesce(p_franjas, '[]'::jsonb)) f;
  exception when check_violation or invalid_datetime_format or invalid_text_representation or not_null_violation then
    raise exception 'HORARIO_NO_VALIDO' using errcode = 'P0001';
  end;
  if exists (
    select 1 from horarios a join horarios b
      on a.barbero_id = b.barbero_id and a.dia_semana = b.dia_semana and a.id < b.id
     and a.inicio < b.fin and b.inicio < a.fin
    where a.barbero_id = p_barbero
  ) then
    raise exception 'FRANJAS_SOLAPADAS' using errcode = 'P0001';
  end if;
end $$;

-- ─── Ajustes de reserva ─────────────────────────────────────────────────────
create or replace function public.admin_guardar_ajustes(
  p_paso_min int, p_antelacion_min int, p_dias_max int, p_limite_cambio_min int, p_max_citas_por_telefono int
) returns void
language plpgsql volatile security definer set search_path = public, pg_temp as $$
begin
  perform _exige_admin();
  begin
    update ajustes
       set paso_min = p_paso_min, antelacion_min = p_antelacion_min, dias_max = p_dias_max,
           limite_cambio_min = p_limite_cambio_min, max_citas_por_telefono = p_max_citas_por_telefono
     where id = 1;
  exception when check_violation or not_null_violation then
    raise exception 'VALOR_NO_VALIDO' using errcode = 'P0001';
  end;
end $$;

-- ─── Permisos ───────────────────────────────────────────────────────────────
revoke all on function
  public._enlaza_cuenta(), public._exige_admin(), public._slug(text),
  public.admin_datos(),
  public.admin_guardar_servicio(text, text, text, int, numeric, boolean),
  public.admin_borrar_servicio(text),
  public.admin_guardar_barbero(uuid, text, text, boolean, boolean),
  public.admin_borrar_barbero(uuid),
  public.admin_ordenar(text, text[]),
  public.admin_guardar_horario(uuid, jsonb),
  public.admin_guardar_ajustes(int, int, int, int, int)
from public, anon;
grant execute on function
  public.admin_datos(),
  public.admin_guardar_servicio(text, text, text, int, numeric, boolean),
  public.admin_borrar_servicio(text),
  public.admin_guardar_barbero(uuid, text, text, boolean, boolean),
  public.admin_borrar_barbero(uuid),
  public.admin_ordenar(text, text[]),
  public.admin_guardar_horario(uuid, jsonb),
  public.admin_guardar_ajustes(int, int, int, int, int)
to authenticated;
