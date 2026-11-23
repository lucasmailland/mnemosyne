// P135 — a memory's project (`scopeRef`) resolved against the workspace's
// `project` entities.
//
// `scopeRef` is free text with no foreign key, so `Acme`, `acme` and
// `acme-integrations` were three projects nobody could tell apart. A
// `project` entity already carries a canonical name and aliases; this module is
// the one place that maps a `scopeRef` onto it:
//
//   - a write whose `scopeRef` names a live project (its name or an alias,
//     ignoring case and surrounding space) stores the canonical name;
//   - a write that names no project but looks like one stores what it was sent
//     and reports the likely project;
//   - a read that filters by a project also matches every other spelling of
//     it, so memories written before the alias existed are found without
//     rewriting them.
//
// A workspace with no `project` entities sees no change, and a storage failure
// never fails the write or the read: resolution degrades to the raw value.

import type { Logger, MnemoEntity, RecallQuery, StorageAdapter } from "@mnemo-ai/types";

/** Upper bound on project entities read per resolution. */
const MAX_PROJECTS = 500;
/** Below this length an edit-distance match is mostly noise. */
const MIN_FUZZY_LENGTH = 5;
const MAX_EDIT_DISTANCE = 2;

export interface ProjectScopeResolution {
  /** The value to store, or to filter by. */
  scopeRef: string;
  /**
   * Other spellings of the same project: its name and aliases, minus
   * `scopeRef`. Empty when `scopeRef` names no project.
   */
  aliases: string[];
  /** Set when the value sent was replaced by the project's canonical name. */
  canonicalized?: { received: string; storedAs: string; entityId: string };
  /** Set when the value names no project but resembles one. */
  suggestion?: { received: string; project: string; entityId: string };
}

type EntityReader = Pick<StorageAdapter, "queryEntities">;

const key = (s: string): string => s.trim().toLowerCase();
/** Case-, space- and punctuation-insensitive form: `Acme_Integrations` → `acmeintegrations`. */
const loose = (s: string): string => key(s).replace(/[^\p{L}\p{N}]+/gu, "");

function spellings(project: MnemoEntity): string[] {
  return [project.name, ...(project.aliases ?? [])].filter((s) => s.trim().length > 0);
}

/** Levenshtein distance, bailing out once it exceeds `max`. */
function editDistanceWithin(a: string, b: string, max: number): boolean {
  if (Math.abs(a.length - b.length) > max) return false;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return false;
    prev = cur;
  }
  return prev[b.length]! <= max;
}

async function liveProjects(storage: EntityReader, workspaceId: string): Promise<MnemoEntity[]> {
  const { items } = await storage.queryEntities({
    workspaceId,
    kind: "project",
    openOnly: true,
    limit: MAX_PROJECTS,
  });
  return items;
}

/**
 * Resolve `raw` against the workspace's live `project` entities. Never throws:
 * on a storage error the raw value comes back unchanged with no aliases.
 */
export async function resolveProjectScopeRef(
  storage: EntityReader,
  workspaceId: string,
  raw: string,
  logger?: Pick<Logger, "warn">
): Promise<ProjectScopeResolution> {
  const unchanged: ProjectScopeResolution = { scopeRef: raw, aliases: [] };
  if (raw.trim().length === 0) return unchanged;

  let projects: MnemoEntity[];
  try {
    projects = await liveProjects(storage, workspaceId);
  } catch (err) {
    logger?.warn("project scopeRef resolution skipped: entity read failed", {
      workspaceId,
      error: {
        type: err instanceof Error ? err.name : typeof err,
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return unchanged;
  }
  if (projects.length === 0) return unchanged;

  const k = key(raw);
  // A project's own name wins over another project's alias.
  const match =
    projects.find((p) => key(p.name) === k) ??
    projects.find((p) => (p.aliases ?? []).some((a) => key(a) === k));

  if (match) {
    const scopeRef = match.name;
    const aliases = [...new Set(spellings(match))].filter((s) => s !== scopeRef);
    return {
      scopeRef,
      aliases,
      ...(raw !== scopeRef
        ? { canonicalized: { received: raw, storedAs: scopeRef, entityId: match.id } }
        : {}),
    };
  }

  const l = loose(raw);
  const similar = projects.find((p) =>
    spellings(p).some((s) => {
      const ls = loose(s);
      if (ls.length === 0) return false;
      if (ls === l) return true;
      return (
        Math.min(ls.length, l.length) >= MIN_FUZZY_LENGTH &&
        editDistanceWithin(ls, l, MAX_EDIT_DISTANCE)
      );
    })
  );
  return similar
    ? { ...unchanged, suggestion: { received: raw, project: similar.name, entityId: similar.id } }
    : unchanged;
}

/**
 * Resolve a recall query's `filter.scopeRef`: the filter keeps the canonical
 * name and gains the project's other spellings, so memories written under any
 * of them are recalled. A query without `scopeRef` comes back as is.
 */
export async function withProjectScope(
  storage: EntityReader,
  query: RecallQuery,
  logger?: Pick<Logger, "warn">
): Promise<RecallQuery> {
  const scopeRef = query.filter?.scopeRef;
  if (!scopeRef) return query;
  const r = await resolveProjectScopeRef(storage, query.workspaceId, scopeRef, logger);
  if (r.scopeRef === scopeRef && r.aliases.length === 0) return query;
  return {
    ...query,
    filter: {
      ...query.filter,
      scopeRef: r.scopeRef,
      ...(r.aliases.length > 0 ? { scopeRefAliases: r.aliases } : {}),
    },
  };
}
