# Mnemosyne — interfaces operativas (página de estado y panel de métricas)

[English](OPERATIONS.md) · **Español**

> **Alcance:** runbooks del día 2: monitoreo, comprobaciones de estado, respuesta a incidentes, copias de seguridad y restauración, y actualizaciones.
> NO es responsable de los Dockerfiles (consulta [`docker/`](../../docker/README.es.md)) ni de las configuraciones de plataforma (consulta [`deploy/`](../../deploy/README.es.md)).
> Punto de entrada: [`docs/DEPLOYMENT.md`](../DEPLOYMENT.es.md).

> Visibilidad operativa para los consumidores. No es el Grafana interno (ese es para operaciones):
> son interfaces públicas o acotadas al espacio de trabajo para que los consumidores entiendan el
> estado del sistema y su propio uso.

---

## 1. Página de estado pública

### Propósito

Estado del sistema en tiempo real, visible para TODOS los consumidores. Comunica:

- ¿El sistema está en marcha?
- ¿Qué está degradado?
- ¿Cuándo se corregirá?
- ¿Qué mantenimiento está planificado?

### Componentes monitoreados

| Componente                    | Qué comprueba                                 | Saludable         | Degradado               | Caído           |
| ----------------------------- | --------------------------------------------- | ----------------- | ----------------------- | --------------- |
| **REST API**                  | HTTP 200 en /health/live                      | <50ms p99         | <500ms p99              | Timeout/5xx     |
| **Servidor MCP**              | Handshake stdio/HTTP                          | Responde          | Lento (>1s)             | No responde     |
| **PostgreSQL**                | SELECT 1 en el primario                       | <10ms             | <100ms                  | Inaccesible     |
| **Redis**                     | PING en el maestro                            | <5ms              | <50ms                   | Inaccesible     |
| **Proveedores de embeddings** | Endpoint de estado por proveedor              | <200ms            | <2s                     | Timeout         |
| **Pipeline de recuperación**  | Consulta de recuperación sintética            | <200ms p99        | <500ms p99              | Fallos >1%      |
| **Servicio de sesiones**      | Redis + pipeline de colapso                   | Funcional         | Degradado (sin colapso) | Fuera de línea  |
| **Federación**                | Estado de cada par por instancia conectada    | Todo sincronizado | Retraso >5min           | Par inaccesible |
| **Capa caliente**             | Conjunto ordenado de Redis + tasa de aciertos | Aciertos >50%     | Aciertos <30%           | Redis caído     |
| **Webhooks**                  | Tasa de entregas correctas                    | >99% entregados   | >95% entregados         | <95% entregados |

### Niveles de estado

```
OPERATIONAL  → All components healthy. No action needed.
DEGRADED     → One or more components degraded. System functional with reduced performance.
PARTIAL      → Major component down. Some features unavailable.
MAJOR        → Core functionality impaired. Immediate action in progress.
MAINTENANCE  → Planned downtime. Announced in advance.
```

### Cronología de incidentes

```typescript
interface Incident {
  id: string;
  title: string; // "Elevated recall latency"
  status: "investigating" | "identified" | "monitoring" | "resolved";
  severity: "minor" | "major" | "critical";
  components: string[]; // ["REST API", "Recall Pipeline"]

  updates: Array<{
    timestamp: string; // ISO 8601
    status: string; // Status at this update
    message: string; // "Root cause identified: PG replica lag"
  }>;

  startedAt: string;
  resolvedAt?: string;
  duration?: number; // minutes
}
```

### Visualización de disponibilidad

- Disponibilidad por componente: 30, 90 y 365 días
- Calendario histórico (verde/amarillo/rojo por día)
- Indicador de cumplimiento del SLA (objetivo: 99.9%)
- Presupuesto de errores restante (% del presupuesto mensual consumido)

### Opciones de suscripción

| Método   | Caso de uso                                                             |
| -------- | ----------------------------------------------------------------------- |
| Email    | Los administradores del espacio de trabajo reciben avisos de incidentes |
| Webhook  | Integración con Slack/PagerDuty/personalizada                           |
| RSS/Atom | Lector de feeds, automatización                                         |
| API      | `GET /status/current`, `GET /status/incidents`                          |

### Avisos de mantenimiento

```typescript
interface MaintenanceWindow {
  id: string;
  title: string; // "Database migration — v3.2 schema update"
  description: string; // What's happening and why
  scheduledStart: string; // ISO 8601
  scheduledEnd: string;
  affectedComponents: string[];
  expectedImpact: "none" | "brief_interruption" | "degraded" | "offline";

  // Notifications sent:
  // - 7 days before (email + webhook)
  // - 24 hours before (email + webhook)
  // - Start (email + webhook + status page update)
  // - End (email + webhook + status page resolved)
}
```

### Opciones de implementación

| Opción                              | Ventajas                               | Desventajas            | Costo                |
| ----------------------------------- | -------------------------------------- | ---------------------- | -------------------- |
| **Autoalojada (Upptime/Cachet)**    | Control total, basada en git, gratuita | Carga de mantenimiento | $0                   |
| **Alojada (Instatus/Statuspage)**   | Sin mantenimiento, interfaz pulida     | Dependencia, costo     | $20-80/mes           |
| **Personalizada (parte de Studio)** | Integración perfecta, con marca propia | Esfuerzo de desarrollo | Tiempo de desarrollo |

**Recomendación**: autoalojada (Upptime) para código abierto. Integración personalizada en Studio para el modo cloud/SaaS. Ambas opciones están disponibles mediante un feature flag.

### Endpoints de la API

> **Nota de v1.0:** el router `/status/*` es un hito posterior a la 1.0. Usa tu proveedor externo de página de estado (Upptime, Instatus, etc.) o el endpoint `/metrics` de Prometheus para los datos de disponibilidad. El diseño de rutas anterior es la superficie de API prevista para v2.0.

El servidor v1.0 expone `/healthz` (sonda de vida) y `/health` (comprobación completa de dependencias, incluidas PG + Redis + embeddings) como interfaz operativa de estado. No hay prefijo de ruta `/v1` en la red; consulta la nota al inicio de `docs/architecture/API.md`.

---

## 2. Panel de métricas para consumidores

### Propósito

Visibilidad del uso por espacio de trabajo. Los consumidores ven SUS métricas, no las partes internas del sistema. Responde a:

- ¿Cuánto estoy usando?
- ¿Estoy obteniendo valor? (ROI)
- ¿Me estoy acercando a mis límites?
- ¿Cuál es la calidad de mi memoria?

### Categorías de métricas

#### 2.1 Métricas de uso (relevantes para la facturación)

| Métrica                   | Descripción                                                  | Visualización                   |
| ------------------------- | ------------------------------------------------------------ | ------------------------------- |
| Recuperaciones / día      | Total de llamadas a la API de recuperación                   | Gráfico de líneas (7d, 30d)     |
| Escrituras / día          | Hechos + decisiones + estrategias creados                    | Gráfico de líneas               |
| Sesiones colapsadas       | Sesiones que produjeron conocimiento                         | Contador + tendencia            |
| Hechos activos            | Hechos vigentes en el espacio de trabajo                     | Indicador                       |
| Almacenamiento usado      | Almacenamiento total de PG (hechos + embeddings + metadatos) | Indicador + porcentaje del plan |
| Agentes activos           | Ids de agente únicos en este período                         | Contador                        |
| Llamadas a la API (total) | Todas las llamadas a endpoints combinadas                    | Gráfico de líneas               |

#### 2.2 Métricas de calidad (demostración de valor)

| Métrica                                 | Descripción                                                | Visualización                           |
| --------------------------------------- | ---------------------------------------------------------- | --------------------------------------- |
| Tasa de aciertos de recuperación        | % de recuperaciones que devolvieron ≥1 resultado relevante | Indicador porcentual                    |
| Tasa de aciertos de la capa caliente    | % de recuperaciones servidas desde la caché (<5ms)         | Indicador porcentual                    |
| Latencia media de recuperación          | p50, p95, p99 de este espacio de trabajo                   | Histograma                              |
| Distribución del valor de los recuerdos | Cuántos hechos hay en cada nivel de valor                  | Gráfico de barras (0-0.2, 0.2-0.4, ...) |
| Cobertura de embeddings                 | % de hechos con embeddings válidos                         | Barra de progreso                       |
| Diversidad del conocimiento             | Distribución entre 10 tipos de primitiva                   | Gráfico circular                        |
| Hechos obsoletos detectados             | Hechos invalidados por la verificación contra el código    | Contador                                |
| Eventos de consolidación                | Hechos fusionados (manteniendo la calidad)                 | Contador + tendencia                    |

#### 2.3 Economía de tokens

Lo que el servidor mide hoy (Prometheus, `GET /metrics`):

| Métrica                                                 | Qué es                                                                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mnemo_llm_tokens_used_total{model,operation}`          | Tokens que los proveedores de LLM y de embeddings informaron en cada llamada. Medido.                                                                                                                                     |
| `mnemo_llm_cost_usd_total`, `mnemo_llm_daily_spend_usd` | Gasto derivado de esos tokens.                                                                                                                                                                                            |
| `mnemo_tokens_saved_estimated_total{mechanism}`         | **Estimación, no medición.** Solo lo emite `distillation` (una estimación del tamaño de la cadena en caché cuando acierta la caché de CoT). El contexto servido medido por recall está en `GET /admin/stats` → `context`. |
| `mnemo_roi_multiplier`                                  | Ahorro estimado en USD dividido por el gasto en LLM. Hereda la estimación anterior; vale 0 sin distillation. Ninguna alerta se basa en ella.                                                                              |

El ahorro de tokens todavía no se mide: ningún código compara el contexto que una recuperación
evitó con el que envió, y la anticipación y el consenso no emiten ningún ahorro. Estado de las
funciones: `docs/STATUS.md`.

#### 2.4 Consumo de límites de tasa

| Métrica              | Descripción                        | Visualización       |
| -------------------- | ---------------------------------- | ------------------- |
| Tasa de recuperación | rps actual frente al límite        | Barra de progreso   |
| Tasa de escritura    | rps actual frente al límite        | Barra de progreso   |
| Sesiones simultáneas | Activas frente al máximo permitido | Barra de progreso   |
| Cuota de exportación | Usada hoy frente al máximo diario  | Barra de progreso   |
| Cerca del límite     | % consumido de cualquier límite    | Indicador de alerta |

#### 2.5 Estado de los proveedores (visible para el consumidor)

| Métrica                     | Descripción                                  | Visualización        |
| --------------------------- | -------------------------------------------- | -------------------- |
| Proveedor de embeddings     | Estado + latencia media                      | Punto de estado + ms |
| Proveedor de LLM            | Estado + latencia media                      | Punto de estado + ms |
| Proveedor de reordenamiento | Estado + latencia media                      | Punto de estado + ms |
| Modo activo                 | A (FTS) / B (vectorial) / C (completo)       | Insignia             |
| Eventos de degradación      | Veces que el sistema bajó a un modo inferior | Contador (30d)       |

### Diseño del panel

Boceto de diseño; las cifras son de relleno, no la salida de ninguna pantalla en funcionamiento.

```
┌─────────────────────────────────────────────────────────────────────────┐
│  MNEMOSYNE — Workspace: {name}                        Period: [7d ▾]    │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐  │
│  │ Active Facts │ │ Recall Rate  │ │ LLM spend    │ │  Mode        │  │
│  │    1,247     │ │  94% hit     │ │   $0.14      │ │    C (Full)  │  │
│  │  ▲ +23 today │ │  ▲ +2% week  │ │  7 days      │ │  ● Healthy   │  │
│  └──────────────┘ └──────────────┘ └──────────────┘ └──────────────┘  │
│                                                                          │
│  ┌─ Usage (7 days) ─────────────┐ ┌─ Worth Distribution ────────────┐  │
│  │  ╭──╮                        │ │                                   │  │
│  │  │  ╰──╮    ╭──╮            │ │  0.8-1.0: ████████████ 34%       │  │
│  │  │     ╰──╮╭╯  ╰──╮        │ │  0.6-0.8: ████████ 28%           │  │
│  │  │        ╰╯       ╰──      │ │  0.4-0.6: █████ 19%              │  │
│  │  Recalls ── Writes           │ │  0.2-0.4: ███ 12%                │  │
│  └──────────────────────────────┘ │  0.0-0.2: █ 7%                   │  │
│                                    └──────────────────────────────────┘  │
│                                                                          │
│  ┌─ Rate Limits ────────────────────────────────────────────────────┐   │
│  │  Recall:  ████████████░░░░░░  587/600 rpm                        │   │
│  │  Write:   ████░░░░░░░░░░░░░░   43/120 rpm                        │   │
│  │  Sessions: ██░░░░░░░░░░░░░░░░  3/10 concurrent                   │   │
│  └───────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### Endpoints de la API (acotados al espacio de trabajo)

```yaml
# Consumer metrics (requires memory:read scope) — no /v1 path prefix on the wire
GET /metrics/prometheus                   # Prometheus text (alias GET /metrics); bearer MNEMO_METRICS_TOKEN, 404 in production without one
GET /usage                                # Durable usage counters (recalls, writes, tokens) — WP10
GET /cost                                 # Cost breakdown by operation type — WP10

# Post-1.0 roadmap (not yet implemented):
#   GET /metrics/quality                  # Quality metrics (hit rate, worth, coverage)
#   GET /metrics/tokens                   # Token economics (spend, savings, ROI)
#   GET /metrics/history?period=7d        # Historical data points
#   GET /metrics/export?format=csv        # Export metrics data
```

> **Nota de v1.0:** los subendpoints de calidad/ROI por espacio de trabajo (`/metrics/quality`, etc.) son un hito posterior a la 1.0. La tabla `mnemo_meter_event` (migración 0070) y las rutas `/usage` + `/cost` ofrecen en v1.0 contadores duraderos relevantes para la facturación. La agregación completa de analítica llegará en v2.0.

### Formato de la respuesta

> Forma prevista para el endpoint de métricas posterior a la 1.0; hoy ninguna ruta la devuelve.

```typescript
interface MetricsResponse {
  workspace: string;
  period: { from: string; to: string };

  usage: {
    recalls: { total: number; trend: number }; // trend: % change vs previous period
    writes: { total: number; trend: number };
    sessions: { collapsed: number; active: number };
    facts: { active: number; archived: number; total: number };
    storage: { usedBytes: number; limitBytes: number; percentage: number };
  };

  quality: {
    recallHitRate: number; // 0-1
    hotTierHitRate: number; // 0-1
    avgRecallLatency: { p50: number; p95: number; p99: number }; // ms
    worthDistribution: Record<string, number>; // "0.0-0.2": 42, "0.2-0.4": 87, ...
    embeddingCoverage: number; // 0-1
    knowledgeDiversity: Record<string, number>; // "fact": 890, "strategy": 23, ...
  };

  tokens: {
    spent: { total: number; byOperation: Record<string, number> };
    saved: { total: number; byMechanism: Record<string, number> };
    roi: number; // saved / spent
    netCostPerSession: number; // USD
  };

  limits: {
    recall: { used: number; limit: number; resetAt: string };
    write: { used: number; limit: number; resetAt: string };
    sessions: { active: number; limit: number };
    export: { usedToday: number; dailyLimit: number };
  };

  providers: Array<{
    type: string; // "embedding" | "llm" | "rerank"
    id: string; // "ollama" | "openai" | "voyage"
    status: "healthy" | "degraded" | "down";
    latency: { p50: number; p99: number }; // ms
    lastError?: string;
  }>;
}
```

### Puntos de datos históricos

```typescript
interface MetricsHistoryResponse {
  workspace: string;
  period: { from: string; to: string };
  granularity: "hour" | "day" | "week";

  dataPoints: Array<{
    timestamp: string; // Start of period bucket
    recalls: number;
    writes: number;
    recallHitRate: number;
    tokensSpent: number;
    tokensSaved: number;
    avgLatency: number; // p50 ms
    factsActive: number;
  }>;
}
```

### Implementación

| Modo de despliegue | ¿Panel disponible?                              | Cómo                                             |
| ------------------ | ----------------------------------------------- | ------------------------------------------------ |
| **Personal**       | CLI `mnemo metrics` o vista de estado en la TUI | Cálculo en el mismo proceso                      |
| **Equipo**         | REST API (`/metrics`) + Studio opcional         | Agregación en el servidor                        |
| **Cloud**          | Panel completo en Studio + API + exportaciones  | Precalculado (reglas de grabación de Prometheus) |
| **Embebido**       | El host lo expone en su propia interfaz         | El núcleo expone el método `getMetrics()`        |

### Retención de datos de métricas

| Granularidad                  | Retención | Almacenamiento                                  |
| ----------------------------- | --------- | ----------------------------------------------- |
| Eventos de medición duraderos | Continua  | PostgreSQL `mnemo_meter_event` (migración 0070) |
| Contadores de uso             | Continua  | PostgreSQL mediante `GET /usage`                |
| Desglose de costos            | Continua  | PostgreSQL mediante `GET /cost`                 |

> **Nota de v1.0:** las tablas de resumen preagregadas por hora, día y semana (`mnemo_metrics_hourly`, etc.) son un hito posterior a la 1.0. v1.0 ofrece datos de facturación duraderos por evento en `mnemo_meter_event` y los expone mediante `/usage` + `/cost`.

### Esquema de almacenamiento de métricas

```sql
CREATE TABLE mnemo_metrics_hourly (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id  UUID NOT NULL,
  hour_start    TIMESTAMPTZ NOT NULL,

  -- Usage
  recalls       INT DEFAULT 0,
  writes        INT DEFAULT 0,
  sessions      INT DEFAULT 0,

  -- Quality
  recall_hits   INT DEFAULT 0,       -- For computing hit rate
  recall_total  INT DEFAULT 0,
  hot_hits      INT DEFAULT 0,
  latency_sum   BIGINT DEFAULT 0,    -- Sum of all recall latencies (ms)
  latency_count INT DEFAULT 0,       -- For computing average

  -- Tokens
  tokens_spent  BIGINT DEFAULT 0,
  tokens_saved  BIGINT DEFAULT 0,

  -- Snapshot
  facts_active  INT DEFAULT 0,       -- Point-in-time count at hour end

  UNIQUE (workspace_id, hour_start)
);

-- Partition by month for retention management
-- BRIN index on hour_start for time-range queries
CREATE INDEX idx_metrics_hourly_time ON mnemo_metrics_hourly
  USING brin (hour_start);

-- RLS: workspace isolation
ALTER TABLE mnemo_metrics_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE mnemo_metrics_hourly FORCE ROW LEVEL SECURITY;
CREATE POLICY metrics_workspace ON mnemo_metrics_hourly
  USING (workspace_id = current_setting('mnemosyne.workspace_id', true)::uuid);
```

### Cron de agregación

```
mnemo.metrics.aggregate_hourly  — every hour (roll raw counters → hourly row)
mnemo.metrics.aggregate_daily   — daily 00:05 (roll hourly → daily)
mnemo.metrics.aggregate_weekly  — Monday 00:10 (roll daily → weekly)
mnemo.metrics.prune_raw         — hourly (delete Redis counters older than 24h)
mnemo.metrics.prune_hourly      — monthly (delete hourly rows older than 30d)
```

---

## 3. API de gestión de sesiones

> Estado: implementada a partir del 2026-06-12

Estos endpoints están implementados en `@mnemo-ai/server` y son la interfaz REST canónica para el ciclo de vida de las sesiones. Las rutas difieren de las rutas heredadas `/v1/memory/sessions` documentadas en borradores anteriores: la implementación actual usa el prefijo `/session`, sin prefijo de ruta `/v1` en la red (consulta la nota al inicio de `docs/architecture/API.md`).

### POST /session/start

Crea una nueva sesión de conversación efímera.

**Cuerpo de la solicitud** (opcional):

```json
{
  "agentId": "orchester-v2",
  "label": "Support ticket #4291",
  "metadata": {}
}
```

**Respuesta** (201 Created):

```json
{
  "id": "01j9abc...",
  "agentId": "orchester-v2",
  "status": "active",
  "createdAt": "2026-06-12T14:23:00.000Z"
}
```

### POST /session/:id/turn

Añade un turno de conversación a una sesión activa.

**Cuerpo de la solicitud** (obligatorio):

```json
{
  "role": "user",
  "content": "What should we prioritize this sprint?",
  "metadata": {}
}
```

**Respuesta**: 204 No Content

**Errores**: 404 si la sesión no existe o ya está colapsada.

### POST /session/:id/collapse

Marca una sesión como colapsada. Devuelve 202 Accepted (asíncrono: la extracción de hechos se encola).

**Cuerpo de la solicitud** (opcional):

```json
{
  "strategy": "auto"
}
```

**Respuesta** (202 Accepted):

```json
{
  "accepted": true,
  "sessionId": "01j9abc..."
}
```

**Nota de implementación:** a partir de v2.0.0-alpha.1, `collapse` marca el estado de la sesión como `collapsed`
y devuelve 202. El pipeline de extracción de hechos con LLM (leer turnos → sintetizar hechos →
persistir en mnemo_fact) está previsto para v3.1.

---

## 4. Ubicación en los paquetes

| Interfaz                              | Paquete                                              | Despliegue                          |
| ------------------------------------- | ---------------------------------------------------- | ----------------------------------- |
| Página de estado (pública)            | `apps/status` o `@mnemo-ai/status`                   | Independiente (Upptime) o en Studio |
| API de métricas                       | `@mnemo-ai/server` (endpoints)                       | Parte del servidor principal        |
| Agregación de métricas                | `@mnemo-ai/server` (cron jobs mediante QueueAdapter) | Mismo proceso del servidor          |
| Esquema de almacenamiento de métricas | `@mnemo-ai/adapter-postgres` (migraciones)           | Tablas de PG                        |
| Interfaz del panel de métricas        | `@mnemo-ai/studio`                                   | Interfaz web opcional               |
| Vista de métricas en la CLI           | Binario Go `mnemo`                                   | Comando `mnemo metrics`             |
| Vista de métricas en la TUI           | Binario Go `mnemo`                                   | Pestaña de estado de la TUI         |
