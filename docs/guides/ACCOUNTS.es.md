# Cuentas, superadministradores y acceso del equipo: guía del operador

[English](ACCOUNTS.md) · **Español**

Público: quien opera una instalación de Mnemosyne. Contexto del modelo: [MULTI_TENANCY.md](../architecture/MULTI_TENANCY.md) (el plano de la instalación es la sección 2).

Esta guía cubre la etapa A: superadministradores, ciclo de vida de los usuarios (desactivar, volver a activar, dar de baja), miembros del espacio de trabajo, enlaces de un solo uso (invitaciones, configuración de cuenta, restablecimiento de contraseña) y la sección Instalación del panel. El autorregistro y el envío de correos son de la etapa B y **no están construidos**: el registro siempre está cerrado, y cada enlace lo copia un administrador y lo comparte a mano.

## 1. Conceptos

- **Superadministrador**: un rol de toda la instalación guardado en `mnemo_instance_admin`, aparte de la pertenencia a un tenant o a un espacio de trabajo. Se lee de la base de datos en cada solicitud, nunca de la cookie de sesión, así que una revocación se aplica en la siguiente solicitud.
- **Plano de la instalación**: rutas bajo `/instance/*`, montadas solo en el puente de cookies del panel. Aceptan una sesión con contraseña de un superadministrador vigente. Ninguna clave de API llega a ellas. Cualquier otra persona recibe el 404 simple de una ruta desconocida.
- **Qué puede hacer un superadministrador**: listar, crear, desactivar, volver a activar y dar de baja usuarios; otorgar y revocar el rol de superadministrador; listar todos los espacios de trabajo y gestionar sus miembros; cambiar los ajustes de la instalación; leer la auditoría de seguridad.
- **La autoridad del superadministrador permanece en la sesión.** Mientras tiene la sesión iniciada, la sesión de un superadministrador también incluye `admin:workspace` (configuración de LLM y de retención para toda la instalación). Una clave de API creada o rotada desde una sesión del panel nunca recibe ese permiso (403), porque la clave lo conservaría después de que se revoque al superadministrador.
- **Acceso de lectura a cualquier espacio de trabajo**: durante el período de pruebas actual, un superadministrador puede abrir cualquier espacio de trabajo (incluidos los personales) desde Instalación > Todos los espacios de trabajo y leer sus recuerdos sin ser miembro. La sesión es de solo lectura, salvo que sea miembro (entonces conserva su rol real). La apertura queda auditada (`workspace_opened`); las lecturas individuales no. Más adelante se auditará cada lectura y será configurable.
- **Roles del espacio de trabajo**: propietario (`owner`), administrador (`admin`), colaborador (`write`) y lector (`read`). Los propietarios y los administradores gestionan los miembros y las invitaciones de su espacio de trabajo. Un administrador no puede invitar, cambiar ni quitar a un propietario. Un espacio de trabajo siempre conserva al menos un propietario activo.
- **Los espacios de trabajo personales no admiten invitaciones.** Comparte un espacio de trabajo de organización en su lugar.

## 2. Despliegue y migración

1. Haz primero una copia de seguridad:

   ```bash
   docker compose exec postgres pg_dump -U <owner> -Fc <database> > mnemosyne-$(date +%F).dump
   ```

2. Ejecuta las migraciones **antes** de iniciar el servidor nuevo. Esta etapa añade de `0050` a `0055`: `0050` ciclo de vida del usuario y superadministrador, `0051` la función de administrador de arranque, `0052` el plano de la instalación, `0053` espacios de trabajo y bajas, `0054` enlaces de un solo uso, `0055` la auditoría de seguridad. En la configuración con compose es `docker compose up migrate`. La conexión de migración (`MIGRATE_DATABASE_URL`) debe ser de un superusuario o de un rol con `BYPASSRLS`: las funciones de la instalación se ejecutan con ese rol y dependen de que omita RLS. Ser propietario de las tablas no basta, porque el propietario de una tabla sin `BYPASSRLS` no omite `FORCE ROW LEVEL SECURITY`.
3. Inicia el servidor y el panel nuevos.
4. ¿Hay un proxy delante? Entonces define `MNEMO_PUBLIC_BASE_URL` (consulta la sección 5).

Tras la migración, el rol de la aplicación ya no puede escribir `disabled_at` en `mnemo_user` ni escribir en `mnemo_instance_admin`. Esos cambios pasan solo por las funciones de la instalación.

## 3. Primer superadministrador

Hay dos maneras. Usa una.

### 3.1 Arranque en la primera ejecución

En una instalación nueva, `/dashboard/setup` (`POST /bootstrap`) acepta `adminEmail` y `adminPassword` juntos (o ninguno). La petición debe llevar el token de configuración que el servidor imprime en su registro al arrancar (`setupToken` en el cuerpo o la cabecera `X-Setup-Token`; `MNEMO_SETUP_TOKEN` fija uno para instalaciones desatendidas): sin él la respuesta es 401 `setup_token_required`. Crea a ese usuario, lo convierte en superadministrador y registra `user_created` y `superadmin_granted` en el registro de auditoría (actor `system:bootstrap`). Solo funciona antes de que exista la primera clave de API; después responde 403 `already_bootstrapped`. La función de la base de datos que la respalda también se niega, a menos que la instalación no tenga ningún superadministrador y, como máximo, la única clave que el arranque acaba de crear, y que el usuario exista y esté activo. Una instalación que ya está en uso y todavía no tiene superadministrador (por ejemplo, justo después de actualizar a esta etapa) obtiene el primero con el script de emergencia, nunca desde la aplicación.

### 3.2 Script de emergencia

Para una instalación existente, o para recuperarte cuando ningún superadministrador puede iniciar sesión:

```bash
docker compose exec -e MNEMO_ADMIN_DATABASE_URL='postgres://<owner>:<secret>@postgres:5432/<db>' \
  server node scripts/dashboard-password.mjs --email <email> --superadmin < password-file
```

Reglas:

- `MNEMO_ADMIN_DATABASE_URL` es la URL de un superusuario o de un rol con `BYPASSRLS` (el rol de migración, sección 2). Debe omitir RLS en `mnemo_instance_admin`, en la que el rol de la aplicación no puede escribir. Pásala **solo en tiempo de ejecución** con `-e`, como arriba. Nunca la pongas en el entorno del servidor, en `.env` ni en el archivo de compose.
- La contraseña viene de stdin (un archivo o una tubería, nunca un argumento; el script rechaza un terminal). Debe cumplir la política: al menos 12 caracteres, como máximo 72 bytes y distinta del correo. Borra el archivo después.
- `DATABASE_URL` ya debe estar definida en el contenedor (lo está, para el servidor).
- El usuario debe existir o debes añadir `--create` (que también aprovisiona su tenant y su espacio de trabajo personales). Con `--create --workspace <id>`, el usuario nuevo recibe acceso de lectura exactamente a ese espacio de trabajo (más un tenant personal, sin espacio de trabajo personal); `--workspace` solo se acepta con `--create`. Con `--superadmin`, se rechaza a un usuario desactivado; actívalo primero.
- Definir una contraseña con el script termina todas las sesiones abiertas del panel de ese usuario, igual que un enlace de restablecimiento (en un servidor en ejecución, dentro de la caché de estado de 15 segundos, sección 6). Úsalo como restablecimiento de contraseña de emergencia.
- El script define la contraseña y después otorga el rol de superadministrador. Si el otorgamiento falla, recibes el mensaje «Password set, but the superadmin grant failed»; revisa la URL y las migraciones. Si el usuario se desactivó entre los dos pasos, recibes «Password set, but the user is disabled so superadmin was not granted»; actívalo y ejecútalo de nuevo.
- **Los otorgamientos del script no aparecen en el registro de auditoría del panel.** Ese registro está encadenado con hashes y una inserción directa podría romper su verificación, por eso el script no escribe en él. El registro de un otorgamiento de emergencia es el historial de shell del operador (y el registro de despliegue). Consérvalo.

### Ejemplo: mnemo.example.com

```bash
# On the host, after migrations; the file holds a password chosen for this purpose.
docker compose exec -e MNEMO_ADMIN_DATABASE_URL="$ADMIN_URL" \
  server node scripts/dashboard-password.mjs --email admin@example.com --superadmin < /root/admin-password.txt
shred -u /root/admin-password.txt
```

## 4. Operaciones del día a día (sección Instalación)

Los superadministradores ven un grupo **Instalación** en la barra lateral: Usuarios, Todos los espacios de trabajo, Ajustes, Auditoría de seguridad. Nadie más ve nada de eso.

### 4.1 Usuarios

- **Crear usuario**: introduce un correo (y un nombre opcional). La respuesta es un **enlace de configuración de cuenta** de un solo uso (válido 7 días). Envíaselo a la persona; ella elige una contraseña y llega a su espacio de trabajo personal. Un correo que ya está en uso responde 409 `email_taken`.
- **Desactivar / volver a activar**: un usuario desactivado no puede iniciar sesión, sus sesiones terminan y sus claves y tokens asociados al usuario (`uk_live_*` y las claves asociadas al usuario) dejan de autenticar en todos los transportes. Los datos, las pertenencias y los tokens se conservan, así que volver a activarlo restablece el acceso. **Desactivar al único propietario activo de un espacio de trabajo compartido lo deja sin un propietario que pueda actuar**: nadie allí puede gestionar miembros ni invitaciones hasta que un superadministrador promueva a otro miembro a propietario (Instalación > Todos los espacios de trabajo) o vuelva a activar al usuario. Revisa los espacios de trabajo de los que es propietario un usuario antes de desactivarlo; la baja (siguiente punto) pide un nuevo propietario en su lugar.
- **Dar de baja**: desactiva al usuario, elimina todas sus pertenencias a espacios de trabajo y tenants excepto su tenant personal, revoca sus tokens `uk_live_*` y sus claves de API asociadas al usuario, retira cualquier otorgamiento de superadministrador y termina sus sesiones, todo en una sola transacción. El espacio de trabajo personal y sus datos se conservan. Si el usuario es el último propietario de un espacio de trabajo compartido, la llamada responde 409 `owner_required` y el cuadro de diálogo lista esos espacios de trabajo; elige un nuevo propietario para cada uno y repite. Volver a activar a un usuario dado de baja no restablece las pertenencias ni el rol de superadministrador. La baja puede dejar un tenant sin un propietario del tenant: los nuevos propietarios de espacio de trabajo que elijas se unen al espacio de trabajo como propietario, pero al tenant solo como member. Los enlaces de configuración de cuenta y de restablecimiento que el usuario dado de baja emitió como superadministrador dejan de funcionar.
- **Otorgar / quitar el rol de superadministrador**: pide tu propia contraseña en la misma solicitud (una incorrecta cuenta para tu bloqueo de inicio de sesión). No se puede revocar, desactivar ni dar de baja al último superadministrador activo (409 `last_superadmin`).
- **Enlace de restablecimiento**: genera para un usuario un enlace de restablecimiento de contraseña de un solo uso (válido 30 minutos). Restablecer desbloquea una cuenta bloqueada y termina todas sus sesiones. Solo los superadministradores pueden hacerlo: una cuenta abarca todos los espacios de trabajo a los que pertenece su titular, así que un administrador de espacio de trabajo no puede.
- Los enlaces de configuración de cuenta y de restablecimiento funcionan solo mientras quien los emitió siga siendo un superadministrador activo: una vez que se revoca, desactiva o da de baja a quien los emitió, sus enlaces pendientes se rechazan (404). Emite uno nuevo desde otro superadministrador.

### 4.2 Espacios de trabajo y miembros

- Instalación > Todos los espacios de trabajo lista todos los espacios de trabajo con su tenant, su propietario y el número de miembros. **Abrir** cambia tu sesión a ese espacio de trabajo (solo lectura, salvo que seas miembro). Los superadministradores también pueden cambiar roles y quitar miembros de cualquier espacio de trabajo desde ahí. **Mis espacios de trabajo** (arriba en la barra lateral) es distinto: muestra solo los espacios de trabajo a los que perteneces y el formulario para crear uno.
- **Agregar miembro** (en el panel Miembros de un espacio de trabajo, ahí mismo) añade una cuenta existente por correo con cualquier rol, al instante y sin invitación; se audita como `member_added`. Es la forma en que un espacio de trabajo **sin propietario** (uno creado con una clave de operador, por ejemplo) obtiene uno: nadie puede gestionar un espacio de trabajo así, invitar a él ni crear sus claves hasta que tenga un propietario, y la lista lo señala. Se rechaza para un espacio de trabajo personal (409 `personal_workspace`), para un correo sin cuenta (`unknown_email`), para una cuenta desactivada (`user_disabled`) y para alguien que ya está en el espacio de trabajo (`already_member`). La migración `0057` añade la función que lo respalda.
- Los propietarios y los administradores de un espacio de trabajo usan **Miembros** en su propio espacio de trabajo: listar miembros, cambiar un rol, quitar a un miembro (se rechaza para el último propietario, 409 `last_owner`), invitar y gestionar las invitaciones pendientes.
- **Quitar a un miembro revoca sus claves de API de ese espacio de trabajo**, ya sea desde el panel, desde Instalación o desde la API v1 (`DELETE /workspaces/:id/members/:userId`, que usan la CLI y la herramienta MCP `memory_workspace`): cada token `uk_live_*` y cada clave asociada al usuario con origen en ese espacio de trabajo se revoca en la misma transacción y deja de autenticar de inmediato en el servidor que procesó la baja (los demás procesos del servidor, en el plazo de un minuto, por su caché de claves). Sus claves con origen en otros espacios de trabajo, incluido el personal, no se tocan. Volver a añadir al miembro no restablece las claves revocadas; creará otras nuevas.

### 4.3 Invitaciones y enlaces

- Un propietario o un administrador introduce un correo y un rol. El servidor devuelve el enlace **una sola vez**; cópialo y compártelo. No se puede mostrar de nuevo, solo regenerar (el enlace anterior deja de funcionar) o revocar.
- Vigencias: invitación y configuración de cuenta, 7 días; restablecimiento de contraseña, 30 minutos. Los enlaces son de un solo uso y solo se guarda su hash SHA-256.
- Al abrir el enlace: una persona nueva elige una contraseña y queda con la sesión iniciada en el espacio de trabajo; una cuenta existente inicia sesión primero y luego acepta. Aceptar añade la pertenencia al espacio de trabajo (y la pertenencia al tenant como `member`) en una sola transacción.
- Reinvitar a una dirección pendiente reemplaza la invitación pendiente. Invitar a alguien que ya es miembro responde 409.
- Las invitaciones se pueden desactivar en Instalación > Ajustes (`MNEMO_INVITATIONS_ENABLED` establece el valor inicial). Entonces no se crea ni se regenera ninguna invitación (403 `invitations_disabled`). **Desactivar las invitaciones no invalida los enlaces ya entregados**: las invitaciones pendientes todavía se pueden aceptar hasta que venzan. Revócalas en Miembros de cada espacio de trabajo (invitaciones pendientes) si deben dejar de funcionar.
- La emisión de enlaces tiene límite de tasa por usuario que actúa (30 cada 15 minutos). Los endpoints públicos de enlaces comparten el presupuesto de inicio de sesión por IP (más abajo).
- Cualquiera que tenga un enlace de invitación puede saber si esa dirección tiene una cuenta (riesgo aceptado). Trata los enlaces como secretos: no los pegues en canales compartidos.

### 4.4 Ajustes

Instalación > Ajustes (`GET/PUT /instance/settings`):

| Ajuste                                           | Notas                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Invitaciones a espacios de trabajo activadas     | Activado por defecto. Variable de entorno `MNEMO_INVITATIONS_ENABLED`; prevalece un valor guardado.                                                                                                                                                                                        |
| URL base pública                                 | Se usa para construir los enlaces. Variable de entorno `MNEMO_PUBLIC_BASE_URL`; prevalece un valor guardado. `https` en cualquier parte, `http` solo para localhost; sin credenciales, consulta ni fragmento. Se guarda cifrada con la clave maestra (501 `encryption_required` sin ella). |
| Registro                                         | Siempre `closed`, solo lectura.                                                                                                                                                                                                                                                            |
| Espacios de trabajo por usuario                  | 5 por defecto. Variable de entorno `MNEMO_WORKSPACE_LIMIT_PER_USER`; prevalece un valor guardado. Espacios de trabajo de equipo que un usuario que no es superadministrador puede crear y poseer (los personales no cuentan); 0 deja la creación a los superadministradores.               |
| Los propietarios pueden definir su propio modelo | Desactivado por defecto. Variable de entorno `MNEMO_WORKSPACE_LLM_OVERRIDE`; prevalece un valor guardado. Consulta la sección 4.5.                                                                                                                                                         |

Cada valor indica su origen: guardado, variable de entorno o valor por defecto.

### 4.4.1 Creación de espacios de trabajo

Cualquier usuario con la sesión iniciada crea un espacio de trabajo de equipo del que es propietario desde **Mis espacios de trabajo** en la barra lateral (`POST /dashboard/api/my-workspaces`, solo sesiones con contraseña). Cada uno recibe su propio tenant de organización, con quien lo crea como propietario del tenant y del espacio de trabajo, así que admite miembros, invitaciones y claves de API como cualquier espacio de trabajo de equipo. Un usuario que no es superadministrador puede ser propietario de como máximo «Espacios de trabajo por usuario» espacios de trabajo de equipo (409 `workspace_limit`); la base de datos cuenta bajo un bloqueo por usuario, así que las solicitudes concurrentes no pueden superarlo. La creación se audita como `workspace_created` en el nuevo espacio de trabajo. La misma página cambia la sesión a cualquier espacio de trabajo al que pertenezca el usuario, sin cerrar sesión.

Para conectar un agente o una herramienta (un orquestador, un motor de flujos), abre el espacio de trabajo, crea una clave de API en Claves con `memory:read` y `memory:write`, y entrégasela a esa herramienta: todo lo que recuerde y recupere se queda en ese espacio de trabajo.

### 4.5 Quién define el modelo de un espacio de trabajo

Un espacio de trabajo puede reemplazar el proveedor de LLM, el modelo y la clave de API de la instalación (página Configuración, `PUT/DELETE /config/llm`). Entonces, cada llamada de completado y de embeddings para los recuerdos de ese espacio de trabajo va a ese proveedor, desde la red del servidor.

- **Por defecto solo los administradores de la instalación pueden cambiarlo**: la sesión con contraseña de un superadministrador o una clave de operador con `admin:workspace`. Los propietarios y los administradores del espacio de trabajo ven el modelo en solo lectura, y el servidor responde a sus escrituras con 403 `LLM_CONFIG_INSTALLATION_ONLY`.
- **Con «Los propietarios pueden definir su propio modelo» activado**, los propietarios y los administradores (`memory:admin`) también pueden definirlo. Su `baseUrl` debe ser `https://` y no puede ser ni resolverse a una dirección de loopback, privada, de NAT de operador, de enlace local (metadatos de la nube) o de multidifusión (422 `BASE_URL_NOT_HTTPS`, `BASE_URL_PRIVATE_ADDRESS`, `BASE_URL_UNRESOLVABLE`, `BASE_URL_INVALID`); `ollama` necesita una `baseUrl` así (422 `BASE_URL_REQUIRED`). La comprobación se ejecuta cuando se guarda la URL; un host cuya respuesta de DNS cambie más tarde no se vuelve a comprobar.
- Las URL base de los administradores de la instalación no se comprueban: un Ollama interno o un proxy es decisión suya.
- Cada guardado y cada eliminación se audita como `settings_changed` con el recurso `llm_config`: proveedor, modelos y el host de la URL base, nunca la clave.

### 4.5.1 Las claves de API de un espacio de trabajo

Claves (propietarios y administradores del espacio de trabajo, `admin:keys`) lista todas las claves vigentes del espacio de trabajo abierto, sin importar quién las creó: el panel, la CLI, `POST /admin/keys` o un operador. Cada fila muestra su etiqueta, sus permisos, la fecha de creación, el último uso y el vencimiento. Ninguna clave de un espacio de trabajo queda oculta en esta página. Antes del 2026-11-04 la página leía el campo equivocado de la respuesta y no listaba ninguna.

- **Rotar** crea una clave con la misma etiqueta y los mismos permisos y la muestra una sola vez, con un botón Copiar. La clave anterior sigue funcionando 7 días para que los clientes puedan cambiarse. Su fila dice _Rotada · válida hasta …_ y no se puede volver a rotar.
- **Revocar** termina una clave de inmediato. El proceso del servidor que procesó la revocación olvida la clave al instante. Otro proceso del servidor aún puede aceptarla hasta 60 segundos, la vida de su caché de autenticación.
- Revoca la clave anterior en cuanto todos los clientes usen la nueva, en lugar de esperar los 7 días.

### 4.6 Auditoría de seguridad

Instalación > Auditoría de seguridad (`GET /instance/audit`) lista, de la más reciente a la más antigua, 50 por página, con filtros por actor, acción y fecha: inicios de sesión (correctos y fallidos), usuario creado/desactivado/activado/dado de baja, superadministrador otorgado/revocado, miembro añadido/quitado/rol cambiado, invitaciones creadas/revocadas/aceptadas, enlaces creados, contraseña cambiada/restablecida, ajustes cambiados, espacio de trabajo abierto, y clave de API creada/rotada/revocada. Los enlaces, los tokens y las contraseñas nunca se registran. Los inicios de sesión limitados por tasa no se auditan. La página Auditoría existente (olvidos y archivados de hechos) no cambia. Los otorgamientos del script de emergencia **no** están aquí (sección 3.2).

`GET /instance/audit/stats?days=30` cuenta esas mismas acciones por día UTC y por acción (de 7 a 90 días; `failedSignIns7d` cuenta los inicios de sesión fallidos de los últimos 7 días), e Instalación > Espacios de trabajo trae los recuerdos vivos de cada espacio (bajo el techo de sensibilidad de quien llama) y su última escritura; ambos leen con las funciones solo para superadministradores de la migración 0060.

## 5. URL base pública detrás de un proxy

Los enlaces se construyen a partir de `MNEMO_PUBLIC_BASE_URL` o del ajuste guardado de Instalación (prevalece el guardado). Si no hay ninguno, el enlace lleva el origen de la solicitud. Detrás de un proxy inverso, ese origen suele ser la dirección interna, así que los enlaces que copies serán incorrectos. **Defínela antes de crear la primera invitación**, por ejemplo `https://mnemo.example.com`. El proxy que está delante del panel también debe sobrescribir las cabeceras de IP del cliente (`X-Forwarded-For`) para que los límites por IP vean la dirección real.

## 6. Sesiones y tiempos

- Las sesiones se comprueban en vivo. Desactivar, dar de baja, la revocación de sesiones (cambio o restablecimiento de contraseña, revocación de superadministrador) y los cambios de rol o de pertenencia se aplican en la siguiente solicitud. El único retraso es una caché de estado por proceso de 15 segundos sobre el estado del usuario. Claves de API: el servidor que hizo un cambio descarta de inmediato las claves y los roles en caché del usuario; los demás procesos del servidor mantienen una caché de claves de 60 segundos y una caché de roles de 30 segundos (`MNEMO_ROLE_CACHE_TTL_MS`).
- La API del panel (`/dashboard/api/*`) rechaza con 403 `invalid_origin` una solicitud que modifica el estado y que el navegador marca como proveniente de otro sitio o de un subdominio hermano (`Sec-Fetch-Site` distinto de `same-origin` o `none`). Los endpoints de inicio de sesión (`/dashboard/auth/*`) rechazan así solo los POST `cross-site`; además exigen `application/json`, que un navegador no puede enviar entre orígenes sin una comprobación previa de CORS que el servidor no concede. Sirve el panel en su propio origen.
- Una sesión lleva una época (`iat`) que se compara con `sessions_valid_after`. La comparación usa el reloj de la base de datos y el reloj de la aplicación, por lo que **los hosts deben ejecutar NTP**. Un reloj de la aplicación desfasado puede rechazar sesiones nuevas o conservar las antiguas.
- Desactivar a un usuario también detiene sus claves y tokens asociados al usuario en HTTP, gRPC, la actualización a WebSocket y `/health/deep`. **Limitación conocida:** las conexiones WebSocket que ya estaban abiertas y los flujos gRPC largos no se cortan; terminan cuando el cliente se reconecta.
- `MNEMO_DASHBOARD_LOGIN_IP_BURST` (por defecto 30 cada 15 minutos) dimensiona el token bucket por IP que comparten el inicio de sesión y los endpoints públicos de enlaces. Auméntalo cuando haya muchos usuarios detrás de una misma dirección NAT. Los buckets por correo y por usuario son independientes.

## 7. Runbook de despliegue (etapa A, ejemplo)

Para `mnemo.example.com`:

1. Haz una copia de seguridad con `pg_dump`; ejecuta las migraciones de `0050` a `0055`; despliega el servidor y el panel nuevos.
2. Otorga el rol de superadministrador a `admin@example.com` (ejemplo de la sección 3.2, o el arranque en la primera ejecución en una instalación vacía).
3. Define la URL base pública como `https://mnemo.example.com` (Instalación > Ajustes o `MNEMO_PUBLIC_BASE_URL`).
4. Inicia sesión como el superadministrador; confirma que aparece la sección Instalación.
5. Invita una dirección de prueba a un espacio de trabajo de organización, abre el enlace en una ventana privada, elige una contraseña, inicia sesión y luego da de baja a ese usuario desde Instalación > Usuarios.
6. Comprueba que Auditoría de seguridad muestra la invitación, la aceptación y la baja.

La etapa B (proveedor de correo, autorregistro restringido por dominio) no está construida.

## 8. Solución de problemas

| Síntoma                                                                      | Causa                                                                                               |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| La sección Instalación no aparece                                            | El usuario no es superadministrador en este momento, o inició sesión con una clave de API.          |
| Los enlaces muestran un host interno                                         | No se definió la URL base pública (sección 5).                                                      |
| Script: necesita `MNEMO_ADMIN_DATABASE_URL`                                  | Pasa la URL del propietario o superusuario con `-e` en tiempo de ejecución.                         |
| Script: contraseña definida pero el otorgamiento falló                       | La URL no tiene los permisos necesarios o las migraciones no se ejecutaron.                         |
| Script: contraseña definida, usuario desactivado                             | Activa al usuario (Instalación > Usuarios) y vuelve a ejecutar el script.                           |
| 403 `invalid_origin` en una acción del panel                                 | La solicitud vino de otro sitio o subdominio (sección 6).                                           |
| El enlace de configuración o de restablecimiento responde 404                | Venció, se usó, se revocó, o quien lo emitió ya no es superadministrador.                           |
| Sesiones nuevas rechazadas, cierres de sesión extraños                       | Desfase de reloj entre la aplicación y el host de la base de datos (NTP).                           |
| 429 en el inicio de sesión o en las páginas de enlaces para toda una oficina | Una IP agotó el bucket; aumenta `MNEMO_DASHBOARD_LOGIN_IP_BURST`.                                   |
| 409 `owner_required` al dar de baja                                          | El usuario es el último propietario de un espacio de trabajo compartido; elige nuevos propietarios. |
| 409 `last_superadmin`                                                        | Otorga primero el rol a otro superadministrador.                                                    |
