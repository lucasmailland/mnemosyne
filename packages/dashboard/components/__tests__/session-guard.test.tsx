import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

import { SessionGuard } from "../session-guard";

const replace = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
afterEach(() => {
  cleanup();
  replace.mockReset();
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const guardWith = (status: number, body = "{}") => {
  const fetchMock = vi.fn(async () => new Response(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/dashboard/recall?q=pagos");
  return { fetchMock, ...render(<SessionGuard />) };
};

it("APP-041 a 401 from the API bridge sends the reader to the login, back to this page", async () => {
  guardWith(401);
  const res = await fetch("/dashboard/api/recall", { method: "POST" });
  expect(res.status).toBe(401); // the caller still gets its answer
  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith("/login?next=%2Fdashboard%2Frecall%3Fq%3Dpagos")
  );
});

it("APP-041 a 401 that is not about the session (a wrong current password) stays on the page", async () => {
  guardWith(401);
  await fetch("/dashboard/auth/password", { method: "POST" });
  await fetch(new Request("http://localhost:3000/dashboard/auth/workspace"));
  await fetch("https://elsewhere.test/dashboard/api/x");
  expect(replace).not.toHaveBeenCalled();
});

it("APP-041 a refused password through the bridge (a superadmin step-up) stays on the page", async () => {
  guardWith(401, JSON.stringify({ error: "invalid_credentials", message: "Invalid password." }));
  const res = await fetch("/dashboard/api/instance/users/u1/superadmin", { method: "POST" });
  // The page still reads the answer it explains.
  expect(await res.json()).toMatchObject({ error: "invalid_credentials" });
  await new Promise((r) => setTimeout(r, 20));
  expect(replace).not.toHaveBeenCalled();
});

it("APP-041 other answers pass through, and unmounting puts fetch back", async () => {
  const { fetchMock, unmount } = guardWith(403);
  expect((await fetch("/dashboard/api/admin/keys")).status).toBe(403);
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(replace).not.toHaveBeenCalled();
  unmount();
  expect(globalThis.fetch).toBe(fetchMock);
});
