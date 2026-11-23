# @mnemo-ai/federation

**English** · [Español](README.es.md)

> **AI pointer:** Cross-instance memory federation — peer discovery, federated recall voting, trust-weighted aggregation.
>
> **Depends on:** @mnemo-ai/types, @mnemo-ai/core
>
> **Exposes:** SyncEngine, MtlsAuthAdapter; 9 federation HTTP routes (mounted in server)
>
> **Status:** BETA — SyncEngine + 9 HTTP routes wired (LWW /resolve live); all transports implemented
>
> **See also:** [CLAUDE.md](../../CLAUDE.md) · [docs/INDEX.md](../../docs/INDEX.md) · [docs/architecture/FEDERATION.md](../../docs/architecture/FEDERATION.md)

Ed25519-signed peer-to-peer sync layer for sharing memories across workspace
boundaries or across multiple Mnemosyne instances in a distributed deployment.

---

## What It Does

Federation allows two Mnemosyne instances — running in different organizations,
regions, or security domains — to share selected memories with cryptographic
attribution and trust-bounded scoring.

A federated memory arrives with `attribution: 'federation_received'` and a
capped trust score of 20, regardless of the originating peer's internal confidence.
This prevents a compromised or malicious peer from injecting high-trust facts.

---

## Architecture Position

```
Instance A (local)         Instance B (remote peer)
  @mnemo-ai/federation  ←───Ed25519-signed payload───  @mnemo-ai/federation
       ↓
  @mnemo-ai/core  (StorageAdapter, VectorAdapter)
```

Federation is a separate concern from storage. The sync engine coordinates
with the core ports but does not bypass them — federated facts flow through the
same `StorageAdapter` interface as locally-created facts.

---

## Implementation Status

| Component                   | Status   | Notes                                                                                           |
| --------------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| Federation type definitions | Done     | In `@mnemo-ai/types`                                                                            |
| `SyncEngine` class          | **Done** | Implemented and wired at server boot                                                            |
| `MtlsAuthAdapter`           | **Done** | mTLS peer authentication implemented                                                            |
| HTTP routes                 | **Done** | 10 routes mounted via `mountFederation` in `routes/federation.ts`                               |
| Peer store                  | **Done** | `DrizzlePeerStore` (Postgres, migration 0061); peers added with `POST /memory/federation/peers` |
| LWW conflict resolution     | **Done** | `POST /memory/federation/resolve` live (last-write-wins)                                        |
| Tombstone protocol          | **Done** | `/items` serves a forgotten, merged or deleted fact as a tombstone; the puller archives it      |
| Resurrection guard          | **Done** | A tombstoned `remoteId` is never upserted again (`SyncEngine`)                                  |
| Pull transport              | **Done** | `pullFromPeer` called in `routes/federation.ts`; full Ed25519-verified sync loop implemented    |
| Wired to live server        | **Done** | `deps.federation` wired at server boot                                                          |

---

## Security Model

**Peer trust is LOCAL configuration only.** Trust weights are never accepted from
incoming sync payloads — a peer cannot declare its own trust level. This is a
core security invariant.

An operator adds each peer with a key that holds `federation:admin`; this is
the only way a peer is created (a key-rotation ANNOUNCE never creates one).
The server keeps peers in `mnemo_federation_peer` (migration 0061), or in
memory when it runs without the Postgres adapter.

```bash
curl -X POST "$MNEMO_URL/memory/federation/peers" \
  -H "Authorization: Bearer $MNEMO_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{
    "peerId": "acme.example",
    "pinnedCertDer": "<base64 DER>",
    "trustWeight": 0.6,
    "url": "https://acme.example",
    "apiKey": "<key this server sends when pulling>"
  }'
```

`trustWeight` (0 to 1) is a LOCAL decision, ignored if the peer sends its own.
`enabled` defaults to true; `signingPublicKey` (PEM) and `symmetricKey` (32
bytes, base64) go together and turn on signed, sealed pulls. Unknown fields
answer 400 and an existing `peerId` answers 409.

`apiKey` and `symmetricKey` are encrypted at rest with the `MNEMO_MASTER_KEY`
key ring (stored as given only in dev, without a master key), and no response,
audit entry or log line carries them: `GET /memory/federation/peers` shows
`hasApiKey`, `hasSymmetricKey` and the pin's `certFingerprint` instead.

### Pulling between two servers

Each server has one federation identity:

- `MNEMO_FED_PEER_ID`: the id other servers register it under (for example
  `acme.example`). It is the `iss` of every service JWT the server signs and the
  `aud` it accepts (`MNEMO_FED_AUDIENCE` overrides the latter).
- `MNEMO_FEDERATION_PRIVATE_KEY`: its Ed25519 private key, PEM. Peers pin the
  matching public key (SPKI DER, base64) as `pinnedCertDer`.

For Larkspur (`larkspur.example`) to pull from Acme (`acme.example`):

1. On Acme, `POST /admin/keys` with `"federation": true` and
   `"scopes": ["memory:federation"]` returns an `mk_fed_` key. Hand it to Larkspur.
2. On Acme, register Larkspur: its id and public key.
3. On Larkspur, register Acme: its id, public key, `url`, and the `mk_fed_` key
   as `apiKey`.
4. On Larkspur, `POST /memory/federation/sync` with `{"peerId": "acme.example"}`
   and a local key holding `memory:federation` (a peer's `mk_fed_` key is
   refused: a peer cannot make you pull). Poll `GET /memory/federation/sync/{jobId}`;
   the items land in the caller's workspace. A sync reads every page the peer
   has after the cursor the previous sync from it recorded, so edits arrive as
   new versions and forgotten or deleted facts as tombstones. The job is kept in Postgres
   (migration 0063), so a restart does not lose it; one a restart cut short
   reads as `failed`.

Every pull carries the `mk_fed_` key in `Authorization`, plus `x-mnemo-peer-id`,
`x-mnemo-client-cert` (the puller's public key) and `x-mnemo-service-jwt`, an
EdDSA JWT for that one server (`aud` = its id, fresh `jti`, 60 seconds). Acme
checks the key class, the pin, and the JWT signature against the pinned key,
which is the proof of possession, then the issuer, audience, expiry and replay.
No header is trusted on its own.

Transport: the serving server requires TLS 1.3, learned from its own TLS socket
or, with `MNEMO_FED_TLS_PROXY=true`, from `x-mnemo-tls-protocol` set by the
TLS-terminating proxy in front of it. That proxy must overwrite
`x-mnemo-tls-protocol` (nginx: `$ssl_protocol`) on every request and drop any
copy the client sent; with mTLS it may also overwrite `x-mnemo-client-cert` with
the verified client certificate (nginx: `$ssl_client_escaped_cert`), whose public
key must be the peer's pinned key. Set `MNEMO_TRUSTED_PROXY_IP` to the address
the proxy connects from so a client that reaches the server directly cannot
write those headers itself. A working nginx setup is in
`docs/architecture/MTLS_BOUNDARY.md`.
`MNEMO_FED_INSECURE_TRANSPORT=true` accepts plain HTTP for development; the
server refuses to start with it in production.

When Larkspur pulls from an Acme whose proxy requires a client certificate,
Larkspur presents one: `MNEMO_FED_CLIENT_CERT_FILE` and
`MNEMO_FED_CLIENT_KEY_FILE` (PEM files; the certificate is issued for
Larkspur's federation key, so its public key is the one Acme pinned).
`MNEMO_FED_CA_FILE` optionally verifies Acme's TLS certificate against a CA of
your own instead of the system roots. Without them pulls go out with no client
certificate, as before; a certificate without its key or an unreadable file
stops the server at boot.

All sync payloads are signed with Ed25519. A payload with an invalid or missing
signature is rejected before any data is written.

---

## Key Concepts

### Attribution Cap

All federated items are stored with:

```
attribution: 'federation_received'
trustScore: 20   // hard cap — never higher, regardless of peer's local score
```

This ensures federated facts are distinguishable from locally-sourced facts and
cannot outrank them in recall without explicit promotion by a local admin.

### Tombstone Protocol

When a fact is deleted locally, a tombstone record is propagated to peers. Peers
that have a copy of the fact mark it as tombstoned rather than deleting
immediately, preserving audit trails.

### Resurrection Guard

A tombstoned fact cannot be re-created by an incoming sync from the originating
peer. The guard checks the tombstone log before accepting any upsert.

### Version Guard

Incoming sync items are rejected if:

```
incoming.version > local.version + 100
```

This prevents version-number manipulation attacks where a peer floods fake
version numbers to force overwrite of local facts.

---

## When to Use Federation

- Multi-instance deployments where two Mnemosyne installations need to share
  memory (e.g., two subsidiaries of an organization)
- Cross-workspace collaboration with explicit trust boundaries
- Disaster-recovery topologies where a standby instance mirrors a primary

Do **not** use federation for single-instance multi-tenant isolation — that is
handled by Row-Level Security in `@mnemo-ai/adapter-postgres`.
