/**
 * `debug.embedded` en POST /recall tiene que decir la verdad.
 *
 * Su propia descripción OpenAPI (routes/recall.ts) promete:
 *
 *   "Whether the server had to call the LLM to embed the query."
 *
 * pero el campo estaba escrito como literal `false` en las dos ramas de
 * respuesta, y `embedded: true` no aparecía en ningún lugar del server. O sea
 * informaba un dato que nunca medía.
 *
 * Por qué importa más de lo que parece: es el único indicador que expone la
 * API para distinguir "la búsqueda fue vectorial" de "degradó a full-text".
 * Un `false` constante manda a quien debuggea recall a buscar un embedder roto
 * que está perfectamente sano. (También va al audit log, vía auditRecall, así
 * que la mentira queda persistida.)
 *
 * La regla que fijan estos tests:
 *   - el que llama manda `vector`  → embedded=false (nadie embebió nada acá)
 *   - no hay embedder (searchMode "fts") → embedded=false
 *   - en cualquier otro caso el server embebió la query → embedded=true
 */
import { describe, it, expect } from "vitest";
import bcrypt from "bcrypt";
import { BCRYPT_COST } from "../auth.js";
import type { ApiKeyLookup } from "../auth.js";
import type { ServerDeps } from "../deps.js";
import type { RecallQuery, RecallResponse } from "@mnemo-ai/types";
import { mountRecall } from "../routes/recall.js";
import { buildMountHarness } from "./_mountHarness.js";

const PLAINTEXT_KEY = "mns_live_debugembeddedtest00001";
const WS_ID = "00000000-0000-0000-0000-000000000017";

async function makeKeyLookup(): Promise<ApiKeyLookup> {
  const keyHash = await bcrypt.hash(PLAINTEXT_KEY, BCRYPT_COST);
  return {
    listActive: async () => [
      { id: "key001", keyHash, workspaceId: WS_ID, scopes: ["memory:read"], plan: "free" },
    ],
    findByLookupHash: undefined,
    setLookupHash: undefined,
    touch: async () => {},
  } as unknown as ApiKeyLookup;
}

const authed = () => ({
  authorization: `Bearer ${PLAINTEXT_KEY}`,
  "content-type": "application/json",
});

/**
 * Stub que refleja el comportamiento real de recall-cold: sin `embedding` en
 * la query hace búsqueda vectorial (el server embebió el texto); con
 * `embedding` usa el vector que le pasaron.
 */
function makeVectorV3(): NonNullable<ServerDeps["cognitive"]> {
  return {
    recall: async (q: RecallQuery): Promise<RecallResponse> => ({
      hits: [],
      total: 0,
      query: { text: q.text, limit: q.limit ?? 10, offset: q.offset ?? 0 },
      latencyMs: 1,
      fromHotTier: false,
      searchMode: "vector",
    }),
  } as unknown as NonNullable<ServerDeps["cognitive"]>;
}

/** Stub sin embedder: recall-cold degrada a full-text. */
function makeFtsV3(): NonNullable<ServerDeps["cognitive"]> {
  return {
    recall: async (q: RecallQuery): Promise<RecallResponse> => ({
      hits: [],
      total: 0,
      query: { text: q.text, limit: q.limit ?? 10, offset: q.offset ?? 0 },
      latencyMs: 1,
      fromHotTier: false,
      searchMode: "fts",
    }),
  } as unknown as NonNullable<ServerDeps["cognitive"]>;
}

async function makeDeps(cognitive: NonNullable<ServerDeps["cognitive"]>): Promise<ServerDeps> {
  return {
    apiKeys: await makeKeyLookup(),
    embedModel: "text-embedding-3-small",
    cognitive,
  } as unknown as ServerDeps;
}

type RecallBody = { debug: { embedded: boolean; searchMode?: string } };

describe("POST /recall — debug.embedded refleja si el server embebió la query", () => {
  it("es true cuando el server embebe la query (búsqueda vectorial, sin vector del caller)", async () => {
    const app = buildMountHarness(await makeDeps(makeVectorV3()), [mountRecall]);

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "preferencias de horario del equipo" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RecallBody;
    expect(body.debug.searchMode).toBe("vector");
    expect(body.debug.embedded).toBe(true);
  });

  it("es false cuando el caller manda un vector precomputado", async () => {
    const app = buildMountHarness(await makeDeps(makeVectorV3()), [mountRecall]);

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({
        query: "preferencias de horario del equipo",
        vector: Array.from({ length: 8 }, () => 0.1),
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RecallBody;
    expect(body.debug.embedded).toBe(false);
  });

  it("es false cuando no hay embedder y la búsqueda degrada a full-text", async () => {
    const app = buildMountHarness(await makeDeps(makeFtsV3()), [mountRecall]);

    const res = await app.request("/recall", {
      method: "POST",
      headers: authed(),
      body: JSON.stringify({ query: "preferencias de horario del equipo" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as RecallBody;
    expect(body.debug.searchMode).toBe("fts");
    expect(body.debug.embedded).toBe(false);
  });
});
