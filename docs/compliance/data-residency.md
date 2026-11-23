# Data Residency & Multi-Region Architecture

> **Owner:** Legal / DPO — PENDING HUMAN OWNER (DPA execution, SCC signing, TIA completion require legal/DPO sign-off)

---

## Supported Regions

| Region           | Role    | Data Centre                    |
| ---------------- | ------- | ------------------------------ |
| `us-east-1`      | Primary | AWS us-east-1 (N. Virginia)    |
| `eu-west-1`      | EU      | AWS eu-west-1 (Ireland)        |
| `ap-southeast-1` | APAC    | AWS ap-southeast-1 (Singapore) |

---

## Region-Lock Guarantee

- A workspace is **pinned to a region at creation** via the `region` column on the workspace record (`mnemo_workspace.region`, migration 0062): it takes the `MNEMO_REGION` of the instance that creates it.
- The region is **immutable** — no API allows changing it. To migrate a workspace to a different region, create a new workspace in the target region and use `/v1/export` + `/v1/import`.
- The `MNEMO_REGION` env var identifies which region a server instance serves. On every authenticated request, the middleware (`packages/server/src/middleware/region.ts`) asserts `workspace.region === MNEMO_REGION`. Mismatch returns `403 wrong_region` with the correct `homeRegion` in the details.
- When `MNEMO_REGION` is unset, the check is disabled (single-region back-compat mode).
- A workspace created before migration 0062, or by an instance without `MNEMO_REGION`, has no region and is not checked.
- The check covers the HTTP API, the dashboard, gRPC (`PermissionDenied`) and WebSocket upgrades (closed with 1008).

## Cross-Region Federation

Federation between instances in **different** regions uses a **metadata-only** projection (spec §35 lines 4074–4076). The peer receives `{ factId, hash, region }` triples only — never `statement`, `content`, or `embedding`. This prevents content data crossing region boundaries via federation.

Implementation: `packages/federation/src/syncProtocol.ts` → `projectForPeer()`.

---

## Sub-Processor List (template — PENDING HUMAN OWNER)

| Sub-processor             | Purpose             | Region(s)             | Data types                     |
| ------------------------- | ------------------- | --------------------- | ------------------------------ |
| AWS RDS / Neon / Supabase | PostgreSQL database | See workspace region  | All workspace data             |
| Redis Labs / Upstash      | Hot-tier cache      | Co-located with PG    | Embeddings, fact cache         |
| OpenAI / Anthropic        | LLM + embeddings    | Varies (process text) | Statements (no PII by default) |
| GitHub Actions            | CI/CD               | us-east-1             | Code, no user data             |

_This list must be kept current and reviewed annually. New sub-processors require DPA execution before data is shared._

---

## DPA Reference

A Data Processing Agreement (DPA) must be executed with Mnemosyne when:

- The customer is subject to GDPR (EU/EEA data subjects).
- The customer requires standard contractual clauses (SCC) for data transfers outside the EU.

_PENDING HUMAN OWNER: DPA template and execution process are owned by Legal._

---

## Standard Contractual Clauses (SCC)

Required for transfers of EU personal data to non-adequacy countries (e.g., `us-east-1` serving EU subjects). Controller-to-Processor SCC Module 2 applies.

_PENDING HUMAN OWNER: SCC signing must be coordinated by Legal / DPO._

---

## Transfer Impact Assessment (TIA)

Per GDPR Article 46 and Schrems II, a TIA is required for any transfer to a third country. The TIA must assess:

1. Laws and practices of the destination country that may impede SCC obligations.
2. Supplementary technical measures (encryption in transit, at rest, DEK-per-actor erasure).
3. Contractual measures (DPA, SCC, sub-processor agreements).
4. Organisational measures (access logs, quarterly access review, same-day offboarding).

_PENDING HUMAN OWNER: TIA is owned by the DPO and must be reviewed annually or on material change._

---

## No-Region-Migration Policy

Workspace regions are immutable. This is an intentional design decision (spec §35 line 4063):

> "Cannot migrate region — must create new workspace + export/import"

Rationale: allowing region changes would require copying all data across regions, with a window where data exists in both. This violates residency guarantees. The correct procedure is:

1. Create a new workspace in the target region.
2. Export the source workspace: `GET /v1/export` (JSONL).
3. Import into the new workspace: `POST /v1/import`.
4. Update API keys to point at the new workspace.
5. Archive / delete the old workspace.
