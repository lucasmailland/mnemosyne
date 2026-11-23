# mnemosyne/sdk-go

**English** · [Español](README.es.md)

> **AI pointer:** Zero-dependency Go HTTP client for the Mnemosyne cognitive memory API. One `Client` struct covers the full REST surface; idempotency keys and exponential-backoff retry are built in.
>
> **Depends on:** Go standard library only (no third-party modules)
>
> **Exposes:** `mnemo.Client`, `mnemo.NewClient`, `mnemo.NewIdempotencyKey`, `mnemo.WithIdempotencyKey`, error type `mnemo.APIError`
>
> **Status:** ALPHA — version 3.0.0a0
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [packages/client-ts/README.md](../client-ts/README.md)

Go SDK for the Mnemosyne v3 cognitive memory server. Uses only the Go standard library (`net/http`, `encoding/json`, `crypto/rand`, etc.) — zero runtime dependencies. Requires Go 1.21+.

## Install

```bash
go get github.com/lucasmailland/mnemosyne/packages/sdk-go
```

The module lives in a subdirectory of the main repository. No `packages/sdk-go/vX.Y.Z` tag has
been cut yet, so `go get` resolves a pseudo-version of the latest commit on `main`.

## Import

```go
import "github.com/lucasmailland/mnemosyne/packages/sdk-go/mnemo"
```

## 30-second start

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

`baseURL` and `apiKey` are both required; the function returns an error for empty strings. The client uses a 30-second per-request timeout (`defaultTimeout = 30 * time.Second`) and defaults to 3 retry attempts on 429/5xx.

## Retry behavior

`Client.do` retries on HTTP 429, 500, 502, 503, and 504 with full-jitter exponential backoff (base delays 200 ms, 400 ms, 800 ms). Context cancellation is respected during backoff sleeps. 4xx errors other than 429 are never retried.

## Idempotency

Mutating methods accept optional `RequestOption` values. The only option today is `WithIdempotencyKey`, which sets the `Idempotency-Key` request header. Generate one key before the first attempt and reuse it across retries — generating a new key per attempt defeats the purpose.

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

`NewIdempotencyKey` returns an RFC-4122 v4 UUID and uses only `crypto/rand`, preserving the zero-dependency guarantee.

## Error handling

Non-2xx responses are returned as `*mnemo.APIError`:

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

All methods accept a `context.Context` as the first argument. Most return `(map[string]interface{}, error)`; exceptions are noted.

### Input structs

| Struct                                                               | Used by                                             |
| -------------------------------------------------------------------- | --------------------------------------------------- |
| `RecallInput{Query, Vector, TopK, AsOf, VectorWeight}`               | `Recall`                                            |
| `FactInput{Content, Attribution, Tags}`                              | `CreateFact`                                        |
| `PinInput{Pinned}`                                                   | internal use in `PinFact` / `UnpinFact`             |
| `AppendTurnInput{Role, Content, Metadata}`                           | `AppendTurn`                                        |
| `PinSessionTurnInput{TurnID, Pinned}`                                | `PinSessionTurn`                                    |
| `ConsolidationInput{Mode, DryRun}`                                   | `TriggerConsolidation`                              |
| `SelfEditInput{Action, Target, Reason, Content, AgentID, SessionID}` | `SelfEdit`                                          |
| `FederationSyncInput{PeerID}`                                        | internal use in `TriggerFederationSync`             |
| `ApprovePeerInput{NewCertDer, IssuedAt}`                             | `ApproveFederationPeer`, `ApproveFederationPeerKey` |

### Recall

```go
func (c *Client) Recall(ctx context.Context, input RecallInput) (*RecallResponse, error)
```

`RecallResponse` has `Hits []map[string]interface{}` and `Debug map[string]interface{}`.

### Facts

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

### Timeline / Graph / Health / Export

```go
func (c *Client) Timeline(ctx, params url.Values) (map[string]interface{}, error)
func (c *Client) Graph(ctx, params url.Values) (map[string]interface{}, error)
func (c *Client) Health(ctx) (map[string]interface{}, error)
func (c *Client) ExportWorkspace(ctx) (map[string]interface{}, error)
func (c *Client) Audit(ctx, params url.Values) (map[string]interface{}, error)
```

### Entities

`ListEntities` · `GetEntity` · `CreateEntity` · `UpdateEntity` · `ListEntityFacts`

### Episodes

`ListEpisodes` · `GetEpisode`

### Decisions

`ListDecisions` · `GetDecision` · `CreateDecision` · `SupersedeDecision`

### Relations / Citations

`ListRelations` · `CreateRelation` · `PatchRelation` · `ListCitations`

### Review queue

`ListReview` · `ReviewCount` · `EnqueueReview` · `ResolveReview`

### Session

```go
func (c *Client) CreateSession(ctx, body map[string]interface{}, ...RequestOption) (map[string]interface{}, error)
func (c *Client) CollapseSession(ctx, id string, body map[string]interface{}, ...RequestOption) (map[string]interface{}, error)
func (c *Client) AppendTurn(ctx, id string, AppendTurnInput, ...RequestOption) error
func (c *Client) PinSessionTurn(ctx, id string, PinSessionTurnInput, ...RequestOption) error
```

`AppendTurn` and `PinSessionTurn` return `error` only (the server responds `204 No Content`).

### Consolidation / Reminders

`TriggerConsolidation` · `CreateReminder` · `ListReminders` · `DismissReminder`

### Tasks / Events / Reasoning / Strategies

Each group: `List*` · `Create*` · `Get*` · `Patch*` · `Archive*`

### Hyperedges

`ListHyperedges` · `CreateHyperedge` · `GetHyperedge` · `PatchHyperedge` · `ArchiveHyperedge`

### Meta-cognition / Anticipation / Composition

`GetSelfModel` · `GetAnticipationFeed` · `ListCompositionRules` · `CreateCompositionRule` · `GetCompositionRule` · `PatchCompositionRule` · `DryRunComposition`

### Self-editing

`SelfEdit` · `SelfReflect` · `GetSelfProfile`

### Federation

`ListFederationPeers` · `ListPendingFederationPeers` · `ApproveFederationPeer` · `ApproveFederationPeerKey` · `DeleteFederationPeer` · `ListFederationItems` · `TriggerFederationSync` · `GetFederationSyncJob` · `ResolveFederationConflict`

## Running tests

```bash
go test ./...
```

Tests use `net/http/httptest` — no live server required.

## License

Apache-2.0 — see [LICENSE](../../LICENSE).
