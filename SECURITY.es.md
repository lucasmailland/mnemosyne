# Política de seguridad

[English](SECURITY.md) · **Español**

Mnemosyne guarda recuerdos en nombre de muchos tenants en una sola base de datos
Postgres. El aislamiento es el producto. Nos tomamos en serio los informes de seguridad y
agradecemos la divulgación responsable.

## Informar de una vulnerabilidad

**Por favor, no abras un issue público para problemas de seguridad.**

- Usa **GitHub Private Vulnerability Reporting** en este repositorio
  (Security → _Report a vulnerability_), con los pasos para reproducirlo, los
  paquetes y versiones afectados, y el impacto. El formulario está disponible
  mientras el repositorio sea público y la función esté activada en su configuración.
- Cuando el proyecto tenga una dirección de seguridad propia, se publicará aquí;
  mientras tanto, el formulario de GitHub de arriba es el único canal. No abras un issue público.

Buscamos acusar recibo en **72 horas** y entregar una corrección o mitigación de
los problemas de alta gravedad confirmados en **30 días**. Daremos crédito a quienes informen y
lo pidan, una vez publicada la corrección.

## Versiones compatibles

Mnemosyne está en la línea `3.6.x` (los paquetes en npm son `@mnemo-ai/cli`,
`@mnemo-ai/mcp`, `@mnemo-ai/client-ts` y `@mnemo-ai/types`). Solo la última versión
publicada de cada uno recibe correcciones de seguridad.

| Versión   | Compatible         |
| --------- | ------------------ |
| `3.6.x`   | :white_check_mark: |
| `< 3.6.0` | :x:                |

## Defensas por capas que ya se entregan

Mnemosyne tiene defensa en profundidad por diseño. El aislamiento entre tenants nunca depende de
una sola comprobación.

- **RLS por espacio de trabajo con `FORCE`.** Las tablas `mnemo_*` con alcance de espacio de
  trabajo habilitan la seguridad a nivel de fila con `FORCE`, de modo que las políticas se aplican
  incluso al propietario de la tabla. Las políticas del esquema `mnemosyne` leen el GUC
  `mnemosyne.workspace_id` (las políticas más antiguas del esquema `public` leen `app.workspace_id`;
  `withMnemoTx` define ambos): sin contexto de espacio de trabajo, no hay filas.

  Excepciones conocidas, según la auditoría del 2026-11-22 (APP-059):
  - `mnemo_api_keys` no tiene RLS **por diseño**: la búsqueda de la clave es lo que
    establece el espacio de trabajo, así que no puede ejecutarse dentro de uno
    (`packages/core/src/api-key-lookup.ts`).
  - Sin RLS: `mnemo_scoped_api_keys`, `mnemo_scoped_key_escrow`,
    `mnemo_scoped_key_usage`, `mnemo_outbox`, `mnemo_deletion_log`,
    `mnemo_hot_tier_snapshot`, `mnemo_consolidation_lock` y
    `mnemo_composition_rule_template`, ni las particiones mensuales de
    `mnemo_audit_log` (la tabla padre tiene su política).
  - `mnemo_recall_log` habilita RLS sin `FORCE`.

  A estas tablas se llega por código del servidor que acota sus propias consultas;
  cerrar la brecha es trabajo pendiente.

- **GUC del tenant con cierre seguro.** El acceso con alcance de espacio de trabajo se ejecuta dentro
  de `withMnemoTx` (`packages/core/src/tx.ts`), que define los GUC del espacio de trabajo con
  `set_config(..., true)`, es decir, locales a la transacción. Un contexto ausente u obsoleto
  produce **cero filas**, nunca los datos de otro tenant. Como el ajuste es local, se revierte
  con `COMMIT`/`ROLLBACK` y no puede filtrarse a la siguiente reserva de una conexión del pool.

- **Degradación de rol frente a `BYPASSRLS`.** Cuando el rol de la conexión es miembro de
  `app_user`, `withMnemoTx` ejecuta `SET LOCAL ROLE app_user` (un rol `NOINHERIT` y sin
  `BYPASSRLS`) antes de cualquier consulta, así que la transacción queda sujeta a RLS+FORCE
  mientras dure, incluso con una conexión de superusuario. Los despliegues de producción
  deberían además conectarse directamente como `app_user`.

- **Aislamiento opcional por actor.** Un espacio de trabajo puede restringir aún más la visibilidad
  a un solo usuario final mediante los GUC `app.actor_id` / `app.enforce_actor_isolation`
  y la política `SELECT` correspondiente en `mnemo_fact`.

- **Claves de API con hash.** Las claves de API se guardan como un hash bcrypt, más un hash de
  búsqueda HMAC-SHA256 con la clave `MNEMO_KEY_PEPPER` para la búsqueda O(1); la clave en texto
  plano se muestra una sola vez al crearla y nunca se persiste.

- **Detección y redacción de PII.** Una capa conservadora de expresiones regulares
  (`@mnemo-ai/core/pii`) detecta correos electrónicos, números de teléfono, tarjetas de crédito, SSN,
  claves de API y tokens bearer, direcciones IP y URL con tokens, los puntúa según su
  gravedad y puede redactar cada coincidencia como `[REDACTED-<category>]` antes de que un
  hecho se persista.

- **Aislamiento probado con pruebas de integración.** Las pruebas de integración comprueban el
  aislamiento entre tenants contra un contenedor pgvector real: el espacio de trabajo B ve **0**
  de los hechos del espacio de trabajo A, y las escrituras entre tenants se rechazan. GitHub
  Actions está desactivado en este repositorio, así que nada las ejecuta en cada push: corren en
  el barrido local completo (`FULL=1 bash scripts/full-sweep.sh`, obligatorio antes de una
  versión, requiere Docker). El hook de pre-push ejecuta el carril rápido, que las omite.

- **Token de instalación para la primera clave de API.** `POST /bootstrap` registra la primera
  clave solo con el token de instalación que el servidor imprime en su log al arrancar (de un
  solo uso, 15 minutos), o con el `MNEMO_SETUP_TOKEN` fijo (16 caracteres o más). El token no se
  sirve por la red. Una vez que existe una clave, el bootstrap queda cerrado.

- **Regla de salida de los webhooks.** La URL de un webhook debe ser https y no puede ser, ni
  resolver a, una dirección de loopback, privada, link-local, carrier-NAT, multicast o no
  especificada. Se comprueba al registrar o cambiar el endpoint y antes de cada entrega; no se
  siguen redirecciones y la ruta de prueba no devuelve el cuerpo del receptor. Registrar,
  cambiar, probar o eliminar un endpoint requiere `memory:admin`. `MNEMO_WEBHOOK_ALLOW_HTTP` y
  `MNEMO_WEBHOOK_ALLOW_PRIVATE` relajan la regla para receptores internos.

- **Techo de sensibilidad en eventos y webhooks.** Una suscripción por WebSocket conserva el
  techo de sensibilidad de su clave: los eventos por encima se descartan y los resultados de
  recuperación por encima se quitan. Los payloads de webhook por encima de `internal` salen solo
  con el id y los metadatos (`redacted: true`), y el secreto de firma no se copia al outbox.

- **Aprobaciones de un solo uso.** Una solicitud aprobada deja pasar una sola petición: el mismo
  disparador, usuario, método y ruta, una vez, dentro de la hora siguiente a la aprobación. Una
  solicitud espera hasta 24 horas la decisión. Las dos ventanas son `APPROVAL_PENDING_TTL_MS` y
  `APPROVAL_USE_TTL_MS` en `@mnemo-ai/types`. La petición se compara con su query string (una
  aprobación para un forget lógico no cubre `?mode=hard`), y una aprobación de exportación
  (`approvalRequestId`) cubre una sola exportación, del usuario que la pidió, con el mismo método y ruta. La denegación de la propia política se evalúa primero
  y una aprobación nunca la anula.

## Lista de endurecimiento para operadores

- Conecta la aplicación como `app_user` (sin `BYPASSRLS`), no como superusuario.
- Guarda `DATABASE_URL` y las claves de API de los proveedores en un gestor de secretos, nunca en el control de versiones.
- Termina TLS delante de `@mnemo-ai/server` y exige claves de API en cada
  ruta.
- Trata el contenido de los recuerdos como datos de usuario: activa la redacción de PII para la entrada no confiable.

Gracias por ayudar a mantener seguros a Mnemosyne y a sus usuarios.
