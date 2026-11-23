/**
 * P130 — contradiction candidates come from MEANING, not from sharing a subject.
 *
 * The reported symptom was conflicts between pairs with nothing to do with each
 * other — "Verificacion de P117: soft delete" against "The team uses PostgreSQL
 * with pgvector", both `subject: 'general'`. The cause was not a bad threshold:
 * the predicate was `subject = $1 OR text_lemmatized @@ plainto_tsquery(…)` and
 * the second half CANNOT match a contradiction, because `plainto_tsquery` ANDs
 * every term — so a candidate has to contain every word of the incoming
 * statement, INCLUDING the one that differs. A contradiction differs by
 * definition. Measured:
 *
 *   to_tsvector('el broker de mensajes es RabbitMQ')
 *     @@ plainto_tsquery('el broker de mensajes es Kafka')   →  FALSE
 *
 * That left `subject = $1` as the only clause producing candidates at all.
 *
 * A previous attempt deleted the subject clause and required lexical overlap.
 * It was REVERTED, and that is the reason this file tests both directions: the
 * false positives went to zero and so did the true positives. Switching a
 * detector off is strictly worse than a noisy one, and only the negative half
 * had been checked.
 *
 * So: every describe block below has a positive and a negative case, and
 * neither is allowed to pass alone.
 *
 * Vectors here are 2-D unit vectors at exact cosines rather than real
 * embeddings — the behaviour under test is the gate, not the embedder, and a
 * test that needs ollama running is a test that gets skipped.
 */
import { describe, it, expect, vi } from "vitest";
import { InMemoryStorageAdapter } from "@mnemo-ai/types/testing";
import { DEFAULT_CONTRADICTION_MIN_SIMILARITY } from "@mnemo-ai/types";

const WS = "ws-1";

/** Unit vector whose cosine against [1,0] is exactly `c`. */
const at = (c: number): number[] => [c, Math.sqrt(1 - c * c)];
const QUERY = [1, 0];

/** Measured on the real pairs — see the port docstring. */
const REAL_CONTRADICTION = 0.6861; // "usamos Postgres" / "ya no usamos Postgres"
const REAL_FALSE_POSITIVE = 0.4356; // "P117: soft delete" / "team uses PostgreSQL"

async function seed(
  storage: InMemoryStorageAdapter,
  facts: Array<{ id?: string; statement: string; subject: string; embedding?: number[] }>
) {
  const out = [];
  for (const f of facts) {
    out.push(
      await storage.createFact({
        workspaceId: WS,
        subject: f.subject,
        statement: f.statement,
        attribution: "user_stated",
        actorId: "key:k1",
        actorType: "agent",
        userId: null,
        ...(f.embedding ? { embedding: f.embedding } : {}),
      } as never)
    );
  }
  return out;
}

describe("P130 — the semantic arm replaces subject-match as the candidate source", () => {
  it("finds a real contradiction — the half the reverted attempt broke", async () => {
    const storage = new InMemoryStorageAdapter();
    const [existing] = await seed(storage, [
      {
        statement: "usamos Postgres como base principal",
        subject: "general",
        embedding: at(REAL_CONTRADICTION),
      },
    ]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "general",
      statement: "ya no usamos Postgres, migramos a MySQL",
      embedding: QUERY,
    });

    expect(found.map((f) => f.id)).toEqual([existing!.id]);
  });

  it("does NOT surface an unrelated fact that merely shares a subject", async () => {
    // THE original bug, in one assertion. Both facts are `general`, which is
    // the default subject, so under the old predicate this was guaranteed to
    // be reported as a conflict.
    const storage = new InMemoryStorageAdapter();
    await seed(storage, [
      {
        statement: "Verificacion de P117: soft delete",
        subject: "general",
        embedding: at(REAL_FALSE_POSITIVE),
      },
    ]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "general",
      statement: "The team uses PostgreSQL with pgvector",
      embedding: QUERY,
    });

    expect(found).toEqual([]);
  });

  it("keeps a same-subject fact when it IS semantically close", async () => {
    // Subject is not banned — it is just no longer sufficient on its own. A
    // fact that shares the subject AND the meaning still comes back.
    const storage = new InMemoryStorageAdapter();
    const [close] = await seed(storage, [
      { statement: "la guardia rota los martes", subject: "guardia", embedding: at(0.86) },
      { statement: "el logo de la marca es azul", subject: "guardia", embedding: at(0.37) },
    ]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "guardia",
      statement: "la guardia ahora rota los jueves",
      embedding: QUERY,
    });

    expect(found.map((f) => f.id)).toEqual([close!.id]);
  });

  it("ranks by similarity, so the resolver sees the closest candidate first", async () => {
    const storage = new InMemoryStorageAdapter();
    const [far, near] = await seed(storage, [
      { statement: "el deploy va por CI", subject: "a", embedding: at(0.62) },
      { statement: "el deploy va por GitLab CI", subject: "b", embedding: at(0.93) },
    ]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "z",
      statement: "el deploy ahora va por GitHub Actions",
      embedding: QUERY,
    });

    expect(found.map((f) => f.id)).toEqual([near!.id, far!.id]);
  });
});

describe("P130 — a fact without a usable vector is not left blind", () => {
  it("still reaches the lexical predicate, rather than becoming invisible", async () => {
    // Dropping un-embedded rows from candidacy would trade a noisy candidate
    // for a silent blind spot — a narrower version of exactly the mistake that
    // got the previous attempt reverted.
    const storage = new InMemoryStorageAdapter();
    const [noVector] = await seed(storage, [
      { statement: "el broker de mensajes es RabbitMQ", subject: "broker" },
    ]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "broker",
      statement: "el broker de mensajes es Kafka",
      embedding: QUERY,
    });

    expect(found.map((f) => f.id)).toEqual([noVector!.id]);
  });

  it("treats a WIDTH MISMATCH as no vector, not as a low score", async () => {
    // P117/P118: comparing across widths is an error, not a weak similarity.
    // Scoring it would silently rank a fact by a number that means nothing.
    const storage = new InMemoryStorageAdapter();
    const [wrongWidth] = await seed(storage, [
      { statement: "el broker es RabbitMQ", subject: "broker", embedding: [0.1, 0.2, 0.3, 0.4] },
    ]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "broker",
      statement: "el broker es Kafka",
      embedding: QUERY,
    });

    // Falls through to lexical (same subject) rather than being cosine-scored.
    expect(found.map((f) => f.id)).toEqual([wrongWidth!.id]);
  });

  it("with NO embedding supplied at all, behaviour is the old lexical path", async () => {
    // Callers with no embed provider must not silently get zero candidates.
    const storage = new InMemoryStorageAdapter();
    const [a] = await seed(storage, [{ statement: "cualquier cosa", subject: "facturacion" }]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "facturacion",
      statement: "algo totalmente distinto",
    });

    expect(found.map((f) => f.id)).toEqual([a!.id]);
  });
});

describe("PRIM-5 — the default subject alone never makes a vectorless fact a candidate", () => {
  // `general` is what every write without a subject gets (remember.ts). A
  // vectorless row fell back to `subject = $1 OR fts`, so ONE such row (a
  // restored fact, PRIM-4) turned every later default-subject write into
  // `judgmentRequired:true` against it. Measured: "The quibblemoor service
  // listens on port 8080" flagged against an unrelated halcyonmint fact.
  it("skips a NULL-vector `general` fact that shares nothing but the subject", async () => {
    const storage = new InMemoryStorageAdapter();
    await seed(storage, [{ statement: "halcyonmint deploys run on Fridays", subject: "general" }]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "general",
      statement: "The quibblemoor service listens on port 8080",
      embedding: QUERY,
    });

    expect(found).toEqual([]);
  });

  it("skips a WRONG-WIDTH `general` fact that shares nothing but the subject", async () => {
    const storage = new InMemoryStorageAdapter();
    await seed(storage, [
      {
        statement: "halcyonmint deploys run on Fridays",
        subject: "general",
        embedding: [0.1, 0.2, 0.3, 0.4],
      },
    ]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "general",
      statement: "The quibblemoor service listens on port 8080",
      embedding: QUERY,
    });

    expect(found).toEqual([]);
  });

  it("skips it on the no-embedding path too", async () => {
    const storage = new InMemoryStorageAdapter();
    await seed(storage, [{ statement: "halcyonmint deploys run on Fridays", subject: "general" }]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "general",
      statement: "The quibblemoor service listens on port 8080",
    });

    expect(found).toEqual([]);
  });

  it("an empty subject is as generic as `general`", async () => {
    const storage = new InMemoryStorageAdapter();
    await seed(storage, [{ statement: "halcyonmint deploys run on Fridays", subject: "" }]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "",
      statement: "The quibblemoor service listens on port 8080",
      embedding: QUERY,
    });

    expect(found).toEqual([]);
  });

  it("still finds a vectorless `general` fact through the statement itself", async () => {
    // Positive control: the generic subject stops GENERATING candidates, it
    // does not hide a fact the text predicate reaches on its own.
    const storage = new InMemoryStorageAdapter();
    const [overlap] = await seed(storage, [
      { statement: "quibblemoor listens on port 9090", subject: "general" },
    ]);

    const found = await storage.findContradictingFacts(WS, {
      subject: "general",
      statement: "quibblemoor listens on port 8080",
      embedding: QUERY,
    });

    expect(found.map((f) => f.id)).toEqual([overlap!.id]);
  });
});

describe("P130 — the floor itself", () => {
  it("admits just above and rejects just below, on the same fixture", async () => {
    const floor = DEFAULT_CONTRADICTION_MIN_SIMILARITY;
    for (const [sim, shouldFind] of [
      [floor + 0.02, true],
      [floor - 0.02, false],
    ] as const) {
      const storage = new InMemoryStorageAdapter();
      await seed(storage, [{ statement: "x", subject: "s", embedding: at(sim) }]);
      const found = await storage.findContradictingFacts(WS, {
        subject: "otro-subject",
        statement: "y",
        embedding: QUERY,
      });
      expect(found.length > 0, `similarity ${sim} should ${shouldFind ? "" : "not "}match`).toBe(
        shouldFind
      );
    }
  });

  it("sits between the measured worst-positive and worst-negative", async () => {
    // Pins the calibration to the evidence rather than to a taste. If someone
    // moves the floor, this says which real pair they just broke.
    expect(DEFAULT_CONTRADICTION_MIN_SIMILARITY).toBeLessThan(REAL_CONTRADICTION);
    expect(DEFAULT_CONTRADICTION_MIN_SIMILARITY).toBeGreaterThan(REAL_FALSE_POSITIVE);
  });

  it("an explicit minSimilarity overrides the default", async () => {
    const storage = new InMemoryStorageAdapter();
    await seed(storage, [{ statement: "x", subject: "s", embedding: at(0.5) }]);

    const strict = await storage.findContradictingFacts(WS, {
      subject: "otro",
      statement: "y",
      embedding: QUERY,
      minSimilarity: 0.9,
    });
    const loose = await storage.findContradictingFacts(WS, {
      subject: "otro",
      statement: "y",
      embedding: QUERY,
      minSimilarity: 0.4,
    });

    expect(strict).toEqual([]);
    expect(loose).toHaveLength(1);
  });
});

describe("P130 — remember() actually hands the vector over", () => {
  it("passes the embedding it already computed into findContradictingFacts", async () => {
    // The half that is usually missing. The gate can be perfect and the query
    // correct, and the vector still never arrives — leaving every write back on
    // the lexical path with nothing failing.
    const { remember } = await import("../remember.js");
    const storage = new InMemoryStorageAdapter();
    const spy = vi.spyOn(storage, "findContradictingFacts");
    const vector = new Float32Array([0.6, 0.8]);

    await remember(
      {
        storage,
        vector: { search: async () => [] }, // pe = 1.0 → never surprise-gated
        embed: { model: "test", embedSingle: async () => vector },
        telemetry: { startSpan: () => ({ end: () => {} }) },
        logger: { info: () => {}, debug: () => {}, warn: () => {}, error: () => {} },
        config: { surpriseThreshold: 0, writeConflictClassification: true },
      } as never,
      {
        workspaceId: WS,
        kind: "fact",
        content: "un hecho cualquiera",
        subject: "general",
      } as never,
      {
        workspaceId: WS,
        actorId: "agent-1",
        actorType: "agent",
        userId: null,
        scopes: ["memory:write"],
      } as never
    );

    expect(spy).toHaveBeenCalled();
    const passed = spy.mock.calls[0]![1] as { embedding?: number[] };
    expect(passed.embedding, "remember() did not forward the embedding").toEqual(
      Array.from(vector)
    );
  });
});
