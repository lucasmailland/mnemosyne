import { describe, it, expect } from "vitest";
import { MNEMO_SPAN_NAMES } from "@mnemo-ai/types";

// Pure unit tests for the MNEMO_SPAN_NAMES constant
describe("MNEMO_SPAN_NAMES", () => {
  it("recall is mnemo.recall", () => {
    expect(MNEMO_SPAN_NAMES.recall).toBe("mnemo.recall");
  });

  it("sessionCollapse is mnemo.session.collapse", () => {
    expect(MNEMO_SPAN_NAMES.sessionCollapse).toBe("mnemo.session.collapse");
  });

  it("reasoningResolve is mnemo.reasoning.resolve", () => {
    expect(MNEMO_SPAN_NAMES.reasoningResolve).toBe("mnemo.reasoning.resolve");
  });

  it("federationSync is mnemo.federation.sync", () => {
    expect(MNEMO_SPAN_NAMES.federationSync).toBe("mnemo.federation.sync");
  });

  it("plugin(name) produces mnemo.plugin.<name>", () => {
    expect(MNEMO_SPAN_NAMES.plugin("github-events")).toBe("mnemo.plugin.github-events");
    expect(MNEMO_SPAN_NAMES.plugin("slack")).toBe("mnemo.plugin.slack");
  });

  it("declares the 5 new domain span names", () => {
    expect(MNEMO_SPAN_NAMES.auth).toBe("mnemo.auth");
    expect(MNEMO_SPAN_NAMES.embed).toBe("mnemo.embed");
    expect(MNEMO_SPAN_NAMES.rerank).toBe("mnemo.rerank");
    expect(MNEMO_SPAN_NAMES.composition).toBe("mnemo.composition");
    expect(MNEMO_SPAN_NAMES.render).toBe("mnemo.render");
  });
});
