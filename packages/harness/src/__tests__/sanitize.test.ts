import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { HARNESS_MAX_MESSAGE_BYTES } from "@mnemo-ai/types";
import { describe, expect, expectTypeOf, it } from "vitest";
import { normalizeVisibleMessage, sanitizeMessage, type VisibleMessage } from "../sanitize.js";

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

describe("sanitizeMessage", () => {
  it.each([
    ["authorization bearer", "Authorization: Bearer bearer-secret-value", "bearer-secret-value"],
    ["mixed-case authorization", "aUtHoRiZaTiOn: bEaReR MixedCaseSecret", "MixedCaseSecret"],
    ["standalone bearer", "Use bearer standalone.secret-token here", "standalone.secret-token"],
    [
      "Mnemosyne key",
      "MNEMO_KEY=mns_live_abcdefghijklmnopqrstuvwxyz123456",
      "mns_live_abcdefghijklmnopqrstuvwxyz123456",
    ],
    [
      "Mnemosyne admin key",
      "key: mk_admin_abcdefghijklmnopqrstuvwxyz123456",
      "mk_admin_abcdefghijklmnopqrstuvwxyz123456",
    ],
    [
      "OpenAI key",
      "OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456",
      "sk-proj-abcdefghijklmnopqrstuvwxyz123456",
    ],
    [
      "GitHub token",
      "token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
      "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij",
    ],
    [
      "GitHub fine-grained token",
      "github_pat_11AA_exampleTokenValue123456789",
      "github_pat_11AA_exampleTokenValue123456789",
    ],
    ["AWS access key", "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"],
    [
      "AWS secret key",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    ],
    ["AWS session token", "AWS_SESSION_TOKEN=aws-session-token-value", "aws-session-token-value"],
    ["secret assignment", "client_secret = super-sensitive-value", "super-sensitive-value"],
    [
      "password assignment",
      "PASSWORD: 'correct horse battery staple'",
      "correct horse battery staple",
    ],
    ["credential assignment", "databaseCredential=credential-value", "credential-value"],
    ["private-key assignment", "private_key=assignment-private-value", "assignment-private-value"],
    ["URL user-info", "https://db-user:db-password@example.com/path", "db-password"],
    ["password in prose", "my password is hunter2", "hunter2"],
    ["passphrase in prose", "the passphrase was correct-horse", "correct-horse"],
    ["api key in prose", "our api key is abc123XYZ please", "abc123XYZ"],
    ["token in prose", "the token is tok_live_9876", "tok_live_9876"],
    ["contraseña en prosa", "mi contraseña es hunter3", "hunter3"],
    ["clave en prosa", "la clave es Pa55word!", "Pa55word!"],
    ["secreto en prosa", "el secreto es valor-oculto", "valor-oculto"],
  ])("redacts %s without leaking its value", (_name, input, secret) => {
    const sanitized = sanitizeMessage(input);

    expect(sanitized).toContain("[REDACTED]");
    expect(sanitized).not.toContain(secret);
  });

  it("redacts multiline private-key blocks and secrets on separate lines", () => {
    const input = [
      "before",
      "-----BEGIN PRIVATE KEY-----",
      "private-line-one",
      "private-line-two",
      "-----END PRIVATE KEY-----",
      "Api_Token=multiline-token-value",
      "after",
    ].join("\n");
    const sanitized = sanitizeMessage(input);

    expect(sanitized).not.toContain("private-line-one");
    expect(sanitized).not.toContain("multiline-token-value");
    expect(sanitized).toContain("before");
    expect(sanitized).toContain("after");
  });

  it.each(["'", '"'])("redacts multiline %s-quoted secret assignments", (quote) => {
    const secret = "first secret line\nsecond secret line";
    const input = `before\nAPI_TOKEN=${quote}${secret}${quote}\nafter`;
    const sanitized = sanitizeMessage(input);

    expect(sanitized).toBe("before\nAPI_TOKEN=[REDACTED]\nafter");
    expect(sanitized).not.toContain("first secret line");
    expect(sanitized).not.toContain("second secret line");
  });

  it("redacts quoted JSON password and api_token keys", () => {
    const input = '{"password":"json-password","api_token":"json-token","safe":"visible"}';

    expect(sanitizeMessage(input)).toBe(
      '{"password":"[REDACTED]","api_token":"[REDACTED]","safe":"visible"}'
    );
  });

  it("redacts an indented multiline password continuation without swallowing safe fields", () => {
    const input = "password=first-line\n  second-line\nsafe=value";

    expect(sanitizeMessage(input)).toBe("password=[REDACTED]\nsafe=value");
  });

  it("redacts a complete multi-word unquoted password scalar", () => {
    const input = "password: correct horse battery staple";

    expect(sanitizeMessage(input)).toBe("password: [REDACTED]");
  });

  it("preserves YAML sibling fields after a nested password scalar", () => {
    const input = [
      "database:",
      "  password: correct horse battery staple",
      "  username: app-user",
      "enabled: true",
    ].join("\n");

    expect(sanitizeMessage(input)).toBe(
      ["database:", "  password: [REDACTED]", "  username: app-user", "enabled: true"].join("\n")
    );
  });

  it("preserves benign identifiers containing secret-like substrings", () => {
    const input = [
      "secretary=alice",
      "passwordless=true",
      "credentialProvider=default-chain",
      "apiKeyProvider=environment",
      "accessKeyManager=system",
    ].join("\n");

    expect(sanitizeMessage(input)).toBe(input);
  });

  it.each(["API_KEY", "GOOGLE_API_KEY", "apiKey", "access_key"])(
    "redacts the exact tokenized secret name %s",
    (name) => {
      expect(sanitizeMessage(`${name}=exact-secret-value`)).toBe(`${name}=[REDACTED]`);
    }
  );

  it.each([
    ["session", "(mk_sess_session01_abcdefghijklmnopqrstuvwxyz123456),", "([REDACTED]),"],
    ["federation", '"mk_fed_peer01_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456";', '"[REDACTED]";'],
  ])("redacts a valid %s API key alias at punctuation boundaries", (_name, input, expected) => {
    expect(sanitizeMessage(input)).toBe(expected);
  });

  it.each(["mk_sess_too_short", "xmk_fed_peer01_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456"])(
    "preserves the non-key token %s",
    (input) => {
      expect(sanitizeMessage(input)).toBe(input);
    }
  );

  it("redacts a multi-word equals password through the next structured field", () => {
    expect(sanitizeMessage("password=correct horse battery staple status=ready")).toBe(
      "password=[REDACTED] status=ready"
    );
  });

  it("redacts URL user-info through the final authority @", () => {
    const sanitized = sanitizeMessage("connect https://db-user:p@ss@example.com/path safely");

    expect(sanitized).toBe("connect https://[REDACTED]@example.com/path safely");
    expect(sanitized).not.toContain("db-user");
    expect(sanitized).not.toContain("p@ss");
  });

  it("redacts RFC-valid apostrophes in URL user-info", () => {
    expect(sanitizeMessage("https://o'connor:secret@example.com/path")).toBe(
      "https://[REDACTED]@example.com/path"
    );
  });

  it("treats a CSV comma as the end of a URL authority", () => {
    const input = "https://example.com,user@example.net";

    expect(sanitizeMessage(input)).toBe(input);
  });

  it("redacts RFC-valid comma user-info when the authority has a valid host", () => {
    for (const input of [
      "https://user,name@example.com/path",
      "https://user,name:secret@example.com/path",
      "https://user.name,other:secret@example.com/path",
      "https://user:pa,ss@example.com/path",
    ]) {
      expect(sanitizeMessage(input)).toBe("https://[REDACTED]@example.com/path");
    }
  });

  it("preserves a port-qualified URL followed by a comma and email", () => {
    const input = "https://example.com:443,user@example.net";

    expect(sanitizeMessage(input)).toBe(input);
  });

  it.each([
    ["https://user:secret@example.com.", "https://[REDACTED]@example.com."],
    ["https://user:secret@example.com,", "https://[REDACTED]@example.com,"],
    ["https://user:secret@example.com:443.", "https://[REDACTED]@example.com:443."],
    ["(https://user:secret@example.com)", "(https://[REDACTED]@example.com)"],
    ["[https://user:secret@example.com]", "[https://[REDACTED]@example.com]"],
    ["{https://user:secret@example.com}", "{https://[REDACTED]@example.com}"],
  ])("redacts URL user-info before trailing punctuation in %s", (input, expected) => {
    expect(sanitizeMessage(input)).toBe(expected);
  });

  it("redacts bracket-wrapped IPv6 URL credentials", () => {
    expect(sanitizeMessage("[https://user:secret@[::1]]")).toBe("[https://[REDACTED]@[::1]]");
  });

  it.each([
    "https://user:secret@/path",
    "https://user:secret@invalid_host/path",
    "https://user:secret@example.com:99999/path",
    "https://user:secret@[:::]/path",
    "https://user:secret@[1.2.3]/path",
    "not_scheme://user:secret@example.com/path",
  ])("does not redact user-info from an invalid URL authority: %s", (input) => {
    expect(sanitizeMessage(input)).toBe(input);
  });

  /**
   * Time how long sanitizing `repeats` copies of `unit` takes, warmed up first.
   *
   * These two tests guard against catastrophic backtracking, and they used to
   * assert a fixed 250ms wall clock — a PROXY for that property, not the
   * property. Under V8 coverage instrumentation everything runs several times
   * slower, so the proxy failed on a sanitizer that was behaving perfectly, and
   * it would fail again on any slower machine.
   *
   * Doubling the input is the real test: linear work roughly doubles, while
   * catastrophic backtracking explodes by orders of magnitude. Both measurements
   * are instrumented equally, so the ratio holds however slow the host is.
   */
  function timeSanitize(unit: string, repeats: number): number {
    // Warmed at the SIZE BEING MEASURED. A token-sized warm-up leaves the JIT
    // cost inside the first real measurement, which inflates the baseline and
    // makes the ratio below pass no matter how badly the sanitizer grows — a
    // test that looks rigorous and checks nothing.
    for (let i = 0; i < 2; i += 1) sanitizeMessage(unit.repeat(repeats));
    const startedAt = performance.now();
    sanitizeMessage(unit.repeat(repeats));
    return performance.now() - startedAt;
  }

  const GROWTH_CEILING = 8;

  it("handles repeated URLs without user-info in time that grows linearly", () => {
    const unit = "https://example.com ";
    expect(sanitizeMessage(unit.repeat(20_000))).toContain("https://example.com");

    const single = timeSanitize(unit, 10_000);
    const double = timeSanitize(unit, 20_000);
    // Twice the input, not eight times the work.
    expect(double).toBeLessThan(Math.max(single, 1) * GROWTH_CEILING);
  }, 30_000);

  it("handles many same-line secret assignments in time that grows linearly", () => {
    const unit = "password=secret safe=value ";
    expect(sanitizeMessage(unit.repeat(10_000))).toContain("password=[REDACTED] safe=value");

    const single = timeSanitize(unit, 5_000);
    const double = timeSanitize(unit, 10_000);
    expect(double).toBeLessThan(Math.max(single, 1) * GROWTH_CEILING);
  }, 30_000);

  it.each([
    [
      "unquoted Basic",
      "trace headers: Authorization: Basic dXNlcjpwYXNz; status=200",
      "trace headers: Authorization: [REDACTED]; status=200",
    ],
    [
      "quoted nested Bearer",
      'headers={"Authorization":"Bearer nested-secret","Accept":"application/json"}',
      'headers={"Authorization":"[REDACTED]","Accept":"application/json"}',
    ],
    [
      "Basic followed by safe log text",
      "request Authorization: Basic dXNlcjpwYXNz operation completed",
      "request Authorization: [REDACTED] operation completed",
    ],
  ])("redacts %s authorization without consuming safe text", (_name, input, expected) => {
    expect(sanitizeMessage(input)).toBe(expected);
  });

  it("redacts an indented multiline Basic credential without swallowing safe log text", () => {
    const input = "Authorization: Basic first-part\n  second-part\nstatus=complete";

    expect(sanitizeMessage(input)).toBe("Authorization: [REDACTED]\nstatus=complete");
  });

  it("redacts an incomplete PEM block through end-of-input", () => {
    const input =
      "safe before\n-----BEGIN PRIVATE KEY-----\nunclosed-private-material\nstill-private";
    const sanitized = sanitizeMessage(input);

    expect(sanitized).toBe("safe before\n[REDACTED]");
    expect(sanitized).not.toContain("unclosed-private-material");
    expect(sanitized).not.toContain("still-private");
  });

  it("handles repeated unmatched PEM beginnings in bounded time", () => {
    const input = "-----BEGIN PRIVATE KEY-----\n".repeat(2_000);
    const startedAt = performance.now();
    const sanitized = sanitizeMessage(input);

    expect(performance.now() - startedAt).toBeLessThan(250);
    expect(sanitized).toBe("[REDACTED]");
  }, 2_000);

  it("truncates on UTF-8 code-point boundaries with an explicit original-byte marker", () => {
    const original = `prefix:${"😀".repeat(HARNESS_MAX_MESSAGE_BYTES)}`;
    const sanitized = sanitizeMessage(original);

    expect(Buffer.byteLength(sanitized, "utf8")).toBeLessThanOrEqual(HARNESS_MAX_MESSAGE_BYTES);
    expect(sanitized).toMatch(/\n\[TRUNCATED: original UTF-8 bytes=\d+\]$/);
    expect(sanitized).toContain(
      `[TRUNCATED: original UTF-8 bytes=${Buffer.byteLength(original, "utf8")}]`
    );
    expect(sanitized).not.toContain("�");
  });

  it("does not add a marker at the exact UTF-8 byte limit", () => {
    const input = "é".repeat(HARNESS_MAX_MESSAGE_BYTES / 2);

    expect(sanitizeMessage(input)).toBe(input);
  });
});

describe("normalizeVisibleMessage", () => {
  it("exposes only user and assistant as visible roles", () => {
    expectTypeOf<VisibleMessage["role"]>().toEqualTypeOf<"user" | "assistant">();
  });

  it.each(["system", "developer", "tool", "reasoning"])("rejects the %s role", (role) => {
    expect(() =>
      normalizeVisibleMessage({ role, content: "hidden" } as unknown as VisibleMessage)
    ).toThrow(/role/i);
  });

  it("rejects unknown roles rather than treating them as visible", () => {
    expect(() =>
      normalizeVisibleMessage({ role: "function", content: "hidden" } as unknown as VisibleMessage)
    ).toThrow(/role/i);
  });

  it.each(["user", "assistant"] as const)("normalizes and hashes sanitized %s content", (role) => {
    const secret = "sk-proj-normalizedSecretValue123456789";
    const normalized = normalizeVisibleMessage({
      role,
      content: `Visible text\nOPENAI_API_KEY=${secret}`,
    });

    expect(normalized).toEqual({
      role,
      content: "Visible text\nOPENAI_API_KEY=[REDACTED]",
      contentHash: sha256("Visible text\nOPENAI_API_KEY=[REDACTED]"),
      normalizationVersion: 1,
    });
    expect(JSON.stringify(normalized)).not.toContain(secret);
  });

  it("hashes exactly the sanitized and truncated UTF-8 bytes", () => {
    const secret = "mns_live_normalizedSecretValue123456789";
    const normalized = normalizeVisibleMessage({
      role: "user",
      content: `${"界".repeat(HARNESS_MAX_MESSAGE_BYTES)}\nMNEMO_KEY=${secret}`,
    });

    expect(normalized.contentHash).toBe(sha256(normalized.content));
    expect(Buffer.byteLength(normalized.content, "utf8")).toBeLessThanOrEqual(
      HARNESS_MAX_MESSAGE_BYTES
    );
    expect(normalized.content).toMatch(/\[TRUNCATED: original UTF-8 bytes=\d+\]$/);
    expect(JSON.stringify(normalized)).not.toContain(secret);
  });
});
