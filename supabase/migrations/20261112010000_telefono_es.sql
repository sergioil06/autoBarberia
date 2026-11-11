-- Los teléfonos de España (+34) deben tener exactamente 9 cifras y empezar por 6, 7, 8 o 9.
-- (Antes se aceptaba, por ejemplo, +34 671 38 12 9, con una cifra de menos.)
create or replace function public.normaliza_telefono(p text) returns text
language plpgsql immutable as $$
declare t text := regexp_replace(coalesce(p, ''), '[\s().-]', '', 'g');
begin
  if t ~ '^00[0-9]+$' then t := '+' || substr(t, 3); end if;
  if t ~ '^34[6789][0-9]{8}$' then t := '+' || t; end if;
  if t ~ '^[6789][0-9]{8}$' then t := '+34' || t; end if;
  if t ~ '^\+34' then
    return case when t ~ '^\+34[6789][0-9]{8}$' then t else null end;
  end if;
  if t ~ '^\+[0-9]{9,15}$' then return t; end if;
  return null;
end $$;
