# Plugin de Mnemosyne

[English](README.md) · **Español**

Memoria persistente para agentes de programación con IA. Recuerda decisiones de arquitectura, correcciones de errores, preferencias del usuario y el contexto de las sesiones a lo largo de todas las sesiones.

## Instalación

### Claude Code

**Recomendado** — `mnemo install` (lo ejecuta la CLI; consulta la [guía de la CLI](https://github.com/lucasmailland/mnemosyne/blob/main/docs/guides/CLI.es.md)) lleva a cabo por ti el flujo nativo del marketplace: `claude plugin marketplace add`, `claude plugin marketplace update`, `claude plugin uninstall` y después `claude plugin install`, de modo que refresca una instalación existente y repara una desactualizada en cada ejecución. Requiere la CLI `claude` en el `PATH`; si falta, la rama de Claude Code se omite con un mensaje accionable en lugar de fallar en silencio.

Equivalente manual, si prefieres ejecutar tú mismo los comandos:

**Paso 1** — Registra el marketplace de Mnemosyne (una vez por máquina):

```bash
claude plugin marketplace add lucasmailland/mnemosyne
```

**Paso 2** — Instala el plugin:

```bash
claude plugin install mnemosyne@mnemosyne
```

Claude Code instalará el plugin y conectará automáticamente los hooks de sesión. En el siguiente inicio de sesión, el protocolo de memoria se inyecta automáticamente.

**Paso 3** — Registra el servidor MCP. El plugin trae hooks y skills pero **ningún servidor MCP**: `.claude-plugin/plugin.json` no declara ninguno a propósito, porque el servidor toma su clave de `MNEMO_KEY` y un manifiesto de plugin solo podría incrustarla o exigirla en el entorno con el que arranca Claude Code, y porque un servidor declarado por un plugin recibe nombres de herramientas con el espacio de nombres del plugin, que no coinciden con las herramientas `mcp__mnemosyne__*` a las que los hooks dirigen al modelo. `mnemo install` hace este paso por ti; a mano:

```bash
claude mcp add --scope user mnemosyne \
  -e MNEMO_URL=https://your-server -e MNEMO_KEY=mns_live_... \
  -- npx -y @mnemo-ai/mcp
```

Sin este paso, los hooks igual hacen el recall automático, pero el modelo no tiene herramientas `memory_*` para llamar.

> El marketplace está definido en `.claude-plugin/marketplace.json`, en la raíz del repositorio.
> El código fuente del plugin vive en `packages/plugin/` y se referencia mediante `"source": "./packages/plugin"`.

Como alternativa, mediante el comando con barra dentro de una sesión de Claude Code:

```
/plugin marketplace add lucasmailland/mnemosyne
```

**Instalación para desarrollo local** — `mnemo install --local` instala el plugin desde tu árbol de trabajo local `packages/plugin/` en lugar de usar el marketplace (útil para probar cambios del plugin sin confirmar). Es solo una instalación de desarrollo: no está bajo seguimiento de git, no tiene `gitCommitSha` y Claude Code nunca la actualizará automáticamente; un `mnemo install` posterior (sin flag) la reemplaza por el plugin publicado. `--local` nunca llama a `claude plugin marketplace`/`claude plugin install`/`uninstall`.

Si `claude plugin marketplace add` falla, lo más habitual es que `lucasmailland/mnemosyne` sea privado y no esté accesible para tu cuenta de GitHub actual: autentícate con `gh auth login` o SSH, o usa `mnemo install --local` como alternativa. El mensaje de error lo presenta como una causa _posible_, no como una certeza, porque los códigos de salida de `claude` para este modo de fallo no están documentados.

### Cursor

1. Copia `.cursor-plugin/` a la raíz de tu proyecto (o a una ubicación global donde Cursor busque plugins).
2. Añade el servidor MCP a `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "node",
      "args": ["/path/to/mnemosyne/packages/mcp/dist/index.js"],
      "env": {
        "MNEMO_URL": "http://localhost:3939",
        "MNEMO_KEY": "your-api-key"
      }
    }
  }
}
```

3. Copia `AGENTS.md` a la raíz de tu proyecto para que Cursor cargue automáticamente el protocolo de memoria.

### Gemini CLI

1. Copia `GEMINI.md` y `gemini-extension.json` a la raíz de tu proyecto.
2. Gemini CLI cargará `GEMINI.md` como contexto y registrará la extensión.

Como alternativa, copia `GEMINI.md` a `~/.gemini/GEMINI.md` para activarlo globalmente en todos los proyectos.

### Codex (OpenAI)

1. Copia `.codex-plugin/` a la raíz de tu proyecto.
2. Establece las variables de entorno (consulta Configuración más abajo).
3. El plugin cargará `AGENTS.md` como protocolo de memoria.

### Manual (cualquier entorno de ejecución)

1. Inicia un servidor de Mnemosyne (consulta la [documentación de despliegue](https://github.com/lucasmailland/mnemosyne/blob/main/docs/DEPLOYMENT.es.md)).
2. Establece las variables de entorno:

```bash
export MNEMO_URL=http://localhost:3939
export MNEMO_KEY=your-api-key
```

O crea `~/.mnemo/config.json`:

```json
{
  "url": "http://localhost:3939",
  "apiKey": "your-api-key"
}
```

> Las variables de entorno tienen prioridad sobre el archivo, tanto en la CLI como
> en cada hook. Es fácil olvidarlo una vez que se exportan desde el perfil del
> shell: un `export MNEMO_URL` antiguo se impone en silencio a un archivo de
> configuración correcto, y los hooks hablan con lo que sea que apunte.

### `recallTimeoutMs` — presupuesto para la recuperación automática del hook

El hook `UserPromptSubmit` recupera contexto para el primer mensaje de una sesión
y da a esa solicitud un presupuesto acotado. El valor por defecto es **1,5 s**,
medido contra una pila local (Ollama, reordenación desactivada).

Un servidor remoto no respeta esa medición. Contra una instancia detrás de TLS con
un proveedor de embeddings alojado, la misma recuperación cuesta aproximadamente
**0,5–1,8 s** según si la caché de embeddings acierta, lo que se sitúa a ambos
lados del valor por defecto, de modo que la recuperación automática falla de forma
_intermitente_. Eso parece un servidor inestable y no un presupuesto demasiado
ajustado, por lo que merece nombrarse aquí.

```bash
mnemo config set recallTimeoutMs 3000
```

Milisegundos, entero positivo. Cualquier otra cosa (no numérica, `0`, negativa) la
rechaza la CLI y la ignora el hook, que recurre al valor por defecto:
`curl --max-time 0` significa _sin límite_, lo contrario de lo que sugiere `0`.
Los valores por encima de 8 s se limitan: el hook tiene un techo estricto en
`hooks.json`, y un presupuesto que lo supere no aporta nada salvo perder el mensaje
de degradación «llama tú mismo a `memory_recall`».

Dejarlo sin establecer mantiene el valor por defecto de 1,5 s, que es el correcto
para un servidor local: existe para que un despliegue remoto no imponga su latencia
a los demás.

3. Añade el servidor MCP a la configuración MCP de tu entorno de ejecución, apuntando a `packages/mcp/dist/index.js`.
4. Copia `SKILL.md` (o `AGENTS.md` / `GEMINI.md`) a la raíz de tu proyecto para que el protocolo de memoria se cargue automáticamente.

---

## Estructura de archivos

```
packages/plugin/
├── .claude-plugin/plugin.json       # Claude Code plugin manifest
├── .cursor-plugin/plugin.json       # Cursor plugin manifest
├── .codex-plugin/plugin.json        # Codex plugin manifest
├── gemini-extension.json            # Gemini CLI extension registration
├── AGENTS.md                        # Protocol for Cursor, Windsurf, Copilot
├── GEMINI.md                        # Protocol for Gemini CLI (static version)
├── hooks/
│   └── hooks.json                   # Claude Code hook definitions
├── scripts/
│   ├── _helpers.sh                  # Shared shell helpers
│   ├── session-start.sh             # Session start hook
│   ├── session-stop.sh              # Session stop hook
│   ├── post-compaction.sh           # Post-compaction recovery hook
│   ├── user-prompt-submit.sh        # Per-prompt hook
│   └── subagent-stop.sh             # Subagent stop hook
└── skills/memory/
    ├── SKILL.md                     # Canonical memory protocol (all runtimes)
    └── references/
        ├── claude-code-tools.md     # Claude Code tool mapping
        ├── cursor-tools.md          # Cursor tool mapping
        └── gemini-tools.md          # Gemini CLI tool mapping
```

---

## Cómo funciona

El plugin inyecta el protocolo de memoria (`SKILL.md`) al inicio de la sesión. El protocolo indica al agente que:

1. Llame a `memory_recall` antes de la primera respuesta de cada sesión.
2. Llame a `memory_remember` de forma proactiva tras decisiones, correcciones de errores y preferencias, sin que se lo pidan.
3. En una sesión solo MCP, envíe los intercambios reales con `memory_session(action: "turn", ...)` y llame a `memory_episode_end` antes de decir «listo»; cuando los hooks gestionan la sesión, no la termine.
4. La compactación no termina la sesión: después de ella, mantenga el mismo `sessionId` y llame a `memory_status` y `memory_recall`.

Toda la memoria se almacena en una instancia del servidor de Mnemosyne. El servidor MCP (`packages/mcp/`) sirve las 37 herramientas de memoria (`MNEMO_MCP_TOOLS=core` las reduce a 9).

---

## Requisitos

- Un servidor de Mnemosyne en ejecución (local o alojado). Consulta [DEPLOYMENT.md](https://github.com/lucasmailland/mnemosyne/blob/main/docs/DEPLOYMENT.es.md).
- `MNEMO_URL` y `MNEMO_KEY` configurados (variables de entorno o `~/.mnemo/config.json`).
- Compatibilidad con MCP en tu entorno de ejecución (Claude Code, modo Agent de Cursor, Gemini CLI, Codex).
