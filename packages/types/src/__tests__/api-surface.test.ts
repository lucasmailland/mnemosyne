/**
 * W4: API surface snapshot — freeze gate for @mnemo-ai/types runtime exports.
 *
 * Only two runtime (non-erased) value exports exist in this package:
 *   - MNEMO_SPAN_NAMES  — canonical OTel span name constants
 *   - MNEMO_ERROR_CODES — canonical error code constants
 *
 * This test locks the public surface so accidental renames or value changes
 * are caught before release.
 */
import { describe, it, expect } from "vitest";
import { MNEMO_SPAN_NAMES, MNEMO_ERROR_CODES } from "../observability.js";

// ─── MNEMO_SPAN_NAMES — canonical OTel span names ────────────────────────────

describe("MNEMO_SPAN_NAMES — canonical OTel span name values (spec §22)", () => {
  it("recall span: 'mnemo.recall'", () => {
    expect(MNEMO_SPAN_NAMES.recall).toBe("mnemo.recall");
  });

  it("remember span: 'mnemo.remember'", () => {
    expect(MNEMO_SPAN_NAMES.remember).toBe("mnemo.remember");
  });

  it("write span is an alias of remember (spec calls it mnemo.write, emitted as mnemo.remember)", () => {
    expect(MNEMO_SPAN_NAMES.write).toBe("mnemo.remember");
  });

  it("sessionCollapse span: 'mnemo.session.collapse'", () => {
    expect(MNEMO_SPAN_NAMES.sessionCollapse).toBe("mnemo.session.collapse");
  });

  it("reasoningResolve span: 'mnemo.reasoning.resolve'", () => {
    expect(MNEMO_SPAN_NAMES.reasoningResolve).toBe("mnemo.reasoning.resolve");
  });

  it("federationSync span: 'mnemo.federation.sync'", () => {
    expect(MNEMO_SPAN_NAMES.federationSync).toBe("mnemo.federation.sync");
  });

  it("auth span: 'mnemo.auth'", () => {
    expect(MNEMO_SPAN_NAMES.auth).toBe("mnemo.auth");
  });

  it("embed span: 'mnemo.embed'", () => {
    expect(MNEMO_SPAN_NAMES.embed).toBe("mnemo.embed");
  });

  it("rerank span: 'mnemo.rerank'", () => {
    expect(MNEMO_SPAN_NAMES.rerank).toBe("mnemo.rerank");
  });

  it("composition span: 'mnemo.composition'", () => {
    expect(MNEMO_SPAN_NAMES.composition).toBe("mnemo.composition");
  });

  it("render span: 'mnemo.render'", () => {
    expect(MNEMO_SPAN_NAMES.render).toBe("mnemo.render");
  });

  it("plugin span factory: (name) => 'mnemo.plugin.{name}'", () => {
    expect(MNEMO_SPAN_NAMES.plugin("my-plugin")).toBe("mnemo.plugin.my-plugin");
    expect(MNEMO_SPAN_NAMES.plugin("auth")).toBe("mnemo.plugin.auth");
  });

  it("all string-valued spans follow the 'mnemo.' prefix convention", () => {
    const { plugin: _fn, ...stringSpans } = MNEMO_SPAN_NAMES;
    for (const [key, value] of Object.entries(stringSpans)) {
      expect(value, `span '${key}'`).toMatch(/^mnemo\./);
    }
  });
});

// ─── MNEMO_ERROR_CODES — canonical error code values ─────────────────────────

describe("MNEMO_ERROR_CODES — canonical error code values (spec §22)", () => {
  // Storage
  it("STORAGE_NOT_FOUND: 'mnemo.storage.not_found'", () => {
    expect(MNEMO_ERROR_CODES.STORAGE_NOT_FOUND).toBe("mnemo.storage.not_found");
  });

  it("STORAGE_CONFLICT: 'mnemo.storage.conflict'", () => {
    expect(MNEMO_ERROR_CODES.STORAGE_CONFLICT).toBe("mnemo.storage.conflict");
  });

  it("STORAGE_CONSTRAINT: 'mnemo.storage.constraint_violation'", () => {
    expect(MNEMO_ERROR_CODES.STORAGE_CONSTRAINT).toBe("mnemo.storage.constraint_violation");
  });

  it("STORAGE_TIMEOUT: 'mnemo.storage.timeout'", () => {
    expect(MNEMO_ERROR_CODES.STORAGE_TIMEOUT).toBe("mnemo.storage.timeout");
  });

  // Auth
  it("AUTH_MISSING_KEY: 'mnemo.auth.missing_key'", () => {
    expect(MNEMO_ERROR_CODES.AUTH_MISSING_KEY).toBe("mnemo.auth.missing_key");
  });

  it("AUTH_EXPIRED_KEY: 'mnemo.auth.expired_key'", () => {
    expect(MNEMO_ERROR_CODES.AUTH_EXPIRED_KEY).toBe("mnemo.auth.expired_key");
  });

  it("AUTH_INSUFFICIENT_SCOPE: 'mnemo.auth.insufficient_scope'", () => {
    expect(MNEMO_ERROR_CODES.AUTH_INSUFFICIENT_SCOPE).toBe("mnemo.auth.insufficient_scope");
  });

  it("AUTH_WORKSPACE_MISMATCH: 'mnemo.auth.workspace_mismatch'", () => {
    expect(MNEMO_ERROR_CODES.AUTH_WORKSPACE_MISMATCH).toBe("mnemo.auth.workspace_mismatch");
  });

  // Recall
  it("RECALL_BUDGET_EXCEEDED: 'mnemo.recall.budget_exceeded'", () => {
    expect(MNEMO_ERROR_CODES.RECALL_BUDGET_EXCEEDED).toBe("mnemo.recall.budget_exceeded");
  });

  it("RECALL_VECTOR_MISSING: 'mnemo.recall.vector_missing'", () => {
    expect(MNEMO_ERROR_CODES.RECALL_VECTOR_MISSING).toBe("mnemo.recall.vector_missing");
  });

  it("RECALL_UPSTREAM_TIMEOUT: 'mnemo.recall.upstream_timeout'", () => {
    expect(MNEMO_ERROR_CODES.RECALL_UPSTREAM_TIMEOUT).toBe("mnemo.recall.upstream_timeout");
  });

  // Composition
  it("COMPOSE_DSL_INVALID: 'mnemo.compose.dsl_invalid'", () => {
    expect(MNEMO_ERROR_CODES.COMPOSE_DSL_INVALID).toBe("mnemo.compose.dsl_invalid");
  });

  it("COMPOSE_MAX_FIRINGS: 'mnemo.compose.max_firings_reached'", () => {
    expect(MNEMO_ERROR_CODES.COMPOSE_MAX_FIRINGS).toBe("mnemo.compose.max_firings_reached");
  });

  it("COMPOSE_MATERIALISE_FAIL: 'mnemo.compose.materialise_failed'", () => {
    expect(MNEMO_ERROR_CODES.COMPOSE_MATERIALISE_FAIL).toBe("mnemo.compose.materialise_failed");
  });

  // Self-edit
  it("SELF_EDIT_BUDGET: 'mnemo.self_edit.budget_exceeded'", () => {
    expect(MNEMO_ERROR_CODES.SELF_EDIT_BUDGET).toBe("mnemo.self_edit.budget_exceeded");
  });

  it("SELF_EDIT_COOLDOWN: 'mnemo.self_edit.cooldown_active'", () => {
    expect(MNEMO_ERROR_CODES.SELF_EDIT_COOLDOWN).toBe("mnemo.self_edit.cooldown_active");
  });

  it("SELF_EDIT_SCOPE: 'mnemo.self_edit.scope_denied'", () => {
    expect(MNEMO_ERROR_CODES.SELF_EDIT_SCOPE).toBe("mnemo.self_edit.scope_denied");
  });

  it("SELF_EDIT_ABUSE_FLAG: 'mnemo.self_edit.abuse_flagged'", () => {
    expect(MNEMO_ERROR_CODES.SELF_EDIT_ABUSE_FLAG).toBe("mnemo.self_edit.abuse_flagged");
  });

  it("SELF_EDIT_WORTH_FROZEN: 'mnemo.self_edit.worth_frozen'", () => {
    expect(MNEMO_ERROR_CODES.SELF_EDIT_WORTH_FROZEN).toBe("mnemo.self_edit.worth_frozen");
  });

  // Federation
  it("FED_SIGNATURE_INVALID: 'mnemo.federation.signature_invalid'", () => {
    expect(MNEMO_ERROR_CODES.FED_SIGNATURE_INVALID).toBe("mnemo.federation.signature_invalid");
  });

  it("FED_VERSION_SKEW: 'mnemo.federation.version_skew'", () => {
    expect(MNEMO_ERROR_CODES.FED_VERSION_SKEW).toBe("mnemo.federation.version_skew");
  });

  it("FED_QUORUM_UNREACHABLE: 'mnemo.federation.quorum_unreachable'", () => {
    expect(MNEMO_ERROR_CODES.FED_QUORUM_UNREACHABLE).toBe("mnemo.federation.quorum_unreachable");
  });

  // Procedural
  it("PROC_BUDGET_BELOW_GATE: 'mnemo.procedural.budget_below_gate'", () => {
    expect(MNEMO_ERROR_CODES.PROC_BUDGET_BELOW_GATE).toBe("mnemo.procedural.budget_below_gate");
  });

  it("PROC_NO_TRAJECTORIES: 'mnemo.procedural.no_trajectories'", () => {
    expect(MNEMO_ERROR_CODES.PROC_NO_TRAJECTORIES).toBe("mnemo.procedural.no_trajectories");
  });

  // General
  it("RATE_LIMIT: 'mnemo.rate_limit'", () => {
    expect(MNEMO_ERROR_CODES.RATE_LIMIT).toBe("mnemo.rate_limit");
  });

  it("VALIDATION: 'mnemo.validation'", () => {
    expect(MNEMO_ERROR_CODES.VALIDATION).toBe("mnemo.validation");
  });

  it("INTERNAL: 'mnemo.internal'", () => {
    expect(MNEMO_ERROR_CODES.INTERNAL).toBe("mnemo.internal");
  });

  it("all error codes follow the 'mnemo.' prefix convention", () => {
    for (const [key, value] of Object.entries(MNEMO_ERROR_CODES)) {
      expect(value, `error code '${key}'`).toMatch(/^mnemo\./);
    }
  });
});
