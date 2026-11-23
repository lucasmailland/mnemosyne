// in-memory/skills.ts — InMemoryStorageAdapter's Skill port methods.
// decompose-inmemory-storage-adapter Batch B2 (design.md Module Map row 13).
// Bodies moved verbatim from InMemoryStorageAdapter.ts — the only edit is
// `this.<field>` → `state.<field>` (design.md D7 move-only rule).

import type { CreateSkillInput, UpdateSkillInput, SkillFilter } from "../../ports.js";
import type { MnemoSkill } from "../../primitives.js";
import type { PaginatedResult } from "../../common.js";
import type { InMemoryStorageState } from "./state.js";
import { uuid, paginate } from "./support.js";
import { projectPrimitiveText } from "../../indexing.js";

export async function createSkill(
  state: InMemoryStorageState,
  input: CreateSkillInput
): Promise<MnemoSkill> {
  const now = new Date();
  const skill = {
    id: uuid(),
    workspaceId: input.workspaceId,
    actorId: input.actorId,
    userId: input.userId,
    actorType: input.actorType,
    name: input.name,
    promptTemplate: input.promptTemplate,
    variables: input.variables ?? [],
    requiredContext: input.requiredContext ?? [],
    sensitivity: input.sensitivity ?? "internal",
    qualityScore: 0,
    worth: 0.5,
    usageCount: 0,
    embeddingStale: true,
    // P18: initialize bitemporal columns
    validFrom: now,
    validTo: undefined,
    createdAt: now,
    updatedAt: now,
    metadata: input.metadata ?? {},
  } as unknown as MnemoSkill;
  state.skills.set(skill.id, skill);
  // P65: mirrors the real adapter's in-transaction text-form vector_upsert.
  // Deliberately kept in step: a double that indexes nothing while Postgres
  // does (or vice versa) makes every unit test agree with the wrong thing —
  // the shape P116 hid behind for as long as it did.
  state.outbox.push({
    id: uuid(),
    workspaceId: skill.workspaceId,
    eventType: "vector_upsert",
    payload: {
      id: skill.id,
      kind: "skill",
      text: projectPrimitiveText("skill", skill as unknown as Record<string, unknown>),
    },
    createdAt: new Date(),
    attempts: 0,
  });
  return skill;
}

export async function getSkill(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<MnemoSkill | null> {
  const s = state.skills.get(id);
  return s && s.workspaceId === workspaceId ? s : null;
}

export async function updateSkill(
  state: InMemoryStorageState,
  id: string,
  input: UpdateSkillInput
): Promise<MnemoSkill> {
  const s = state.skills.get(id);
  if (!s) throw new Error(`Skill ${id} not found`);
  const updated = { ...s, ...input, updatedAt: new Date() };
  state.skills.set(id, updated);
  return updated;
}

export async function archiveSkill(
  state: InMemoryStorageState,
  id: string,
  workspaceId: string
): Promise<void> {
  const s = state.skills.get(id);
  if (s && s.workspaceId === workspaceId) {
    // P18: close bitemporal interval (do NOT delete — mirrors Postgres repository)
    state.skills.set(id, { ...s, validTo: new Date(), updatedAt: new Date() });
  }
}

export async function querySkills(
  state: InMemoryStorageState,
  filter: SkillFilter
): Promise<PaginatedResult<MnemoSkill>> {
  const items = [...state.skills.values()].filter((s) => {
    if (s.workspaceId !== filter.workspaceId) return false;
    // P18: validAt predicate — open-interval semantics (validTo > validAt, NOT >=)
    if (filter.validAt) {
      if (s.validFrom > filter.validAt) return false;
      if (s.validTo != null && s.validTo <= filter.validAt) return false;
    }
    if (filter.openOnly && s.validTo != null) return false;
    return true;
  });
  return paginate(items, filter.offset, filter.limit);
}
