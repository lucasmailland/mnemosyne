# Mnemosyne 3.0 — Architecture Constraints & Addendum

> Supplements MEMORY_IMPROVEMENT.md with binding constraints, provider model,
> distribution strategy, and admin interfaces. This is the source of truth
> for architectural decisions that override or refine the main spec.

---

## 1. Core Constraint: Zero External Cost

Mnemosyne's core functionality MUST work with **zero paid dependencies**.

```
HARD REQUIREMENT : PostgreSQL (open-source, self-hosted)
OPTIONAL ENHANCE : Redis (open-source, self-hosted)
OPTIONAL ENHANCE : Embedding provider (consumer-provided)
OPTIONAL ENHANCE : LLM provider (consumer-provided)
OPTIONAL ENHANCE : Rerank provider (consumer-provided)
```

Features by dependency tier:

| Tier          | Dependencies    | Features Available                                                                                                                       |
| ------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| **Minimal**   | PostgreSQL only | Recall (FTS), remember, forget, review, graph, bitemporal, RLS, zero-LLM features (composition, consensus, meta-cognition, anticipation) |
| **Enhanced**  | + Redis         | Session memory, working memory L0-L2, hot tier, ACT-R activation                                                                         |
| **Semantic**  | + Embedder      | Vector recall, hybrid search, semantic dedup, rerank                                                                                     |
| **Cognitive** | + LLM           | Extraction, session collapse, CoT distillation, procedural evolution, self-reflection                                                    |

> **Note (ALG-02):** Consolidation requires LLM + vector embeddings; it is available in the Cognitive tier only. See SUBSYSTEM_CONSOLIDATION.md.

Every tier is additive. Downgrading never breaks — it gracefully degrades.

---

## 2. Provider Injection Model

Mnemosyne does NOT own inference. The **connecting system** provides it.

### 2.1 Configuration Contract

```typescript
interface MnemoProviderConfig {
  embedding?: {
    type: ProviderType;
    model: string;
    endpoint?: string; // Custom base URL
    apiKey?: string; // If needed
    dimensions?: number; // Override default
    batchSize?: number; // Max items per call
  };

  extraction?: {
    type: ProviderType;
    model: string;
    endpoint?: string;
    apiKey?: string;
    maxTokens?: number;
    temperature?: number;
  };

  rerank?: {
    type: ProviderType;
    model: string;
    endpoint?: string;
    apiKey?: string;
    topN?: number;
  };

  judgment?: {
    type: ProviderType;
    model: string;
    endpoint?: string;
    apiKey?: string;
  };
}

type ProviderType =
  | "openai" // OpenAI native
  | "openai-compatible" // Any OpenAI-API endpoint (LM Studio, vLLM, TGI, LocalAI)
  | "anthropic" // Anthropic Messages API
  | "google" // Google Generative AI (Gemini)
  | "bedrock" // AWS Bedrock (multi-model)
  | "cohere" // Cohere (embed + rerank)
  | "mistral" // Mistral
  | "voyage" // Voyage AI (embeddings)
  | "ollama" // Ollama native
  | "inherited"; // Use the host session's model (MCP pattern)
```

### 2.2 Inherited Model Pattern (MCP/Agent)

When Mnemosyne runs as an MCP server inside Claude, Gemini, Cursor, or any agent:

```
Agent (has model access) → MCP tool call → Mnemosyne
                                              │
                                              ├── Core ops: handled locally (PG)
                                              └── LLM ops: returns structured request
                                                   back to the agent to execute
```

For "inherited" provider type:

- Extraction: Mnemosyne returns the extraction prompt + schema; the host executes it
- Embedding: Host must expose an embed endpoint or Mnemosyne falls back to FTS
- This means zero API keys needed when running inside an agent

### 2.3 Configuration Methods

| Method                                | Use Case                     |
| ------------------------------------- | ---------------------------- |
| Environment variables                 | Docker/K8s deployment        |
| REST API (`POST /v1/admin/providers`) | Runtime hot-reload           |
| TUI interface                         | Interactive setup            |
| Web UI (Studio)                       | Visual configuration         |
| SDK constructor                       | Programmatic (embedded mode) |

---

## 3. Integration Surface (Universal)

Mnemosyne MUST be consumable from any system. No single integration is privileged.

| Integration         | Package                             | Status                   |
| ------------------- | ----------------------------------- | ------------------------ |
| **npm library**     | `@mnemo-ai/core`                    | Existing (v2.0)          |
| **HTTP API**        | `@mnemo-ai/server`                  | Existing (v2.0)          |
| **MCP server**      | `@mnemo-ai/mcp`                     | Existing (v2.0, 5 tools) |
| **TypeScript SDK**  | `@mnemo-ai/client-ts`               | Existing (v2.0)          |
| **Python SDK**      | `mnemo-ai-sdk` (pip, from the repo) | Existing                 |
| **Go SDK**          | `packages/sdk-go` (REST client)     | Existing                 |
| **CLI**             | `mnemosyne` binary (Homebrew/apt)   | Planned                  |
| **TUI**             | Built into CLI binary               | Planned                  |
| **Web UI (Studio)** | Separate deployable app             | Planned                  |
| **gRPC**            | ConnectRPC service                  | Implemented              |
| **WebSocket**       | Real-time subscriptions             | Implemented              |
| **Docker image**    | `mnemosyne/server`                  | Existing                 |

---

## 4. Distribution & Packaging

### 4.1 npm (primary)

```
@mnemo-ai/core           — Pure library (zero network, zero paid deps)
@mnemo-ai/server         — Hono HTTP server
@mnemo-ai/mcp            — MCP server (stdio only; calls the REST API)
@mnemo-ai/client-ts      — Typed HTTP client
@mnemo-ai/llm-providers  — Provider adapters (all 9+ types)
@mnemo-ai/tui            — Terminal UI (optional)
@mnemo-ai/studio         — Web admin UI (optional)
```

### 4.2 Homebrew

```bash
brew install mnemosyne
# Installs: mnemo CLI + server + TUI
# Single binary (Go or Bun-compiled)
```

### 4.3 Docker

```bash
docker pull mnemosyne/server:3.0
docker pull mnemosyne/studio:3.0  # Optional web UI
```

### 4.4 System packages

```bash
# Debian/Ubuntu
apt install mnemosyne

# Arch
yay -S mnemosyne
```

### 4.5 Python

```bash
# Not on PyPI yet: install from the repository
pip install "git+https://github.com/lucasmailland/mnemosyne.git#subdirectory=packages/sdk-python"
# Generated from OpenAPI spec
```

### 4.6 Go

```go
import "github.com/lucasmailland/mnemosyne/packages/sdk-go/mnemo"
```

---

## 5. Admin Interfaces (All Optional)

### 5.1 TUI (Terminal User Interface)

Built with Bubbletea (Go) or Ink (Node). For power users and server admins.

**Features:**

- Provider configuration wizard
- Health dashboard (real-time metrics)
- Fact browser (search, filter, time-travel)
- Workspace management
- Review queue processing
- Session inspector
- Graph explorer (ASCII-rendered)
- Import/Export operations

**Invocation:**

```bash
mnemo tui                    # Launch full TUI
mnemo tui --view health      # Jump to health view
mnemo tui --view facts       # Jump to fact browser
```

### 5.2 Web UI (Mnemosyne Studio)

Self-hostable web inspector. React/Next.js or similar.

**Features:**

- Visual fact search with time-travel slider
- Knowledge graph visualization (force-directed)
- Provider configuration UI
- Workspace & API key management
- Review queue with approve/reject/edit
- Session timeline viewer
- Consolidation history & rollback
- Memory worth distribution charts
- Cost & token economics dashboard
- Real-time health monitoring

**Deployment:**

```bash
docker compose up studio    # Alongside server
# OR
npx @mnemo-ai/studio      # Standalone
```

### 5.3 CLI (Headless)

For scripting, CI/CD, and non-interactive use.

```bash
mnemo recall "what's our deploy process?"
mnemo remember "Redis version is 7.2" --type fact --confidence 0.9
mnemo forget fact_123 --reason "outdated"
mnemo health
mnemo export --workspace ws_default --format jsonl
mnemo providers list
mnemo providers set embedding --type ollama --model nomic-embed-text
```

---

## 6. Example: Orchester Integration

Orchester (the consuming monorepo) connects to Mnemosyne with its own models:

```
┌─────────────────────────────────────────────────────┐
│  ORCHESTER (consuming app — uses @mnemo-ai/client-ts) │
│                                                      │
│  Models configured:                                  │
│  ├── Claude Sonnet (Anthropic API) → extraction     │
│  ├── Ollama nomic-embed-text (local) → embeddings   │
│  └── Cohere rerank-v3.5 → reranking                 │
│                                                      │
│  On boot:                                            │
│  mnemo.configure({                                   │
│    providers: {                                      │
│      embedding: { type: "ollama", model: "nomic..." }│
│      extraction: { type: "anthropic", model: "..." } │
│      rerank: { type: "cohere", model: "rerank-v3.5" }│
│    }                                                 │
│  })                                                  │
└──────────────┬──────────────────────────────────────┘
               │ In-process (embedded mode)
               ▼
┌─────────────────────────────────────────────────────┐
│  MNEMOSYNE (@mnemo-ai/core)                         │
│                                                      │
│  Uses Orchester's models for:                        │
│  ├── Session collapse → Claude Sonnet               │
│  ├── Fact embedding → Ollama (local, free)          │
│  ├── Recall rerank → Cohere                         │
│  └── Everything else → pure PG (no model needed)    │
└─────────────────────────────────────────────────────┘
```

When connected via MCP (Claude Desktop, Cursor):

```
┌─────────────────────────────────────────────────────┐
│  CLAUDE DESKTOP / CURSOR                             │
│                                                      │
│  Has: Claude model (inherited)                       │
│  MCP connection to Mnemosyne                         │
│                                                      │
│  Provider config:                                    │
│  { extraction: { type: "inherited" } }              │
│  (Mnemosyne asks Claude to extract via tool response)│
└──────────────┬──────────────────────────────────────┘
               │ MCP (stdio)
               ▼
┌─────────────────────────────────────────────────────┐
│  MNEMOSYNE MCP SERVER                                │
│                                                      │
│  Core ops: local (PG)                                │
│  Embedding: disabled OR local Ollama if configured   │
│  Extraction: returns prompt to host (inherited)      │
└─────────────────────────────────────────────────────┘
```

---

## 7. What This Changes in the Spec

Compared to MEMORY_IMPROVEMENT.md, these constraints ADD:

| Addition                                         | Section Affected        |
| ------------------------------------------------ | ----------------------- |
| Provider injection model                         | Service Architecture    |
| "inherited" provider type for MCP                | Interfaces de Consumo   |
| TUI interface                                    | New section             |
| Web UI (Studio)                                  | New section             |
| CLI headless mode                                | New section             |
| Homebrew/apt/pip distribution                    | SDK & Client Generation |
| Zero-cost tier guarantee                         | Architecture Cognitiva  |
| Graceful degradation tiers (Minimal → Cognitive) | Architecture Cognitiva  |
| Config hot-reload via API                        | Service Architecture    |

And these constraints MODIFY:

| Modification   | Original           | Now                                  |
| -------------- | ------------------ | ------------------------------------ |
| LLM provider   | Assumed available  | Consumer-provided, optional          |
| Redis          | Assumed available  | Optional, graceful degradation       |
| Cost model     | Billing for hosted | Self-hosted free; hosted optional    |
| SDK generation | From OpenAPI only  | npm + brew + pip + go + docker + apt |
| Admin          | Via API only       | TUI + Web UI + CLI + API             |

---

## 8. Non-Goals (Explicit)

- Mnemosyne does NOT provide hosted LLM inference
- Mnemosyne does NOT charge for core memory operations
- Mnemosyne does NOT require internet access for core functionality
- Mnemosyne does NOT lock users into specific model providers
- Mnemosyne does NOT mandate the TUI or Web UI for operation
- Mnemosyne does NOT require Redis to function (only to optimize)
