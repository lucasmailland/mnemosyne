/**
 * AB7.2 — Request coalescing (spec §35 line 4434).
 */
import { describe, it, expect, vi } from "vitest";
import { Coalescer } from "../coalesce.js";

describe("Coalescer — spec §35 line 4434", () => {
  it("two concurrent calls with same key invoke fn exactly once", async () => {
    const coalescer = new Coalescer();
    let callCount = 0;
    const slowFn = async () => {
      callCount++;
      await new Promise<void>((res) => setTimeout(res, 20));
      return "result";
    };

    const [r1, r2] = await Promise.all([
      coalescer.coalesce("k", slowFn),
      coalescer.coalesce("k", slowFn),
    ]);

    expect(callCount).toBe(1);
    expect(r1).toBe("result");
    expect(r2).toBe("result");
  });

  it("a third call after settlement re-invokes fn", async () => {
    const coalescer = new Coalescer();
    let callCount = 0;
    const fn = async () => {
      callCount++;
      return callCount;
    };

    const r1 = await coalescer.coalesce("k", fn);
    const r2 = await coalescer.coalesce("k", fn);

    expect(callCount).toBe(2);
    expect(r1).toBe(1);
    expect(r2).toBe(2);
  });

  it("different keys invoke fn independently", async () => {
    const coalescer = new Coalescer();
    let aCount = 0;
    let bCount = 0;

    const [ra, rb] = await Promise.all([
      coalescer.coalesce("a", async () => { aCount++; await new Promise<void>(r => setTimeout(r, 10)); return "a"; }),
      coalescer.coalesce("b", async () => { bCount++; await new Promise<void>(r => setTimeout(r, 10)); return "b"; }),
    ]);

    expect(aCount).toBe(1);
    expect(bCount).toBe(1);
    expect(ra).toBe("a");
    expect(rb).toBe("b");
  });

  it("fn rejection propagates to all waiters", async () => {
    const coalescer = new Coalescer();
    const err = new Error("boom");
    const fn = async () => { throw err; };

    const [r1, r2] = await Promise.allSettled([
      coalescer.coalesce("k", fn),
      coalescer.coalesce("k", fn),
    ]);

    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
    // fn called once (both waiters share same rejection)
  });

  it("three concurrent calls coalesce to one invocation", async () => {
    const coalescer = new Coalescer();
    let count = 0;
    const fn = async () => {
      count++;
      await new Promise<void>(r => setTimeout(r, 30));
      return "x";
    };

    const results = await Promise.all([
      coalescer.coalesce("k", fn),
      coalescer.coalesce("k", fn),
      coalescer.coalesce("k", fn),
    ]);

    expect(count).toBe(1);
    expect(results).toEqual(["x", "x", "x"]);
  });
});
