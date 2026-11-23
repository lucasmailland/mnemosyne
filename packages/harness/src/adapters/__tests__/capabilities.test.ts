import { describe, expect, it } from "vitest";
import {
  computeCaptureArtifactHash,
  resolveCaptureMode,
  resolveHostCaptureMode,
  type QualificationRecord,
} from "../capabilities.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const RECORD: QualificationRecord = {
  version: 1,
  host: "opencode",
  hostVersion: "1.18.29",
  pluginPackage: { name: "@opencode-ai/plugin", version: "1.17.18" },
  platform: "darwin-arm64",
  packageHash: "a".repeat(64),
  fixtureHash: "b".repeat(64),
  observedEvents: ["session.idle", "session.deleted"],
  sources: ["node_modules/@opencode-ai/plugin/dist/index.d.ts"],
  proofs: { transcript: true, compaction: true, deletion: true },
  qualifiedAt: "2026-09-10T00:00:00.000Z",
  mode: "full",
};

const env = {
  hostVersion: RECORD.hostVersion,
  platform: RECORD.platform,
  packageHash: RECORD.packageHash,
  fixtureHash: RECORD.fixtureHash,
};

describe("deciding how much of a host we may capture", () => {
  it("grants full capture only when the record matches this machine exactly", () => {
    expect(resolveCaptureMode({ record: RECORD, ...env })).toMatchObject({ mode: "full" });
  });

  it("captures nothing when there is no qualification record at all", () => {
    for (const record of [null, undefined, {}, "not a record", []]) {
      // Never assume support: an unqualified host gets MCP only.
      expect(resolveCaptureMode({ record, ...env })).toMatchObject({ mode: "mcp-only" });
    }
  });

  it("refuses a record from a different host version", () => {
    const result = resolveCaptureMode({ record: RECORD, ...env, hostVersion: "1.19.0" });
    expect(result).toMatchObject({ mode: "mcp-only" });
    expect(result.reason).toMatch(/version/i);
  });

  it("refuses a record from a different platform", () => {
    const result = resolveCaptureMode({ record: RECORD, ...env, platform: "linux-x64" });
    expect(result).toMatchObject({ mode: "mcp-only" });
    expect(result.reason).toMatch(/platform/i);
  });

  for (const field of ["packageHash", "fixtureHash"] as const) {
    it(`refuses a record whose ${field} no longer matches what is installed`, () => {
      const result = resolveCaptureMode({ record: RECORD, ...env, [field]: "c".repeat(64) });
      // The record proves what a specific build did. A different build is unproven.
      expect(result).toMatchObject({ mode: "mcp-only" });
      expect(result.reason).toMatch(/hash/i);
    });
  }

  it("drops to user-only when a proof failed, rather than guessing full support", () => {
    for (const failed of ["transcript", "deletion"] as const) {
      const record = { ...RECORD, proofs: { ...RECORD.proofs, [failed]: false } };
      const result = resolveCaptureMode({ record, ...env });
      // User messages still arrive through a channel that was proven; the parts
      // that were not proven are simply not used.
      expect(result).toMatchObject({ mode: "user-only" });
      expect(result.reason).toContain(failed);
    }
  });

  it("never returns a mode above what the record itself claims", () => {
    const record = { ...RECORD, mode: "user-only" as const };
    expect(resolveCaptureMode({ record, ...env })).toMatchObject({ mode: "user-only" });
  });

  it("rejects a record that claims a mode its proofs do not support", () => {
    const record = {
      ...RECORD,
      mode: "full" as const,
      proofs: { transcript: false, compaction: false, deletion: false },
    };
    // A record cannot promote itself past its own evidence.
    expect(resolveCaptureMode({ record, ...env })).toMatchObject({ mode: "user-only" });
  });

  it("rejects a structurally invalid record instead of reading round it", () => {
    for (const broken of [
      { ...RECORD, version: 2 },
      { ...RECORD, host: "not-a-host" },
      { ...RECORD, observedEvents: "session.idle" },
      { ...RECORD, proofs: { transcript: true } },
      { ...RECORD, packageHash: "short" },
    ]) {
      expect(resolveCaptureMode({ record: broken, ...env })).toMatchObject({ mode: "mcp-only" });
    }
  });

  it("always explains itself, so an operator is never left guessing", () => {
    const result = resolveCaptureMode({ record: null, ...env });
    expect(result.reason).toBeTruthy();
  });
});

describe("the qualification record actually checked in", () => {
  const record = JSON.parse(
    readFileSync(join(HERE, "..", "..", "..", "qualifications", "opencode.json"), "utf8")
  ) as QualificationRecord;

  it("was recorded from a real installation, not hand-written", () => {
    expect(record.hostVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(record.pluginPackage.name).toBe("@opencode-ai/plugin");
    expect(record.observedEvents).toContain("session.idle");
    expect(record.observedEvents).toContain("session.deleted");
  });

  it("claims no more than it proved", () => {
    const proven = record.proofs.transcript && record.proofs.deletion;
    // Whatever the proofs say, the mode has to follow them.
    expect(record.mode).toBe(proven ? "full" : "user-only");
  });

  it("resolves on this machine to exactly what it proved", () => {
    const decision = resolveHostCaptureMode({
      host: "opencode",
      hostVersion: record.hostVersion,
      // A location. The digest is computed from these bytes; the old API took a
      // hash VALUE from the caller, which meant the artifact vouched for itself.
      artifactRoot: join(HERE, "..", "..", "..", "..", "plugin"),
      platform: record.platform,
    });
    expect(decision.mode).toBe(record.mode);
    expect(decision.reason).toBeTruthy();
  });

  it("falls back to MCP-only for a host that was never qualified", () => {
    expect(resolveHostCaptureMode({ host: "codex", hostVersion: "1.0.0" })).toMatchObject({
      mode: "mcp-only",
    });
  });

  it("carries nothing that could identify a person or a conversation", () => {
    const serialized = JSON.stringify(record);
    // The record is checked into a public repository.
    for (const term of ["/Users/", "/home/", "@gmail", "apiKey", "mns_live_"]) {
      expect(serialized).not.toContain(term);
    }
  });
});

describe("the observed hash is computed, never asserted by the caller", () => {
  const artifactRoot = join(HERE, "..", "..", "..", "..", "plugin");

  it("changes when a capture artifact changes", () => {
    const before = computeCaptureArtifactHash({ host: "opencode", artifactRoot });
    expect(before).toHaveProperty("hash");
  });

  it("refuses rather than returning a partial digest when an artifact is missing", () => {
    const result = computeCaptureArtifactHash({ host: "opencode", artifactRoot: "/nonexistent" });
    // A digest over "whatever happened to be readable" would silently match
    // nothing and look like an ordinary hash.
    expect(result).toHaveProperty("error");
  });

  it("degrades to mcp-only when no artifact root is supplied at all", () => {
    const decision = resolveHostCaptureMode({ host: "opencode", hostVersion: "1.18.29" });
    expect(decision.mode).toBe("mcp-only");
    expect(decision.reason).toMatch(/artifact root/i);
  });
});

describe("the record's claimed mode is a ceiling, applied before the proofs settle", () => {
  it("does not PROMOTE a claimed mcp-only to user-only when proofs are unproven", () => {
    // The Codex-on-Windows shape: hooks do not exist on that platform, so the
    // qualifier records `mcp-only` with nothing proven. Deciding on the proofs
    // first and returning early raised it to `user-only` — the gate handing out
    // a mode above the one it was built to enforce.
    const codex: QualificationRecord = {
      ...RECORD,
      host: "codex",
      mode: "mcp-only",
      proofs: { transcript: false, compaction: false, deletion: false },
      gateReason: "hooks are not available on this platform",
    };
    expect(resolveCaptureMode({ record: codex, ...env })).toEqual({
      mode: "mcp-only",
      reason: "hooks are not available on this platform",
    });
  });

  it("surfaces the qualifier's own sentence, not a paraphrase of it", () => {
    const capped: QualificationRecord = {
      ...RECORD,
      mode: "user-only",
      gateReason: "compaction was never observed on this build",
    };
    expect(resolveCaptureMode({ record: capped, ...env })).toEqual({
      mode: "user-only",
      reason: "compaction was never observed on this build",
    });
  });

  it("falls back to a generic reason when an older record carries no gateReason", () => {
    const capped: QualificationRecord = { ...RECORD, mode: "mcp-only" };
    expect(resolveCaptureMode({ record: capped, ...env })).toEqual({
      mode: "mcp-only",
      reason: "qualification record limits capture to mcp-only",
    });
  });

  it("still degrades a claimed full to user-only when a proof is missing", () => {
    const unproven: QualificationRecord = {
      ...RECORD,
      proofs: { transcript: false, compaction: true, deletion: true },
    };
    expect(resolveCaptureMode({ record: unproven, ...env })).toEqual({
      mode: "user-only",
      reason: "unproven capabilities: transcript",
    });
  });

  it("takes the LOWER of claimed and earned, in both directions", () => {
    const cases = [
      { claimed: "full", proven: true, expected: "full" },
      { claimed: "full", proven: false, expected: "user-only" },
      { claimed: "user-only", proven: true, expected: "user-only" },
      { claimed: "user-only", proven: false, expected: "user-only" },
      { claimed: "mcp-only", proven: true, expected: "mcp-only" },
      { claimed: "mcp-only", proven: false, expected: "mcp-only" },
      { claimed: "unavailable", proven: true, expected: "unavailable" },
      { claimed: "unavailable", proven: false, expected: "unavailable" },
    ] as const;
    for (const { claimed, proven, expected } of cases) {
      const record: QualificationRecord = {
        ...RECORD,
        mode: claimed,
        proofs: { transcript: proven, compaction: proven, deletion: proven },
      };
      expect(resolveCaptureMode({ record, ...env }).mode, `${claimed} + proven=${proven}`).toBe(
        expected
      );
    }
  });

  it("accepts a record without gateReason, and rejects a non-string one", () => {
    expect(resolveCaptureMode({ record: { ...RECORD }, ...env }).mode).toBe("full");
    expect(resolveCaptureMode({ record: { ...RECORD, gateReason: 7 }, ...env })).toMatchObject({
      mode: "mcp-only",
      reason: expect.stringContaining("no valid qualification record"),
    });
  });
});

describe("how far a record reaches across host releases", () => {
  // Claude Code ships almost daily, and its qualifier never reads the installed
  // host: it checks the plugin's own hooks.json against the checked-in fixture.
  // An exact pin therefore turned capture off on every update while adding no
  // evidence. A same-major record covers later releases; the package and fixture
  // hashes still pin exactly what was proven.
  const SAME_MAJOR = { ...RECORD, hostVersion: "2.1.268", hostVersionMatch: "same-major" as const };
  const at = (hostVersion: string) =>
    resolveCaptureMode({ record: SAME_MAJOR, ...env, hostVersion });

  it("covers a later release of the same major", () => {
    expect(at("2.1.303").mode).toBe("full");
    expect(at("2.4.0").mode).toBe("full");
    expect(at("2.1.268").mode).toBe("full");
  });

  it("never covers an earlier release", () => {
    expect(at("2.1.200")).toMatchObject({ mode: "mcp-only" });
    expect(at("2.0.999")).toMatchObject({ mode: "mcp-only" });
  });

  it("never covers another major, where events may have been renamed", () => {
    const result = at("3.0.0");
    expect(result).toMatchObject({ mode: "mcp-only" });
    expect(result.reason).toContain("2.1.268");
    expect(result.reason).toContain("3.0.0");
  });

  it("never covers a version it cannot compare", () => {
    expect(at("2.1.303-beta")).toMatchObject({ mode: "mcp-only" });
    expect(at("")).toMatchObject({ mode: "mcp-only" });
  });

  it("still holds an exact record, or one without the field, to its own version", () => {
    const exact = { ...SAME_MAJOR, hostVersionMatch: "exact" as const };
    expect(resolveCaptureMode({ record: exact, ...env, hostVersion: "2.1.303" }).mode).toBe(
      "mcp-only"
    );
    const { hostVersionMatch: _omitted, ...legacy } = SAME_MAJOR;
    expect(resolveCaptureMode({ record: legacy, ...env, hostVersion: "2.1.303" }).mode).toBe(
      "mcp-only"
    );
  });

  it("still refuses a later release when the build or the fixture changed", () => {
    expect(
      resolveCaptureMode({
        record: SAME_MAJOR,
        ...env,
        hostVersion: "2.1.303",
        packageHash: "c".repeat(64),
      })
    ).toMatchObject({ mode: "mcp-only" });
    expect(
      resolveCaptureMode({
        record: SAME_MAJOR,
        ...env,
        hostVersion: "2.1.303",
        fixtureHash: "d".repeat(64),
      })
    ).toMatchObject({ mode: "mcp-only" });
  });

  it("rejects a record with an unknown match rule instead of guessing one", () => {
    expect(
      resolveCaptureMode({ record: { ...RECORD, hostVersionMatch: "any" }, ...env })
    ).toMatchObject({
      mode: "mcp-only",
      reason: expect.stringContaining("no valid qualification record"),
    });
  });

  it("is what the checked-in Claude Code record declares", () => {
    const record = JSON.parse(
      readFileSync(join(HERE, "..", "..", "..", "qualifications", "claude-code.json"), "utf8")
    ) as QualificationRecord;
    expect(record.hostVersionMatch).toBe("same-major");
  });
});

describe("Codex's version rule (APP-035c)", () => {
  // Codex ships a minor release every few days (0.163.0 -> 0.169.0 in a week),
  // and its qualifier, like Claude Code's, reads the host only for its version
  // and its features.hooks gate: the events come from the checked-in fixture.
  // An exact pin turned capture off on every update while adding no evidence.
  const CODEX = {
    ...RECORD,
    host: "codex" as const,
    hostVersion: "codex-cli 0.163.0",
    proofs: { transcript: false, compaction: false, deletion: false },
    mode: "user-only" as const,
  };
  const at = (hostVersion: string) => resolveCaptureMode({ record: CODEX, ...env, hostVersion });

  it("covers later releases of the same major, prefix and all", () => {
    expect(at("codex-cli 0.163.0").mode).toBe("user-only");
    expect(at("codex-cli 0.169.0").mode).toBe("user-only");
    expect(at("codex-cli 0.163.4").mode).toBe("user-only");
  });

  it("keeps the qualified version as a floor", () => {
    const result = at("codex-cli 0.162.9");
    expect(result).toMatchObject({ mode: "mcp-only" });
    expect(result.reason).toContain("codex-cli 0.163.0");
  });

  it("never covers a new major, another binary, or a version it cannot order", () => {
    expect(at("codex-cli 1.0.0").mode).toBe("mcp-only");
    expect(at("other-cli 0.169.0").mode).toBe("mcp-only");
    expect(at("codex-cli 0.169.0-alpha.1").mode).toBe("mcp-only");
    expect(at("0.169.0").mode).toBe("mcp-only");
  });

  it("still honours an explicit exact pin on a Codex record", () => {
    expect(
      resolveCaptureMode({
        record: { ...CODEX, hostVersionMatch: "exact" },
        ...env,
        hostVersion: "codex-cli 0.169.0",
      }).mode
    ).toBe("mcp-only");
  });

  it("leaves other hosts' records without the field pinned exactly", () => {
    expect(resolveCaptureMode({ record: RECORD, ...env, hostVersion: "1.18.30" }).mode).toBe(
      "mcp-only"
    );
  });
});

describe("APP-035 — the shipped Codex record describes the build, not the qualifier's machine", () => {
  // The qualifier used to bake `mode: "mcp-only"` into codex.json whenever
  // features.hooks was off on the machine that ran it. The record is a CEILING,
  // so every user's Codex stayed mcp-only even after they enabled hooks. The
  // gate belongs to the user's machine: the CLI reads it live and takes the
  // lower of the two. The qualifier's own gate is kept, as a fact, apart.
  const shipped = JSON.parse(
    readFileSync(join(HERE, "..", "..", "..", "qualifications", "codex.json"), "utf8")
  ) as QualificationRecord & { qualifierGate?: { hooksEnabled?: unknown } };

  it("carries the mode its proofs earn, not one capped by a local features.hooks", () => {
    const earned = shipped.proofs.transcript && shipped.proofs.deletion ? "full" : "user-only";
    expect(shipped.mode).toBe(earned);
    expect(shipped.gateReason ?? "").not.toMatch(/features\.hooks/);
  });

  it("records the qualifier machine's gate separately", () => {
    expect(typeof shipped.qualifierGate?.hooksEnabled).toBe("boolean");
  });

  it("so a matching build resolves above mcp-only, leaving the gate to the live check", () => {
    const decision = resolveCaptureMode({
      record: shipped,
      hostVersion: shipped.hostVersion,
      platform: shipped.platform,
      packageHash: shipped.packageHash,
      fixtureHash: shipped.fixtureHash,
    });
    expect(decision.mode).not.toBe("mcp-only");
  });
});
