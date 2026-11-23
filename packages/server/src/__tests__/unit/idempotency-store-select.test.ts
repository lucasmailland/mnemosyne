import { describe, it, expect } from "vitest";
import { selectIdempotencyStoreKind } from "../../idempotencyMemory.js";

describe("idempotency store selection (spec §RDD9)", () => {
  it("prefers postgres when MNEMO_IDEMPOTENCY_STORE=postgres and a databaseUrl is present", () => {
    expect(selectIdempotencyStoreKind({ idempotencyStoreEnv: "postgres", redisUrl: "redis://x", databaseUrl: "postgres://x" })).toBe("postgres");
  });
  it("prefers redis when a redis url is set and no explicit postgres opt-in", () => {
    expect(selectIdempotencyStoreKind({ idempotencyStoreEnv: undefined, redisUrl: "redis://x", databaseUrl: "postgres://x" })).toBe("redis");
  });
  it("falls back to memory when neither redis nor postgres opt-in apply", () => {
    expect(selectIdempotencyStoreKind({ idempotencyStoreEnv: undefined, redisUrl: undefined, databaseUrl: "postgres://x" })).toBe("memory");
  });
  it("falls back to memory if postgres opt-in but no databaseUrl", () => {
    expect(selectIdempotencyStoreKind({ idempotencyStoreEnv: "postgres", redisUrl: "redis://x", databaseUrl: undefined })).toBe("memory");
  });
});
