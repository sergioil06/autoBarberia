-- Datos iniciales. ⚠️ PROVISIONAL: los mismos datos de ejemplo que la web.
-- Cambiadlos desde el panel (o aquí) por los reales.

insert into public.servicios (id, nombre, descripcion, minutos, precio_cents, orden) values
  ('corte',       'Corte',            'Tijera y máquina, con lavado y peinado.',          30, 1400, 1),
  ('degradado',   'Degradado',        'Fade a máquina, tan bajo o alto como lo quieras.', 40, 1600, 2),
  ('barba',       'Arreglo de barba', 'Perfilado a navaja y acabado con aceite.',         20,  900, 3),
  ('corte-barba', 'Corte + barba',    'El corte completo y la barba perfilada.',          50, 2100, 4)
on conflict (id) do nothing;

with b as (
  insert into public.barberos (nombre, orden, es_admin) values
    ('Álex', 1, true),
    ('Dani', 2, false)
  returning id
)
-- Lunes a sábado, 9:00–13:00 y 16:00–20:00.
insert into public.horarios (barbero_id, dia_semana, inicio, fin)
select b.id, d, f.inicio, f.fin
from b
cross join generate_series(1, 6) d
cross join (values (time '09:00', time '13:00'), (time '16:00', time '20:00')) f(inicio, fin);
