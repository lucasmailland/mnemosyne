import { describe, it, expect, vi } from "vitest";
import type { AuthContext } from "@mnemo-ai/types";

// composeInferences is exercised elsewhere; stub it so these tests isolate relevance.
vi.mock("../compositionality.js", () => ({ composeInferences: vi.fn(async () => []) }));

const { tryHotTier, hotTierKey } = await import("../recall-hot.js");

// ─── Infra-free fakes ──────────────────────────────────────────────────────────

function makeCache(ids: string[]) {
  const m = new Map<string, number>();
  ids.forEach((id, i) => m.set(id, i + 1));
  const zsets = new Map<string, Map<string, number>>([[hotTierKey("ws"), m]]);
  return {
    id: "fake-cache",
    capabilities: { sortedSets: true, pubSub: false, patterns: false, atomic: false },
    async zincrby(key: string, by: number, member: string): Promise<void> {
      const z = zsets.get(key) ?? new Map<string, number>();
      z.set(member, (z.get(member) ?? 0) + by);
      zsets.set(key, z);
    },
    async zrangeByScore(key: string): Promise<string[]> {
      const z = zsets.get(key) ?? new Map<string, number>();
      return [...z.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
    },
  } as any;
}

/** Every fact was recalled in the last seconds, so all clear the 0.7 activation bar. */
function makeStorage(statements: Record<string, string>) {
  const now = Date.now(); // determinism-ok: only relative offsets matter for ACT-R recency scoring
  return {
    async getFact(id: string) {
      const statement = statements[id];
      if (statement === undefined) return null;
      return {
        id,
        status: "active",
        validTo: undefined,
        validFrom: new Date("2026-01-01T00:00:00Z"),
        statement,
        sensitivity: "internal",
        worth: 0.9,
        worthAlpha: 20,
        worthBeta: 5,
        createdAt: "2026-01-01T00:00:00Z",
        attribution: "user_stated",
      };
    },
    async getRecallLog() {
      return [0, 1000, 2000, 3000, 4000].map((ago, i) => ({
        id: `r-${i}`,
        recalledAt: new Date(now - ago).toISOString(),
        recallScore: 1,
      }));
    },
  } as any;
}

function makeCtx(cache: any, storage: any) {
  const logger = {
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return this;
    },
  };
  const telemetry = { startSpan: () => ({ end() {} }), histogram: () => {} };
  return { cache, storage, config: { maxHotTierSize: 1000 }, logger, telemetry } as any;
}

const auth = { scopes: [] } as unknown as AuthContext;

// Highly activated facts that a workspace keeps recalling, none about Odoo.
const GENERIC = {
  g1: "El deploy de Acme va por GitLab CI a Kubernetes.",
  g2: "El chatbot de soporte de Acme corre en NestJS.",
  g3: "El equipo de RRHH prefiere reuniones cortas los lunes por la mañana.",
};
const ODOO = {
  o1: "El Odoo de Acme responde JSON-RPC en POST /jsonrpc y su versión es saas~19.3.",
  // Covers only half of the version question (odoo, acme): not enough to be served.
  o2: "Odoo de Acme: las automatizaciones del helpdesk avisan a soporte por tags.",
  o3: "La version de Odoo de Acme no expone XML-RPC detrás del proxy.",
  o4: "Acme usa la versión 19 de Odoo en la nube.",
};

async function hot(statements: Record<string, string>, text: string | undefined) {
  const ids = Object.keys(statements);
  const query = { workspaceId: "ws", limit: 10, ...(text === undefined ? {} : { text }) };
  return tryHotTier(makeCtx(makeCache(ids), makeStorage(statements)), query as any, auth);
}

describe("tryHotTier query relevance", () => {
  it("falls through instead of serving highly activated facts unrelated to the query", async () => {
    const res = await hot(GENERIC, "qué versión de odoo usa acme?");
    expect(res).toBeNull();
  });

  it("serves only the activated facts that cover most of the query terms", async () => {
    const res = await hot({ ...GENERIC, ...ODOO }, "qué versión de odoo usa acme?");
    expect(res).not.toBeNull();
    expect(res!.hits.map((h) => h.id).sort()).toEqual(["o1", "o3", "o4"]);
  });

  it("matches across case and accents", async () => {
    const res = await hot(ODOO, "VERSIÓN DE ODOO");
    expect(res!.hits.map((h) => h.id).sort()).toEqual(["o1", "o3", "o4"]);
  });

  it("falls through on a bare confirmation", async () => {
    const res = await hot({ ...GENERIC, ...ODOO }, "sí, adelante");
    expect(res).toBeNull();
  });

  it("falls through when the query has no content words", async () => {
    const res = await hot({ ...GENERIC, ...ODOO }, "¿y eso qué?");
    expect(res).toBeNull();
  });

  it("keeps serving by activation alone when no query text is given", async () => {
    const res = await hot(GENERIC, undefined);
    expect(res).not.toBeNull();
    expect(res!.hits).toHaveLength(3);
  });
});
