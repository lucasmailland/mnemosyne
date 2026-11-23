# Política de estabilidad y obsolescencia de la API de Mnemosyne

[English](STABILITY.md) · **Español**

**En vigor desde:** v1.0.0

---

## Niveles de estabilidad

A cada superficie pública de la API se le asigna un nivel de estabilidad:

| Nivel            | Símbolo | Significado                                                                                                      |
| ---------------- | ------- | ---------------------------------------------------------------------------------------------------------------- |
| **Estable**      | ✅      | Sin cambios incompatibles sin un aumento de versión mayor (semver MAJOR).                                        |
| **Beta**         | 🔶      | Puede tener cambios incompatibles menores en versiones menores; se marca como obsoleta con aviso de 2 versiones. |
| **Experimental** | 🔸      | Puede cambiar en cualquier versión; no requiere aviso de obsolescencia.                                          |

Todas las superficies listadas sin anotación de nivel son **Estables** desde v1.0.0.

---

## Qué cubre

Las siguientes superficies están sujetas a esta política:

- **API REST HTTP**: todas las rutas (forma de la solicitud, forma de la respuesta, códigos de estado HTTP, nombres de los encabezados de autenticación). No hay prefijo de ruta `/v1` en la red; consulta la nota al inicio de [`docs/architecture/API.md`](../architecture/API.es.md).
- **Esquemas de las herramientas MCP**: nombres de las herramientas, parámetros de entrada, formas de salida
- **SDK de TypeScript** (`@mnemo-ai/client-ts`): todas las funciones y tipos exportados
- **SDK de Python** (`mnemo-ai-sdk`): todos los métodos y excepciones públicos
- **SDK de Go** (`github.com/lucasmailland/mnemosyne/packages/sdk-go`): todas las funciones y tipos exportados
- **Comandos de la CLI** (`mnemo`): nombres de los comandos, indicadores y formatos de salida de todos los comandos incluidos
- **gRPC/ConnectRPC**: el proto `MnemosyneService` y los stubs generados (nombres de métodos, tipos de mensajes)
- **Bus de eventos**: los valores de `MnemoBusEventType` y la forma del sobre
- **API de plugins**: las firmas de los hooks de `MnemoPlugin` y los métodos de `PluginContext`

Lo siguiente **NO** está cubierto:

- Detalles internos de implementación (adaptadores, internos de las fábricas, internos de las migraciones)
- `docs/`: la documentación siempre se actualiza sin un aumento de versión
- Nombres de variables de entorno (pueden renombrarse con aviso de 1 versión)
- El idioma y la redacción del texto legible por personas: los valores de `message` de los errores, la salida de la CLI y las descripciones de las herramientas MCP pueden reescribirse o traducirse en cualquier versión. Ramifica según `code`/`type`, no según el texto del mensaje
- Internos del esquema de la base de datos (usa el SDK o la API HTTP; nunca consultes directamente las tablas de PG de Mnemosyne)

---

## Versionado

Mnemosyne sigue el [Versionado Semántico 2.0](https://semver.org/lang/es/):

| Tipo de cambio                                     | Impacto en la versión |
| -------------------------------------------------- | --------------------- |
| Corrección de errores, mejora sin incompatibilidad | PATCH (1.0.x)         |
| Nueva capacidad sin incompatibilidad               | MINOR (1.x.0)         |
| Cambio incompatible en una superficie Estable      | MAJOR (x.0.0)         |

**Las etiquetas son de release-please.** Nunca etiquetes a mano. Haz push a `main`; release-please publica la versión cuando se aplica la etiqueta `release: true` al PR de la versión.

---

## Proceso de obsolescencia

1. **Anuncio**: la versión que marca algo como obsoleto incluye una nota `deprecation` en el CHANGELOG y un registro de advertencia en tiempo de ejecución (para los métodos de los SDK) o un encabezado de respuesta `Deprecation` (para las rutas HTTP).
2. **Periodo de gracia**: al menos **2 versiones menores** (por ejemplo, v1.1.0 y v1.2.0) antes de eliminarla.
3. **Eliminación**: la siguiente versión MAJOR después del periodo de gracia elimina la superficie.
4. **Excepción**: las vulnerabilidades de seguridad pueden eliminarse de inmediato en una versión PATCH sin aviso.

---

## Definición de cambio incompatible

Un **cambio incompatible** es cualquier cambio que obliga a quien llama a actualizar su código:

- Eliminar una ruta, un método, un parámetro o un campo que antes existía
- Cambiar un parámetro de opcional a obligatorio
- Restringir un tipo de entrada aceptado (por ejemplo, `string | number` → `string`)
- Ampliar el tipo de un campo devuelto de una manera que rompa el estrechamiento de tipos
- Cambiar los códigos de estado HTTP de las respuestas exitosas
- Renombrar una herramienta MCP, un comando de la CLI o un RPC de gRPC
- Eliminar un tipo o una constante exportados anteriormente

Lo siguiente **NO** son cambios incompatibles:

- Agregar campos opcionales nuevos a los objetos de respuesta
- Agregar parámetros opcionales nuevos con valores por defecto
- Agregar rutas, herramientas, métodos o comandos nuevos
- Agregar valores nuevos de enumeración a campos de respuesta (quien llama debe manejar los valores desconocidos)
- Cambios de rendimiento, mejoras de latencia o cambios en los mensajes de registro
- Correcciones de errores que cambian el comportamiento de incorrecto a correcto

---

## Superficies experimentales (v1.0)

Las siguientes superficies se publican en v1.0 pero están marcadas como **Experimentales** (pueden cambiar en 1.x):

- `POST /procedural/optimize` y los endpoints relacionados de memoria procedimental (§14)
- `POST /composition/dry-run`: simulación de inferencia (§32)
- El subcampo de tendencias de `GET /metacognition` (§31)
- RPC de streaming de gRPC: `ingestBatch`, `importMemory`, `session`, `federationSync`
- Hooks de la API de plugins: `onSync`, `onFederationEvent`, `verify` (agregados en v1.0; se estabilizan en v1.1)

---

## Política de seguridad

Las vulnerabilidades de seguridad se corrigen en versiones PATCH y se portan a la rama MINOR actual. No se requiere aviso previo para los parches de seguridad. Reporta las vulnerabilidades mediante un aviso de seguridad privado de GitHub; consulta [SECURITY.md](../../SECURITY.es.md).

---

## Contacto

Para preguntas sobre la estabilidad de la API o para solicitar una exención de obsolescencia, abre un issue de GitHub con la etiqueta `api-stability`.
