-- ═══════════════════════════════════════════════════════════════════════════
-- WhatsApp por Green-API (para la demo)
--
-- Green-API conecta un WhatsApp normal (como WhatsApp Web) y envía texto libre:
-- no necesita plantillas ni verificación de Meta. NO es oficial: Meta puede
-- bloquear el número. Úsalo con una SIM dedicada a pruebas, nunca con el
-- número real de un negocio.
--
-- Activar:
--   select vault.create_secret('API_TOKEN_INSTANCE', 'greenapi_token');
--   update ajustes set whatsapp_proveedor = 'greenapi',
--     greenapi_url = 'https://XXXX.api.greenapi.com', greenapi_instancia = 'ID_INSTANCE',
--     whatsapp_activo = true;
-- ═══════════════════════════════════════════════════════════════════════════

alter table public.ajustes
  add column if not exists whatsapp_proveedor text not null default 'meta'
    check (whatsapp_proveedor in ('meta', 'greenapi')),
  add column if not exists greenapi_url        text,  -- p. ej. https://7105.api.greenapi.com
  add column if not exists greenapi_instancia  text,  -- idInstance
  add column if not exists nombre_negocio      text not null default 'Llano Peluqueros';

-- Texto de los mensajes (Green-API envía texto libre; Meta usa plantillas).
-- p_parametros: [nombre, servicio, fecha, hora, barbero, código?]
create or replace function public._whatsapp_texto(p_tipo text, p_parametros text[], p_token_cita text)
returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case p_tipo
    when 'confirmacion' then format(
      E'Hola %s 👋\n\nTu cita en *%s* está confirmada:\n✂️ %s\n📅 %s a las %s\n💈 Con %s\nCódigo: %s\n\nPara ver, cambiar o cancelar tu cita:\n%s',
      p_parametros[1], a.nombre_negocio, p_parametros[2], p_parametros[3], p_parametros[4], p_parametros[5], p_parametros[6],
      a.web_url || '/cita/?t=' || p_token_cita)
    else format(
      E'Hola %s, te recordamos tu cita en *%s*:\n✂️ %s\n📅 %s a las %s\n💈 Con %s\n\nSi no puedes venir, cámbiala o cancélala aquí:\n%s',
      p_parametros[1], a.nombre_negocio, p_parametros[2], p_parametros[3], p_parametros[4], p_parametros[5],
      a.web_url || '/cita/?t=' || p_token_cita)
  end
  from ajustes a where a.id = 1
$$;

-- Envío: según el proveedor, Meta (plantillas) o Green-API (texto).
create or replace function public._whatsapp_enviar(
  p_cita uuid, p_tipo text, p_telefono text, p_plantilla text, p_parametros text[], p_token_cita text
) returns bigint
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare
  a ajustes;
  tok text;
  pid bigint;
  cuerpo jsonb;
  numero text := regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g');
begin
  select * into a from ajustes where id = 1;
  if not a.whatsapp_activo or p_telefono is null then return null; end if;

  -- ── Green-API ──
  if a.whatsapp_proveedor = 'greenapi' then
    if a.greenapi_url is null or a.greenapi_instancia is null then return null; end if;
    select decrypted_secret into tok from vault.decrypted_secrets where name = 'greenapi_token' limit 1;
    if tok is null then
      raise warning 'WhatsApp: falta el secreto greenapi_token en Vault';
      return null;
    end if;
    select net.http_post(
      url := format('%s/waInstance%s/sendMessage/%s', rtrim(a.greenapi_url, '/'), a.greenapi_instancia, tok),
      headers := jsonb_build_object('Content-Type', 'application/json'),
      body := jsonb_build_object('chatId', numero || '@c.us', 'message', _whatsapp_texto(p_tipo, p_parametros, p_token_cita))
    ) into pid;
    insert into whatsapp_envios (cita_id, tipo, telefono, peticion_id) values (p_cita, p_tipo, p_telefono, pid);
    return pid;
  end if;

  -- ── Meta (API oficial) ──
  if a.whatsapp_phone_number_id is null then return null; end if;
  select decrypted_secret into tok from vault.decrypted_secrets where name = 'whatsapp_token' limit 1;
  if tok is null then
    raise warning 'WhatsApp: falta el secreto whatsapp_token en Vault';
    return null;
  end if;

  if p_plantilla = 'hello_world' then
    -- Plantilla de prueba de Meta: sin parámetros y en inglés.
    cuerpo := jsonb_build_object(
      'messaging_product', 'whatsapp', 'to', numero, 'type', 'template',
      'template', jsonb_build_object('name', 'hello_world', 'language', jsonb_build_object('code', 'en_US')));
  else
    cuerpo := jsonb_build_object(
      'messaging_product', 'whatsapp', 'to', numero, 'type', 'template',
      'template', jsonb_build_object(
        'name', p_plantilla,
        'language', jsonb_build_object('code', a.idioma_plantillas),
        'components', jsonb_build_array(
          jsonb_build_object('type', 'body', 'parameters',
            (select jsonb_agg(jsonb_build_object('type', 'text', 'text', x)) from unnest(p_parametros) x)),
          jsonb_build_object('type', 'button', 'sub_type', 'url', 'index', '0', 'parameters',
            jsonb_build_array(jsonb_build_object('type', 'text', 'text', p_token_cita))))));
  end if;

  select net.http_post(
    url := format('https://graph.facebook.com/%s/%s/messages', a.whatsapp_version_api, a.whatsapp_phone_number_id),
    headers := jsonb_build_object('Authorization', 'Bearer ' || tok, 'Content-Type', 'application/json'),
    body := cuerpo
  ) into pid;
  insert into whatsapp_envios (cita_id, tipo, telefono, peticion_id) values (p_cita, p_tipo, p_telefono, pid);
  return pid;
end $$;

revoke all on function public._whatsapp_enviar(uuid, text, text, text, text[], text) from public, anon, authenticated;
revoke all on function public._whatsapp_texto(text, text[], text) from public, anon, authenticated;

-- La confirmación ya no depende de que haya un Phone number ID de Meta.
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
      split_part(new.cliente_nombre, ' ', 1), s, fecha_es(new.inicio, a.zona),
      to_char(new.inicio at time zone a.zona, 'HH24:MI'), b, new.codigo
    ],
    new.token
  );
  update citas set confirmacion_enviada_en = now() where id = new.id;
  return null;
end $$;
