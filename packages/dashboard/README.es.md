# @mnemo-ai/dashboard

[English](README.md) · **Español**

Dashboard web de Mnemosyne: observabilidad, configuración y recuperación interactiva
contra una instancia en ejecución de `@mnemo-ai/server`. Next.js 16 App Router,
autenticación con cookie de sesión (`mnemo_dash_token`) mediante `/dashboard/auth/*`, y todas las
lecturas y escrituras de datos pasan por el puente `/dashboard/api/*` (`packages/server/src/routes/dashboard-api.ts`).

Paquete privado: no se publica en npm (`"private": true`).

## Ejecútalo

```bash
# from the repo root, after `pnpm install`, against a server already running (see docker/README.md)
MNEMO_SERVER_URL=http://localhost:3939 pnpm --filter @mnemo-ai/dashboard dev
```

`dev` compila primero los paquetes del workspace que importa el dashboard (`@mnemo-ai/types`:
sus `exports` apuntan a `dist/`) y después arranca `next dev`, así que funciona en un clon
recién hecho sin un `pnpm build` previo.

Luego abre `http://localhost:3000/dashboard` e inicia sesión con una clave de API `mns_live_...`.

`MNEMO_SERVER_URL` vale `http://localhost:3939` por defecto si no se define
(`lib/server-api.ts`).

## Compilación

```bash
pnpm --filter @mnemo-ai/dashboard build
pnpm --filter @mnemo-ai/dashboard start
```

Consulta [`docker/README.md`](../../docker/README.es.md) para ver el backend con el que se comunica, y
[`docs/guides/PRODUCTION_DEPLOY.md`](../../docs/guides/PRODUCTION_DEPLOY.es.md) para ejecutarlo en
producción (imagen, proxy de borde, HTTPS).

## Sistema de diseño e idiomas

- **Tokens.** Los colores, la tipografía, el espaciado, el radio y el movimiento viven como variables CSS en
  `app/globals.css` (claro por defecto, oscuro bajo `data-theme="dark"`). Usa las
  clases de tokens; los valores arbitrarios de Tailwind (`foo-[...]`) y las utilidades de espaciado o
  tamaño de medio paso (`p-1.5`, `-mt-0.5`, `sm:gap-2.5`: fuera de la escala de 4 px) hacen fallar
  `pnpm lint` salvo que estén listados, con una razón, en `lib/tokens-allowlist.json`.
- **Movimiento.** Solo se animan `opacity` y `transform`, con las duraciones compartidas
  y una única curva de easing de los tokens. `prefers-reduced-motion: reduce` pone
  todas las duraciones en 0 y elimina el escalonado, la deriva y el pulso.
- **Salas.** Cada página es una sala definida en `lib/rooms.ts` (una entrada de la barra lateral más
  el título del encabezado); agrega una página ahí para que el marco y el encabezado la tomen.
- **Idiomas.** `en-US` y `es-419`; gana la cookie `mnemo_locale`, luego
  `Accept-Language`, luego `en-US`. `mnemo_theme` es `light`, `dark` o `system`.
- **Agregar una cadena de texto.** Agrega la clave en los dos diccionarios de `lib/i18n/messages/`
  (`en.ts`, `es.ts`; `es.ts` está tipado contra `en.ts`, así que una clave faltante hace fallar
  la comprobación de tipos) y léela con `useT()` (cliente) o `getT()` (servidor). Nada de
  texto visible para el usuario escrito a mano en `app/` ni en `components/`.

## El palacio (las cinco salas de la memoria)

Inicio, Explorador, Recall, Sesiones y Grafo son las cinco salas del «palacio de
la memoria». Inicio y Grafo son escenas: no tienen franja de encabezado de sala, y el título se dibuja
en la propia escena. Explorador, Recall y Sesiones conservan el encabezado de sala. Las cinco
leen del servidor por el mismo puente y dibujan solo lo que este devuelve; donde un
número no tiene fuente, la sala lo omite.

| Sala (ruta)             | Nombre              | Notas                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inicio (`/`)            | El atrio            | Frase narrativa (recuerdos escritos hoy, decisiones reemplazadas, conflictos), fichas del libro de cuentas (barras rayadas de 14 días), los eventos del día y el primer conflicto abierto. Quien puede escribir puede conservar el más reciente o conservar ambos (`/conflicts/{id}/resolve`); todos pueden seguir el linaje. Si no hay conflicto, se muestra la tarjeta del archivo.                                       |
| Explorador (`/browser`) | El catálogo         | Tarjetas a la izquierda y el recuerdo abierto a la derecha (`?open=<factId>`, renderizado en el servidor, así que el enlace se puede compartir): los dos relojes (verdadero en el mundo, conocido por Mnemosyne) y la cadena de procedencia (sesión, episodio, qué reemplaza y qué lo reemplazó).                                                                                                                           |
| Recall (`/recall`)      | Las aguas del Leteo | Una llamada medida a `/recall` por cada clic en Recuperar, nunca al cargar ni mientras se escribe. La franja del pipeline muestra los candidatos y el tiempo de cada etapa; un conteo que el nivel de acceso de quien llama oculta aparece como una raya larga con una explicación en texto. «Por qué este resultado» hace una llamada a `/recall/explain` por consulta, al expandirlo por primera vez.                     |
| Sesiones (`/sessions`)  | El columbario       | Un nicho por episodio; `?open=<episodeId>` muestra la narración, los participantes, la línea de tiempo del episodio y hasta 10 recuerdos que produjo.                                                                                                                                                                                                                                                                       |
| Grafo (`/relations`)    | La constelación     | Entidades, episodios y decisiones como estrellas, y las relaciones como líneas (discontinua = inferida por significado), con fuerzas vivas (react-force-graph): arrastrar, mover, acercar, entrar al vecindario de una entidad y volver, en 2D o 3D. Una sola parada de tabulador; las flechas del teclado se mueven entre estrellas, Enter selecciona, Escape borra la selección o vuelve atrás y la selección se anuncia. |

Las escrituras desde la interfaz (resolver un conflicto) aparecen solo para las sesiones cuyos permisos
incluyen `memory:write`. Los grabados se dibujan a 180 px o más en su
lado corto; los recortes están bien, los panoramas reducidos no.

Las compuertas sobre estas salas viven en `e2e/` (`layout`, `a11y`, `motion`, `locale`,
`palace`, `palette`). `global-setup.ts` siembra el espacio de trabajo compartido E2E Team mediante la
API (`e2e/seed.ts`: hechos, un reemplazo, una decisión reemplazada, un conflicto
abierto, un episodio, entidades y relaciones), de modo que las compuertas miden las salas
con datos, y `palace.spec.ts` las recorre en inglés y en español.

## Los guardianes

Configuración, Mis espacios de trabajo, Mi cuenta, Miembros, Claves, Estado, Auditoría y las
páginas de Instalación (usuarios, espacios de trabajo, ajustes, auditoría) son los guardianes: las
salas donde las personas cuidan la instancia. Comparten un mismo lenguaje visual desde
`components/keeper.tsx` y `components/form-bits.tsx`: una sección es un
encabezado `.eyebrow` sobre una línea de 1 px; los registros son filas finas en un
panel con borde (nunca tarjetas apiladas); las etiquetas de estado y de permisos son etiquetas discretas con contorno
(`StatusTag`); los campos de texto, selectores, casillas, botones y alertas salen solo de
esas primitivas; las acciones destructivas se confirman en un `Dialog` (nunca
`window.confirm`; mientras la acción se ejecuta no se puede cancelar el diálogo). Conservan
sus llamadas a la API, sus payloads y sus nombres accesibles, así que las especificaciones e2e que las manejan
(`workspace-model`, `own-workspaces`, `account`, `locale`, `members`,
`invitation`, `keys`, `installation`, `offboarding`, `mobile`) solo cambiaron donde
una acción ahora se confirma en ese diálogo (el revocar de `invitation` y el rotar y
revocar de `keys` hacen clic en su botón). Las salas de Instalación se muestran solo a los superadministradores; las
salas de administración y la acción «Nueva clave de API» solo a los administradores, e «Invitar a un miembro»
solo a los administradores de un espacio de trabajo que admite miembros (no uno personal).

## La paleta ⌘K

⌘K (Ctrl+K fuera de macOS) abre una búsqueda desde cualquier página con sesión iniciada, igual que la
barra de búsqueda de la barra lateral. Es un diálogo modal sobre un combobox y una lista agrupada
(salas, acciones, hechos, entidades) y no está en el DOM mientras está cerrado. Escribir
solo filtra salas y acciones y, a partir de dos caracteres y 200 ms después de la
última pulsación, busca hechos y entidades mediante `/dashboard/api/facts` y
`/dashboard/api/entities`. **Escribir nunca envía una recuperación**: ⌘↵ (Ctrl+↵) sí lo hace,
armando un token de un solo uso en `sessionStorage` y abriendo `/recall?q=…&run=1`;
la página de Recall hace su única llamada medida solo cuando el token coincide con `q`
y lo gasta, así que un enlace `?run=1` compartido o armado a mano solo rellena el campo. Enter abre el resultado resaltado, las flechas se mueven, Escape cierra y
devuelve el foco a lo que lo abrió, y la cantidad de resultados se anuncia en una
región activa en modo cortés. Fuente: `components/palette/`, con las listas de salas y acciones
en `lib/palette-items.ts`.

## Páginas de error

Toda ruta desconocida llega a `app/(dashboard)/[...missing]`, que llama a
`notFound()`: el layout del grupo se ejecuta primero, así que quien no ha iniciado sesión va al
inicio de sesión, y quien sí lo hizo recibe la página de no encontrada del Leteo dentro del marco
(la barra lateral y la paleta se quedan) con HTTP 404, igual que una página de Instalación abierta por
alguien que no es superadministrador. La escena es dueña de la página: un solo h1, y el
encabezado propio de la sala se oculta cuando una página del Leteo está dentro de `main`. Una falla dentro de una sala muestra
la variante de error de esa misma página con un reintento; `app/global-error.tsx` cubre una
falla del layout raíz, lee las cookies de idioma y de tema de forma síncrona
y lleva sus seis cadenas en línea (una prueba las fija contra los diccionarios); su vía de regreso es un enlace simple al dashboard. Las
especificaciones de compuerta miden esa página como una sala, dos veces: `/browser/this-does-not-exist`
con sesión de administrador y `/installation/users` con sesión de lector: un 404,
la barra lateral alrededor, exactamente un h1 (el del Leteo), sin encabezado de sala, sin desbordamiento, sin
violaciones graves de accesibilidad, en ambos temas.
