# Publicar versiones de Mnemosyne

[English](RELEASING.md) · **Español**

## Cómo se publica hoy

Las versiones se publican **a mano**. GitHub Actions está desactivado en este repositorio, así
que nada de `.github/workflows/` se ejecuta: ni la CI, ni release-please, ni `docker-publish.yml`,
ni `deploy-canary.yml`. Los archivos de release-please (`.github/release-please-config.json` y
`.github/.release-please-manifest.json`) se conservan para cuando vuelva la CI; el manifiesto
refleja las versiones de los `package.json`.

### La compuerta de cada versión

Antes de cada versión, ejecuta el barrido completo en local (Docker tiene que estar en marcha) y
guarda su registro con la versión:

```bash
FULL=1 bash scripts/full-sweep.sh 2>&1 | tee "sweep-$(git rev-parse --short HEAD).log"
```

`FULL=1` suma, a lo que ya ejecuta el hook de pre-push, las suites de integración contra Postgres
y Redis reales, la compuerta de regresión del benchmark y la prueba de carga de k6. Publica solo
si el resumen dice `PASS` en todas las líneas, y adjunta el registro al GitHub Release (o
guárdalo junto a las notas de la versión). Esto reemplaza la ejecución de CI que ya no ocurre. Los dos
carriles también ejecutan los tests de los hooks del plugin (`pnpm test:hooks`). Antes del paso de
integración, el barrido comprueba que responda un entorno de contenedores: con `DOCKER_HOST` sin
definir y sin `/var/run/docker.sock`, usa el socket de OrbStack si existe; si no, falla el paso e
indica el `DOCKER_HOST` que hay que definir para OrbStack, Colima o Docker sin root.

Los registros de captura de cada host también tienen que coincidir con el build que publicas.
Cualquier cambio en `packages/harness` o en los archivos del plugin de un host los deja
obsoletos, y un registro obsoleto baja ese host a `mcp-only` sin aviso en cada
`mnemo install --capture` nuevo. Después de `pnpm build`:

```bash
node scripts/qualify-harness-host.mjs validate-all
```

Si falla, vuelve a cualificar cada host obsoleto en la máquina que indica su registro (ver
`CLAUDE.md`) antes de publicar. Ningún test acepta un registro obsoleto en su lugar.

## Qué se publica

En npm hay solo cuatro paquetes: `@mnemo-ai/cli`, `@mnemo-ai/mcp`, `@mnemo-ai/client-ts` y
`@mnemo-ai/types`. Todos los demás son internos: viajan dentro de las imágenes del servidor y de
migración o, en el caso de `@mnemo-ai/harness`, empaquetado dentro del `dist` de la CLI. Cada
paquete publicado lleva su propia versión; no están vinculadas.

## Pasos

1. Parte de un `main` limpio (`git status` vacío) y ejecuta la compuerta de arriba.
2. Sube la versión de cada paquete que publiques. Cuando un paquete cambia, todo paquete
   publicado que dependa de él también necesita versión, primero las dependencias:
   `types` → `client-ts` → `mcp` y `cli`.
3. Empaqueta y revisa cada paquete antes de publicarlo. `pnpm pack` reemplaza `workspace:*` por
   versiones reales (`npm pack` no lo hace), y `prepack` copia el `LICENSE` de la raíz:

   ```bash
   (cd packages/cli && pnpm pack --pack-destination /tmp/mnemo-release)
   tar -tzf /tmp/mnemo-release/mnemo-ai-cli-*.tgz | grep -c LICENSE
   ```

4. Publica en orden de dependencias con `pnpm --filter <paquete> publish --access public`.
5. Comprueba la CLI como la recibe quien la usa: en un directorio vacío, instala con
   `npm install` la versión publicada y ejecuta `mnemo --version`.
6. Etiqueta el commit desde el que publicaste, una etiqueta por paquete
   (`<directorio>-v<versión>`, el formato de release-please), y sube las etiquetas:

   ```bash
   git tag cli-v0.1.0 && git push origin cli-v0.1.0
   ```

7. Las imágenes de Docker tampoco se publican solas: constrúyelas desde el mismo commit con
   `docker build -f docker/Dockerfile.server .` (y `Dockerfile.migrate`, `Dockerfile.dashboard`).

## Próxima publicación

El versionado se reinició en `0.1.0` cuando el repositorio pasó a público: todos los paquetes,
los SDK y el plugin llevan la misma versión. npm todavía tiene los builds viejos `3.6.x` de
`@mnemo-ai/types`, `@mnemo-ai/client-ts`, `@mnemo-ai/mcp` y `@mnemo-ai/cli`. Publicar `0.1.0`
mueve la etiqueta `latest` de npm a esa versión (`npm publish` etiqueta lo que publica);
después marca la línea vieja como obsoleta para que nadie la instale por error:

```bash
npm deprecate "@mnemo-ai/cli@3.x" "Versioning restarted at 0.1.0; install @mnemo-ai/cli@latest"
```

(y lo mismo para `types`, `client-ts` y `mcp`). `pnpm pack` fija cada paquete a la versión
exacta de los otros, así que publica en este orden: `types`, `client-ts`, y después `mcp` y
`cli`. Un paquete publicado antes que sus dependencias no se instalaría.

## Cuando vuelva la CI

release-please puede volver a encargarse: `linked-versions` en
`.github/release-please-config.json` mantiene todos los componentes en una sola versión, que es
la que llevan hoy los paquetes.
