/**
 * Q-3 (end-to-end verification of the eval fixes) — the fact subtype list.
 *
 * WP-5 turned an unknown fact `subtype` into a 400 (AGENTSIM-8), and 45 of 62
 * writes from an agent following the protocol failed: agents file facts under
 * the decision vocabulary. The six of those values that name a category of
 * fact are fact kinds now; "decision" is not, because recall hydrates a fact
 * whose kind is another primitive's name as that primitive first.
 */
import { describe, expect, it } from "vitest";
import { PRIMITIVE_KINDS, PRIMITIVE_SUBTYPES } from "../primitives.js";

describe("PRIMITIVE_SUBTYPES.fact", () => {
  it("accepts the categories agents file facts under", () => {
    expect(PRIMITIVE_SUBTYPES.fact).toEqual(
      expect.arrayContaining(["architecture", "bugfix", "config", "discovery", "policy", "process"])
    );
  });

  it("keeps every earlier fact kind and the 'other' fallback", () => {
    expect(PRIMITIVE_SUBTYPES.fact).toEqual(
      expect.arrayContaining([
        "preference",
        "trait",
        "event",
        "relationship",
        "skill",
        "concern",
        "other",
      ])
    );
  });

  it("names no primitive kind beyond the two it always shared (event, skill)", () => {
    const shared = PRIMITIVE_SUBTYPES.fact.filter((k) =>
      (PRIMITIVE_KINDS as readonly string[]).includes(k)
    );
    expect(shared.sort()).toEqual(["event", "skill"]);
  });
});
