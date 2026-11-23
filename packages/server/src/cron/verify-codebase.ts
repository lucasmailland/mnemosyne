import type { StorageAdapter, LLMAdapter, Telemetry, CreateEventInput, CreateFactInput, UpdateFactInput } from "@mnemo-ai/types";

export interface FileReader {
  read(path: string, ref?: string): Promise<string | null>;
}

export interface VerifyDeps {
  workspaceId: string;
  storage: StorageAdapter;
  fileReader?: FileReader;
  llm?: LLMAdapter;
  telemetry: Telemetry;
  logger: { info(o: object, m?: string): void; warn(o: object, m?: string): void; debug(o: object, m?: string): void };
  autoCorrect?: boolean;
}

export interface VerifyResult { checked: number; drifted: number; corrected: number; }

export async function verifyCodebaseForWorkspace(deps: VerifyDeps): Promise<VerifyResult> {
  if (!deps.fileReader) {
    deps.logger.info({ ws: deps.workspaceId }, "verify_codebase.skipped_no_file_reader");
    return { checked: 0, drifted: 0, corrected: 0 };
  }
  const candidates = await deps.storage.queryDriftCandidates(deps.workspaceId);
  let drifted = 0;
  let corrected = 0;

  for (const fact of candidates) {
    const ref = (fact.metadata["file_ref"] ?? {}) as { path?: string; ref?: string };
    if (!ref.path) continue;
    const content = await deps.fileReader.read(ref.path, ref.ref).catch(() => null);
    const isDrift = content === null || !content.includes(fact.statement.trim());
    if (!isDrift) continue;
    drifted++;

    // Step 4a: close validity
    const closeInput: UpdateFactInput = { validTo: new Date() };
    await deps.storage.updateFact(fact.id, deps.workspaceId, closeInput);

    // Step 4b: auto-correct (optional)
    if (deps.autoCorrect && content) {
      try {
        const createInput: CreateFactInput = {
          workspaceId: deps.workspaceId,
          scope: "global",
          subject: "codebase",
          kind: "other",
          statement: content.slice(0, 2000),
          metadata: { ...fact.metadata, corrected_from: fact.id },
        };
        await deps.storage.createFact(createInput);
        corrected++;
      } catch { /* best-effort */ }
    }

    // Step 4c: review queue
    await deps.storage.enqueueReviewItem({
      workspaceId: deps.workspaceId, primitiveId: fact.id, primitiveKind: "fact",
      reason: "codebase_drift", detail: { path: ref.path },
    });

    // Step 4d: decrease worth
    await deps.storage.updateWorth(fact.id, deps.workspaceId, "fact", { success: 0, failure: 1, creditWeight: 1 });

    // Step 5: emit event
    const eventInput: CreateEventInput = {
      workspaceId: deps.workspaceId,
      type: "system",
      name: "verification.drift_detected",
      description: `Codebase drift detected in fact ${fact.id}`,
      source: "mnemo.verify.codebase",
      occurredAt: new Date(),
      metadata: { factId: fact.id, path: ref.path },
    };
    await deps.storage.createEvent(eventInput);
  }

  // Step 6: health gauge
  deps.telemetry.gauge("mnemo_codebase_drift_rate", candidates.length ? drifted / candidates.length : 0, { workspaceId: deps.workspaceId });
  return { checked: candidates.length, drifted, corrected };
}
