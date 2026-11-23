# @mnemo-ai/harness

[English](README.md) · **Español**

Normalización, saneamiento, hash y persistencia local segura con pocas dependencias para las integraciones de Mnemosyne con aplicaciones anfitrionas (host).

## Instalación

No se publica en npm: `@mnemo-ai/cli` lo empaqueta dentro de su propio `dist`. Dentro de este
monorepo, agrégalo como paquete del workspace:

```bash
pnpm add @mnemo-ai/harness --workspace
```

## API

- `sanitizeMessage(content)` oculta las credenciales reconocidas y trunca el contenido UTF-8 de tamaño excesivo.
- `normalizeVisibleMessage(message)` acepta solo los mensajes `user` y `assistant` y calcula el hash del contenido saneado.
- `computePayloadHash(event)` calcula el hash del cuerpo JSON canónico de la comunicación, sin `payloadHash`.
- `computeTerminalDigest(members)` calcula el resumen (digest) terminal del conjunto de mensajes del harness v1.
- `enqueueVisibleMessage(input)` sanea y guarda de forma atómica un mensaje visible.
- `readPendingEvents()` elimina los archivos temporales de fallo sin confirmar, fija la pérdida de fidelidad, repara el estado validado de los eventos finales y devuelve los eventos pendientes.
- `acknowledgeEvent(...)` registra los miembros terminales `M`/`L` calificados por generación, los metadatos de pérdida y las lápidas de retractación con una marca de agua de confirmación contigua.
- `compactTerminalState(...)` fija de forma duradera el plazo de retención de cada generación, lo aplica según el reloj local y luego compacta todas las generaciones completadas y elegibles del prefijo confirmado.
- `inspectFilesystemCapabilities()` ejecuta una sonda temporal de no-follow, flock, propiedad, fsync de archivos y fsync de directorios.

La política de capacidad predeterminada reserva 32 MiB para los eventos pendientes normales y 1 MiB para los marcadores de pérdida y cancelación. Los registros de auditoría sin contenido tienen un tope aparte de 4 MiB, y las cargas en cuarentena tienen un tope aparte de 16 MiB para el operador y la cola de mensajes fallidos. `OutboxOptions.capacity` puede bajar o subir cada tope. Al agotarse la capacidad, falla de forma cerrada, fija la fidelidad degradada y exige que el operador aplique retención o limpieza; nunca expulsa automáticamente la evidencia pendiente. La sincronización de sesiones usa un espacio de nombres fijo de 32 particiones de bloqueo, de modo que las identidades de sesión elegidas por quien llama no pueden crear archivos de bloqueo sin límite.

## Modelo de amenazas del sistema de archivos local

Node 20 no expone el recorrido `openat(2)` relativo a descriptores. Por eso el harness exige un HOME canónico cuya cadena completa de ancestros pertenezca a root o al UID actual y no tenga permiso de escritura para el grupo ni para otros usuarios. Los directorios gestionados son `0700` del UID actual; los archivos son `0600` y se abren con `O_NOFOLLOW`. Antes de adquirir el bloqueo, después de adquirirlo y después de cada operación bloqueada, el harness vuelve a validar la política de los ancestros, además de `dev`, `ino`, el propietario, el tipo y el modo de HOME y de cada raíz gestionada. La sonda de capacidades demuestra la exclusión del bloqueo consultivo con un descriptor hijo que compite. Las plataformas que no pueden ofrecer aperturas no-follow, flock consultivo exclusivo, comprobaciones de propiedad y fsync de archivos y directorios se informan como no disponibles en lugar de recibir una emulación insegura.

Un proceso malicioso que ya se ejecute con el mismo UID queda fuera de este límite. Ese proceso puede reemplazar ancestros que pertenecen al usuario, editar el estado `0600`, inyectar módulos, depurar el proceso o cambiar el propio ejecutable del harness, por lo que el endurecimiento de rutas no puede crear un límite de aislamiento significativo frente a él. Las comprobaciones de límite detectan el reemplazo o la deriva de política que estén presentes en un límite de operación comprobado; no pueden detectar un reemplazo transitorio del mismo UID que se restaure entre comprobaciones y no son una defensa contra una cuenta comprometida.

La entrega por red y los adaptadores de host quedan fuera de esta porción del paquete.

Cómo se comportan los hooks de cada host, con fuentes: [contratos de hooks por host](../../docs/internals/host-hook-contracts.md).
