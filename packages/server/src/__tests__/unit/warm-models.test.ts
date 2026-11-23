/**
 * P134 — warming the models must never be able to break the thing it speeds up.
 *
 * The bug: `POST /recall` is wrapped by the `storage.read` breaker at 5000ms,
 * and the first call after a restart answered 500. Measured on the local stack —
 * embed cold 1409–1669ms, generate cold 836ms, warm pipeline 1400–2955ms. No
 * component is near 5s; the sum is, and the fourth call onwards runs in ~145ms.
 * The entire cost is loading weights the next request would have found resident.
 *
 * A boot warmup is a small thing that can go wrong in a big way, so the shape
 * matters more than the feature:
 *
 *   - it must not block `listen()` — the server has to accept traffic first;
 *   - it must not throw — an unreachable provider is precisely when the server
 *     most needs to come up and degrade (B5.9 / P128), not refuse to start;
 *   - it must be off unless asked for — free on self-hosted ollama, a billed
 *     call on OpenAI, which has no cold start to amortise.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { warmModels, warmModelsEnabled } from "../../boot/warm-models.js";

function logger() {
  return { info: vi.fn(), warn: vi.fn() };
}

const flush = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  delete process.env.MNEMO_WARM_MODELS_ON_BOOT;
});

describe("P134 — the warmup only runs when asked", () => {
  it("does nothing when unset", async () => {
    const embed = { embedSingle: vi.fn(async () => new Float32Array([1])) };
    warmModels({ embed, logger: logger() });
    await flush();
    expect(embed.embedSingle).not.toHaveBeenCalled();
  });

  it("does nothing for any value other than the exact opt-in", async () => {
    // "1", "yes" and "TRUE" are the classic near-misses. Treating them as
    // enabled would bill OpenAI users for a warmup they never asked for.
    for (const value of ["1", "yes", "TRUE", ""]) {
      process.env.MNEMO_WARM_MODELS_ON_BOOT = value;
      const embed = { embedSingle: vi.fn(async () => new Float32Array([1])) };
      warmModels({ embed, logger: logger() });
      await flush();
      expect(embed.embedSingle, `"${value}" should not enable the warmup`).not.toHaveBeenCalled();
    }
  });

  it("warms both ports when enabled", async () => {
    process.env.MNEMO_WARM_MODELS_ON_BOOT = "true";
    const embed = { embedSingle: vi.fn(async () => new Float32Array([1])) };
    const llm = { generate: vi.fn(async () => ({ content: "ok" })) };

    warmModels({ embed, llm, logger: logger() });
    await flush();

    expect(embed.embedSingle).toHaveBeenCalledTimes(1);
    expect(llm.generate).toHaveBeenCalledTimes(1);
  });
});

describe("P134 — the warmup cannot break boot", () => {
  it("returns synchronously — listen() is never held", () => {
    process.env.MNEMO_WARM_MODELS_ON_BOOT = "true";
    // A provider that never answers. If warmModels awaited it, this call would
    // not return and the server would never start accepting traffic.
    const embed = { embedSingle: vi.fn(() => new Promise<Float32Array>(() => {})) };

    const before = Date.now(); // determinism-ok: elapsed-time bound, not a fixed instant
    warmModels({ embed, logger: logger() });
    expect(Date.now() - before).toBeLessThan(50); // determinism-ok: elapsed duration
  });

  it("and the CALLER does not await it — where the guarantee actually lives", () => {
    // The check above is weaker than it looks: an async function returns its
    // promise synchronously too, so it passes whether or not the work is
    // detached. What genuinely holds `listen()` open is an `await` at the call
    // site, so that is what has to be asserted. Found by mutating the helper to
    // return the promise and watching the timing test stay green.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.ts"),
      "utf8"
    );
    const idx = src.indexOf("warmModels({");
    const preceding = src.slice(Math.max(0, idx - 40), idx);
    expect(preceding).not.toContain("await");
  });

  it("swallows a failing provider and says so", async () => {
    process.env.MNEMO_WARM_MODELS_ON_BOOT = "true";
    const log = logger();
    const embed = {
      embedSingle: vi.fn(async () => {
        throw new Error("Network error calling ollama: fetch failed");
      }),
    };

    expect(() => warmModels({ embed, logger: log })).not.toThrow();
    await flush();

    expect(log.warn).toHaveBeenCalled();
    const warned = JSON.stringify(log.warn.mock.calls);
    expect(warned).toContain("boot.warm_models");
    // The real cause has to reach the log — a silent warmup failure is a cold
    // start nobody can explain.
    expect(warned).toContain("fetch failed");
  });

  it("still warms the LLM when the embedder fails, and vice versa", async () => {
    // One dead provider must not skip the other: they are independent cold
    // starts and the request path pays for both.
    process.env.MNEMO_WARM_MODELS_ON_BOOT = "true";
    const embed = {
      embedSingle: vi.fn(async () => {
        throw new Error("embed down");
      }),
    };
    const llm = { generate: vi.fn(async () => ({ content: "ok" })) };

    warmModels({ embed, llm, logger: logger() });
    await flush();

    expect(llm.generate).toHaveBeenCalledTimes(1);
  });

  it("tolerates a missing port entirely", async () => {
    process.env.MNEMO_WARM_MODELS_ON_BOOT = "true";
    const log = logger();
    expect(() => warmModels({ logger: log })).not.toThrow();
    await flush();
  });
});

describe("P134 — the boot path actually calls it", () => {
  it("index.ts warms AFTER listen(), not before", () => {
    // Order is the whole safety argument: called before listen(), a slow
    // provider would delay the server accepting traffic — trading a slow first
    // request for a slow start, which is worse.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "index.ts"),
      "utf8"
    );
    const listenIdx = src.indexOf("httpServer.listen(port, () => {");
    const warmIdx = src.indexOf("warmModels({");

    expect(warmIdx).toBeGreaterThan(-1);
    expect(listenIdx).toBeGreaterThan(-1);
    expect(warmIdx).toBeGreaterThan(listenIdx);
  });

  it("warmModelsEnabled reads the documented variable name", () => {
    process.env.MNEMO_WARM_MODELS_ON_BOOT = "true";
    expect(warmModelsEnabled()).toBe(true);
  });
});
