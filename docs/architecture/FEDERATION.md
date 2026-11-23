# Mnemosyne — Plugins and Federation

What `@mnemo-ai/plugins` and `@mnemo-ai/federation` do inside the server today, taken
from the code. Each statement names the file it comes from. The product status of both
features is in [docs/STATUS.md](../STATUS.md).

---

## Table of Contents

### Part 1: Plugins

1. [Loading and configuration](#1-loading-and-configuration)
2. [Hooks the server calls](#2-hooks-the-server-calls)
3. [PluginContext](#3-plugincontext)
4. [Failure handling](#4-failure-handling)
5. [Built-in plugins](#5-built-in-plugins)

### Part 2: Federation

6. [What federation does](#6-what-federation-does)
7. [Server identity](#7-server-identity)
8. [Peers](#8-peers)
9. [Pulling: POST /memory/federation/sync](#9-pulling-post-memoryfederationsync)
10. [Serving: GET /memory/federation/items and the peer gate](#10-serving-get-memoryfederationitems-and-the-peer-gate)
11. [App-layer crypto (optional)](#11-app-layer-crypto-optional)
12. [Applying pulled items: SyncEngine](#12-applying-pulled-items-syncengine)
    - 12a. [Pulled items in recall](#12a-pulled-items-in-recall)
13. [POST /memory/federation/resolve](#13-post-memoryfederationresolve)
14. [gRPC FederationSync](#14-grpc-federationsync)
15. [Endpoints and scopes](#15-endpoints-and-scopes)
16. [Metrics, audit and logs](#16-metrics-audit-and-logs)
17. [What does not exist](#17-what-does-not-exist)

---

# Part 1: Plugins

The plugin runtime is `packages/plugins/src/index.ts`; the server wires it in
`packages/server/src/boot/plugins.ts`. The full interface, the loader API and the
built-in table are in [packages/plugins/README.md](../../packages/plugins/README.md).

## 1. Loading and configuration

- `MNEMO_PLUGINS` lists the plugins to load, comma-separated: `builtin:<id>` for a
  built-in, or the name of an npm package installed next to the server, whose default or
  named `plugin` export is the plugin. With the variable unset, no plugin code runs.
- `MNEMO_PLUGIN_<ID>__<KEY>` sets one config value. `<ID>` is the plugin id upper-cased
  with every character outside `A-Z0-9` turned into `_`; `<KEY>` in UPPER_SNAKE becomes
  the camelCase key the plugin reads from `ctx.config` (`MNEMO_PLUGIN_OUTLINE_SYNC__API_TOKEN`
  arrives as `ctx.config.apiToken`).
- Plugins load in the order `MNEMO_PLUGINS` lists them, and chained hooks run in that order.
- An entry that does not load (unknown built-in, missing package, bad export) is logged as
  `plugin.load_failed` and skipped; the server boots without it.

```bash
MNEMO_PLUGINS=builtin:webhook-notify,@acme/mnemosyne-erp-plugin
MNEMO_PLUGIN_WEBHOOK_NOTIFY__URL=https://hooks.acme.example/mnemo
```

Plugins run in the server process with no sandbox: a listed package has the server's
memory, filesystem, network and environment. The threat model is in
[PLUGIN_SECURITY.md](./PLUGIN_SECURITY.md).

## 2. Hooks the server calls

| Hook                                       | Called from                                                                                                                                                                        |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `onInit` (or the deprecated `onBoot`)      | Boot, once (`runBoot` in `boot/plugins.ts`)                                                                                                                                        |
| `onShutdown`                               | Server shutdown, 5 s per plugin (`runShutdown`)                                                                                                                                    |
| `onBeforeWrite`, `onAfterWrite`            | `POST /remember` for `kind: "fact"` only (`routes/remember.ts`); `null` from `onBeforeWrite` rejects                                                                               |
| `onBeforeRecall`, `onAfterRecall`          | The recall route (`routes/recall.ts`)                                                                                                                                              |
| `onFactCreated`, `onTaskCompleted`         | Event bus, fire-and-forget                                                                                                                                                         |
| `onSessionCollapsed`, `onConflictDetected` | Event bus, fire-and-forget                                                                                                                                                         |
| `onWorthChanged`, `onEventRecorded`        | Event bus, fire-and-forget                                                                                                                                                         |
| `sync`                                     | Cron job `mnemo.plugin.sync:<id>` per plugin, every `syncInterval` (60 s minimum; else `MNEMO_PLUGIN_SYNC_INTERVAL_MS`), in `MNEMO_PLUGIN_<ID>__WORKSPACE_ID`                      |
| `verify`                                   | Cron job `mnemo.plugin.verify`, daily at 05:45 UTC, on that workspace's code, config and infrastructure facts under the plugin's ceiling; an invalid fact goes to the review queue |
| `onHealthCheck`                            | `GET /health/deep`, block `plugins` (never changes the overall status)                                                                                                             |

A plugin without `MNEMO_PLUGIN_<ID>__WORKSPACE_ID` is skipped by `sync` and `verify`, with a
warning. Each per-plugin job takes the cron lock, so it runs once per period across replicas.

## 3. PluginContext

Every hook gets a context built for that plugin (`packages/server/src/plugins/context.ts`):

- `workspaceId`, `config` (its own `MNEMO_PLUGIN_<ID>__*` values) and `maxSensitivity`
  (`MNEMO_PLUGIN_<ID>__MAX_SENSITIVITY`, default `internal`), which also caps the
  sensitivity of facts it writes;
- reads: `recall(query)`, `getFact(id)`;
- writes: `createFact`, `createEvent`, `createTask`, `createEpisode`, attributed to
  `plugin:<id>`;
- `state`: a key-value store kept under the plugin id in `mnemo_plugin_state`;
- `log` / `logger`.

## 4. Failure handling

Each hook call goes through `PluginLoader.guard` with a 2 s timeout. A timeout disables the
plugin at once; three consecutive failures disable it too. Both log `MNEMO_010`, and a
disabled plugin stays in `list()` with `disabled: true` until the process restarts.

## 5. Built-in plugins

`BUILTIN_FACTORIES` (`packages/plugins/src/builtins/index.ts`) has 10 entries:
`webhook-notify`, `feedback-loop`, `git-verifier`, `calendar-sync`, `slack-events`,
`github-events`, `outline-sync`, `obsidian-export`, `claude-import` and `event-reactions`.
What each one does, the hook it uses and its config keys are in
[packages/plugins/README.md](../../packages/plugins/README.md#built-in-plugins). `git-verifier`
checks facts through the daily `verify` job, and `obsidian-export` uses that same job to write
those facts as markdown files into its `vaultDir`;
`slack-events`, `github-events` and `claude-import` only export functions
(`handleSlackEvent`, `handleGithubWebhook`, `importClaudeMemory`) for a host to call, and
the server mounts no route for them.

---

# Part 2: Federation

## 6. What federation does

One server pulls another server's facts. Pulling is the only direction: there is no push,
no announce message and no handshake. A pull is a sync job that reads the peer's facts
changed since the previous sync from it, page by page, and applies them to the caller's
workspace with `SyncEngine`.

The server wires federation in `packages/server/src/boot/federation.ts`. With the Postgres
adapter installed, peers live in `mnemo_federation_peer` (migration 0061), sync jobs in
`mnemo_federation_sync_job` (0063) and pulled items in `mnemo_federated_item`; without it,
all three live in memory and a restart forgets them. Pulled items stay in
`mnemo_federated_item`, apart from the workspace's own memory; recall reads them as one more
source (section 12a).

## 7. Server identity

From `packages/server/src/federation/federationIdentity.ts`:

| Variable                       | Meaning                                                                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MNEMO_FED_PEER_ID`            | The id other servers register this one under, the `iss` of every service JWT it signs and the `aud` it accepts.                                     |
| `MNEMO_FED_AUDIENCE`           | Overrides the accepted `aud`. Without it and without `MNEMO_FED_PEER_ID`, the accepted `aud` is `mnemo:instance:self`.                              |
| `MNEMO_FEDERATION_PRIVATE_KEY` | Ed25519 private key, PEM. Signs the service JWTs; peers pin its public key (SPKI DER, base64). Another key type logs `federation.identity_invalid`. |

Without both `MNEMO_FED_PEER_ID` and `MNEMO_FEDERATION_PRIVATE_KEY` the server still serves
peers but cannot pull (`federation.identity=none` at boot).

## 8. Peers

An operator adds each peer with `POST /memory/federation/peers` and a key that holds
`federation:admin`. It is the only way a peer is created. The body is strict (an unknown
field answers 400) and an existing `peerId` answers 409:

| Field              | Required | Rule                                                                                                        |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| `peerId`           | yes      | `^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$`                                                                       |
| `pinnedCertDer`    | yes      | Base64, non-empty, at most 16 384 characters: the peer's public key (SPKI DER) or DER certificate. The pin. |
| `trustWeight`      | yes      | 0 to 1. A local decision, used as the peer's weight in `/resolve`.                                          |
| `enabled`          | no       | Defaults to true.                                                                                           |
| `url`              | no       | The peer's base URL. `https` only, unless `MNEMO_FED_INSECURE_TRANSPORT=true`.                              |
| `apiKey`           | no       | The `mk_fed_` key the peer issued to this server; sent as the bearer when pulling.                          |
| `signingPublicKey` | no       | The peer's Ed25519 public key, PEM. Goes together with `symmetricKey` (section 11).                         |
| `symmetricKey`     | no       | 32 bytes, base64. Goes together with `signingPublicKey`.                                                    |

The pin is mandatory: every peer has `pinnedCertDer`, and the peer gate (section 10)
rejects a request whose presented key does not match it and verifies the JWT with it.

`apiKey` and `symmetricKey` are sealed with the `MNEMO_MASTER_KEY` key ring
(`peerSecretCipherFromEnv` in `boot/federation.ts`); without a master key, in development,
they are stored as given. `GET /memory/federation/peers` returns `hasApiKey`,
`hasSymmetricKey` and `certFingerprint` (SHA-256 hex of the pin) instead of the secrets.
`DELETE /memory/federation/peers/{id}` removes a peer.

Replacing a pin: `POST /memory/federation/peers/{id}/approve` and
`POST /memory/federation/peers/{id}/approve-key` both take `{ "newCertDer": "<base64>" }`
and replace the stored pin of an existing, enabled peer (the first through
`MtlsAuthAdapter.processAnnounce` with operator approval, the second through
`approveKeyRotation`). Both write a `federation_cert_rotated` audit entry with the old and
new fingerprints. `GET /memory/federation/peers/pending` always answers
`{ "peers": [], "discovery": { "enabled": false, ... } }`: no discovery exists.

The key a peer pulls with comes from `POST /admin/keys` with `"federation": true`. It is an
`mk_fed_` workspace key, never a test key, and its scopes must be exactly
`["memory:federation"]` (`packages/server/src/routes/keys.ts`). Its workspace is the
workspace the peer reads from.

Setting up Larkspur (`larkspur.example`) to pull from Acme (`acme.example`):

1. On Acme, `POST /admin/keys` with `"federation": true` and
   `"scopes": ["memory:federation"]`; hand the `mk_fed_` key to Larkspur.
2. On Acme, register Larkspur: its `peerId` and the public key of Larkspur's
   `MNEMO_FEDERATION_PRIVATE_KEY` as `pinnedCertDer`.
3. On Larkspur, register Acme: its `peerId`, its public key, `url` and the `mk_fed_` key as
   `apiKey`.
4. On Larkspur, `POST /memory/federation/sync` with `{"peerId": "acme.example"}`.

```bash
curl -X POST "$MNEMO_URL/memory/federation/peers" \
  -H "Authorization: Bearer $MNEMO_ADMIN_KEY" -H "Content-Type: application/json" \
  -d '{
    "peerId": "acme.example",
    "pinnedCertDer": "<base64 SPKI DER>",
    "trustWeight": 0.6,
    "url": "https://acme.example",
    "apiKey": "<mk_fed_ key Acme issued>"
  }'
```

## 9. Pulling: POST /memory/federation/sync

`routes/federation.ts`:

- Body `{ "peerId": "...", "conflictResolution"?: "theirs_wins" | "ours_wins" | "manual" | "merge" }`.
- Needs `memory:federation` from a key that is not an `mk_fed_` key: a peer's key answers
  403, so a peer cannot make this server pull.
- Answers 202 `{ "jobId": "...", "status": "pending" }` and writes a `federation_sync` audit
  entry. Poll `GET /memory/federation/sync/{jobId}`: `status` is `pending`, `running`,
  `done` or `failed`, and `outcome.results` lists the result of each item. The job records a
  heartbeat every 30 s; one that a restart cut short reads as `failed`.
- The job fails when the peer is unknown, has no `url` or `apiKey`, or this server has no
  identity (section 7).

Each request is `GET {url}/memory/federation/items?limit=200&cursor=<cursor>`
(`packages/federation/src/PullClient.ts`), with:

| Header                | Value                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------- |
| `Authorization`       | `Bearer <apiKey>`, the `mk_fed_` key the peer issued                                                  |
| `x-mnemo-peer-id`     | This server's `MNEMO_FED_PEER_ID`                                                                     |
| `x-mnemo-client-cert` | This server's public key, SPKI DER in base64url                                                       |
| `x-mnemo-service-jwt` | EdDSA JWT: `iss` = own id, `aud` = the peer's id, `sub: "federation"`, fresh `jti`, 60 s, empty scope |
| `traceparent`         | W3C trace context, when tracing is on                                                                 |

Each request times out after 30 s, and a response larger than 32 MiB is refused.

A sync reads pages until the peer answers `nextCursor: null` (or a `nextCursor` that does
not move, which a peer that ignores `cursor` would send), passing each page's `nextCursor`
as the next `cursor`. It starts from the cursor the previous sync from that peer into the
same workspace recorded: the job stores it as `outcome.cursor` (in
`mnemo_federation_sync_job`, read back by `SyncJobStore.lastCursor` through the index of
migration 0064), also when it fails midway, so the next sync asks only for what changed
after the last page it applied. Every request of the sync also sends that starting cursor
as `knownCursor`, which tells the peer which tombstones it may send (section 10). Without a
recorded cursor, the sync starts from the peer's first fact and sends no `knownCursor`.

One job reads at most 50 pages (10 000 items) and for at most 5 minutes; then it stops with
`outcome.more: true` and the next sync goes on from its cursor. A page with an item that
failed to apply (`error`) stops the sync before that page, so the next one retries it. The
outcome keeps `itemsProcessed`, a count per result in `outcomes` and the first 100
per-item `results`, never one entry per item.

The job overwrites each pulled item's `peerDomain` with the `peerId` it pulled from: the
origin of an item is the registered peer, not what the peer's response claims. Only that
exact peer id counts as the origin. Copies that older servers stored under the serving
peer's host name were renamed once by migration 0066, where exactly one registered peer had
that host in its `url` and no peer used it as its id. The rest keep the host name (an
ambiguous host, a peer since removed, a proxy that rewrote `Host`, or a migration role that
cannot bypass RLS, which leaves every row as it is): they count as another origin, so no
peer can update or tombstone them, including a peer registered later with that host.

For a peer behind a proxy that requires a client certificate, set
`MNEMO_FED_CLIENT_CERT_FILE` and `MNEMO_FED_CLIENT_KEY_FILE` (PEM; the certificate carries
this server's federation key). `MNEMO_FED_CA_FILE` verifies the peer against your own CA
instead of the system roots. A certificate without its key, an unreadable file or a pair
that does not match stops the server at boot. The nginx setup is in
[MTLS_BOUNDARY.md](./MTLS_BOUNDARY.md).

## 10. Serving: GET /memory/federation/items and the peer gate

`GET /memory/federation/items` and `POST /memory/federation/resolve` pass the peer gate,
`authenticateFederationRequest` (`packages/server/src/federation/authenticateFederationRequest.ts`),
after the normal API-key authentication. In order:

1. The key is an `mk_fed_` key and a client key or certificate was presented
   (`x-mnemo-client-cert`).
2. TLS 1.3 was negotiated. The version comes from this server's own TLS socket or, with
   `MNEMO_FED_TLS_PROXY=true`, from `x-mnemo-tls-protocol` set by the TLS-terminating proxy.
   With `MNEMO_TRUSTED_PROXY_IP` set, `x-mnemo-tls-protocol` and `x-mnemo-client-cert` count
   only on a connection from that socket address. `MNEMO_FED_INSECURE_TRANSPORT=true`
   accepts a request without TLS; the server refuses to start with it when
   `NODE_ENV=production`.
3. `x-mnemo-peer-id` names a registered, enabled peer.
4. The presented key (or the public key of a presented X.509 certificate, DER in base64url
   or the URL-encoded PEM nginx gives as `$ssl_client_escaped_cert`) equals the pin,
   compared in constant time. A mismatch writes a `federation_cert_pin_mismatch` audit
   entry with both fingerprints.
5. `x-mnemo-service-jwt` verifies against the pinned key: `alg` EdDSA, `aud` equal to this
   server's audience, not expired (5 s skew), `exp - iat` at most 300 s, a `jti` not seen
   before, and `iss` equal to `x-mnemo-peer-id`.
6. A non-empty `workspace_scope` claim must include the key's workspace (the pull client
   sends an empty one).

Any failure answers 403 with the reason. The `jti` store is Redis when `MNEMO_REDIS_URL` is
set, so every replica sees it; otherwise it is per process.

The response holds up to `limit` facts (default 100, at most 200) of the key's workspace,
active or not, in (`updated_at`, `id`) order, after `cursor` and after `since` when given.
An active fact is an item whose `version` is its `revisionCount`, which every edit raises. A
forgotten or merged fact is a tombstone (the same `remoteId` and `version`, `deletedAt` with
the day only, at UTC midnight, and an empty `payload`), and only when it was created by the
instant of `knownCursor`, where the caller's previous sync ended, and by the serve mark: a
fact the caller may hold. `knownCursor` is the caller's word, so the server bounds it with
what it served that caller itself: `mnemo_federation_serve_mark` (migration 0070) keeps, per
workspace and peer authenticated by the gate, the latest creation time among the active facts
served to it, raised before each page leaves. A first sync (no `knownCursor`) or a peer never
served gets no tombstones, so a peer does not learn which facts were forgotten or deleted
before it started pulling, and a `knownCursor` in the future reveals nothing more. A `cursor`
whose value is not the exact instant format the server renders reads from the start. A row left out still moves `nextCursor`, which is null
only when the page read no row. A fact deleted outright (`DELETE /facts/{id}/hard`,
`/facts/purge`, the hard mode of `forget()`) leaves no row: it comes from its
`mnemo_deletion_log` row (`hard` or `gdpr_erasure`, while no fact with that id exists, read
through the function `mnemo_deleted_facts`), merged into the same order at its deletion
time, as a tombstone with `version` 0 under the same rule. That row keeps the fact's
creation time (`item_created_at`, migration 0068); one written before 0068 has none and is
never served, so a fact deleted outright before then reaches no peer.

```json
{
  "items": [
    {
      "remoteId": "<fact id>",
      "version": 2,
      "peerDomain": "<host name of the request URL>",
      "payload": {
        "statement": "Acme ships on Thursdays",
        "kind": "objective_fact",
        "attribution": "federation_received",
        "sensitivity": "internal",
        "validFrom": "2026-11-02T10:00:00.000Z",
        "validTo": null
      }
    }
  ],
  "nextCursor": "<opaque cursor>"
}
```

`nextCursor` resumes strictly after the last item of the page; it is null only when the page
is empty.

## 11. App-layer crypto (optional)

On top of the transport, the items response can be signed and its payloads sealed
(`packages/federation/src/secureEnvelope.ts`).

Serving side: with `MNEMO_FEDERATION_PRIVATE_KEY` and `MNEMO_FEDERATION_SYMMETRIC_KEY`
(32 bytes, base64) both set, `GET /memory/federation/items` returns
`{ "alg": "ed25519+aes-256-gcm", "signature", "items", "nextCursor" }`. Each item's
`payload` is sealed with AES-256-GCM under the shared symmetric key (`sealed: { iv, tag, ct }`);
`remoteId`, `version`, `peerDomain` and the optional fields stay in clear, and the
signature is Ed25519 over the canonical JSON of the sealed list. A key that does not parse,
or a symmetric key that is not 32 bytes, logs `federation.serve_crypto_init_failed` and the
server serves plaintext.

```bash
# Ed25519 private key (PEM): the federation identity and the envelope signing key
openssl genpkey -algorithm ed25519 -out fed_priv.pem
export MNEMO_FEDERATION_PRIVATE_KEY="$(cat fed_priv.pem)"

# Shared 32-byte symmetric key (base64): seals item payloads
export MNEMO_FEDERATION_SYMMETRIC_KEY="$(openssl rand -base64 32)"

# Public key for the peers that pull from this server
openssl pkey -in fed_priv.pem -pubout -out fed_pub.pem
```

Pulling side: a peer registered with `signingPublicKey` and `symmetricKey` gets the
envelope verified and opened, and the whole batch is rejected if the signature or any
payload fails. With those keys set, a plaintext response is rejected too, unless
`MNEMO_FED_ALLOW_PLAINTEXT=true`. An envelope from a peer registered without keys is
rejected. Without keys on either side, items travel as plaintext over the transport.

## 12. Applying pulled items: SyncEngine

`packages/federation/src/SyncEngine.ts` processes each item on its own; an exception marks
that item `error` and the batch continues. For each item, in order:

1. **Resurrection guard.** A `remoteId` already in `mnemo_sync_tombstone` is rejected
   (`rejected_resurrection_guard`).
2. **Tombstone.** An item with `deletedAt` archives the local copy and is logged in
   `mnemo_sync_tombstone`, with the sender as `peer_domain` (`tombstoned`), only when the
   local copy came from the sender. A tombstone for another peer's copy is
   `rejected_foreign_tombstone` and changes nothing; one for an item not held is
   `skipped_no_change` and logs nothing, so a peer cannot block an id it does not own.
3. **Version guard.** An item whose `version` is more than 100 above a local copy from
   another peer is rejected (`rejected_version_inflation`). A copy from the same peer is its
   own item, so a fact edited more than 100 times between two syncs still arrives.
4. **Vector clock.** When both sides carry one, an incoming clock that is equal or older is
   skipped (`skipped_no_change`); a newer one goes to the upsert.
5. **Strategy**, when a local copy exists:
   - `ours_wins`: keep the local copy (`skipped_resolver_kept_local`).
   - `manual`: `contested_enqueued_review`.
   - `merge`: the local copy is linked as superseded in `mnemo_sync_supersession` and the
     incoming item becomes current (`merged_superseded`).
   - `theirs_wins`: upsert; on an equal version the peer with the greater `peerDomain` wins
     (`skipped_tie_lost` otherwise).
   - none, and the local copy came from the same peer (same `peerDomain`, no vector
     clocks):
     a higher `version` is that peer's own update and goes to the upsert; the same or a lower
     one is `skipped_no_change`. No conflict is resolved.
   - none, and the local copy came from another peer: `resolveConflict` compares trust
     anchor, then `validFrom`, then worth (a gap above 0.2). The incoming side always counts
     as `federation_received` and its worth is clamped to 0 to 1. Only a verdict with
     confidence above 0.7 decides; anything else is `contested_enqueued_review`.
6. **Upsert** into `mnemo_federated_item`, always with `attribution: "federation_received"`
   (`upserted`). A local copy with a higher version and no vector clocks is skipped instead.

A contested item keeps the local copy. The sync job wires `onContested`: each contested
item increments `mnemo_federation_conflicts_total`, emits a `federation.conflict` event on
the `federation.sync` channel and fires the `federation.conflict` webhook, with
`{ workspaceId, peerId, remoteId, jobId, strategy: "sync_contested" }`, and the job's
`outcome.results` lists it. There is no review queue for federated items, so an operator
settles it on the peer or with another strategy. The engine can also escalate an
undecided conflict to a weighted vote across several peers (`knownPeerVersions`), but the
sync job never passes those versions.

Trust anchors (`packages/federation/src/trust.ts`):

| Attribution           | Score |
| --------------------- | ----: |
| `codebase_verified`   |   100 |
| `user_stated`         |    90 |
| `user_confirmed`      |    85 |
| `api_response`        |    80 |
| `document_extracted`  |    70 |
| `agent_observed`      |    60 |
| `agent_inferred`      |    40 |
| `llm_generated`       |    30 |
| `federation_received` |    20 |

The fact attributions map onto this scale: `objective_fact` 100, `user_stated` 90,
`user_belief` 60, `inferred` 40; anything unknown is 20.

## 12a. Pulled items in recall

`POST /recall`, and `memory_recall` through it, also returns the pulled items of the
caller's workspace (`packages/core/src/cognitive/recall-federated.ts`, after the hot,
pointer and cold tiers answered; `RecallRepository.federatedRecallCandidates` for the
query):

- They have no embedding, so they match lexically only: the statement against the query's
  terms in both FTS configurations, strict first and then at least two content terms, as
  the other kinds. Migration 0065 indexes those two expressions. Strict `semantic` mode
  never returns them.
- Each one is a hit of kind `fact` with
  `"federation": { "peer": <peerDomain>, "trustScore": 20 }`; `peer` is the id this server
  registered the serving peer under, whatever the items claim. Its `id` is the local id, which
  `GET /facts/:id` does not find, so a compact projection never cuts it.
- Tier: the `sensitivity` the peer sent; any other value reads as `restricted`. The
  caller's ceiling applies as to every hit. RLS by workspace applies (the read sets
  `app.current_workspace_id`, which the table's policy reads).
- Archived items and items whose `validFrom`/`validTo` do not hold now (or at `asOf`) are
  left out; an unreadable window leaves the item out.
- Order: after the local hits, unless recall judged nothing local relevant
  (`nothingRelevant`), then before them; the page limit applies to the whole page. They
  are skipped on a later page and with a filter they cannot meet (`scope`, `scopeRef`,
  `actorId`, a personal recall, `kinds` without `fact`).
- Recalling one changes nothing: no recall log, worth, hot tier or cache entry.
- Only `POST /recall` asks for them (`RecallQuery.includeFederated`), because its hit can
  carry the mark. gRPC `Recall`, `/recall/unified`, `/recall/explain`, anticipation and
  the plugin context's recall do not return them.

## 13. POST /memory/federation/resolve

Goes through the peer gate (section 10), so only a registered peer can call it. Two body
forms:

- `{ "items": [FederationClaim, ...] }` runs `resolveConsensus`
  (`packages/federation/src/consensus.ts`). Each claim weighs
  `peerWeight × exp(-clockSkewMs / 60000) × worth × exp(-daysOld / 30)`; `peerWeight` is
  the claim peer's `trustWeight` from the local peer store, or 0.5 when the claim names no
  registered peer. A version wins with strictly more than 2/3 of the total weight
  (`winner`); otherwise `no_consensus` with `recommendation: "human_review"`. A claim's
  `attribution` does not change its weight.
- `{ "itemA": {...}, "itemB": {...} }` is last-write-wins: the later `updatedAt` wins, then
  the higher `version`, then `itemA`. A winner with `attribution: "federation_received"`
  gets `trustScore` capped at 20. This form emits the `federation.conflict` event and
  webhook and increments `mnemo_federation_conflicts_total`.

Neither form writes anything to storage.

## 14. gRPC FederationSync

`FederationSync` is a bidirectional RPC in `packages/server/proto/mnemosyne.proto`. Its
messages would carry items for this server to apply: a peer pushing into this server.
Federation over HTTP never lets a peer write here (its `mk_fed_` key reads `/items` and
cannot start a sync), and the peer gate proves who a peer is, not that it may write, so the
RPC cannot be held to the HTTP rules. `packages/server/src/grpc.ts` therefore answers it
with `Unimplemented` for every key that passes authentication and the `memory:federation`
scope check, and applies nothing. A pull is started with `POST /memory/federation/sync`.
Over HTTP/1.1 (`PORT`) a bidirectional call fails with HTTP 505 before that answer; over
the h2c listener (`MNEMO_GRPC_PORT`, see SDK_INTEGRATION.md §5) it gets `Unimplemented`.

## 15. Endpoints and scopes

All under `/memory/federation/` (`routes/federation.ts`). `app-scope.ts` requires
`federation:admin` for every path under `/federation/peers` and `memory:federation` for the
rest.

| Method and path                | Scope               | Notes                                |
| ------------------------------ | ------------------- | ------------------------------------ |
| `GET /peers`                   | `federation:admin`  | Peers without secrets                |
| `POST /peers`                  | `federation:admin`  | Section 8                            |
| `GET /peers/pending`           | `federation:admin`  | Always empty                         |
| `POST /peers/{id}/approve`     | `federation:admin`  | Replaces the pin                     |
| `POST /peers/{id}/approve-key` | `federation:admin`  | Replaces the pin                     |
| `DELETE /peers/{id}`           | `federation:admin`  |                                      |
| `GET /items`                   | `memory:federation` | Peer gate; section 10                |
| `POST /sync`                   | `memory:federation` | Not with an `mk_fed_` key; section 9 |
| `GET /sync/{jobId}`            | `memory:federation` | The caller's workspace only          |
| `POST /resolve`                | `memory:federation` | Peer gate; section 13                |

With Redis configured, every path containing `/federation` draws from the `federation`
rate-limit bucket, 60 requests per minute per key (`packages/server/src/ratelimit.ts`).

## 16. Metrics, audit and logs

| Metric                                                   | Emitted by                                                                   |
| -------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `mnemo_federation_sync_duration_seconds{peer}`           | Every sync job, success or failure                                           |
| `mnemo_federation_lag_seconds{peer}`                     | Set to 0 after a successful sync                                             |
| `mnemo_federation_conflicts_total`                       | The last-write-wins form of `/resolve` and each contested item of a sync job |
| `mnemo_queue_completed_total{job_key="federation_sync"}` | A sync job that ends `done`                                                  |
| `mnemo_queue_failed_total{job_key="federation_sync"}`    | A sync job that ends `failed`                                                |

Audit actions: `create` (peer added), `federation_sync` (job accepted),
`federation_cert_rotated` (pin replaced), `federation_cert_pin_mismatch` (gate rejected a
key). Boot logs name the stores in use: `federation.peer_store=postgres|in_memory`,
`federation.jti_store=redis|in_memory`, `federation.sync_storage=drizzle|in_memory`,
`federation.serve_crypto=enabled`, `federation.identity=none`, `federation.ready`.

## 17. What does not exist

None of these has code behind it: announce or handshake messages, push sync (gRPC
`FederationSync` is refused, section 14), peer discovery
(DNS SRV, mDNS, a central registry), a peer connection state machine with reconnect
backoff, a JWT `operation` or `payload_hash` claim, a payload key derived from the TLS
handshake, automated certificate rotation or expiry tracking, erase notifications between
peers, a review queue for contested items (they are counted, emitted and listed, section
12), and data-residency rules in the federation code.
