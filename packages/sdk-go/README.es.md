# mnemosyne/sdk-go

[English](README.md) · **Español**

> **Puntero para IA:** cliente HTTP de Go sin dependencias para la API de memoria cognitiva de Mnemosyne. Una sola estructura `Client` cubre toda la superficie REST; las claves de idempotencia y el reintento con espera exponencial vienen incluidos.
>
> **Depende de:** solo la biblioteca estándar de Go (sin módulos de terceros)
>
> **Expone:** `mnemo.Client`, `mnemo.NewClient`, `mnemo.NewIdempotencyKey`, `mnemo.WithIdempotencyKey`, tipo de error `mnemo.APIError`
>
> **Estado:** ALPHA — versión 3.0.0a0
>
> **Ver también:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [packages/client-ts/README.md](../client-ts/README.es.md)

SDK de Go para el servidor de memoria cognitiva Mnemosyne v3. Usa solo la biblioteca estándar de Go (`net/http`, `encoding/json`, `crypto/rand`, etc.): cero dependencias en tiempo de ejecución. Requiere Go 1.21+.

## Instalación

```bash
go get github.com/lucasmailland/mnemosyne/packages/sdk-go
```

El módulo vive en un subdirectorio del repositorio principal. Todavía no hay ninguna etiqueta
`packages/sdk-go/vX.Y.Z`, así que `go get` resuelve una pseudoversión del último commit de `main`.

## Importación

```go
import "github.com/lucasmailland/mnemosyne/packages/sdk-go/mnemo"
```

## Empieza en 30 segundos

```go
package main

import (
    "context"
    "fmt"
    "log"

    "github.com/lucasmailland/mnemosyne/packages/sdk-go/mnemo"
)

func main() {
    client, err := mnemo.NewClient("https://memory.example.com", "mns_live_...")
    if err != nil {
        log.Fatal(err)
    }

    result, err := client.Recall(context.Background(), mnemo.RecallInput{
        Query: "user email preferences",
    })
    if err != nil {
        log.Fatal(err)
    }

    for _, hit := range result.Hits {
        fmt.Println(hit)
    }
}
```

## Constructor

```go
func NewClient(baseURL, apiKey string) (*Client, error)
```

`baseURL` y `apiKey` son obligatorios; la función devuelve un error si alguno es una cadena vacía. El cliente usa un tiempo de espera de 30 segundos por solicitud (`defaultTimeout = 30 * time.Second`) y por defecto hace 3 intentos ante 429/5xx.

## Comportamiento de reintento

`Client.do` reintenta ante HTTP 429, 500, 502, 503 y 504 con espera exponencial con variación completa (retardos base de 200 ms, 400 ms, 800 ms). La cancelación del contexto se respeta durante las pausas de espera. Los errores 4xx distintos de 429 nunca se reintentan.

## Idempotencia

Los métodos de escritura aceptan valores `RequestOption` opcionales. La única opción actual es `WithIdempotencyKey`, que establece la cabecera de solicitud `Idempotency-Key`. Genera una clave antes del primer intento y reutilízala en los reintentos: generar una clave nueva por intento anula su propósito.

```go
key, err := mnemo.NewIdempotencyKey()  // crypto/rand UUID v4
if err != nil {
    log.Fatal(err)
}

fact, err := client.CreateFact(ctx,
    mnemo.FactInput{Content: "Acme prefers communication in Spanish."},
    mnemo.WithIdempotencyKey(key),
)
```

`NewIdempotencyKey` devuelve un UUID v4 conforme a RFC-4122 y usa solo `crypto/rand`, con lo que se mantiene la garantía de cero dependencias.

## Gestión de errores

Las respuestas que no son 2xx se devuelven como `*mnemo.APIError`:

```go
result, err := client.Recall(ctx, mnemo.RecallInput{Query: "billing policy"})
if err != nil {
    var apiErr *mnemo.APIError
    if ok := errors.As(err, &apiErr); ok {
        fmt.Printf("HTTP %d: %s (code=%s, requestId=%s)\n",
            apiErr.Status, apiErr.Message, apiErr.Code, apiErr.RequestID)
        if apiErr.Status == 401 {
            // rotate key
        }
    }
    // Transport errors (DNS, TLS, connection refused) are wrapped
    // with "mnemo: transport error: ..." and are not *APIError.
    log.Fatal(err)
}
```

## API

Todos los métodos aceptan un `context.Context` como primer argumento. La mayoría devuelve `(map[string]interface{}, error)`; las excepciones se indican.

### Estructuras de entrada

| Estructura                                                           | Usada por                                           |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| `RecallInput{Query, Vector, TopK, AsOf, VectorWeight}`               | `Recall`                                            |
| `FactInput{Content, Attribution, Tags}`                              | `CreateFact`                                        |
| `PinInput{Pinned}`                                                   | uso interno en `PinFact` / `UnpinFact`              |
| `AppendTurnInput{Role, Content, Metadata}`                           | `AppendTurn`                                        |
| `PinSessionTurnInput{TurnID, Pinned}`                                | `PinSessionTurn`                                    |
| `ConsolidationInput{Mode, DryRun}`                                   | `TriggerConsolidation`                              |
| `SelfEditInput{Action, Target, Reason, Content, AgentID, SessionID}` | `SelfEdit`                                          |
| `FederationSyncInput{PeerID}`                                        | uso interno en `TriggerFederationSync`              |
| `ApprovePeerInput{NewCertDer, IssuedAt}`                             | `ApproveFederationPeer`, `ApproveFederationPeerKey` |

### Recuperación (Recall)

```go
func (c *Client) Recall(ctx context.Context, input RecallInput) (*RecallResponse, error)
```

`RecallResponse` tiene `Hits []map[string]interface{}` y `Debug map[string]interface{}`.

### Hechos

```go
func (c *Client) CreateFact(ctx, FactInput, ...RequestOption) (map[string]interface{}, error)
func (c *Client) GetFact(ctx, id string) (map[string]interface{}, error)
func (c *Client) ListFacts(ctx, params url.Values) (map[string]interface{}, error)
func (c *Client) PatchFact(ctx, id string, fields map[string]interface{}, ...RequestOption) (map[string]interface{}, error)
func (c *Client) ForgetFact(ctx, id string, ...RequestOption) error
func (c *Client) RestoreFact(ctx, id string, ...RequestOption) (map[string]interface{}, error)
func (c *Client) PinFact(ctx, id string, ...RequestOption) (map[string]interface{}, error)
func (c *Client) UnpinFact(ctx, id string, ...RequestOption) (map[string]interface{}, error)
func (c *Client) GetFactCitations(ctx, id string) (map[string]interface{}, error)
```

### Línea de tiempo / Grafo / Salud / Exportación

```go
func (c *Client) Timeline(ctx, params url.Values) (map[string]interface{}, error)
func (c *Client) Graph(ctx, params url.Values) (map[string]interface{}, error)
func (c *Client) Health(ctx) (map[string]interface{}, error)
func (c *Client) ExportWorkspace(ctx) (map[string]interface{}, error)
func (c *Client) Audit(ctx, params url.Values) (map[string]interface{}, error)
```

### Entidades

`ListEntities` · `GetEntity` · `CreateEntity` · `UpdateEntity` · `ListEntityFacts`

### Episodios

`ListEpisodes` · `GetEpisode`

### Decisiones

`ListDecisions` · `GetDecision` · `CreateDecision` · `SupersedeDecision`

### Relaciones / Citas

`ListRelations` · `CreateRelation` · `PatchRelation` · `ListCitations`

### Cola de revisión

`ListReview` · `ReviewCount` · `EnqueueReview` · `ResolveReview`

### Sesión

```go
func (c *Client) CreateSession(ctx, body map[string]interface{}, ...RequestOption) (map[string]interface{}, error)
func (c *Client) CollapseSession(ctx, id string, body map[string]interface{}, ...RequestOption) (map[string]interface{}, error)
func (c *Client) AppendTurn(ctx, id string, AppendTurnInput, ...RequestOption) error
func (c *Client) PinSessionTurn(ctx, id string, PinSessionTurnInput, ...RequestOption) error
```

`AppendTurn` y `PinSessionTurn` devuelven solo `error` (el servidor responde `204 No Content`).

### Consolidación / Recordatorios

`TriggerConsolidation` · `CreateReminder` · `ListReminders` · `DismissReminder`

### Tareas / Eventos / Razonamiento / Estrategias

Cada grupo: `List*` · `Create*` · `Get*` · `Patch*` · `Archive*`

### Hiperaristas

`ListHyperedges` · `CreateHyperedge` · `GetHyperedge` · `PatchHyperedge` · `ArchiveHyperedge`

### Metacognición / Anticipación / Composición

`GetSelfModel` · `GetAnticipationFeed` · `ListCompositionRules` · `CreateCompositionRule` · `GetCompositionRule` · `PatchCompositionRule` · `DryRunComposition`

### Autoedición

`SelfEdit` · `SelfReflect` · `GetSelfProfile`

### Federación

`ListFederationPeers` · `ListPendingFederationPeers` · `ApproveFederationPeer` · `ApproveFederationPeerKey` · `DeleteFederationPeer` · `ListFederationItems` · `TriggerFederationSync` · `GetFederationSyncJob` · `ResolveFederationConflict`

## Ejecutar las pruebas

```bash
go test ./...
```

Las pruebas usan `net/http/httptest`: no hace falta un servidor real.

## Licencia

Apache-2.0 — consulta [LICENSE](../../LICENSE).
