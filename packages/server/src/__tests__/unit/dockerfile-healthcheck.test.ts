/**
 * CHAOS-14: the image's HEALTHCHECK probed port 3000 whatever `PORT` said, so
 * a container run with `PORT=3939` stayed `unhealthy` forever (FailingStreak
 * 16 on the chaos stack). The probe must follow `PORT` at run time.
 *
 * Docker runs a shell-form HEALTHCHECK as `/bin/sh -c "<cmd>"` with the
 * container's environment, so this runs the same command through `sh -c`
 * with `wget` stubbed to print its URL.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DOCKERFILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../../docker/Dockerfile.server"
);

function healthcheckCommand(): string {
  const text = readFileSync(DOCKERFILE, "utf8").replace(/\\\n\s*/g, " ");
  const line = text.split("\n").find((l) => l.startsWith("HEALTHCHECK"));
  if (!line) throw new Error("no HEALTHCHECK in Dockerfile.server");
  const cmd = line.slice(line.indexOf(" CMD ") + 5).trim();
  // Shell form only: an exec-form (JSON array) command would get no expansion.
  expect(cmd.startsWith("[")).toBe(false);
  return cmd;
}

function probedUrl(env: Record<string, string>): string {
  const cmd = healthcheckCommand();
  return execFileSync("sh", ["-c", `wget() { echo "$@"; }; ${cmd}`], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env },
    encoding: "utf8",
  }).trim();
}

describe("Docker HEALTHCHECK follows PORT (CHAOS-14)", () => {
  it("probes the configured port", () => {
    expect(probedUrl({ PORT: "3939" })).toContain("http://localhost:3939/health/live");
  });

  it("falls back to 3000, the image's default, when PORT is unset", () => {
    expect(probedUrl({})).toContain("http://localhost:3000/health/live");
  });
});
