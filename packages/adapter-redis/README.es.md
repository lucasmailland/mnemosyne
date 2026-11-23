# @mnemo-ai/adapter-redis

[English](README.md) · **Español**

> **Puntero para IA:** implementa el puerto CacheAdapter mediante Redis/ioredis. Se usa para la recuperación del nivel caliente (los últimos N turnos) y para la caché de sesiones.
>
> **Depende de:** @mnemo-ai/types, ioredis
>
> **Expone:** RedisCacheAdapter
>
> **Estado:** STABLE
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/internals/ALGORITHMS.md](../../docs/internals/ALGORITHMS.md)

Adaptador de caché para Redis / Valkey que implementa el puerto `CacheAdapter` de
`@mnemo-ai/types`. Ofrece la caché de recuperación del nivel caliente, la caché de embeddings
y el almacenamiento del estado de las sesiones de Mnemosyne v3.

---

## Posición en la arquitectura

```
@mnemo-ai/core  (CacheAdapter port)
       ↑
@mnemo-ai/adapter-redis  (RedisCacheAdapter)
       ↓
Redis / Valkey  (hot-tier, in-memory)
```

Redis se sitúa delante de Postgres como almacén del nivel caliente. Los hechos que se recuperan con frecuencia
se guardan en un conjunto ordenado clasificado por la puntuación de activación ACT-R, de modo que las consultas repetidas
se atienden sin llegar a Postgres ni a pgvector.

---

## Estado de la implementación

| Componente                                 | Estado | Notas                                                                                                                                                                              |
| ------------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interfaz `CacheAdapter`                    | Listo  | Definida en `@mnemo-ai/types`                                                                                                                                                      |
| Clase `RedisCacheAdapter`                  | Listo  | Respaldada por Redis/Valkey; cubierta por pruebas unitarias                                                                                                                        |
| `get` / `set` / `delete` / `deletePattern` | Listo  | Implementados                                                                                                                                                                      |
| `zadd` / `zrangeByScore`                   | Listo  | Conjunto ordenado del nivel caliente con ACT-R                                                                                                                                     |
| TTL                                        | Listo  | Mediante las opciones de `set` (`CacheSetOpts`)                                                                                                                                    |
| Conectado al servidor en vivo              | Listo  | Se inyecta en el núcleo v3 al arrancar el servidor cuando `MNEMO_REDIS_URL` está definida (`packages/server/src/index.ts`); si no lo está, la recuperación pasa a la cascada fría. |

---

## Interfaz del puerto

```typescript
interface CacheAdapter {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, opts?: CacheSetOpts): Promise<void>;
  delete(key: string): Promise<void>;
  deletePattern(pattern: string): Promise<number>;
  zadd(key: string, score: number, member: string): Promise<void>;
  zrangeByScore(key: string, min: number, max: number, opts?: { limit?: number; offset?: number }): Promise<string[]>;
  publish(channel: string, message: string): Promise<void>;
  subscribe(channel: string, handler: (message: string) => void): Promise<void>;
  info(): Promise<CacheInfo>;
}
```

---

## Instalación

```bash
pnpm add @mnemo-ai/adapter-redis
```

Dependencia entre pares (peer): `ioredis` (^5)

Compatible con Redis >= 6.2 y Valkey >= 7.2.

---

## Convención de espacios de nombres de las claves

Todas las claves de caché siguen un espacio de nombres estructurado para evitar colisiones entre
espacios de trabajo y tipos de clave:

```
mnemo:{workspaceId}:{type}:{id}
```

Ejemplos:

| Clave                               | Descripción                                          |
| ----------------------------------- | ---------------------------------------------------- |
| `mnemo:ws_abc:session:sess_xyz`     | Estado de una sesión activa                          |
| `mnemo:ws_abc:embed:sha256_of_text` | Vector de embedding en caché                         |
| `mnemo:ws_abc:hottier:facts`        | Conjunto ordenado ACT-R de los hechos calientes      |
| `mnemo:ws_abc:fact:fact_123`        | Entrada de caché de lectura directa de un solo hecho |

---

## Niveles de TTL

| Nivel                                | TTL       | Justificación                                            |
| ------------------------------------ | --------- | -------------------------------------------------------- |
| Claves de sesión                     | 24 horas  | Las sesiones vencen tras un día de inactividad           |
| Caché de embeddings                  | 7 días    | Los embeddings son costosos; el texto rara vez cambia    |
| Conjunto ordenado del nivel caliente | 24 horas  | Se renueva en cada acierto de recuperación               |
| Caché de validación de claves de API | 5 minutos | De vida corta para detectar las revocaciones con rapidez |

---

## Política de expulsión

Establece `maxmemory-policy allkeys-lru` en la configuración de Redis / Valkey.
Así, bajo presión de memoria se expulsan primero las claves menos usadas recientemente,
lo que conserva los hechos más calientes del conjunto ordenado.

```conf
maxmemory 512mb
maxmemory-policy allkeys-lru
```

---

## Inicio rápido (una vez conectado)

```typescript
import { RedisCacheAdapter } from "@mnemo-ai/adapter-redis";

// Connect by URL
const cache = new RedisCacheAdapter({ url: process.env.REDIS_URL! });

// Or by host/port
const cache2 = new RedisCacheAdapter({ host: "127.0.0.1", port: 6379 });

// Hot-tier recall sorted set
await cache.zadd("mnemo:ws_abc:hottier:facts", 0.92, "fact_123");
const hotFacts = await cache.zrangeByScore("mnemo:ws_abc:hottier:facts", 0, 1.0);
```

---

## Notas

- `publish` / `subscribe` se usan para las señales de invalidación en tiempo real cuando un
  hecho se actualiza o se elimina, de modo que las demás instancias del servidor puedan vaciar las entradas
  de caché obsoletas sin reiniciarse por completo.
- La clave de la caché de embeddings es el hash SHA-256 del texto de entrada; el texto idéntico
  nunca vuelve a generar su embedding dentro de la ventana del TTL.
- El adaptador es dueño de su propia conexión de ioredis; pasa `{ url }` o `{ host, port }` en
  la configuración y deja que gestione el ciclo de vida. Llama a `close()` al apagar.
