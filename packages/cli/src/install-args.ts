/**
 * `mnemo install`'s argv, parsed once, in a pure function.
 *
 * The flag set used to be a `Set<string>` used as a membership filter, which
 * works only while every flag is a bare switch. `--capture` takes a value, and a
 * membership filter has no way to tell a flag's value from a stray positional —
 * so the rule for what to consume and the rule for what to reject end up in two
 * places and drift apart. A table with arities keeps them as one rule.
 *
 * Every ambiguity here is an error rather than a guess. `--capture` twice is not
 * "last one wins": the user asked for two different things and only one of them
 * would happen, silently. `--accept-degraded` without `--capture` is not a
 * harmless no-op: the user believes capture is being installed, and it is not.
 */

import { t } from "./i18n/index.js";
export type CaptureHost = "opencode" | "claude-code" | "codex";

export interface InstallArgs {
  local: boolean;
  acceptDegraded: boolean;
  /** Empty when `--capture` was absent. Capture is opt-in, always. */
  capture: CaptureHost[];
}

export type ParseResult = { ok: true; args: InstallArgs } | { ok: false; error: string };

const CAPTURE_HOSTS: readonly CaptureHost[] = ["opencode", "claude-code", "codex"];

/** Flag → how many following tokens it consumes. */
const KNOWN_INSTALL_FLAGS: Record<string, 0 | 1> = {
  "--local": 0,
  "--accept-degraded": 0,
  "--capture": 1,
};

const VALID_OPTIONS = Object.keys(KNOWN_INSTALL_FLAGS).join(", ");

function unknown(tokens: string[]): string {
  return t(tokens.length > 1 ? "installArgs.unknownOptions" : "installArgs.unknownOption", {
    tokens: tokens.join(", "),
    valid: VALID_OPTIONS,
  });
}

function parseHostList(
  raw: string
): { ok: true; hosts: CaptureHost[] } | { ok: false; error: string } {
  const parts = raw.split(",");
  const hosts: CaptureHost[] = [];
  for (const part of parts) {
    const name = part.trim();
    if (name === "") {
      // `a,,b` and `a,` are typos, and the charitable reading of a typo in a
      // consent flag is still "the user did not say what they meant".
      return { ok: false, error: t("installArgs.captureHasAnEmpty", { raw }) };
    }
    if (!(CAPTURE_HOSTS as readonly string[]).includes(name)) {
      return {
        ok: false,
        error: t("installArgs.unknownHost", { name, hosts: CAPTURE_HOSTS.join(", ") }),
      };
    }
    // De-duplicated, first-occurrence order preserved — which is also the order
    // the summary reports at the end.
    if (!hosts.includes(name as CaptureHost)) hosts.push(name as CaptureHost);
  }
  return { ok: true, hosts };
}

export function parseInstallArgs(argv: readonly string[]): ParseResult {
  let local = false;
  let acceptDegraded = false;
  let capture: CaptureHost[] | null = null;
  const unrecognised: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    // `--capture=a,b` is the same request as `--capture a,b`.
    const equals = token.indexOf("=");
    const name = equals === -1 ? token : token.slice(0, equals);
    const inlineValue = equals === -1 ? null : token.slice(equals + 1);

    const arity = KNOWN_INSTALL_FLAGS[name];
    if (arity === undefined) {
      unrecognised.push(token);
      continue;
    }

    if (arity === 0) {
      if (inlineValue !== null) {
        return { ok: false, error: t("installArgs.doesNotTakeA", { name }) };
      }
      if (name === "--local") local = true;
      else acceptDegraded = true;
      continue;
    }

    if (capture !== null) {
      // Not last-wins: two different requests, one of which would vanish.
      return { ok: false, error: t("installArgs.captureMayOnlyBe") };
    }

    let value: string;
    if (inlineValue !== null) {
      value = inlineValue;
    } else {
      const next = argv[index + 1];
      // A `--`-prefixed next token is the following FLAG, not this flag's value.
      // Consuming it would silently install capture for nothing.
      if (next === undefined || next.startsWith("--")) {
        return {
          ok: false,
          error: t("installArgs.requiresHostList", { hosts: CAPTURE_HOSTS.join(", ") }),
        };
      }
      value = next;
      index += 1;
    }

    const parsed = parseHostList(value);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    capture = parsed.hosts;
  }

  if (unrecognised.length > 0) return { ok: false, error: unknown(unrecognised) };

  if (acceptDegraded && capture === null) {
    return {
      ok: false,
      error: t("installArgs.acceptDegradedOnlyMeans"),
    };
  }

  return { ok: true, args: { local, acceptDegraded, capture: capture ?? [] } };
}
