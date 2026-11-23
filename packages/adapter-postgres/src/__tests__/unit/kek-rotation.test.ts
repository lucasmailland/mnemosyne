/**
 * T3.6 — KEK rotation: re-wraps every live DEK under a new KEK version.
 *
 * The KeyRingAdapters are fakes that wrap/unwrap using a simple XOR-based
 * scheme so the test is self-contained (no real HKDF/AES needed here — the
 * real crypto is covered by KeyRingAdapter.test.ts).
 */
import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import type { EncryptedField } from "@mnemo-ai/types";

// ─── Minimal fakes ─────────────────────────────────────────────────────────

/**
 * A fake KeyRingAdapter whose wrap/unwrap just stores plaintext (base64).
 * We need two distinct versions so we can assert the wrapped bytes changed.
 */
class FakeRing {
  readonly version: number;
  constructor(version: number) {
    this.version = version;
  }

  /** Wrap: prefix the base64 with "v<N>:" so we can distinguish versions. */
  wrapDek(_wsId: string, _actorId: string, dek: Buffer): string {
    return `v${this.version}:${dek.toString("base64")}`;
  }

  /** Unwrap: strip the prefix. */
  unwrapDek(_wsId: string, _actorId: string, wrapped: string): Buffer {
    const colonIdx = wrapped.indexOf(":");
    return Buffer.from(wrapped.slice(colonIdx + 1), "base64");
  }

  generateDek(): Buffer {
    return randomBytes(32);
  }

  encryptField(_dek: Buffer, dekId: string, plaintext: string): EncryptedField {
    return {
      ciphertext: Buffer.from(plaintext).toString("base64"),
      iv: "aaaaaaaaaaaa",
      tag: "bbbbbbbbbbbbbbbb",
      dekId,
      algorithm: "AES-256-GCM",
    };
  }

  decryptField(_dek: Buffer, field: EncryptedField): string {
    return Buffer.from(field.ciphertext, "base64").toString("utf8");
  }
}

// ─── Unit under test ────────────────────────────────────────────────────────

import { rotateWorkspaceKek } from "../../encryption/rotateWorkspaceKek.js";
import type { KeyRingLike } from "../../encryption/rotateWorkspaceKek.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeLiveDeks(wsId: string, ring: FakeRing, count: number) {
  return Array.from({ length: count }, (_, i) => {
    const actorId = `actor-${i}`;
    const dek = ring.generateDek();
    return {
      id: `dek-${i}`,
      workspaceId: wsId,
      actorId,
      encryptedKey: ring.wrapDek(wsId, actorId, dek),
      algorithm: "AES-256-GCM",
      status: "active",
      createdAt: new Date(), // determinism-ok: throwaway fixture date, not asserted
      destroyedAt: null,
    };
  });
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("rotateWorkspaceKek — re-wrap all live DEKs under new KEK version", () => {
  it("returns 0 when there are no live DEKs for the workspace", async () => {
    const wsId = "ws-empty";
    const oldRing = new FakeRing(1) as unknown as KeyRingLike;
    const newRing = new FakeRing(2) as unknown as KeyRingLike;
    const count = await rotateWorkspaceKek(wsId, oldRing, newRing, []);
    expect(count).toBe(0);
  });

  it("re-wraps each live DEK and returns the affected count", async () => {
    const wsId = "ws-main";
    const oldRing = new FakeRing(1);
    const newRing = new FakeRing(2);

    const deks = makeLiveDeks(wsId, oldRing, 3);
    const updatedDeks: typeof deks = [];

    const count = await rotateWorkspaceKek(
      wsId,
      oldRing as unknown as KeyRingLike,
      newRing as unknown as KeyRingLike,
      deks,
      (dekId, newWrapped) => {
        const idx = deks.findIndex((d) => d.id === dekId);
        if (idx !== -1) {
          updatedDeks.push({ ...deks[idx]!, encryptedKey: newWrapped });
        }
      },
    );

    expect(count).toBe(3);
    expect(updatedDeks).toHaveLength(3);

    // Each re-wrapped key should start with the NEW version prefix.
    for (const d of updatedDeks) {
      expect(d.encryptedKey).toMatch(/^v2:/);
    }
  });

  it("skips destroyed DEKs (null encryptedKey)", async () => {
    const wsId = "ws-mixed";
    const oldRing = new FakeRing(1);
    const newRing = new FakeRing(2);

    const deks = makeLiveDeks(wsId, oldRing, 2);
    // Simulate a destroyed DEK.
    deks[1]!.encryptedKey = null as unknown as string;

    let updated = 0;
    const count = await rotateWorkspaceKek(
      wsId,
      oldRing as unknown as KeyRingLike,
      newRing as unknown as KeyRingLike,
      deks,
      () => { updated++; },
    );

    expect(count).toBe(1);
    expect(updated).toBe(1);
  });
});
