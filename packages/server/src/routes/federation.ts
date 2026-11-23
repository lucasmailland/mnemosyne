// Federation HTTP routes — 10 endpoints under /memory/federation/.
//
// Two authorization tiers, both enforced by API key scope — there is no
// "operator" role and no minRole mechanism anywhere in this codebase:
//   - Peer trust administration (GET /peers, POST /peers, GET /peers/pending,
//     POST /peers/:id/approve, POST /peers/:id/approve-key,
//     DELETE /peers/:id) requires federation:admin. Enforced centrally by
//     getScopeForRequest() (app-scope.ts) and again inline per handler via
//     requirePeerAdmin() below.
//   - Routes a PEER calls (/items, /resolve) require memory:federation AND
//     pass gateFederationRequest() (mk_fed_ key + pinned key + service JWT +
//     workspace scope binding; protocol in authenticateFederationRequest.ts).
//   - POST /sync and GET /sync/:jobId are local: memory:federation from a key
//     that is not a peer's mk_fed_ key. The pull signs with our own identity.
//
// Security invariants are enforced in the @mnemo-ai/federation package itself:
//   - Attribution cap → SyncEngine forces attribution = "federation_received"
//   - Trust weights come from LOCAL peer config → SyncEngine reads only local
//   - Version guard MAX_VERSION_JUMP=100 → SyncEngine rejects inflated versions
//   - mTLS key rotation → MtlsAuthAdapter only accepts cross-signed or pre-approved keys
//
// References: PLUGINS_AND_FEDERATION.md §13, AUDIT_REPORT.md FED-03/FED-04.

import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { randomUUID, createPublicKey, createHash } from "node:crypto";
import { pullFromPeer, resolveConsensus, buildSecureItemsEnvelope } from "@mnemo-ai/federation";
import type { FederationClaim } from "@mnemo-ai/federation";
import { InMemoryJtiStore } from "@mnemo-ai/core";

import type { AuthVariables } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import {
  BadRequestError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ServiceUnavailableError,
} from "../errors.js";
import { requireScopes } from "../middleware/rbac.js";
import { authenticateFederationRequest } from "../federation/authenticateFederationRequest.js";
import { pullHeaders } from "../federation/federationIdentity.js";
import { resolveProvenance } from "../provenance.js";
import { emitAudit } from "../audit-emit.js";
import { emitEvent } from "../events.js";
import { injectTraceContext } from "../telemetry/otel.js";
import { dispatchWebhookEvent } from "../webhookDispatch.js";
import {
  federationConflicts,
  federationSyncDuration,
  federationLag,
  queueCompleted,
  queueFailed,
} from "../metrics/index.js";
import { SYNC_JOB_HEARTBEAT_MS, type SyncJobPatch } from "../federation/JobStore.js";
import { MNEMO_SPAN_NAMES, formatActorRef, type ActorProvenance } from "@mnemo-ai/types";

// ─── OpenAPI documentation (doc-only, see note in mountFederation) ──────────
//
// These routes are mounted below with plain `app.get`/`app.post`/
// `app.delete`, not `.openapi()` — each already has its own hand-written
// body parsing, `requirePeerAdmin`/`gateFederationRequest` checks, and error
// responses that predate the OpenAPI convention used elsewhere in this
// package (see routes/decisions.ts). Wiring them through `.openapi()` would
// ALSO attach `@hono/zod-openapi`'s automatic request-validation
// middleware, which intercepts and reformats validation failures BEFORE
// this file's own handler runs — a real behavior change, not just
// documentation. `app.openAPIRegistry.registerPath()` is the exact call
// `.openapi()` makes internally to populate `/openapi.json` (see
// @hono/zod-openapi's own source), minus the validator wiring, so calling
// it directly documents these routes' real request/response shapes without
// touching how they validate, authorize, or respond today.
//
// Split across 2 commits for review-budget reasons: the peer-admin routes
// (peer trust tier, 5 routes) were documented in a prior commit; this one
// adds the remaining 4 data-plane routes (/items, /sync, /sync/{jobId},
// /resolve).

const FederationPeerRecord = z
  .object({
    peerId: z.string(),
    certFingerprint: z
      .string()
      .openapi({ description: "SHA-256 (hex) of the pinned DER certificate." }),
    trustWeight: z.number(),
    approvedAt: z.string(),
    enabled: z.boolean(),
    url: z.string().optional(),
    signingPublicKey: z.string().optional(),
    hasApiKey: z
      .boolean()
      .openapi({ description: "Whether a pull key is set. The key itself is never returned." }),
    hasSymmetricKey: z.boolean().openapi({
      description: "Whether a shared symmetric key is set. The key itself is never returned.",
    }),
  })
  .openapi("FederationPeerRecord");

const PeerIdParamSchema = z.object({
  id: z
    .string()
    .min(1)
    .openapi({ param: { name: "id", in: "path" }, example: "peer_1" }),
});

const JobIdParamSchema = z.object({
  jobId: z
    .string()
    .min(1)
    .openapi({ param: { name: "jobId", in: "path" }, example: "job_1" }),
});

const listPeersRoute = createRoute({
  method: "get",
  path: "/memory/federation/peers",
  tags: ["federation"],
  summary:
    "List all known federation peers and their pinned-cert metadata. Requires `federation:admin` scope.",
  responses: {
    200: {
      description: "Known peers.",
      content: {
        "application/json": { schema: z.object({ peers: z.array(FederationPeerRecord) }) },
      },
    },
    403: { description: "Missing federation:admin scope." },
  },
});

const listPendingPeersRoute = createRoute({
  method: "get",
  path: "/memory/federation/peers/pending",
  tags: ["federation"],
  summary: "List pending (unapproved) peer announcements. Requires `federation:admin` scope.",
  responses: {
    200: {
      description:
        "Pending peers plus discovery state. Always empty today — mDNS auto-discovery is not implemented; peers are added with POST /memory/federation/peers.",
      content: {
        "application/json": {
          schema: z.object({
            peers: z.array(FederationPeerRecord),
            discovery: z.object({ enabled: z.boolean(), reason: z.string().optional() }),
          }),
        },
      },
    },
    403: { description: "Missing federation:admin scope." },
  },
});

// Strict: unknown keys are refused, so a body can never set approvedAt or any
// field the operator did not mean to send.
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const CreatePeerBody = z
  .object({
    peerId: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,252}$/, "must be a domain or UUID")
      .openapi({ example: "acme.example" }),
    pinnedCertDer: z
      .string()
      .max(16384)
      .regex(BASE64, "must be base64")
      .refine((v) => Buffer.from(v, "base64").length > 0, "must not be empty")
      .openapi({ description: "The peer's pinned DER certificate (or SPKI key), base64." }),
    trustWeight: z.number().min(0).max(1).openapi({ description: "Local voting weight, 0 to 1." }),
    enabled: z.boolean().optional().openapi({ description: "Defaults to true." }),
    url: z
      .string()
      .url()
      .max(2048)
      .refine((u) => /^https?:\/\//.test(u), "must be an https URL")
      .optional()
      .openapi({
        description:
          "The peer's base URL, used to pull its items. https only, unless MNEMO_FED_INSECURE_TRANSPORT=true (dev).",
      }),
    apiKey: z.string().min(1).max(512).optional(),
    signingPublicKey: z
      .string()
      .min(1)
      .max(8192)
      .refine((k) => {
        try {
          createPublicKey(k);
          return true;
        } catch {
          return false;
        }
      }, "must be a PEM public key")
      .optional()
      .openapi({ description: "The peer's Ed25519 public key, PEM." }),
    symmetricKey: z
      .string()
      .regex(BASE64, "must be base64")
      .refine((k) => Buffer.from(k, "base64").length === 32, "must decode to 32 bytes")
      .optional(),
  })
  .strict()
  .refine((b) => (b.signingPublicKey === undefined) === (b.symmetricKey === undefined), {
    message: "signingPublicKey and symmetricKey go together",
    path: ["symmetricKey"],
  })
  .openapi("CreateFederationPeerRequest");

const createPeerRoute = createRoute({
  method: "post",
  path: "/memory/federation/peers",
  tags: ["federation"],
  summary:
    "Provision a federation peer (the only way a peer is created). Requires `federation:admin` scope.",
  request: {
    body: { content: { "application/json": { schema: CreatePeerBody } }, required: true },
  },
  responses: {
    201: {
      description: "Peer created, approved now.",
      content: {
        "application/json": {
          schema: z.object({
            created: z.literal(true),
            peerId: z.string(),
            approvedAt: z.string(),
          }),
        },
      },
    },
    400: { description: "Invalid body." },
    403: { description: "Missing federation:admin scope." },
    409: { description: "A peer with this peerId already exists." },
  },
});

const approvePeerRoute = createRoute({
  method: "post",
  path: "/memory/federation/peers/{id}/approve",
  tags: ["federation"],
  summary:
    "Approve a pending key-rotation ANNOUNCE from a peer (operator pre-approval path). Requires `federation:admin` scope.",
  request: {
    params: PeerIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            newCertDer: z.string().openapi({ description: "Base64-encoded DER certificate." }),
            issuedAt: z
              .string()
              .optional()
              .openapi({ description: "ISO 8601. Defaults to server time when omitted." }),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Rotation accepted.",
      content: {
        "application/json": { schema: z.object({ accepted: z.literal(true), reason: z.string() }) },
      },
    },
    400: { description: "newCertDer is required (base64-encoded DER)." },
    403: { description: "Missing federation:admin scope." },
    422: {
      description: "Rotation rejected — unknown peer, disabled peer, or invalid cross-signature.",
      content: {
        "application/json": {
          schema: z.object({ accepted: z.literal(false), reason: z.string() }),
        },
      },
    },
  },
});

const approvePeerKeyRoute = createRoute({
  method: "post",
  path: "/memory/federation/peers/{id}/approve-key",
  tags: ["federation"],
  summary:
    "Explicit operator approval of a pending key rotation for an already-provisioned peer. Requires `federation:admin` scope.",
  request: {
    params: PeerIdParamSchema,
    body: {
      content: {
        "application/json": {
          schema: z.object({
            newCertDer: z.string().openapi({ description: "Base64-encoded DER certificate." }),
            approvedAt: z
              .string()
              .optional()
              .openapi({ description: "ISO 8601. Defaults to server time when omitted." }),
          }),
        },
      },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Key rotation approved.",
      content: {
        "application/json": {
          schema: z.object({
            approved: z.literal(true),
            peerId: z.string(),
            approvedAt: z.string(),
          }),
        },
      },
    },
    400: { description: "newCertDer is required (base64-encoded DER)." },
    403: { description: "Missing federation:admin scope." },
    422: {
      description:
        "Peer is not provisioned; add it with POST /memory/federation/peers before rotating its key.",
    },
  },
});

const deletePeerRoute = createRoute({
  method: "delete",
  path: "/memory/federation/peers/{id}",
  tags: ["federation"],
  summary: "Remove a peer from the local trust store. Requires `federation:admin` scope.",
  request: { params: PeerIdParamSchema },
  responses: {
    200: {
      description: "Peer removed. Subsequent sync attempts from it fail authentication.",
      content: {
        "application/json": { schema: z.object({ deleted: z.literal(true), peerId: z.string() }) },
      },
    },
    403: { description: "Missing federation:admin scope." },
    404: { description: "Peer not found." },
  },
});

const FederationItemPayload = z
  .object({
    statement: z.string(),
    kind: z.literal("objective_fact"),
    attribution: z.literal("federation_received"),
    sensitivity: z.string(),
    validFrom: z.string(),
    validTo: z.string().nullable(),
  })
  .openapi("FederationItemPayload");

const FederationItemRecord = z
  .object({
    remoteId: z.string(),
    version: z.number().int().openapi({
      description: "The fact's revisionCount; 0 on the tombstone of a fact deleted outright.",
    }),
    peerDomain: z.string(),
    deletedAt: z.string().optional().openapi({
      description:
        "Set on a tombstone: the day (UTC midnight) the fact was forgotten, merged or deleted. Its payload is empty.",
    }),
    payload: z.union([FederationItemPayload, z.object({}).strict()]),
  })
  .openapi("FederationItemRecord");

const NextCursor = z.string().nullable().openapi({
  description: "Pass as `cursor` to read on after this page; null when the page read nothing.",
});

const FederationItemsPlainResponse = z
  .object({ items: z.array(FederationItemRecord), nextCursor: NextCursor })
  .openapi("FederationItemsPlainResponse");

const FederationSealedItem = z
  .object({
    remoteId: z.string(),
    version: z.number().int(),
    peerDomain: z.string(),
    vectorClock: z.record(z.string(), z.number()).optional(),
    attribution: z.string().optional(),
    deletedAt: z.string().optional(),
    sealed: z
      .object({ iv: z.string(), tag: z.string(), ct: z.string() })
      .openapi({ description: "AES-256-GCM sealed payload — base64 iv/authTag/ciphertext." }),
  })
  .openapi("FederationSealedItem");

const FederationItemsSecureResponse = z
  .object({
    alg: z.literal("ed25519+aes-256-gcm"),
    signature: z.string(),
    items: z.array(FederationSealedItem),
    nextCursor: NextCursor,
  })
  .openapi("FederationItemsSecureResponse");

const listFederationItemsRoute = createRoute({
  method: "get",
  path: "/memory/federation/items",
  tags: ["federation"],
  summary:
    "Expose locally-held facts as federable items for a remote peer to pull. Requires `memory:federation` scope plus the mTLS + service-JWT peer gate.",
  request: {
    query: z.object({
      since: z.string().optional().openapi({
        description: "ISO timestamp cursor — only items updated after this are returned.",
      }),
      cursor: z.string().optional().openapi({
        description: "The `nextCursor` of an earlier page: resume strictly after its last item.",
      }),
      knownCursor: z.string().optional().openapi({
        description:
          "Where the caller's previous sync ended. Tombstones are served only for facts created by then and by the latest creation time among the facts this server served the caller; without it, none.",
      }),
      limit: z.coerce
        .number()
        .int()
        .min(1)
        .optional()
        .openapi({ description: "Max items per page. Server caps at 200, default 100." }),
    }),
  },
  responses: {
    200: {
      description:
        "Federated items — plaintext by default, or a signed+sealed envelope when app-layer crypto (serveCrypto) is configured on this instance.",
      content: {
        "application/json": {
          schema: z.union([FederationItemsPlainResponse, FederationItemsSecureResponse]),
        },
      },
    },
    403: { description: "Peer gate failed (mTLS pin, service-JWT, or workspace-scope check)." },
  },
});

const TriggerSyncBody = z
  .object({
    peerId: z.string().min(1),
    conflictResolution: z.enum(["theirs_wins", "ours_wins", "manual", "merge"]).optional().openapi({
      description: "Falls back to the default trust/recency/worth resolver when omitted.",
    }),
  })
  .openapi("TriggerFederationSyncRequest");

const triggerSyncRoute = createRoute({
  method: "post",
  path: "/memory/federation/sync",
  tags: ["federation"],
  summary:
    "Pull from a registered peer into the caller's workspace, asynchronously; returns a jobId to poll. A local action: requires `memory:federation` from a key that is not a peer's `mk_fed_` key. This server signs the pull with its own federation identity (MNEMO_FED_PEER_ID + MNEMO_FEDERATION_PRIVATE_KEY).",
  request: {
    body: { content: { "application/json": { schema: TriggerSyncBody } }, required: true },
  },
  responses: {
    202: {
      description: "Sync job accepted — poll GET /memory/federation/sync/{jobId} for its outcome.",
      content: {
        "application/json": {
          schema: z.object({ jobId: z.string(), status: z.literal("pending") }),
        },
      },
    },
    400: { description: "peerId is required." },
    403: { description: "Called with a peer's mk_fed_ key." },
  },
});

const FederationSyncJobSchema = z
  .object({
    id: z.string(),
    peerId: z.string(),
    workspaceId: z.string(),
    status: z.enum(["pending", "running", "done", "failed"]),
    startedAt: z.string(),
    completedAt: z.string().optional(),
    outcome: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
  })
  .openapi("FederationSyncJob");

const getSyncJobRoute = createRoute({
  method: "get",
  path: "/memory/federation/sync/{jobId}",
  tags: ["federation"],
  summary:
    "Poll the status of a previously-triggered sync job. Requires `memory:federation` scope.",
  request: { params: JobIdParamSchema },
  responses: {
    200: {
      description: "The sync job record.",
      content: { "application/json": { schema: FederationSyncJobSchema } },
    },
    404: { description: "Sync job not found." },
  },
});

const FederationClaimSchema = z
  .object({
    version: z.string(),
    peerId: z.string().optional(),
    attribution: z.string().optional(),
    clockSkewMs: z.number().optional(),
    worth: z.number().optional(),
    freshness: z.string().optional(),
  })
  .openapi("FederationClaim");

const ResolveBatchBody = z
  .object({ items: z.array(FederationClaimSchema).min(1) })
  .openapi("ResolveFederationConflictBatchRequest");

const ResolveLwwBody = z
  .object({ itemA: z.record(z.string(), z.unknown()), itemB: z.record(z.string(), z.unknown()) })
  .openapi("ResolveFederationConflictPairRequest");

const ConsensusOutcomeSchema = z
  .union([
    z.object({ status: z.literal("winner"), version: z.string(), confidence: z.number() }),
    z.object({
      status: z.literal("no_consensus"),
      versions: z.array(z.string()),
      recommendation: z.literal("human_review"),
    }),
    z.object({ status: z.literal("rejected"), reason: z.string() }),
  ])
  .openapi("FederationConsensusOutcome");

const ResolveBatchResponse = z
  .object({
    outcome: ConsensusOutcomeSchema,
    strategy: z.literal("supermajority"),
    resolvedAt: z.string(),
  })
  .openapi("ResolveFederationConflictBatchResponse");

const ResolveLwwResponse = z
  .object({
    winner: z.record(z.string(), z.unknown()),
    loser: z.record(z.string(), z.unknown()),
    strategy: z.literal("last_write_wins"),
    resolvedAt: z.string(),
  })
  .openapi("ResolveFederationConflictPairResponse");

const resolveConflictRoute = createRoute({
  method: "post",
  path: "/memory/federation/resolve",
  tags: ["federation"],
  summary:
    "Resolve a conflict between federated claims — a supermajority-consensus batch (`items`) or a legacy last-write-wins pair (`itemA`/`itemB`). Requires `memory:federation` scope plus the peer gate.",
  request: {
    body: {
      content: { "application/json": { schema: z.union([ResolveBatchBody, ResolveLwwBody]) } },
      required: true,
    },
  },
  responses: {
    200: {
      description: "Resolution result — shape depends on which request-body form was sent.",
      content: {
        "application/json": { schema: z.union([ResolveBatchResponse, ResolveLwwResponse]) },
      },
    },
    400: { description: "itemA and itemB are required objects (legacy pair form)." },
    403: { description: "Peer gate failed." },
  },
});

export function mountFederation(
  app: OpenAPIHono<{ Variables: AuthVariables }>,
  deps: ServerDeps
): void {
  const fed = deps.federation;
  // Guard: only mount if federation deps are present (caller already checks,
  // but this keeps the function safe to call unconditionally in tests).
  if (!fed) return;

  // Documentation-only: registers these 10 routes' real shapes in
  // /openapi.json without wiring `.openapi()`'s validator middleware (see
  // the note above the schemas). The handlers mounted below are unchanged.
  // Gated behind the same `if (!fed) return` as the handlers themselves —
  // when federation deps aren't configured, neither the routes nor their
  // docs exist, matching the rest of this file's conditional-mount pattern.
  app.openAPIRegistry.registerPath(listPeersRoute);
  app.openAPIRegistry.registerPath(listPendingPeersRoute);
  app.openAPIRegistry.registerPath(createPeerRoute);
  app.openAPIRegistry.registerPath(approvePeerRoute);
  app.openAPIRegistry.registerPath(approvePeerKeyRoute);
  app.openAPIRegistry.registerPath(deletePeerRoute);
  app.openAPIRegistry.registerPath(listFederationItemsRoute);
  app.openAPIRegistry.registerPath(triggerSyncRoute);
  app.openAPIRegistry.registerPath(getSyncJobRoute);
  app.openAPIRegistry.registerPath(resolveConflictRoute);

  const {
    peerStore,
    mtls,
    jobStore,
    syncEngine,
    jtiStore,
    selfAudience,
    serveCrypto,
    transport,
    identity,
    pullTls,
  } = fed;

  // Defence in depth. The central app.ts scope guard already maps every
  // /memory/federation/peers* path to federation:admin (app-scope.ts); this
  // re-checks it at the handler so a future re-mount, path-normalisation
  // divergence, or non-HTTP transport cannot silently downgrade peer trust
  // administration to the data-plane memory:federation scope.
  function requirePeerAdmin(c: Context<{ Variables: AuthVariables }>): void {
    requireScopes({ scopes: c.get("scopes") ?? [] }, "federation:admin");
  }

  // §6 peer gate shared by the endpoints a PEER calls (items, resolve); the
  // protocol is documented in federation/authenticateFederationRequest.ts. Enforces the mTLS + service-JWT binding AND that the validated JWT
  // workspace_scope authorises the workspace the bearer key resolved to — a peer
  // JWT scoped to ws_A must not be able to drive an operation on ws_B just
  // because the bearer key also holds ws_B. Returns a JSON error Response to
  // early-return on failure, or null when the request is authorised.
  //
  // jtiStore/selfAudience come from the SHARED boot-time instances (see index.ts);
  // the `??` fallbacks are defence-in-depth for older callers that built
  // deps.federation without them — they must NOT be the live path, or replay
  // dedup breaks (a fresh store every request never sees a prior jti).
  // Passes: the peer id the gate authenticated. Fails: the 403 to return.
  async function gateFederationRequest(
    c: Context<{ Variables: AuthVariables }>
  ): Promise<Response | { peerId: string }> {
    const authResult = await authenticateFederationRequest(c, {
      peerStore,
      jtiStore: jtiStore ?? new InMemoryJtiStore(),
      selfAudience:
        selfAudience ??
        process.env["MNEMO_FED_AUDIENCE"] ??
        process.env["MNEMO_FED_PEER_ID"] ??
        "mnemo:instance:self",
      ...(transport ? { transport } : {}),
    });
    if (!authResult.ok) {
      if (authResult.auditAction) {
        let provenance: ActorProvenance;
        try {
          provenance = resolveProvenance(c);
        } catch {
          provenance = {
            actorType: "agent",
            actorId: formatActorRef("key", "unknown"),
            userId: null,
          };
        }
        await emitAudit(deps, {
          workspaceId: c.get("workspaceId"),
          actorId: provenance.actorId,
          actorType: provenance.actorType,
          action: authResult.auditAction,
          resourceKind: "federation_peer",
          resourceId: authResult.peerId,
          isTerminal: false,
          detail: {
            ...(provenance.userId ? { userId: provenance.userId } : {}),
            peerId: authResult.peerId,
            presentedCertFingerprint: authResult.presentedCertFingerprint,
            pinnedCertFingerprint: authResult.pinnedCertFingerprint,
            reason: authResult.reason,
          },
        });
      }
      return c.json({ error: { code: "unauthorized", message: authResult.reason } }, 403);
    }
    // workspace_scope enforcement: the JWT's scope must include the workspace the
    // bearer key resolved to. Empty/absent scope is treated as unscoped (allow).
    const workspaceId = c.get("workspaceId");
    if (authResult.workspaceScope.length > 0 && !authResult.workspaceScope.includes(workspaceId)) {
      return c.json({ error: { code: "forbidden", message: "workspace not in JWT scope" } }, 403);
    }
    return { peerId: authResult.peerId };
  }

  // ── GET /memory/federation/peers ─────────────────────────────────────────────
  // List all known peers and their pinned-cert metadata.
  app.get("/memory/federation/peers", async (c) => {
    requirePeerAdmin(c);
    const peers = (await peerStore.list()).map(peerView);
    return c.json({ peers }, 200);
  });

  // ── GET /memory/federation/peers/pending ──────────────────────────────────────
  // Returns pending (unapproved) peer announcements. mDNS auto-discovery is not
  // implemented in v3, so this is always empty; the `discovery` flag lets clients
  // distinguish "no pending peers" from "discovery disabled". Peers are added with
  // POST /memory/federation/peers.
  app.get("/memory/federation/peers/pending", (c) => {
    requirePeerAdmin(c);
    return c.json(
      { peers: [], discovery: { enabled: false, reason: "mDNS discovery not implemented" } },
      200
    );
  });

  // ── POST /memory/federation/peers ─────────────────────────────────────────────
  // Provision a peer: the only path that creates one (FED-04). The operator
  // sets its pin, trust weight and pull credentials; approvedAt is server time.
  app.post("/memory/federation/peers", async (c) => {
    requirePeerAdmin(c);
    const parsed = CreatePeerBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ");
      throw new BadRequestError(`Invalid peer: ${detail}`);
    }
    const { pinnedCertDer: certB64, enabled, ...rest } = parsed.data;
    // The pull key and JWT must not travel in clear: http only with the dev switch.
    if (rest.url?.startsWith("http://") && !transport?.allowInsecure) {
      const detail = "url: must be an https URL";
      throw new BadRequestError(`Invalid peer: ${detail}`);
    }
    const pinnedCertDer = Buffer.from(certB64, "base64");
    const approvedAt = new Date().toISOString();

    const created = await peerStore.addPeer({
      ...rest,
      pinnedCertDer,
      enabled: enabled ?? true,
      approvedAt,
    });
    if (!created) {
      throw new ConflictError(`Peer '${rest.peerId}' already exists`);
    }

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId: c.get("workspaceId"),
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "create",
      resourceKind: "federation_peer",
      resourceId: rest.peerId,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        peerId: rest.peerId,
        certFingerprint: certFingerprint(pinnedCertDer),
        trustWeight: rest.trustWeight,
        enabled: enabled ?? true,
        ...(rest.url ? { url: rest.url } : {}),
      },
    });

    return c.json({ created: true as const, peerId: rest.peerId, approvedAt }, 201);
  });

  // ── POST /memory/federation/peers/:id/approve ─────────────────────────────────
  // Approve a pending ANNOUNCE from a peer (operator pre-approval path).
  // Body: { newCertDer: string (base64), issuedAt?: string (ISO) }
  app.post("/memory/federation/peers/:id/approve", async (c) => {
    requirePeerAdmin(c);
    const peerId = c.req.param("id");
    const workspaceId = c.get("workspaceId");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const newCertDerB64 = body["newCertDer"] as string | undefined;
    const issuedAt = (body["issuedAt"] as string | undefined) ?? new Date().toISOString();

    if (!newCertDerB64) {
      return c.json(
        { error: { code: "bad_request", message: "newCertDer is required (base64-encoded DER)" } },
        400
      );
    }

    const newCertDer = Buffer.from(newCertDerB64, "base64");

    // P54/D2/D4: read the pre-rotation peer state EAGERLY, before the mutating
    // processAnnounce() call. upsertPinnedCert() may replace (not mutate) the
    // peer object, so a lazy read afterward could silently capture the NEW
    // cert instead of the old one. Advisory-only: a store fault must not turn
    // a working rotation into a 500 — it just omits oldCertFingerprint.
    const existingPeer = await peerStore.get(peerId).catch(() => null);
    const oldCertFingerprint = existingPeer
      ? certFingerprint(existingPeer.pinnedCertDer)
      : undefined;

    const result = await mtls.processAnnounce(
      { peerId, newCertDer, issuedAt },
      true // preApproved = true (operator approval path)
    );

    if (result.accepted) {
      const provenance = resolveProvenance(c);
      await emitAudit(deps, {
        workspaceId,
        actorId: provenance.actorId,
        actorType: provenance.actorType,
        action: "federation_cert_rotated",
        resourceKind: "federation_peer",
        resourceId: peerId,
        isTerminal: false,
        detail: {
          ...(provenance.userId ? { userId: provenance.userId } : {}),
          peerId,
          ...(oldCertFingerprint ? { oldCertFingerprint } : {}),
          newCertFingerprint: certFingerprint(newCertDer),
          method: result.reason,
        },
      });
    }

    return c.json(result, result.accepted ? 200 : 422);
  });

  // ── POST /memory/federation/peers/:id/approve-key ─────────────────────────────
  // Explicit operator approval of a pending key rotation for an existing peer.
  // Body: { newCertDer: string (base64), approvedAt?: string (ISO) }
  app.post("/memory/federation/peers/:id/approve-key", async (c) => {
    requirePeerAdmin(c);
    const peerId = c.req.param("id");
    const workspaceId = c.get("workspaceId");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    const newCertDerB64 = body["newCertDer"] as string | undefined;
    const approvedAt = (body["approvedAt"] as string | undefined) ?? new Date().toISOString();

    if (!newCertDerB64) {
      return c.json(
        { error: { code: "bad_request", message: "newCertDer is required (base64-encoded DER)" } },
        400
      );
    }

    // FED-04: key rotation is for ALREADY-PROVISIONED peers only. Reject unknown
    // peers up front so this surface can't enrol an attacker peer by pinning a
    // cert for a fresh peerId (the PeerStore also refuses to auto-create, but
    // guarding here yields a clean 422 instead of a thrown 500). Peers must be
    // added deliberately with POST /memory/federation/peers.
    const existing = await peerStore.get(peerId);
    if (!existing) {
      return c.json(
        {
          error: {
            code: "unknown_peer",
            message: `Peer '${peerId}' is not provisioned; add it before approving a key rotation`,
          },
        },
        422
      );
    }

    // P54/D4: capture BEFORE approveKeyRotation() mutates/replaces the pin.
    // Always present here — the 422 guard above proves the peer existed.
    const oldCertFingerprint = certFingerprint(existing.pinnedCertDer);

    const newCertDer = Buffer.from(newCertDerB64, "base64");
    await mtls.approveKeyRotation(peerId, newCertDer, approvedAt);

    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "federation_cert_rotated",
      resourceKind: "federation_peer",
      resourceId: peerId,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        peerId,
        oldCertFingerprint,
        newCertFingerprint: certFingerprint(newCertDer),
        method: "operator_key_rotation_approved",
      },
    });

    return c.json({ approved: true, peerId, approvedAt }, 200);
  });

  // ── DELETE /memory/federation/peers/:id ───────────────────────────────────────
  // Remove a peer from the local store. Subsequent sync attempts from this
  // peer will fail authentication with "unknown_peer".
  app.delete("/memory/federation/peers/:id", async (c) => {
    requirePeerAdmin(c);
    const peerId = c.req.param("id");

    const existing = await peerStore.get(peerId);
    if (!existing) {
      throw new NotFoundError(`Peer '${peerId}' not found`);
    }

    await peerStore.deletePeer(peerId);
    return c.json({ deleted: true, peerId }, 200);
  });

  // ── GET /memory/federation/items ──────────────────────────────────────────────
  // Exposes locally-held facts as federable items for remote peers to pull.
  // Authenticated via the same bearer API key as all other routes.
  // Query params:
  //   cursor — the nextCursor of an earlier page: resume strictly after its
  //            last item. A sync walks the pages with it and keeps the last
  //            one for its next run.
  //   since  — ISO timestamp: only facts with updated_at > since.
  //   limit  — max items per page (max 200, default 100).
  //   knownCursor — where the puller's previous sync ended (see below).
  // Every fact of the workspace, in (updated_at, id) order: an active one as
  // an item whose version is its revisionCount; a forgotten or merged one
  // created by knownCursor as a tombstone (deletedAt, empty payload) so the
  // puller archives its copy. A fact deleted outright (hard delete, purge,
  // erasure) comes from mnemo_deletion_log at its deletion time, as a
  // tombstone under the same rule (0068 keeps its creation time). "Created by
  // knownCursor" is bounded by what this server served the peer (0070).
  app.get("/memory/federation/items", async (c) => {
    // §6 mTLS + service-JWT + workspace-scope gate: this endpoint streams local
    // facts to peers, so it must be peer-gated exactly like /sync — a generic
    // bearer key alone is not sufficient for federation data egress.
    const gate = await gateFederationRequest(c);
    if (gate instanceof Response) return gate;

    const workspaceId = c.get("workspaceId");
    const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10) || 100, 200);
    const since = c.req.query("since");
    const cursor = c.req.query("cursor");
    if (!deps.storage) throw new ServiceUnavailableError("Storage adapter not available");
    // Tombstones only for facts the puller may hold: created by the end of its
    // previous sync (knownCursor) AND by the latest creation time among the
    // facts this server served that peer (0070). knownCursor is the peer's word;
    // the mark is ours, so a cursor in the future reveals nothing more. A first
    // sync (no knownCursor) or a peer never served gets none, so a peer never
    // learns which facts were forgotten or deleted before it started pulling.
    const clientKnown = cursorInstant(c.req.query("knownCursor"));
    const served = clientKnown
      ? await deps.storage.federationServeMark?.(workspaceId, gate.peerId)
      : null;
    const knownUntil =
      clientKnown && served ? (clientKnown < served ? clientKnown : served) : undefined;
    const page = await deps.storage.queryFactsPage({
      workspaceId,
      status: "all",
      sortBy: "updated_at",
      order: "asc",
      limit,
      ...(since ? { updatedSince: new Date(since) } : {}),
      ...(cursor ? { cursor } : {}),
    });

    // Facts deleted outright are no longer in the table: they come from the
    // deletion log, keyed by deletion time in the same cursor format, and are
    // merged into the fact stream so one cursor walks both.
    const deleted =
      (await deps.storage.queryDeletedFactsPage?.({
        workspaceId,
        limit,
        ...(since ? { deletedSince: new Date(since) } : {}),
        ...(cursor ? { cursor } : {}),
      })) ?? [];
    const rows = [
      ...page.items.map((fact, i) => ({ fact, cursor: page.itemCursors?.[i] })),
      ...deleted.map((gone) => ({ gone, cursor: gone.cursor })),
    ];
    const keyed = rows.map((row) => ({ ...row, key: cursorKey(row.cursor) }));
    // ponytail: string order of (v, id); equal to the database's except on an exact
    // microsecond tie between a fact and a deletion.
    keyed.sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
    // Both inputs are their stream's first `limit` rows after the cursor, so the
    // first `limit` of the merge are the first `limit` of the whole stream.
    const read = keyed.slice(0, limit);

    const peerDomain = new URL(c.req.url).hostname;
    // The day only: the receiver needs to know it is gone, not when exactly.
    const day = (at: Date) => `${at.toISOString().slice(0, 10)}T00:00:00.000Z`;
    // Tombstones only for facts created by knownUntil; a deletion logged
    // without the creation time (before 0068) is never served.
    const known = (createdAt: Date | null) =>
      knownUntil !== undefined && createdAt !== null && createdAt <= knownUntil;

    const items = read.flatMap((row): import("@mnemo-ai/federation").FederatedItem[] => {
      if ("gone" in row) {
        const { gone } = row;
        // A hard-deleted fact has no revision count left; tombstones ignore it.
        return known(gone.createdAt)
          ? [
              {
                remoteId: gone.id,
                version: 0,
                peerDomain,
                deletedAt: day(gone.deletedAt),
                payload: {},
              },
            ]
          : [];
      }
      const { fact } = row;
      if (fact.status === "active") {
        return [
          {
            remoteId: fact.id,
            version: fact.revisionCount,
            peerDomain,
            payload: {
              statement: fact.statement,
              kind: "objective_fact",
              attribution: "federation_received",
              sensitivity: fact.sensitivity ?? "public",
              validFrom: fact.validFrom.toISOString(),
              validTo: fact.validTo?.toISOString() ?? null,
            },
          },
        ];
      }
      return known(fact.createdAt)
        ? [
            {
              remoteId: fact.id,
              version: fact.revisionCount,
              peerDomain,
              deletedAt: day(fact.updatedAt),
              payload: {},
            },
          ]
        : [];
    });

    // Record what this page served before it leaves: the next request's bound.
    const servedUntil = read.reduce<Date | null>(
      (max, row) =>
        "fact" in row && row.fact.status === "active" && (!max || row.fact.createdAt > max)
          ? row.fact.createdAt
          : max,
      null
    );
    if (servedUntil) {
      await deps.storage.raiseFederationServeMark?.(workspaceId, gate.peerId, servedUntil);
    }

    // Resume point after this page's last row (served or not), even on the last
    // page, so the puller can store it and ask only for what changed next time.
    // Null only when the page read no row at all.
    const nextCursor = read.at(-1)?.cursor ?? page.nextCursor ?? null;

    // §20 app-layer crypto: when configured, sign + seal the payload so peers can
    // verify authenticity and decrypt items (defence-in-depth over transport mTLS).
    // Absent → plaintext (back-compat with peers that have no shared keys yet).
    if (serveCrypto) {
      return c.json(buildSecureItemsEnvelope(items, nextCursor, serveCrypto), 200);
    }
    return c.json({ items, nextCursor }, 200);
  });

  // ── POST /memory/federation/sync ──────────────────────────────────────────────
  // Pull from a registered peer into the caller's workspace, asynchronously.
  // Body: { peerId: string }
  // Returns 202 immediately with a jobId to poll via GET /sync/:jobId.
  //
  // A LOCAL action, not a peer call: it used to sit behind the peer gate, which
  // made the server's own operator unable to start a pull. memory:federation is
  // still required (central scope guard); a peer's mk_fed_ key is refused here,
  // so a peer cannot make this server pull. The pull itself is authenticated to
  // the serving peer with our identity (pullHeaders, federationIdentity.ts).
  app.post("/memory/federation/sync", async (c) => {
    if (c.get("apiKeyPrefix")?.startsWith("mk_fed_")) {
      throw new ForbiddenError("A peer's federation key cannot start a sync");
    }

    const workspaceId = c.get("workspaceId");
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const peerId = body["peerId"] as string | undefined;
    // §33 caller-supplied conflict resolution strategy (falls back to the default
    // trust/recency/worth resolver when omitted or not a recognised value).
    const VALID_CONFLICT_RESOLUTIONS = new Set(["theirs_wins", "ours_wins", "manual", "merge"]);
    const rawCR = body["conflictResolution"];
    const conflictResolution =
      typeof rawCR === "string" && VALID_CONFLICT_RESOLUTIONS.has(rawCR)
        ? (rawCR as import("@mnemo-ai/federation").ConflictResolution)
        : undefined;

    if (!peerId) {
      return c.json({ error: { code: "bad_request", message: "peerId is required" } }, 400);
    }

    const jobId = randomUUID();
    const startedAt = new Date().toISOString();

    await jobStore.create({
      id: jobId,
      peerId,
      workspaceId,
      status: "pending",
      startedAt,
    });

    // D7: emit synchronously at ACCEPT time, right after jobStore.create, and
    // NEVER inside the setImmediate block below — there is no request context
    // available in there, so resolveProvenance(c) (which needs the live Hono
    // `c`) cannot run once that deferred callback fires.
    const provenance = resolveProvenance(c);
    await emitAudit(deps, {
      workspaceId,
      actorId: provenance.actorId,
      actorType: provenance.actorType,
      action: "federation_sync",
      resourceKind: "federation_sync",
      resourceId: jobId,
      isTerminal: false,
      detail: {
        ...(provenance.userId ? { userId: provenance.userId } : {}),
        peerId,
        ...(conflictResolution ? { conflictResolution } : {}),
        phase: "accepted",
      },
    });

    // Fire-and-forget: run sync asynchronously via the SyncEngine.
    // SyncEngine.processBatch() processes each incoming FederatedItem independently;
    // one failure does not abort the batch.  When no syncEngine is available at
    // boot (e.g. the federation dep itself is missing) we mark the job done with
    // a clear diagnostic outcome rather than silently failing.
    const setJob = async (patch: SyncJobPatch) => {
      await jobStore.update(jobId, workspaceId, patch);
      if (patch.status === "done") queueCompleted.inc({ job_key: "federation_sync" });
      if (patch.status === "failed") queueFailed.inc({ job_key: "federation_sync" });
    };
    setImmediate(async () => {
      const syncStart = Date.now();
      // While this process runs the job it says so; a job whose heartbeat stops
      // (the process died) reads as failed after a restart (DrizzleSyncJobStore).
      const heartbeat = setInterval(() => {
        jobStore.heartbeat(jobId, workspaceId).catch(() => void 0);
      }, SYNC_JOB_HEARTBEAT_MS);
      heartbeat.unref();
      const syncSpan = deps.telemetry.startSpan(MNEMO_SPAN_NAMES.federationSync, {
        attributes: { "mnemo.federation.peer": peerId },
      });
      // What the job keeps: a count per outcome and the first results, never
      // one entry per item of a sync that may cover thousands.
      const tally = new SyncTally();
      let cursor: string | undefined;
      try {
        await setJob({ status: "running" });
        if (!syncEngine) {
          await setJob({
            status: "done",
            completedAt: new Date().toISOString(),
            outcome: {
              note: "sync_engine_unavailable",
              message:
                "SyncEngine was not wired at boot time. Federation routes are active " +
                "but no SyncStorage adapter is available to persist incoming items.",
            },
          });
          return;
        }

        // Fetch the peer to retrieve its sync endpoint / items.
        const peer = await peerStore.get(peerId);
        if (!peer) {
          await setJob({
            status: "failed",
            completedAt: new Date().toISOString(),
            error: `Peer '${peerId}' not found in peer registry`,
          });
          return;
        }

        if (!identity) {
          throw new Error(
            "This server has no federation identity: set MNEMO_FED_PEER_ID and MNEMO_FEDERATION_PRIVATE_KEY"
          );
        }
        if (!peer.url || !peer.apiKey) {
          throw new Error(`Peer '${peerId}' has no url or apiKey to pull from`);
        }
        const { url, apiKey } = peer;

        // §20 app-layer crypto: when the peer has a signing pubkey + shared
        // symmetric key configured, the pull path verifies the signature and
        // opens sealed items (rejecting on tamper). Absent → plaintext pull.
        const crypto: {
          peerSigningPublicKey?: import("node:crypto").KeyObject;
          symmetricKey?: Buffer;
        } = {};
        if (peer.signingPublicKey && peer.symmetricKey) {
          try {
            crypto.peerSigningPublicKey = createPublicKey(peer.signingPublicKey);
            crypto.symmetricKey = Buffer.from(peer.symmetricKey, "base64");
          } catch (keyErr) {
            console.warn(
              "federation peer crypto key parse error:",
              keyErr instanceof Error ? keyErr.message : String(keyErr)
            );
          }
        }
        // Contested items are counted, emitted as federation.conflict (event bus,
        // webhook) and listed in the job outcome; nothing else applies them.
        const onContested = ({ remoteId }: { remoteId: string; workspaceId: string }) => {
          federationConflicts.inc({});
          const conflict = { workspaceId, peerId, remoteId, jobId, strategy: "sync_contested" };
          emitEvent(deps.bus, "federation.conflict", conflict, jobId, "federation.sync");
          void dispatchWebhookEvent(deps, workspaceId, "federation.conflict", conflict);
        };
        const engine = syncEngine.forWorkspace(workspaceId, { onContested });

        // Walk the peer's pages from where the last sync from it stopped. The job
        // records the cursor after the last page it applied, also when it fails
        // midway or stops at the page or time limit, and the next sync resumes
        // there. startCursor tells the peer which of its facts we may hold, so it
        // sends tombstones only for those.
        const startCursor = (await jobStore.lastCursor(peerId, workspaceId)) ?? undefined;
        cursor = startCursor;
        const deadline = Date.now() + SYNC_TIME_LIMIT_MS;
        let pages = 0;
        let more = false;
        for (;;) {
          // A failed pull fails the job (it used to finish "done" with nothing).
          const pulled = await pullFromPeer(url, apiKey, {
            limit: 200,
            ...(cursor ? { cursor } : {}),
            ...(startCursor ? { knownCursor: startCursor } : {}),
            ...crypto,
            // F9: opt-in plaintext acceptance during mid-rollout migrations.
            allowPlaintextDowngrade: process.env.MNEMO_FED_ALLOW_PLAINTEXT === "true",
            // A fresh JWT per pull: the serving peer records each jti once.
            injectHeaders: (headers) =>
              injectTraceContext({ ...headers, ...pullHeaders(identity, peerId) }),
            ...(pullTls ? { tls: pullTls } : {}),
          });
          // The peer we pulled from is the origin, whatever peerDomain its items claim.
          const pageItems = pulled.items.map((item) => ({ ...item, peerDomain: peerId }));
          const pageResults = await engine.processBatch(
            pageItems,
            conflictResolution ? { conflictResolution } : undefined
          );
          tally.add(pageResults);
          // An item that failed to apply: stay before this page, the next sync retries it.
          if (pageResults.some((r) => r.outcome === "error")) break;
          // A peer that ignores `cursor` would hand back the same page forever.
          if (!pulled.nextCursor || pulled.nextCursor === cursor) break;
          cursor = pulled.nextCursor;
          if (++pages >= SYNC_MAX_PAGES || Date.now() >= deadline) {
            more = true; // the next sync goes on from here
            break;
          }
        }

        const syncDurationSec = (Date.now() - syncStart) / 1000;
        federationSyncDuration.observe({ peer: peerId }, syncDurationSec);
        // Lag: set to 0 on success (real lag needs cursor timestamps from the peer)
        federationLag.set({ peer: peerId }, 0);

        await setJob({
          status: "done",
          completedAt: new Date().toISOString(),
          outcome: { peerId, ...tally.outcome(), ...(cursor ? { cursor } : {}), more },
        });
      } catch (err) {
        syncSpan.setStatus("error", String(err));
        federationSyncDuration.observe({ peer: peerId }, (Date.now() - syncStart) / 1000);
        // If the store itself is down the job cannot be failed here; its
        // heartbeat stops and a later read fails it.
        await setJob({
          status: "failed",
          completedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
          ...(cursor ? { outcome: { peerId, ...tally.outcome(), cursor } } : {}),
        }).catch((storeErr) => console.warn("federation sync job store error:", String(storeErr)));
      } finally {
        clearInterval(heartbeat);
        syncSpan.end();
      }
    });

    return c.json({ jobId, status: "pending" as const }, 202);
  });

  // ── GET /memory/federation/sync/:jobId ────────────────────────────────────────
  // Poll the status of a previously-triggered sync job.
  // Only a job of the caller's workspace; a job of another one is not found.
  app.get("/memory/federation/sync/:jobId", async (c) => {
    const jobId = c.req.param("jobId");
    const job = await jobStore.get(jobId, c.get("workspaceId"));

    if (!job) {
      throw new NotFoundError(`Sync job '${jobId}' not found`);
    }

    return c.json(job, 200);
  });

  // ── POST /memory/federation/resolve ───────────────────────────────────────────
  // Last-write-wins conflict resolution.
  // Body: { itemA: record, itemB: record }
  // Both items are expected to carry: id, version (number), updatedAt (ISO string),
  // attribution (string).
  //
  // LWW algorithm:
  //   1. Compare updatedAt lexicographically — ISO-8601 strings sort correctly.
  //   2. Tiebreak: higher version wins.
  //   3. Still equal: itemA wins (deterministic).
  //
  // Security invariant: if winner.attribution === 'federation_received',
  // cap trustScore to at most 20.
  //
  // References: AUDIT_REPORT.md FED-03, PLUGINS_AND_FEDERATION.md §13.
  app.post("/memory/federation/resolve", async (c) => {
    // §6 mTLS + service-JWT + workspace-scope gate: conflict resolution consumes
    // peer-supplied claims, so it must be peer-gated like /sync rather than
    // running on a generic bearer key alone.
    const gate = await gateFederationRequest(c);
    if (gate instanceof Response) return gate;

    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

    // ── Supermajority consensus path (new in Wave I) ──────────────────────────
    // Body: { items: FederationClaim[] }
    // Peer trust weights are read from the LOCAL PeerStore — never from the request body.
    const items = body["items"] as unknown[] | undefined;
    if (Array.isArray(items) && items.length > 0) {
      // Build peer weight map from local PeerStore (trust weights must not be self-reported).
      const peerWeightMap = new Map<string, number>();
      for (const item of items) {
        if (item && typeof item === "object") {
          const peerId = (item as Record<string, unknown>)["peerId"];
          if (typeof peerId === "string" && !peerWeightMap.has(peerId)) {
            const peerCfg = await peerStore.get(peerId);
            if (peerCfg) peerWeightMap.set(peerId, peerCfg.trustWeight);
          }
        }
      }

      const claims: FederationClaim[] = items
        .filter((i): i is Record<string, unknown> => i !== null && typeof i === "object")
        .map((i) => ({
          version: String(i["version"] ?? ""),
          peerId: typeof i["peerId"] === "string" ? i["peerId"] : undefined,
          attribution: typeof i["attribution"] === "string" ? i["attribution"] : undefined,
          clockSkewMs: typeof i["clockSkewMs"] === "number" ? i["clockSkewMs"] : undefined,
          worth: typeof i["worth"] === "number" ? i["worth"] : undefined,
          freshness: typeof i["freshness"] === "string" ? i["freshness"] : undefined,
        }));

      const outcome = resolveConsensus(claims, peerWeightMap);
      return c.json(
        { outcome, strategy: "supermajority", resolvedAt: new Date().toISOString() },
        200
      );
    }

    // ── Legacy LWW path ───────────────────────────────────────────────────────
    const itemA = body["itemA"] as Record<string, unknown> | undefined;
    const itemB = body["itemB"] as Record<string, unknown> | undefined;

    if (!itemA || typeof itemA !== "object" || !itemB || typeof itemB !== "object") {
      return c.json(
        { error: { code: "bad_request", message: "itemA and itemB are required objects" } },
        400
      );
    }

    // LWW: compare updatedAt ISO-8601 strings lexicographically.
    const updatedAtA = (itemA["updatedAt"] as string | undefined) ?? "";
    const updatedAtB = (itemB["updatedAt"] as string | undefined) ?? "";

    let winnerIsA: boolean;
    if (updatedAtA > updatedAtB) {
      winnerIsA = true;
    } else if (updatedAtB > updatedAtA) {
      winnerIsA = false;
    } else {
      // Timestamps equal — compare version numbers.
      const versionA = typeof itemA["version"] === "number" ? itemA["version"] : 0;
      const versionB = typeof itemB["version"] === "number" ? itemB["version"] : 0;
      // itemA wins on equal version (deterministic tiebreak).
      winnerIsA = versionA >= versionB;
    }

    let winner: Record<string, unknown> = winnerIsA ? { ...itemA } : { ...itemB };
    const loser: Record<string, unknown> = winnerIsA ? { ...itemB } : { ...itemA };

    // Security invariant: cap trust score for federation_received items.
    if (winner["attribution"] === "federation_received") {
      const currentScore = typeof winner["trustScore"] === "number" ? winner["trustScore"] : 0;
      winner = { ...winner, trustScore: Math.min(currentScore, 20) };
    }

    const d = new Date();
    const resolvedAt = d.toISOString();

    const traceId = (c.get("requestId" as never) as string | undefined) ?? "";
    // APP-030: the event names its workspace. Without it the WebSocket fan-out
    // delivered this tenant's contested items to every workspace's subscribers.
    const conflictPayload = {
      workspaceId: c.get("workspaceId"),
      winner,
      loser,
      strategy: "last_write_wins",
      resolvedAt,
    };
    emitEvent(deps.bus, "federation.conflict", conflictPayload, traceId, "federation.sync");
    federationConflicts.inc({}); // §22 mnemo_federation_conflicts_total
    // §35(n) webhook fan-out — best-effort, detached.
    void dispatchWebhookEvent(deps, c.get("workspaceId"), "federation.conflict", conflictPayload);
    return c.json(conflictPayload, 200);
  });
}

// ─── Sync job limits and outcome ─────────────────────────────────────────────

/** Pages (of 200) one sync job reads at most; the next sync goes on from there. */
const SYNC_MAX_PAGES = 50;
/** How long one sync job keeps reading pages before it stops and leaves the rest. */
const SYNC_TIME_LIMIT_MS = 5 * 60_000;
/** Per-item results a job keeps in its outcome; the rest only count. */
const SYNC_RESULTS_SAMPLE = 100;

/** Counts per outcome plus the first SYNC_RESULTS_SAMPLE results of a sync job. */
class SyncTally {
  private readonly counts: Record<string, number> = {};
  private readonly sample: import("@mnemo-ai/federation").SyncItemResult[] = [];
  private total = 0;

  add(results: import("@mnemo-ai/federation").SyncItemResult[]): void {
    for (const r of results) {
      this.total++;
      this.counts[r.outcome] = (this.counts[r.outcome] ?? 0) + 1;
      if (this.sample.length < SYNC_RESULTS_SAMPLE) this.sample.push(r);
    }
  }

  outcome() {
    return { itemsProcessed: this.total, outcomes: this.counts, results: this.sample };
  }
}

/** The updated_at instant of a keyset cursor (`{v, id}`, base64url JSON), if it is one. */
// The (v, id) of a {v, id} cursor as one comparable string: v is a fixed-width
// UTC timestamp, so string order is time order. No cursor sorts first.
function cursorKey(cursor: string | undefined): string {
  if (!cursor) return "";
  try {
    const { v, id } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      id?: unknown;
    };
    return `${String(v)}\u0000${String(id)}`;
  } catch {
    return "";
  }
}

function cursorInstant(cursor: string | undefined): Date | undefined {
  if (!cursor) return undefined;
  try {
    const { v } = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { v?: unknown };
    const at = typeof v === "string" ? new Date(v) : undefined;
    return at && !Number.isNaN(at.getTime()) ? at : undefined;
  } catch {
    return undefined;
  }
}

// ─── Fingerprint helper (P54) ──────────────────────────────────────────────────
// SHA-256 hex digest, lowercase, no prefix — matches the repo-wide idiom used
// by routes/capture.ts:314 (contentHash) and core/security/session-token.ts:23.
function certFingerprint(der: Uint8Array): string {
  return createHash("sha256").update(der).digest("hex");
}

// What the API shows of a peer: never its apiKey or symmetricKey, only whether
// they are set, and the pin as a fingerprint.
function peerView(p: import("@mnemo-ai/federation").PeerConfig) {
  return {
    peerId: p.peerId,
    certFingerprint: certFingerprint(p.pinnedCertDer),
    trustWeight: p.trustWeight,
    approvedAt: p.approvedAt,
    enabled: p.enabled,
    ...(p.url ? { url: p.url } : {}),
    ...(p.signingPublicKey ? { signingPublicKey: p.signingPublicKey } : {}),
    hasApiKey: Boolean(p.apiKey),
    hasSymmetricKey: Boolean(p.symmetricKey),
  };
}
