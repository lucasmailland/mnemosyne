/**
 * The empty Home's last step, "waiting for the first memory" (APP-040, 5.2): it polls the stats
 * read with backoff and turns done, once, when a live fact appears.
 */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { I18nProvider } from "@/lib/i18n/client";
import { FIRST_POLL_MS, FirstSteps } from "../atrium/first-steps";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const fetchMock = vi.fn();
const stats = (live: number) => ({ ok: true, status: 200, json: async () => ({ facts: { live, closed: 0 } }) });
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

const renderSteps = () =>
  render(
    <I18nProvider locale="en-US">
      <FirstSteps canCreateKey />
    </I18nProvider>
  );

it("polls the stats with a growing delay and turns done when the first fact appears, then stops", async () => {
  fetchMock.mockResolvedValueOnce(stats(0)).mockResolvedValueOnce(stats(0)).mockResolvedValue(stats(1));
  renderSteps();
  expect(fetchMock).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(FIRST_POLL_MS));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  // APP-043: a read the server never answers ends, and the poll goes on.
  expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/admin/stats", {
    cache: "no-store",
    signal: expect.any(AbortSignal),
  });
  // Backoff: the same interval again is not enough for the second read.
  await act(() => vi.advanceTimersByTimeAsync(FIRST_POLL_MS));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(FIRST_POLL_MS));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for the first memory…");
  await act(() => vi.advanceTimersByTimeAsync(10 * FIRST_POLL_MS));
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("status")).toHaveTextContent("The first memory arrived.");
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(() => vi.advanceTimersByTimeAsync(100 * FIRST_POLL_MS));
  expect(fetchMock).toHaveBeenCalledTimes(3);
});

it("a failed read keeps waiting instead of giving up or saying done", async () => {
  fetchMock.mockRejectedValueOnce(new Error("down")).mockResolvedValue(stats(0));
  renderSteps();
  await act(() => vi.advanceTimersByTimeAsync(FIRST_POLL_MS));
  await act(() => vi.advanceTimersByTimeAsync(3 * FIRST_POLL_MS));
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("status")).toHaveTextContent("Waiting for the first memory…");
  expect(refresh).not.toHaveBeenCalled();
});

it("stops polling when it leaves the page", async () => {
  fetchMock.mockResolvedValue(stats(0));
  const view = renderSteps();
  view.unmount();
  await act(() => vi.advanceTimersByTimeAsync(100 * FIRST_POLL_MS));
  expect(fetchMock).not.toHaveBeenCalled();
});
