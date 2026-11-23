/**
 * Unit tests for the passive-capture heuristic extraction (T4).
 *
 * These tests exercise `extractWithHeuristics` and `isNoiseLine` directly —
 * no HTTP stack, no deps. The goal is to verify that the expanded regex
 * patterns correctly classify the new fact types (discovery, architecture,
 * preference) and that the noise filter blocks tool outputs / filler lines.
 */
import { describe, it, expect } from "vitest";

import { extractWithHeuristics, isNoiseLine } from "../routes/capture.js";

// ─── isNoiseLine ─────────────────────────────────────────────────────────────

describe("isNoiseLine", () => {
  it("filters JSON-like lines starting with {", () => {
    expect(isNoiseLine('{ "key": "value" }')).toBe(true);
  });

  it("filters JSON array lines starting with [", () => {
    expect(isNoiseLine('["a", "b"]')).toBe(true);
  });

  it("filters conversational filler — 'ok'", () => {
    expect(isNoiseLine("ok")).toBe(true);
    expect(isNoiseLine("Sure!")).toBe(true);
    expect(isNoiseLine("great.")).toBe(true);
    expect(isNoiseLine("done")).toBe(true);
  });

  it("filters intent statements starting with 'let me'", () => {
    expect(isNoiseLine("Let me check the file")).toBe(true);
  });

  it("filters intent statements with 'I will'", () => {
    expect(isNoiseLine("I will now run the migration")).toBe(true);
  });

  it("filters intent statements with \"i'll\"", () => {
    expect(isNoiseLine("I'll fix this next")).toBe(true);
  });

  it("does NOT filter a real decision sentence", () => {
    expect(isNoiseLine("We switched to bun because npm was slow")).toBe(false);
  });

  it("does NOT filter a real bugfix sentence", () => {
    expect(isNoiseLine("The crash was caused by a null pointer in the cache layer")).toBe(false);
  });

  it("does NOT filter a discovery sentence", () => {
    expect(isNoiseLine("Turns out pgvector requires the extension to be enabled per-db")).toBe(false);
  });
});

// ─── extractWithHeuristics ────────────────────────────────────────────────────

describe("extractWithHeuristics — decisions", () => {
  it("detects 'decided to'", () => {
    const result = extractWithHeuristics("We decided to use Turborepo for the monorepo build.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("decision");
    expect(result[0].statement).toContain("Turborepo");
  });

  it("detects 'switched to'", () => {
    const result = extractWithHeuristics("The team switched to pnpm workspaces from yarn.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("decision");
  });

  it("detects 'chose'", () => {
    const result = extractWithHeuristics("We chose Postgres over MySQL for its JSONB support.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("decision");
  });

  it("detects 'migrated to'", () => {
    const result = extractWithHeuristics("Project migrated to Vitest from Jest for ESM compatibility.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("decision");
  });

  it("detects 'going with'", () => {
    const result = extractWithHeuristics("Going with drizzle-orm for the query builder layer.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("decision");
  });
});

describe("extractWithHeuristics — bug fixes", () => {
  it("detects 'root cause'", () => {
    const result = extractWithHeuristics("Root cause was a missing await on the async initializer.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("bugfix");
  });

  it("detects 'caused by'", () => {
    const result = extractWithHeuristics("The timeout was caused by unclosed DB connections in tests.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("bugfix");
  });

  it("detects 'fixed'", () => {
    const result = extractWithHeuristics("Fixed the race condition in the session collapse handler.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("bugfix");
  });

  it("detects 'error was'", () => {
    const result = extractWithHeuristics("The error was a schema mismatch between v2 and v3 tables.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("bugfix");
  });

  it("detects 'issue was'", () => {
    const result = extractWithHeuristics("Issue was that RLS bypassed the workspace filter on imports.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("bugfix");
  });
});

describe("extractWithHeuristics — config", () => {
  it("detects config with colon", () => {
    const result = extractWithHeuristics("The server port: 3939 is configured via environment.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
  });

  it("detects env variable with equals", () => {
    const result = extractWithHeuristics("Set the env variable DATABASE_URL=postgres://localhost/mnemo.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
  });

  it("does NOT fire on config-keyword line without assignment", () => {
    // No colon or equals — should not match config
    const result = extractWithHeuristics("The configuration is complex and took a long time to understand.");
    expect(result.filter(f => f.kind === "config")).toHaveLength(0);
  });
});

describe("extractWithHeuristics — discoveries", () => {
  it("detects 'turns out'", () => {
    const result = extractWithHeuristics("Turns out pgvector requires the extension enabled before migration.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("discovery");
  });

  it("detects 'learned'", () => {
    const result = extractWithHeuristics("Learned that Hono middleware runs before route matching.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("discovery");
  });

  it("detects 'discovered'", () => {
    const result = extractWithHeuristics("Discovered the FORCE ROW LEVEL SECURITY flag is required for app_user.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("discovery");
  });

  it("detects 'found out'", () => {
    const result = extractWithHeuristics("Found out that drizzle-orm handles nulls differently than raw postgres.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("discovery");
  });

  it("detects 'gotcha'", () => {
    const result = extractWithHeuristics("Gotcha: FTS5 operators must be escaped in user-provided search queries.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("discovery");
  });

  it("detects 'realized'", () => {
    const result = extractWithHeuristics("Realized the bitemporal model requires both valid_from and created_at.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("discovery");
  });
});

describe("extractWithHeuristics — architecture", () => {
  it("detects 'pattern uses'", () => {
    const result = extractWithHeuristics("The project uses the hexagonal architecture pattern for core isolation.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("architecture");
  });

  it("detects 'convention follows'", () => {
    const result = extractWithHeuristics("The convention follows domain-driven design with port interfaces.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("architecture");
  });

  it("detects 'design requires'", () => {
    const result = extractWithHeuristics("The design requires all adapters to be injected via CoreContext.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("architecture");
  });

  it("does NOT match 'pattern' without a structural verb", () => {
    // Should not produce architecture for a sentence that just mentions 'pattern'
    const result = extractWithHeuristics("The pattern looks interesting but I am not sure about it yet.");
    expect(result.filter(f => f.kind === "architecture")).toHaveLength(0);
  });
});

describe("extractWithHeuristics — preferences", () => {
  it("detects user preference with 'prefer'", () => {
    const result = extractWithHeuristics("The user prefers concise commit messages without emoji.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("preference");
  });

  it("detects team preference with 'always'", () => {
    const result = extractWithHeuristics("The team always runs pnpm typecheck before pushing to main.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("preference");
  });

  it("detects project constraint with 'must not'", () => {
    const result = extractWithHeuristics("The project must not import drizzle-orm inside packages/core/src/v3.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("preference");
  });

  it("does NOT match preference without a named subject", () => {
    // 'prefer' without user/pablo/team/project — should not fire
    const result = extractWithHeuristics("We prefer using plain objects over class instances here.");
    expect(result.filter(f => f.kind === "preference")).toHaveLength(0);
  });
});

describe("extractWithHeuristics — noise filtering", () => {
  it("does not extract from JSON blobs", () => {
    const json = '{ "key": "value", "nested": { "a": 1 } }';
    expect(extractWithHeuristics(json)).toHaveLength(0);
  });

  it("does not extract from intent statements ('let me check')", () => {
    const result = extractWithHeuristics("Let me check if the migration has already been applied.");
    expect(result).toHaveLength(0);
  });

  it("does not extract from 'I will do X'", () => {
    const result = extractWithHeuristics("I will now run the test suite and report back.");
    expect(result).toHaveLength(0);
  });

  it("returns empty array for empty-ish input", () => {
    expect(extractWithHeuristics("   ")).toHaveLength(0);
    expect(extractWithHeuristics("ok.")).toHaveLength(0);
  });
});

describe("extractWithHeuristics — cap at 3 facts", () => {
  it("returns at most 3 facts even with many matching lines", () => {
    const content = [
      "We decided to use Vitest for testing.",
      "Learned that Hono middleware fires before route handlers.",
      "The project uses hexagonal architecture and follows port interfaces.",
      "Turns out pgvector requires the extension to be enabled per database.",
      "The team switched to pnpm from yarn for workspace support.",
    ].join("\n");
    const result = extractWithHeuristics(content);
    expect(result.length).toBeLessThanOrEqual(3);
  });
});

describe("extractWithHeuristics — statement length cap", () => {
  it("truncates statements longer than 200 chars (line must be under the 300-char filter)", () => {
    // Line must be < 300 chars (filter upper bound) but > 200 chars (truncation kicks in).
    // "We decided to " = 14 chars; adding 250 'x' chars = 264 total (< 300, > 200).
    const longLine = "We decided to " + "x".repeat(250);
    expect(longLine.length).toBeGreaterThan(200);
    expect(longLine.length).toBeLessThan(300);
    const result = extractWithHeuristics(longLine);
    expect(result).toHaveLength(1);
    expect(result[0].statement.length).toBeLessThanOrEqual(200);
  });
});

// ─── T4 speculative patterns (confidence 0.3) ────────────────────────────────

describe("extractWithHeuristics — URL pattern (confidence 0.3)", () => {
  it("detects an https URL reference", () => {
    const result = extractWithHeuristics("See https://api.example.com/v2/users for the endpoint spec.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("discovery");
    expect(result[0].confidence).toBe(0.3);
    expect(result[0].statement).toContain("URL referenced:");
  });

  it("detects an http URL reference", () => {
    const result = extractWithHeuristics("The old endpoint is http://localhost:3939/health/live for checks.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("discovery");
    expect(result[0].confidence).toBe(0.3);
  });

  it("does NOT match a URL shorter than 10 chars after the protocol", () => {
    // 'https://x.co' — path after :// is 4 chars, under the 10-char minimum
    const result = extractWithHeuristics("Check https://x.co for more information about the topic today.");
    expect(result.filter(f => f.statement.startsWith("URL referenced:"))).toHaveLength(0);
  });

  it("does NOT match a line that is pure JSON (noise filter wins)", () => {
    const result = extractWithHeuristics('{ "url": "https://api.example.com/very/long/path" }');
    expect(result).toHaveLength(0);
  });
});

describe("extractWithHeuristics — shell command pattern (confidence 0.3)", () => {
  it("detects a $ prompt shell command line", () => {
    const result = extractWithHeuristics("$ npm install typescript --save-dev in the project root directory.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
    expect(result[0].confidence).toBe(0.3);
  });

  it("detects a > prompt shell command line", () => {
    const result = extractWithHeuristics("> docker run --rm postgres:16 -e POSTGRES_PASSWORD=secret here.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
    expect(result[0].confidence).toBe(0.3);
  });

  it("detects inline npm install without prompt character", () => {
    const result = extractWithHeuristics("Run npm install vitest to add the test runner to devDependencies.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
    expect(result[0].confidence).toBe(0.3);
  });

  it("detects git commit invocation", () => {
    const result = extractWithHeuristics("Use git commit -m to create a conventional commit message here.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
    expect(result[0].confidence).toBe(0.3);
  });

  it("does NOT match a generic sentence mentioning git without an invocation verb", () => {
    // 'git' appears but is not followed by a word character after whitespace in invocation form
    const result = extractWithHeuristics("The team stores git history in the monorepo for full traceability.");
    expect(result.filter(f => f.kind === "config" && f.confidence === 0.3)).toHaveLength(0);
  });

  it("does NOT match a noise line (intent statement)", () => {
    const result = extractWithHeuristics("Let me run npm install to get the packages set up right now.");
    expect(result).toHaveLength(0);
  });
});

describe("extractWithHeuristics — error type pattern (confidence 0.3)", () => {
  it("detects TypeError", () => {
    const result = extractWithHeuristics("TypeError: Cannot read property 'id' of undefined in auth handler.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("discovery");
    expect(result[0].confidence).toBe(0.3);
    expect(result[0].statement).toContain("Error encountered:");
  });

  it("detects ENOENT", () => {
    const result = extractWithHeuristics("ENOENT: no such file or directory, open '/tmp/missing-file.txt' not found.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("discovery");
    expect(result[0].confidence).toBe(0.3);
  });

  it("detects ECONNREFUSED", () => {
    const result = extractWithHeuristics("ECONNREFUSED: connect ECONNREFUSED 127.0.0.1:5432 postgres down.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("discovery");
    expect(result[0].confidence).toBe(0.3);
  });

  it("does NOT match 'TypeError' mentioned in prose without colon-space", () => {
    const result = extractWithHeuristics("The TypeError pattern happens when you access undefined properties.");
    expect(result.filter(f => f.confidence === 0.3 && f.kind === "discovery")).toHaveLength(0);
  });

  it("does NOT match a noise JSON line containing an error key", () => {
    const result = extractWithHeuristics('{ "error": "TypeError: not found" }');
    expect(result).toHaveLength(0);
  });
});

describe("extractWithHeuristics — port/service pattern (confidence 0.3)", () => {
  it("detects 'running on port N'", () => {
    const result = extractWithHeuristics("Server is running on port 3939 and accepting connections now.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
    expect(result[0].confidence).toBe(0.3);
    expect(result[0].statement).toContain("3939");
  });

  it("detects 'listening on port N'", () => {
    const result = extractWithHeuristics("MCP server is listening on port 8080 for stdio connections.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
    expect(result[0].confidence).toBe(0.3);
  });

  it("detects PORT= assignment", () => {
    const result = extractWithHeuristics("PORT=5000 is what the Kubernetes deployment manifest sets for the container.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
    expect(result[0].confidence).toBe(0.3);
  });

  it("does NOT match a short standalone number without port context", () => {
    const result = extractWithHeuristics("There are 42 items in the backlog queue for this sprint today.");
    expect(result.filter(f => f.confidence === 0.3 && f.kind === "config")).toHaveLength(0);
  });

  it("does NOT match a noise intent line mentioning a port", () => {
    const result = extractWithHeuristics("Let me start the server running on port 3939 right away here.");
    expect(result).toHaveLength(0);
  });
});

describe("extractWithHeuristics — version declaration pattern (confidence 0.3)", () => {
  it("detects a semver version token", () => {
    const result = extractWithHeuristics("Using TypeScript 5.4.2 for this project configuration setting.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
    expect(result[0].confidence).toBe(0.3);
    expect(result[0].statement).toContain("Version referenced:");
  });

  it("detects a v-prefixed version token", () => {
    const result = extractWithHeuristics("Upgraded Hono to v4.2.0 for the new routing and middleware APIs.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
    expect(result[0].confidence).toBe(0.3);
  });

  it("detects an @scoped package version", () => {
    const result = extractWithHeuristics("Installed @mnemo-ai/core@3.2.1 in the workspace for testing.");
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe("config");
    expect(result[0].confidence).toBe(0.3);
  });

  it("does NOT match a line with only a single digit number (not semver)", () => {
    const result = extractWithHeuristics("The team has 3 open PRs waiting for review in the backlog now.");
    expect(result.filter(f => f.confidence === 0.3 && f.kind === "config")).toHaveLength(0);
  });

  it("does NOT match a JSON noise line containing a version string", () => {
    const result = extractWithHeuristics('{ "version": "1.2.3", "name": "pkg" }');
    expect(result).toHaveLength(0);
  });
});
