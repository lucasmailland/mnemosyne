# Despliegue en producción: servidor y panel

[English](PRODUCTION_DEPLOY.md) · **Español**

Cómo ejecutar juntos el servidor de la API y el panel web en producción con la capa de Docker
Compose `docker/docker-compose.prod.yml`. Los demás destinos (Railway, imágenes
precompiladas, operación del día 2) empiezan en [DEPLOYMENT.md](../DEPLOYMENT.es.md). Los
cambios del servidor de los que depende el panel actual están en [DASHBOARD_DEPLOY.md](DASHBOARD_DEPLOY.es.md).

## Qué se ejecuta

| Servicio    | Se compila desde              | Escucha en                          | Función                                    |
| ----------- | ----------------------------- | ----------------------------------- | ------------------------------------------ |
| `migrate`   | `docker/Dockerfile.migrate`   | nada (se ejecuta una vez y termina) | Aplica las migraciones de la base de datos |
| `server`    | `docker/Dockerfile.server`    | `3000` en la capa de producción     | La API HTTP (una réplica o más)            |
| `dashboard` | `docker/Dockerfile.dashboard` | `3000`, bajo `/dashboard`           | El panel web de Next.js                    |

Junto a ellos se ejecutan `pgbouncer` (agrupa en un pool las conexiones del servidor a Postgres,
en modo de transacción), `redis-master` (el Redis del servidor) con `redis-replica-1` y
`redis-replica-2`, y `otel-collector`, además de `postgres` y `redis` del archivo base (y `ollama` solo con `--profile local`).
La capa de producción publica Postgres, Redis, pgBouncer, Ollama y el colector solo en `127.0.0.1`.

La capa de producción necesita Docker Compose 2.24 o posterior: reemplaza el puerto del servidor
del archivo base con `!override`, que las versiones anteriores rechazan.

Las tres imágenes se basan en `node:22-alpine` (Node 22). Los paquetes de npm siguen
funcionando con Node 20 o posterior; solo el build y las imágenes pasaron a 22. La imagen del
servidor no incluye el panel, y en GHCR solo se publican las imágenes del servidor y de las
migraciones: compila la imagen del panel desde este repositorio.

## Antes de compilar el panel

- **Google Fonts al compilar.** El build descarga Inter, JetBrains Mono y GFS Didot una sola
  vez desde `fonts.googleapis.com` y `fonts.gstatic.com` y las incluye en la imagen. El
  contenedor en ejecución nunca llama a Google. Una máquina de build sin acceso a esos hosts
  hace fallar el build.
- **`MNEMO_SERVER_URL` es un argumento de build y una variable de ejecución.** El panel
  reenvía `/dashboard/auth/*`, `/dashboard/api/*` y `/dashboard/bootstrap*` al servidor, y
  esas reescrituras quedan escritas en la imagen al compilarla. Las páginas que se generan en
  el servidor leen la misma variable al ejecutarse. Define las dos con la misma dirección; la
  capa de producción usa `http://server:3000` en ambas. Si solo la defines al ejecutar, las
  reescrituras conservan el valor por defecto del build, `http://mnemosyne-server:3939`
  (`docker/Dockerfile.dashboard`), y el inicio de sesión falla sin un error claro salvo que
  algo responda con ese nombre. Compila una imagen por cada dirección de servidor.

## Ajustes que exige la capa de producción

Mientras falte alguno de estos, Compose se detiene antes de iniciar nada y nombra la variable:

| Variable                       | Qué es                                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `POSTGRES_PASSWORD`            | La contraseña del superusuario de Postgres. En producción no tiene valor por defecto.                                                   |
| `MNEMO_MIGRATION_DATABASE_URL` | La URL del superusuario directa a Postgres, para las migraciones: `postgres://mnemo:<POSTGRES_PASSWORD>@postgres:5432/mnemo`.           |
| `MNEMO_APP_DB_PASSWORD`        | La contraseña del rol de la aplicación. `migrate` crea el rol (`mnemo_app`) y pgBouncer inicia sesión en Postgres con ella.             |
| `DATABASE_URL_PROD`            | La URL del servidor, a través de pgBouncer: `postgres://mnemo_app:<MNEMO_APP_DB_PASSWORD>@pgbouncer:5435/mnemo`.                        |
| `MNEMO_MASTER_KEY`             | Cifra las filas confidenciales y restringidas. 64 caracteres hexadecimales (`openssl rand -hex 32`); sin ella el servidor no arranca.   |
| `MNEMO_KEY_PEPPER`             | Protege los tokens de API guardados. 64 caracteres hexadecimales (`openssl rand -hex 32`); sin ella el servidor no arranca.             |
| `REDIS_PASSWORD`               | La contraseña que pide cada nodo de Redis; la URL por defecto del servidor la lleva. Sin caracteres especiales: `openssl rand -hex 32`. |
| `MNEMO_DASHBOARD_SECRET`       | Consulta la sección siguiente.                                                                                                          |

`MNEMO_LLM_API_KEY` y los ajustes del modelo están en [`docker/README.md`](../../docker/README.es.md).

**Métricas.** `GET /metrics` y `GET /metrics/prometheus` sirven las métricas de Prometheus. Con
`NODE_ENV=production`, que la capa de producción define, las dos responden `404` hasta que
definas `MNEMO_METRICS_TOKEN` (`openssl rand -hex 32`); desde ahí cada lectura tiene que mandar
`Authorization: Bearer <token>` y cualquier otro pedido recibe `401`. Igual conviene que el proxy
de borde no enrute `/metrics*` desde internet: léelas desde dentro de la red.

**Redis.** El servidor se conecta a una sola URL de Redis, `MNEMO_REDIS_URL_PROD` (por defecto
`redis://:<REDIS_PASSWORD>@redis-master:6379/0`; una URL propia también tiene que llevar la contraseña), para el nivel caliente, los límites de tasa y la idempotencia. Su
cliente no sigue a Redis Sentinel, así que la capa de producción no ejecuta Sentinel: una
conmutación automática dejaría al servidor escribiendo en un nodo degradado de solo lectura. Las
réplicas siguen al maestro; para conmutar a mano, promueve una (`REPLICAOF NO ONE`) y apunta
`MNEMO_REDIS_URL_PROD` a ella. Un Redis administrado que conserva una sola dirección tras una
conmutación funciona igual.

**pgBouncer.** No puede llevar los parámetros de inicio del servidor (`search_path` y los límites
`MNEMO_PG_*_TIMEOUT_MS`) a las sesiones del pool, así que los descarta, y la sesión toma los mismos
valores del rol de la aplicación: `migrate` los define con `ALTER ROLE … IN DATABASE`. Para
cambiarlos, define `MNEMO_PG_STATEMENT_TIMEOUT_MS`, `MNEMO_PG_LOCK_TIMEOUT_MS` o
`MNEMO_PG_IDLE_IN_TRANSACTION_TIMEOUT_MS` (milisegundos; 60000, 15000 y 60000 por defecto) en
`docker/.env`: la capa de producción los pasa tanto a `migrate` como al servidor, y los valores
nuevos rigen desde la siguiente ejecución de `migrate`.

## Ajustes del servidor que necesita el panel

| Variable                          | Obligatoria         | Qué hace                                                                                                                                                                                                                                                                             |
| --------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MNEMO_DASHBOARD_SECRET`          | Sí                  | Firma la cookie de sesión. Al menos 32 bytes (`openssl rand -hex 32`); con un valor más corto el servidor no arranca. Sin definir, el servidor arranca con el inicio de sesión del panel desactivado y lo registra una vez en nivel info. La capa de producción no arranca sin ella. |
| `MNEMO_PUBLIC_BASE_URL`           | Recomendada         | El origen HTTPS público del panel, que se usa en los enlaces que muestran Miembros y las invitaciones. Un valor guardado en Instalación > Ajustes tiene prioridad.                                                                                                                   |
| `MNEMO_DASHBOARD_INSECURE_COOKIE` | Nunca en producción | Solo para desarrollo: envía la cookie sin `Secure` para que el inicio de sesión funcione por HTTP sin cifrar. Con `NODE_ENV=production` el server se niega a arrancar si vale `true` (lo mismo con `MNEMO_ALLOW_UNSAFE_DB_ROLE`).                                                    |

Los ajustes propios del servidor (`DATABASE_URL_PROD`, `MNEMO_MIGRATION_DATABASE_URL`,
`MNEMO_APP_DB_PASSWORD`, `MNEMO_LLM_API_KEY` y el resto) se describen en
[`docker/README.md`](../../docker/README.es.md) y en `docker/.env.example`.

## HTTPS y el proxy de borde

La cookie de sesión, `mnemo_dash_token`, es `HttpOnly`, `Secure`, `SameSite=Lax` y
`Path=/dashboard`, y una sesión dura 8 horas. Los navegadores solo guardan una cookie `Secure`
recibida por HTTPS: por HTTP sin cifrar, el inicio de sesión responde que funcionó y la página
siguiente te devuelve al formulario. Termina TLS en un proxy de borde delante de los dos
contenedores.

Sirve los dos contenedores desde **un solo origen público** y enruta por ruta:

- `/dashboard` y `/dashboard/*` van al contenedor del panel (puerto 3000; la capa de
  producción lo publica solo en `127.0.0.1:3300`, `MNEMO_DASHBOARD_PORT`, así que el proxy
  corre en el mismo host y es la única entrada). Eso incluye
  `/dashboard/auth/*`, `/dashboard/api/*` y `/dashboard/bootstrap*`, que el propio panel
  reenvía al servidor.
- Todo lo demás va al servidor (puerto del host `PORT`, 3939 en `docker/.env.example`,
  asignado al 3000 del contenedor).

El servidor también responde `GET /dashboard` con su página de operador integrada; con este
enrutamiento, el panel web ocupa esa ruta. Un solo origen es obligatorio, no solo práctico: la
API del panel rechaza con `403 invalid_origin` las escrituras que el navegador marca como
provenientes de otro sitio, y la cookie solo se envía en las rutas `/dashboard`.

Las respuestas de error del servidor llevan `Content-Language` y `Vary: Accept-Language, Cookie`.
Si una CDN guarda en caché las respuestas de la API, mantén `Vary` en su clave de caché.

## Orden

1. **Migraciones.** `migrate` se ejecuta antes que el servidor, y Compose espera a que termine
   bien. El panel no tiene migraciones ni tablas propias.
2. **Primero el servidor, después el panel.** La capa de producción inicia el panel cuando el
   servidor está sano. Al actualizar, despliega primero el servidor: el panel llama a rutas y
   campos que los servidores anteriores no tienen, y con un servidor anterior esas páginas
   muestran estados vacíos en lugar de datos.

```bash
cd docker
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Los archivos base y de producción fijan el nombre del proyecto de Compose (`mnemosyne`), los nombres
de los contenedores y los de los volúmenes (`mnemosyne-pgdata`, `mnemosyne-ollama-data`) que usa la
pila local de desarrollo, así que en un host que también ejecuta esa pila este comando la reemplaza y
reutiliza sus datos: despliega en un host sin ella (o renombra antes los volúmenes) y nunca ejecutes
`down -v` en un host cuyos datos importen, porque borra esos volúmenes.

El servidor ejecuta una réplica por defecto. `docker compose` sin Swarm publica cada réplica en
el host, y un puerto del host atiende a una sola, así que para más réplicas dale a `PORT` un
rango con un puerto por réplica y apunta el proxy de borde a todos:

```bash
MNEMO_SERVER_REPLICAS=3 PORT=3939-3941 \
  docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

Con Docker Swarm (`docker stack deploy`), el ingress publica un único `PORT` para todas las
réplicas, así que alcanza con `MNEMO_SERVER_REPLICAS`.

## Comprobarlo

```bash
curl -fsS https://mnemo.example.com/health/ready
curl -sI https://mnemo.example.com/dashboard/login    # 200
```

`/health/ready` responde `{"status":"ready", … "checks":{"postgres":"ok", … "cache":"ok", …}}`:
`postgres` es el camino a través de pgBouncer y `cache` es Redis.

Después de iniciar sesión, la respuesta define `mnemo_dash_token` con `Secure` y
`Path=/dashboard`. En una instalación nueva y vacía, abre `/dashboard/setup` para crear el
primer superadministrador; consulta [ACCOUNTS.md](ACCOUNTS.es.md).

## Cuando algo falla

| Síntoma                                                                             | Causa                                                                                     |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| El inicio de sesión responde que funcionó y vuelve a aparecer el formulario         | El sitio se sirve por HTTP sin cifrar, así que el navegador descarta la cookie `Secure`.  |
| El inicio de sesión falla con un 404 o un error de conexión                         | La imagen del panel se compiló con un `MNEMO_SERVER_URL` incorrecto. Vuelve a compilarla. |
| Nadie puede iniciar sesión; el registro del servidor dice `dashboard auth disabled` | `MNEMO_DASHBOARD_SECRET` no está definido en el servidor.                                 |
| El servidor no arranca y nombra `MNEMO_DASHBOARD_SECRET`                            | El secreto tiene menos de 32 bytes.                                                       |
| Guardar cualquier cosa responde `403 invalid_origin`                                | El panel y el servidor se sirven desde orígenes distintos.                                |
| El build de la imagen del panel falla al descargar las fuentes                      | La máquina de build no llega a `fonts.googleapis.com` ni a `fonts.gstatic.com`.           |
| Compose se detiene con `required variable … is missing a value`                     | Falta alguno de los ajustes que exige la capa de producción.                              |
| `/health/ready` responde `postgres_unavailable`                                     | `DATABASE_URL_PROD` o `MNEMO_APP_DB_PASSWORD` no coinciden con el rol de la aplicación.   |
