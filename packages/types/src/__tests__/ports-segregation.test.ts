/// <reference types="node" />
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Structural guard for the segregate-storage-ports change (design.md Testing
 * Strategy row 3). Mirrors purity.test.ts's house pattern: readFileSync +
 * regex over the source, `expect(violations).toEqual([])`.
 *
 * Locks the shape of the named `*Port` interfaces whose members sum to
 * exactly EXPECTED_TOTAL_MEMBERS (methods + the 1 `capabilities` property), no member name
 * duplicated across ports, and `StorageAdapter` declared as `export type`
 * (the intersection alias), never `export interface`.
 *
 * IMPORTANT — expected to be RED until task 1.8 lands (a later PR in this
 * stacked chain). This PR (PR1, tasks 1.1-1.3) only extracts Port Map rows
 * 1-8 (SessionPort..DecisionPort) as new, additive interfaces; the other 31
 * named ports do not exist yet, and `StorageAdapter` is still the pre-existing
 * flat `export interface`, not yet the intersection `export type`. Assertions
 * (b), (c)(partially), and (d) will only go GREEN once all 39 ports exist and
 * task 1.8 replaces the flat interface with the alias.
 */

const PORTS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "ports.ts");

/**
 * Locked constant per design.md's "Count correction" section: 221 methods + 1
 * `capabilities` property, +1 for `RecallPort.getRecallPrecision` added by
 * harden-hooks-and-measure-precision (Slice 4, A2-read, Requirement 5/6), +1
 * for `RecallPort.recallableCandidates?` added by make-primitives-recallable
 * (PR3 — Phase 5, design.md D4/Interfaces) — both deliberate, in-scope
 * read-only port additions, not structural regressions. +1 for
 * `ReminderPort.listDueReminderWorkspaceIds`, the reminder poller's discovery
 * through a SECURITY DEFINER function (migration 0042).
 * +1 for `SessionPort.recordCollapseFailure?`, which keeps a failed collapse
 * retryable instead of closing the session.
 * +1 for `RecallPort.getUnresolvedConflictIds?`, which lets recall mark a hit
 * `contested` (WP-3, AGENTSIM-4).
 * +1 for `SessionPort.commitSessionCollapse?` (LIFECYCLE-7/8), the ordinary
 * collapse's single-winner, all-or-nothing commit.
 * +1 for `ReminderPort.claimUndeliveredReminders?` (LIFECYCLE-6), which lets
 * a recall deliver what the poller fired, once.
 * +1 for `FactPort.findLiveFactByStatement?` (WP-5, CHAOS-7): the loser of a
 * dedup-index race re-reads the winner instead of failing the write.
 * +1 for `EntityPort.supersedeEntity` (WP-6 / PRIM-2): close + successor +
 * lineage in one transaction. +1 for `DecisionPort.supersedeDecision` (WP-6 /
 * PRIM-18): validate both decisions, close the predecessor and record lineage
 * in one transaction.
 * +1 for `FactPort.findFactByImportedId?`, POST /import's whole-workspace
 * idempotency lookup (PRIM-15).
 * +2 for `DecisionPort.createDecisionUnlessDuplicate?` and
 * `StrategyPort.createStrategyUnlessDuplicate?` (PRIM-18): the atomic
 * exact-repeat-or-insert remember() uses when no topicKey is given.
 * +1 for `RecallPort.recordRecallObservation?`: one recall request and its
 * final ordered hits, written atomically (recall observability, 0058).
 * +2 for `RecallPort.getRecallLatency` and `RecallPort.getWritesPerDay`, the
 * dashboard stats' latency percentiles and daily-writes series.
 * +1 for `GraphPort.countEntityMentions`: the ceiling-aware mention count every
 * /entities response carries (the stored column was never maintained).
 * +1 for `GraphPort.findHiddenIds`: routes drop id pointers (linkedMemoryIds,
 * mergedIntoId, canonicalId, supersededById…) to rows above the ceiling.
 * +1 for `GraphPort.countOpenConflicts`: GET /conflicts' total and /admin/stats'
 * conflict count, one ceiling-aware COUNT.
 * +2 for `RecallPort.getRecallMetrics` and `RecallPort.getFactStats`, the
 * dashboard's recall-per-day and live-fact breakdown aggregates.
 * +1 for `SessionPort.getSessionStats`, the Sessions room's window aggregate.
 * +1 for `AuditPort.getAuditActivity`, members' last activity and the account's own.
 * +1 for `WorkspacePort.getHealthSnapshots`, the Health room's 30-day history.
 * +1 for `WorkspacePort.getAuditFeedStats`, the Audit room's undo log per day.
 * +1 for `RecallPort.federatedRecallCandidates?`, the items a federation sync
 * pulled, as a recall source.
 * +1 for `queryDeletedFactsPage?`, the hard-deleted facts federation serves as
 * tombstones (0068).
 * +1 for `EmbeddingMaintenancePort.getEmbeddingSourceSensitivity?`, the tier the
 * outbox worker re-reads before embedding a text-form job (SECURITY.md §7).
 * +2 for `federationServeMark?` and `raiseFederationServeMark?`, what the items
 * endpoint served each peer, which bounds its tombstones (0070).
 * +1 for `getContextEconomy?`, the served-context figures of GET /admin/stats
 * (APP-015).
 */
const EXPECTED_TOTAL_MEMBERS = 277;
const EXPECTED_PORT_INTERFACE_COUNT = 43;

function readPortsSource(): string {
  return readFileSync(PORTS_FILE, "utf8");
}

/**
 * Splits ports.ts into one block per `export interface *Port { ... }`
 * declaration, matched by brace-depth so nested object-literal braces inside
 * method signatures don't terminate the block early.
 */
function extractPortInterfaceBlocks(source: string): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = [];
  const headerRe = /export interface (\w+Port) \{/g;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(source)) !== null) {
    const name = match[1];
    const bodyStart = match.index + match[0].length;
    let depth = 1;
    let i = bodyStart;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    const body = source.slice(bodyStart, i - 1);
    blocks.push({ name, body });
  }
  return blocks;
}

/**
 * Counts top-level members (methods + properties) in an interface body by
 * counting semicolons that close a member signature at brace-depth 0 and
 * paren-depth 0 — i.e. statement terminators, not ones nested inside a
 * method's parameter object type or return type.
 */
function countMembers(body: string): number {
  let depth = 0;
  let parenDepth = 0;
  let count = 0;
  let inBlockComment = false;
  let inLineComment = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const next = body[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === ";" && depth === 0 && parenDepth === 0) count++;
  }
  return count;
}

/**
 * Splits an interface body into one chunk per TOP-LEVEL member (methods +
 * properties), using the same brace/paren-depth tracking as `countMembers` so
 * a member's own multi-line parameter object type or return type is never
 * mistaken for a sibling top-level member.
 */
function splitTopLevelMembers(body: string): string[] {
  const chunks: string[] = [];
  let depth = 0;
  let parenDepth = 0;
  let inBlockComment = false;
  let inLineComment = false;
  let chunkStart = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const next = body[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === "(") parenDepth++;
    else if (ch === ")") parenDepth--;
    else if (ch === ";" && depth === 0 && parenDepth === 0) {
      chunks.push(body.slice(chunkStart, i));
      chunkStart = i + 1;
    }
  }
  return chunks;
}

/**
 * Extracts member NAMES from an interface body (method names and property
 * names), ignoring comments. Each top-level member chunk (split by
 * `splitTopLevelMembers`) yields at most one name — the identifier at its
 * start, optionally preceded by `readonly`, followed by `(` (method) or
 * `:`/`?:` (property). Used for the no-duplicate-member-name check.
 */
function extractMemberNames(body: string): string[] {
  const names: string[] = [];
  const memberRe = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[:(]/;
  for (const rawChunk of splitTopLevelMembers(body)) {
    const chunk = rawChunk.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const match = memberRe.exec(chunk);
    if (match) names.push(match[1]);
  }
  return names;
}

describe("ports.ts structural segregation guard (segregate-storage-ports)", () => {
  it("declares the expected named *Port interfaces plus the StorageAdapter alias", () => {
    const source = readPortsSource();
    const portInterfaceHeaders = source.match(/export interface \w+Port \{/g) ?? [];
    const storageAdapterAliasDecl = /export type StorageAdapter\s*=/.test(source);

    const violations: string[] = [];
    if (portInterfaceHeaders.length !== EXPECTED_PORT_INTERFACE_COUNT) {
      violations.push(
        `expected ${EXPECTED_PORT_INTERFACE_COUNT} "export interface *Port {" declarations, found ${portInterfaceHeaders.length}`
      );
    }
    if (!storageAdapterAliasDecl) {
      violations.push(
        `expected "export type StorageAdapter = ...;" intersection alias declaration, not found`
      );
    }
    expect(violations).toEqual([]);
  });

  it("sums to exactly EXPECTED_TOTAL_MEMBERS across all *Port interfaces", () => {
    const source = readPortsSource();
    const blocks = extractPortInterfaceBlocks(source);
    const total = blocks.reduce((sum, b) => sum + countMembers(b.body), 0);
    expect(total).toBe(EXPECTED_TOTAL_MEMBERS);
  });

  it("has no member name duplicated across two or more *Port interfaces", () => {
    const source = readPortsSource();
    const blocks = extractPortInterfaceBlocks(source);
    const ownerOf = new Map<string, string>();
    const violations: string[] = [];
    for (const block of blocks) {
      for (const name of extractMemberNames(block.body)) {
        const existingOwner = ownerOf.get(name);
        if (existingOwner && existingOwner !== block.name) {
          violations.push(`member "${name}" appears in both ${existingOwner} and ${block.name}`);
        } else if (!existingOwner) {
          ownerOf.set(name, block.name);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("declares StorageAdapter with export type, never export interface", () => {
    const source = readPortsSource();
    const violations: string[] = [];
    if (/export interface StorageAdapter\s*\{/.test(source)) {
      violations.push(
        `"export interface StorageAdapter {" still present — must be replaced by "export type StorageAdapter = ...;" (task 1.8)`
      );
    }
    if (!/export type StorageAdapter\s*=/.test(source)) {
      violations.push(`"export type StorageAdapter = ...;" not found`);
    }
    expect(violations).toEqual([]);
  });

  it("requires session storage to return the authoritative appended turn index", () => {
    const source = readPortsSource();
    const sessionPort = extractPortInterfaceBlocks(source).find(
      (block) => block.name === "SessionPort"
    );

    expect(sessionPort?.body).toMatch(
      /appendTurn\([\s\S]*?turn: Omit<SessionTurn, "id" \| "createdAt">[\s\S]*?\): Promise<number>;/
    );
  });
});
