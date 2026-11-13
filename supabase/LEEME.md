# Reservas de Llano Peluqueros: puesta en marcha

La web funciona en **modo demostración** hasta que se conecta Supabase. Pasos para activarla:

## 1. Crear el proyecto
1. Crea una cuenta en <https://supabase.com> y un proyecto nuevo (plan gratuito, región **Europa (Frankfurt o París)**).
2. Guarda la contraseña de la base de datos en un sitio seguro.

## 2. Crear las tablas y los datos
1. En el proyecto: **SQL Editor → New query**.
2. Pega el contenido de `migrations/20261111000000_reservas.sql` y pulsa **Run**.
3. Nueva consulta: pega `seed.sql` y pulsa **Run** (servicios, barberos y horario provisionales).

## 3. Cuentas de los barberos (panel)
1. **Authentication → Users → Add user → Create new user**: email y contraseña de cada barbero (marca *Auto Confirm User*).
2. Copia el **User UID** de cada uno y asócialo a su barbero en el **SQL Editor**:
   ```sql
   update barberos set user_id = 'PEGA-AQUÍ-EL-UID' where nombre = 'Álex';
   ```
   El dueño, además: `update barberos set es_admin = true where nombre = 'Álex';`
3. En **Authentication → Providers → Email**, desactiva **Allow new users to sign up** (solo el dueño crea cuentas).

## 4. Conectar la web
En **Project Settings → API** copia la *Project URL* y la clave *anon public*, y añádelas como variables de entorno en el alojamiento (Netlify, Cloudflare o Vercel):

```
PUBLIC_SUPABASE_URL=https://xxxx.supabase.co
PUBLIC_SUPABASE_ANON_KEY=eyJ...
```

Vuelve a desplegar. La clave *anon* es pública a propósito: con ella solo se pueden usar las funciones de reserva, no leer las tablas. **La clave `service_role` no debe ir nunca en la web.**

## Gestión desde el panel (dueño)
Aplica también `migrations/20261113000000_gestion.sql` (SQL Editor → Run). Después, un barbero con `es_admin = true` ve el botón **Gestión** en la agenda (web y app del móvil) y puede:
- **Servicios**: crear, cambiar nombre, descripción, duración y precio, ordenar, ocultar o eliminar.
- **Peluqueros**: dar de alta, cambiar nombre y email de acceso, hacer admin, ordenar, dar de baja o eliminar. Un peluquero nuevo empieza con el horario del primero del equipo.
- **Horarios**: las franjas de cada día para cada peluquero.
- **Reservas**: los ajustes de la tabla de abajo.

Lo que ya tiene citas no se borra (se perdería el historial): se oculta o se da de baja. Un peluquero con citas pendientes no se puede dar de baja hasta moverlas o cancelarlas.

**Acceso de un peluquero nuevo:** ponle un email en Gestión y crea su usuario en **Authentication → Users → Add user** con ese mismo email. Se enlaza solo, sin SQL.

## Ajustes
Se cambian en Gestión → Reservas (o en la tabla `ajustes`):
| Campo | Qué es | Por defecto |
|---|---|---|
| `paso_min` | cada cuántos minutos empieza un hueco | 15 |
| `antelacion_min` | antelación mínima para reservar | 120 (2 h) |
| `dias_max` | hasta cuántos días vista se puede reservar | 30 |
| `limite_cambio_min` | hasta cuánto antes se puede cambiar o cancelar | 120 (2 h) |
| `max_citas_por_telefono` | citas futuras a la vez por teléfono | 3 |

Horarios: tabla `horarios` (un registro por barbero, día y franja; 0 = domingo).

## Pruebas
```
cd supabase/tests && npm install && npm test
```
`node servidor-prueba.mjs` levanta una API de prueba en `http://localhost:54321` (usuario del panel: `alex@llano.test` / `prueba123`).
