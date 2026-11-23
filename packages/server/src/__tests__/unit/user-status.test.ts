import { describe, expect, it, vi } from "vitest";
import { UserStatusService, type UserStatus, type UserStatusSource } from "../../user-status.js";

const status = (over: Partial<UserStatus> = {}): UserStatus => ({
  disabledAt: null,
  sessionsValidAfter: new Date(0),
  isSuperadmin: false,
  ...over,
});
const sourceOf = (load: UserStatusSource["load"]): UserStatusSource => ({ load });

describe("UserStatusService cache", () => {
  it("loads once for two gets within the ttl", async () => {
    let t = 1_000;
    const load = vi.fn(async () => status());
    const svc = new UserStatusService(sourceOf(load), { now: () => t });
    await svc.get("u1");
    t += 14_999;
    await svc.get("u1");
    expect(load).toHaveBeenCalledTimes(1);
    t += 2;
    await svc.get("u1");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("invalidate forces a reload", async () => {
    const load = vi.fn(async () => status());
    const svc = new UserStatusService(sourceOf(load), { now: () => 1 });
    await svc.get("u1");
    svc.invalidate("u1");
    await svc.get("u1");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("propagates source errors and caches nothing", async () => {
    const load = vi
      .fn<UserStatusSource["load"]>()
      .mockRejectedValueOnce(new Error("db down"))
      .mockResolvedValueOnce(status());
    const svc = new UserStatusService(sourceOf(load), { now: () => 1 });
    await expect(svc.get("u1")).rejects.toThrow("db down");
    await expect(svc.get("u1")).resolves.toEqual(status());
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("caches unknown users (null) within the ttl", async () => {
    const load = vi.fn(async () => null);
    const svc = new UserStatusService(sourceOf(load), { now: () => 1 });
    expect(await svc.get("ghost")).toBeNull();
    expect(await svc.get("ghost")).toBeNull();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not let an in-flight load resurrect a status after invalidate", async () => {
    let release!: (s: UserStatus) => void;
    const load = vi
      .fn<UserStatusSource["load"]>()
      .mockImplementationOnce(() => new Promise((r) => (release = r)))
      .mockResolvedValueOnce(status({ isSuperadmin: true }));
    const svc = new UserStatusService(sourceOf(load), { now: () => 1 });
    const stale = svc.get("u1");
    svc.invalidate("u1");
    release(status());
    await stale;
    expect((await svc.get("u1"))?.isSuperadmin).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("sessionAllowed", () => {
  const svc = new UserStatusService(sourceOf(async () => null));
  it("denies unknown users", () => expect(svc.sessionAllowed(null, 5_000)).toBe(false));
  it("denies disabled users", () =>
    expect(svc.sessionAllowed(status({ disabledAt: new Date(1) }), 5_000)).toBe(false));
  it("kills tokens minted in the revocation second, keeps later ones", () => {
    const s = status({ sessionsValidAfter: new Date(1_000_400) });
    expect(svc.sessionAllowed(s, 1000)).toBe(false);
    expect(svc.sessionAllowed(s, 1001)).toBe(true);
  });
  it("allows any token at the epoch default", () =>
    expect(svc.sessionAllowed(status(), 0)).toBe(true));
  it("treats an exact-second boundary as valid", () =>
    expect(svc.sessionAllowed(status({ sessionsValidAfter: new Date(1_000_000) }), 1000)).toBe(
      true
    ));
});
