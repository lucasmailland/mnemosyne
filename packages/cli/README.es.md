# @mnemo-ai/cli

[English](README.md) · **Español**

> El comando `mnemo` de [Mnemosyne](https://github.com/lucasmailland/mnemosyne), memoria cognitiva para agentes de IA: recall y remember desde la terminal, sesiones, claves y espacios, y `mnemo install` para registrar el servidor MCP en Claude Code, Cursor, Codex, Gemini CLI, OpenCode y Windsurf.
>
> [Repositorio](https://github.com/lucasmailland/mnemosyne) · [Guía del CLI](https://github.com/lucasmailland/mnemosyne/blob/main/docs/guides/CLI.es.md) · [Estado](https://github.com/lucasmailland/mnemosyne/blob/main/docs/STATUS.md)

La interfaz de línea de comandos oficial de Mnemosyne.

> **Necesita un servidor de Mnemosyne en marcha y una clave de API.** El [inicio rápido](https://github.com/lucasmailland/mnemosyne/blob/main/README.es.md#inicio-rápido) levanta uno con Docker en unos minutos.

## Descripción general

`mnemo` es una CLI ligera para interactuar con un servidor de Mnemosyne en ejecución. Está pensada para
operadores que revisan el estado del servidor, desarrolladores que guardan y buscan hechos durante el desarrollo local
y scripts de shell que necesitan integrar operaciones de memoria en canalizaciones de automatización.

**Filosofía de diseño**: el binario usa únicamente el `fetch` nativo de Node.js. No hay un framework de CLI
(ni `commander` ni `yargs`), ni una biblioteca de cliente HTTP (ni `axios`). Además del cliente y los tipos de Mnemosyne,
solo depende de dos parsers chicos, `jsonc-parser` y `smol-toml`. Así la instalación es mínima y el arranque es rápido.

## Instalación

```bash
# pnpm (recommended)
pnpm add -g @mnemo-ai/cli

# npm
npm install -g @mnemo-ai/cli
```

Verifica la instalación:

```bash
mnemo help
```

Deberías ver la referencia de comandos impresa en stdout.

## Binario independiente (sin Node)

Puedes construir un binario autocontenido que incluye el entorno de ejecución junto con el código de la aplicación.
Se construye con **bun compile**, así que la máquina de compilación necesita Bun.

### bun compile

Produce un único binario `mnemo-standalone` que incorpora el entorno de ejecución de Bun (~58 MB en macOS arm64).
No hace falta Node.js ni npm en la máquina de destino.

**Requisitos previos:** [Bun](https://bun.sh) ≥ 1.1 instalado en la máquina de _compilación_.

```bash
# From the repo root
pnpm --filter @mnemo-ai/cli build:standalone

# Or from packages/cli directly
bun build src/index.ts --compile --outfile dist/mnemo-standalone --target bun
```

**Pruébalo:**

```bash
./packages/cli/dist/mnemo-standalone help
./packages/cli/dist/mnemo-standalone version
```

**Tamaño del archivo:** ~58.6 MB (arm64 macOS).

**Distribúyelo:**

```bash
# Install globally on the build machine
cp packages/cli/dist/mnemo-standalone /usr/local/bin/mnemo
chmod +x /usr/local/bin/mnemo

# Or copy to a server / CI artefact
scp packages/cli/dist/mnemo-standalone user@server:/usr/local/bin/mnemo
```

> **Nota sobre la firma de código en macOS:** el binario compilado con bun es un ejecutable Mach-O sin firmar.
> En macOS puede que debas firmarlo ad hoc antes de ejecutarlo fuera de una terminal:
>
> ```bash
> codesign --force --sign - dist/mnemo-standalone
> ```

### ¿`dist/index.js` funciona en otra máquina?

Sí, con salvedades. La salida de tsup (`dist/index.js`) es un bundle ESM autocontenido sin
dependencias externas de npm: solo necesita Node ≥ 20 en la máquina de destino.

```bash
# Copy the single file and run it directly
scp packages/cli/dist/index.js user@server:/usr/local/lib/mnemo.js
chmod +x /usr/local/lib/mnemo.js

# Run (Node 20+ required)
node /usr/local/lib/mnemo.js help
```

Para una distribución sin instalación y sin Node, usa los binarios independientes de arriba.

## Configuración

`mnemo` guarda su configuración en `~/.mnemo/config.json`. El directorio y el archivo se crean
automáticamente en el primer `config set`.

**Formato del archivo de configuración**

```json
{
  "url": "http://localhost:3939",
  "apiKey": "mns_live_..."
}
```

**Sobrescritura con variables de entorno**

Ambos valores se pueden sobrescribir en tiempo de ejecución sin tocar el archivo de configuración:

| Variable    | Sobrescribe | Ejemplo                             |
| ----------- | ----------- | ----------------------------------- |
| `MNEMO_URL` | `url`       | `MNEMO_URL=http://prod.example.com` |
| `MNEMO_KEY` | `apiKey`    | `MNEMO_KEY=mns_live_yourkey`        |

**Prioridad**: las variables de entorno tienen precedencia sobre el archivo de configuración. Si no hay ninguna definida,
`mnemo` termina con el código 3 e imprime un mensaje de error con pasos a seguir.

### Idioma

`mnemo` habla inglés estadounidense (`en-US`) y español latinoamericano (`es-419`). El idioma se elige una sola vez, antes de imprimir nada, con la primera de estas fuentes:

1. El indicador global `--locale <tag>`. Debe ir **antes** del subcomando: `mnemo --locale es-419 recall "query"`. La forma `--locale=es-419` no es compatible, y después del subcomando el indicador se le pasa al comando sin tocar y no cambia el idioma (la misma regla que `--workspace`).
2. `MNEMO_LOCALE`.
3. `"locale"` en `~/.mnemo/config.json` (`mnemo config set locale es-419`).
4. La primera que esté definida entre `LC_ALL`, `LC_MESSAGES` y `LANG`.
5. `en-US`.

Cualquier etiqueta que empiece con `es` (`es`, `es-MX`, `es_AR.UTF-8`) se asigna a `es-419`; una etiqueta que no sea ni español ni inglés se asigna a `en-US`. Un valor inválido de `--locale` es un error de uso. En los pasos de `MNEMO_LOCALE`, de la configuración y de POSIX, un valor desconocido se omite y la cadena continúa: `MNEMO_LOCALE=fr` con `LANG=es_AR.UTF-8` da español.

`@mnemo-ai/mcp` (el servidor MCP) también lee `MNEMO_LOCALE`. Igual que `MNEMO_URL` y `MNEMO_KEY`, si la exportas en un shell, un servidor MCP iniciado desde ese shell la hereda.

En español, los avisos muestran `[s/N]` y aceptan `s`, `sí` o `si` además de `y`/`yes`. La salida de `--json`, los nombres de los indicadores, los nombres de los comandos y los códigos de salida nunca cambian.

**Configuración inicial**

```bash
mnemo config set url http://localhost:3939
mnemo config set apiKey mns_live_yourkey

# Verify (apiKey is masked in output)
mnemo config get
```

Salida esperada:

```
{
  "url": "http://localhost:3939",
  "apiKey": "****...rkey"
}
```

## Comandos

### `mnemo recall <query>`

Busca en la memoria con búsqueda híbrida semántica + léxica. Devuelve los 10 mejores resultados ordenados por
puntuación de relevancia (peso vectorial 0.7, peso léxico 0.3).

**Sintaxis**

```
mnemo recall <query>
```

**Ejemplo**

```bash
mnemo recall "user prefers TypeScript"
```

**Salida**

```
id                                     │ score    │ statement
──────────────────────────────────────────┼──────────┼──────────────────────────────────────────────────
01j9abc123def456ghi789jkl012mno345pq   │ 0.9412   │ The user prefers TypeScript over Python
01j9abc789rst012uvw345xyz678abc901de   │ 0.8203   │ TypeScript generics allow type-safe reuse
```

Las columnas tienen ancho fijo y están alineadas. La columna `statement` se trunca a 80 caracteres con
puntos suspensivos (`…`) si el texto es más largo.

Si no se encuentran resultados:

```
No results found.
```

---

### `mnemo remember <text>`

Guarda un hecho nuevo en la memoria. El texto se guarda como una sola afirmación y se convierte en embedding de inmediato.

**Sintaxis**

```
mnemo remember <text>
```

**Ejemplo**

```bash
mnemo remember "The user prefers TypeScript over Python"
```

**Salida**

```
✓ Remembered: 01j9abc123def456ghi789jkl012mno345pq
```

El ID devuelto es un ULID que identifica de forma única este hecho. Guárdalo si necesitas eliminarlo
más tarde con `mnemo forget`.

---

### `mnemo forget <id>`

Borra lógicamente un hecho a partir de su ID. El hecho se retira de los resultados de búsqueda futuros.

**Sintaxis**

```
mnemo forget <id>
```

**Ejemplo**

```bash
mnemo forget 01j9abc123def456ghi789jkl012mno345pq
```

**Salida**

```
✓ Forgotten: 01j9abc123def456ghi789jkl012mno345pq
```

Termina con el código 4 si el ID no existe (consulta [Códigos de salida](#códigos-de-salida) para ver otras fallas).

---

### `mnemo status`

Revisa el estado del servidor. Consulta `/health` e imprime la respuesta con formato y valores de estado
con colores: verde para `ok`/`healthy`, amarillo para `degraded` y rojo para cualquier otro.

**Sintaxis**

```
mnemo status
```

**Ejemplo**

```bash
mnemo status
```

**Salida (saludable)**

```json
{
  "status": "ok",
  "version": "3.6.1",
  "checks": {
    "db": "ok",
    "redis": "ok",
    "embeddings": "ok"
  }
}
```

**Salida (degradado)**

```json
{
  "status": "degraded",
  "checks": {
    "db": "ok",
    "redis": "degraded",
    "embeddings": "ok"
  }
}
```

Las cadenas de estado se colorean en una terminal que admite códigos de escape ANSI.

---

### `mnemo config set <key> <value>`

Guarda un valor de configuración en `~/.mnemo/config.json`.

**Claves válidas**: `url`, `apiKey`, `uiMode` (`delight`, `verbose`, `quiet`), `locale` (`en-US`, `es-419`).

**Sintaxis**

```
mnemo config set <key> <value>
```

**Ejemplos**

```bash
mnemo config set url http://localhost:3939
mnemo config set apiKey mns_live_abc123xyz
mnemo config set uiMode delight
mnemo config set locale es-419
```

**Salida**

```
✓ Set url
```

Termina con el código 2 si se indica una clave desconocida.

---

### `mnemo config get [key]`

Lee valores de configuración. La `apiKey` siempre se enmascara: solo se muestran los últimos 4 caracteres.

**Sintaxis**

```
mnemo config get           # print all values
mnemo config get url       # print a single value
mnemo config get apiKey    # print masked apiKey
```

**Ejemplos**

```bash
$ mnemo config get
{
  "url": "http://localhost:3939",
  "apiKey": "****xyz"
}

$ mnemo config get url
http://localhost:3939

$ mnemo config get apiKey
****xyz
```

Imprime `(not set)` para las claves que no tienen valor ni en el archivo de configuración ni en el entorno.

---

### `mnemo login [--url <url>] [--key <apiKey>]`

Guarda las credenciales del servidor en `~/.mnemo/config.json` (creado de forma segura con modo `0600`). Admite tanto avisos interactivos como indicadores no interactivos:

```bash
# Non-interactive (scripting / CI):
npx -y @mnemo-ai/cli login --url https://mnemo.example.com --key mns_live_...

# Interactive:
mnemo login
```

---

### `mnemo install`

Detecta y configura automáticamente todos los agentes de programación con IA instalados en esta máquina (**Claude Code**, **Cursor**, **OpenCode**, **Codex**, **Gemini CLI**):

```bash
npx -y @mnemo-ai/cli install
```

Qué hace `mnemo install`:

1. **Registra el servidor MCP**: configura `@mnemo-ai/mcp` en todos los agentes detectados.
2. **Instala hooks y skills**: registra automáticamente los hooks de sesión (`session-start`, `user-prompt-submit`, `session-end`) y las skills cognitivas para Claude Code, Cursor y Gemini.

> ℹ️ **JSON manual frente al instalador automático:** agregar a mano el bloque JSON `mcpServers` a Claude Desktop o Cursor registra las herramientas MCP, pero **no** instala los hooks de sesión ni las skills. Usa `mnemo install` para una configuración automática completa.

---

### `mnemo info` / `mnemo whoami`

Muestra el contexto de la sesión actual: la URL del servidor conectado, el ID del espacio de trabajo activo, la identidad del usuario, el rol en el tenant y las estadísticas de almacenamiento.

```bash
mnemo info
```

---

### `mnemo doctor`

Ejecuta diagnósticos del lado del servidor, entre ellos la conectividad de la API, el estado de RLS, los permisos de las tablas y las colas de los workers de embeddings.

```bash
mnemo doctor
```

---

### `mnemo workspace list` / `mnemo workspace members <id>`

Lista los espacios de trabajo a los que tiene acceso el usuario autenticado, o inspecciona los miembros de un espacio de trabajo.

```bash
mnemo workspace list
mnemo workspace members 00000000-0000-0000-0000-000000000001
```

---

### `mnemo keys <list|create|revoke|show|rotate|scoped>`

Administra las claves de API del espacio de trabajo activo:

```bash
mnemo keys list
mnemo keys create --label "CI Agent" --scopes memory:read,memory:write
mnemo keys rotate mk_abc123def456 "scheduled rotation"
mnemo keys scoped create --type sess --scopes memory:read --expires 8h
mnemo keys scoped revoke mk_sess_a1B2c3D4e5F6
```

`keys scoped create|rotate|revoke` administra las claves del esquema con alcances que verifica `MNEMO_SCOPED_AUTH=1` (`POST /admin/scoped-keys`). `--type admin` emite una clave de emergencia `mk_admin_` ligada a tu usuario e imprime su secreto TOTP una sola vez; cada solicitud con ella necesita un código vigente en `x-mnemo-mfa`.

---

### `mnemo policy <list|get|set|delete>`

Administra la política RBAC de cada agente del espacio de trabajo (necesita `memory:admin`). Un agente se identifica por el id de su clave de API (`mnemo keys list`). `set` crea o reemplaza la política entera desde un archivo JSON; el servidor rechaza campos y alcances desconocidos. Una clave no puede cambiar su propia política, y un cambio vale de inmediato en el servidor que lo recibió y en hasta 60 segundos en las demás réplicas.

```bash
mnemo policy list
mnemo policy get 6f1c2d3e-0000-4000-8000-000000000001
mnemo policy set 6f1c2d3e-0000-4000-8000-000000000001 --file acme-agent-policy.json
mnemo policy delete 6f1c2d3e-0000-4000-8000-000000000001
```

El archivo lleva todos los campos de la política (`namespaces` es opcional; un límite de `0` significa sin límite):

```json
{
  "readScopes": ["memory:read"],
  "writeScopes": ["memory:write"],
  "selfEdit": { "enabled": false },
  "taskScopes": { "canCreate": true, "canDelegate": false, "canDelegateTo": [] },
  "limits": {
    "maxRecallsPerMinute": 600,
    "maxWritesPerMinute": 120,
    "maxSessionsConcurrent": 10,
    "maxSelfEditsPerSession": 3
  },
  "requireApprovalFor": ["delete_fact", "bulk_export"],
  "federationAccess": "none",
  "namespaces": ["acme-*"]
}
```

---

### `mnemo list [--limit N]`

Lista los hechos recientes del espacio de trabajo, ordenados por fecha de creación descendente. Por defecto: 20 hechos.

```bash
mnemo list
mnemo list --limit 50
```

---

### `mnemo search <query>`

Búsqueda de texto completo sin Claude. Usa el pipeline de recuperación con la alternativa FTS: funciona incluso sin `MNEMO_LLM_API_KEY`.

```bash
mnemo search "TypeScript generics"
mnemo search "bug fixed in auth"
```

---

### `mnemo show <factId>`

Muestra todos los campos de un hecho como JSON con formato.

```bash
mnemo show mfact_abc123def456
```

---

### `mnemo sessions`

Lista las sesiones activas y recientes del espacio de trabajo.

```bash
mnemo sessions
```

---

### `mnemo tasks`

Lista las tareas del espacio de trabajo.

```bash
mnemo tasks
```

---

### `mnemo events`

Lista los eventos registrados en el registro del espacio de trabajo.

```bash
mnemo events
```

---

### `mnemo health`

Muestra información detallada del estado, incluidos los endpoints `/health/ready` y `/health`. Más detallado que `mnemo status`.

```bash
mnemo health
```

---

### `mnemo export`

Exporta la memoria del espacio de trabajo como JSONL comprimido con gzip a stdout. Encadénalo con `gunzip` para procesarlo:

```bash
mnemo export | gunzip | jq .
mnemo export > backup.jsonl.gz
```

---

### `mnemo import <file.jsonl.gz>`

Importa un archivo JSONL exportado previamente. Admite `--from mem0|zep|claude` para formatos de terceros y `--conflict-resolution skip|overwrite|newest`.

```bash
mnemo import ./backup.jsonl.gz
mnemo import ./claude-memory.json --from claude
mnemo import ./export.jsonl.gz --conflict-resolution newest
```

---

### `mnemo init [--docker]`

Asistente de configuración con dos modos:

- **Sin `--docker`**: pide la URL del servidor y la clave de API, y configura el MCP de Claude Code y Claude Desktop.
- **Con `--docker`**: arma una pila local completa: inicia Docker (Postgres + Redis), ejecuta las migraciones, genera una clave de API y configura el MCP. Requiere el monorepo de Mnemosyne.

```bash
mnemo init             # cloud/manual mode
mnemo init --docker    # full local Docker bootstrap
```

---

### `mnemo link [--label <name>] [--force]`

Escribe un archivo `.mnemo.json` en el directorio actual, fijándolo al espacio de trabajo de la clave de API activa. Es una configuración local del proyecto que los hooks `SessionStart` (instalados por `mnemo install`) detectan automáticamente, de modo que los agentes lanzados desde este directorio resuelven el espacio de trabajo correcto sin volver a ejecutar `mnemo login`.

```bash
mnemo link                        # pin cwd to the current workspace
mnemo link --label "backend-svc"  # optional human-readable label
mnemo link --force                # overwrite an existing .mnemo.json
```

Falla si `.mnemo.json` ya existe (pasa `--force` para sobrescribirlo), o si la clave de API activa no puede resolver un `workspaceId` (necesita al menos `memory:read`, igual que `mnemo whoami`).

---

### `mnemo reset --workspace <id> --confirm`

Ejecuta una verificación de seguridad en **simulación** para el reinicio del modelo de embeddings de un espacio de trabajo (`targetModel: "reset"`); no elimina ni modifica datos. Queda bloqueado por completo cuando `NODE_ENV=production`, y requiere `--confirm` explícito incluso fuera de producción.

```bash
mnemo reset --workspace 3fa85f64-5717-4562-b3fc-2c963f66afa6 --confirm
```

---

### `mnemo completion <shell>`

Genera scripts de autocompletado de shell. Shells admitidos: `bash`, `zsh`, `fish`, `pwsh`.

```bash
mnemo completion bash >> ~/.bashrc
mnemo completion zsh >> ~/.zshrc
source <(mnemo completion fish)
```

---

### `mnemo help`

Imprime la referencia de comandos integrada en stdout.

```bash
mnemo help
# or simply
mnemo
```

## Códigos de salida

| Código | Significado                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `0`    | El comando terminó correctamente.                                                                                                   |
| `1`    | Falla genérica: todo lo que no cubren los demás códigos. Los scripts que solo prueban un valor distinto de cero siguen funcionando. |
| `2`    | Error de uso: comando o indicador desconocido, argumento faltante o inválido. También `mnemo export` mientras espera aprobación.    |
| `3`    | Autenticación o autorización: no hay servidor ni clave configurados, HTTP 401 o 403.                                                |
| `4`    | No encontrado: HTTP 404 (por ejemplo, `mnemo forget <unknown id>`).                                                                 |
| `5`    | Falla transitoria que vale la pena reintentar: error de red, tiempo de espera agotado, HTTP 408, 429 o 5xx.                         |

## Flujos de salida

stdout lleva solo el resultado del comando. Los banners (`🧠 ... [mnemosyne] ...`), el texto de progreso y
los mensajes de error se escriben en stderr, de modo que la salida de `--json` y las canalizaciones nunca se contaminan.
`--json` está disponible en `recall`, `remember`, `status`, `health` y `doctor`; los demás
comandos de lista y de detalle ya imprimen cargas JSON en stdout.

## Scripts

Como `mnemo` escribe una salida limpia en stdout y los errores en stderr, se integra de forma natural
en los scripts de shell.

**Comprobar si un remember tuvo éxito**

```bash
if mnemo remember "Deploy completed at $(date -u +%Y-%m-%dT%H:%M:%SZ)"; then
  echo "Memory stored."
else
  echo "Failed to store memory." >&2
  exit 1
fi
```

**Usar variables de entorno para credenciales por tarea**

```bash
MNEMO_URL=https://prod.example.com \
MNEMO_KEY=mns_live_yourkey \
mnemo status
```

**Capturar el ID de remember**

La línea de confirmación va a stderr; usa `--json` para obtener el registro guardado en stdout:

```bash
ID=$(mnemo remember --json "fact goes here" | jq -r '.id')
echo "Stored as: $ID"
```

**Ramificar según la clase de falla**

```bash
mnemo recall --json "deploy" > out.json
case $? in
  0) ;;
  3) echo "check MNEMO_KEY" >&2 ;;
  5) echo "server unavailable, retry later" >&2 ;;
esac
```

**Encadenar la salida de recall como JSON**

`mnemo recall` con `--json` produce JSON estructurado:

```bash
mnemo recall --json "user preferences" | jq '.hits[].statement'
```

O llama directamente a la API HTTP:

```bash
curl -s -X POST "$MNEMO_URL/recall" \
  -H "Authorization: Bearer $MNEMO_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "user preferences", "limit": 10}' \
  | jq '.memories.hits[].content'
```

**Buscar sin LLM (alternativa FTS)**

`mnemo search` usa búsqueda de texto completo incluso sin una clave de API:

```bash
mnemo search "TypeScript strict mode"
```

**Verificación de estado en CI**

```bash
if ! mnemo status --json 2>/dev/null | grep -q '"ok"'; then
  echo "Mnemosyne not healthy — aborting." >&2
  exit 1
fi
```

## Licencia

Apache-2.0: consulta [LICENSE](https://github.com/lucasmailland/mnemosyne/blob/main/LICENSE).
