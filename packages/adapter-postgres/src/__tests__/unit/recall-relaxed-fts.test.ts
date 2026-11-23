import { describe, expect, it, vi } from "vitest";
import { recallContentTerms, RecallRepository } from "../../repositories/RecallRepository.js";

const query = {
  workspaceId: "66666666-6666-4666-8666-666666666666",
  terms: ["¿cómo", "se", "despliega", "el", "chatbot", "de", "soporte?"],
  limit: 10,
};

function repository(rows: unknown[][]) {
  let read = 0;
  const select = vi.fn(() => ({
    from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows[read++] ?? [] }) }) }),
  }));
  const tx = {
    execute: vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { term: "despliega", en: "'desplieg'", es: "'desplieg'" },
        { term: "chatbot", en: "'chatbot'", es: "'chatbot'" },
        { term: "soporte", en: "'soport'", es: "'soport'" },
      ]),
    select,
  };
  const db = { transaction: async (fn: (value: unknown) => unknown) => fn(tx) };
  const repo = new RecallRepository(db as never, db as never);
  (repo as unknown as { pointerCandidate: (row: unknown) => unknown }).pointerCandidate = (row) =>
    row;
  return { repo, select, tx };
}

describe("recall-only relaxed FTS", () => {
  it("normalizes Spanish and English stopwords before counting content terms", () => {
    expect(recallContentTerms(query.terms)).toEqual(["despliega", "chatbot", "soporte"]);
    expect(recallContentTerms(["the", "and", "of", "el", "de", "se"])).toEqual([]);
  });

  it("retries a strict-empty query only when recall enables fallback", async () => {
    const { repo, select, tx } = repository([[], []]);
    expect(await repo.ftsCandidates({ ...query, relaxedOnEmpty: true })).toEqual([]);
    expect(select).toHaveBeenCalledTimes(2);
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it("does not retry when strict search found a fact", async () => {
    const { repo, select } = repository([[{ factId: "f1", rank: 0.4 }]]);
    expect(
      (await repo.ftsCandidates({ ...query, relaxedOnEmpty: true })).map((row) => row.factId)
    ).toEqual(["f1"]);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("leaves the shared strict matcher unchanged", async () => {
    const { repo, select } = repository([[]]);
    expect(await repo.ftsCandidates(query)).toEqual([]);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does not retry stopword-only input", async () => {
    const { repo, select } = repository([[]]);
    expect(
      await repo.ftsCandidates({ ...query, terms: ["el", "de", "se"], relaxedOnEmpty: true })
    ).toEqual([]);
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("does not relax when stemming leaves fewer than three distinct terms", async () => {
    const { repo, select, tx } = repository([[]]);
    tx.execute.mockReset();
    tx.execute.mockResolvedValueOnce([]).mockResolvedValueOnce([
      { term: "chatbot", en: "'chatbot'", es: "'chatbot'" },
      { term: "chatbots", en: "'chatbot'", es: "'chatbot'" },
      { term: "nomina", en: "'nomina'", es: "'nomin'" },
    ]);
    expect(
      await repo.ftsCandidates({
        ...query,
        terms: ["chatbot", "chatbots", "nómina"],
        relaxedOnEmpty: true,
      })
    ).toEqual([]);
    expect(select).toHaveBeenCalledTimes(1);
  });
});
