import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import HomePage from "../(home)/page";
import { I18nProvider } from "@/lib/i18n/client";
import { apiGet, getSession } from "@/lib/server-api";

vi.mock("@/lib/server-api", () => ({ apiGet: vi.fn(), getSession: vi.fn() }));
// Home's "needs you" section refreshes through the router.
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
vi.mock("@/lib/i18n/server", async () => {
  const { translate } = await import("@/lib/i18n/core");
  const { es } = await import("@/lib/i18n/messages/es");
  return {
    getLocale: async () => "es-419",
    getT: async () => (key: string, vars?: Record<string, string | number>) =>
      translate(es, key as never, vars, "es-419"),
    roomTitle: () => async () => ({}),
  };
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const stats = {
  workspaceId: "w",
  generatedAt: new Date().toISOString(),
  facts: { live: 3, closed: 1, pinned: 2, archived: 0, withZeroHits: 0 },
  decisions: { active: 4 },
  relations: { conflicts: 0 },
  embeddings: { indexed: 10, pending: 0 },
  snapshot: { at: null, ageSeconds: null, available: true },
  recall: { lastRecallAt: null, hitRate30d: 0.5, latencyP50Ms7d: 40, latencyP95Ms7d: 90 },
  lastWriteAt: null,
  writesPerDay14d: Array.from({ length: 14 }, (_, i) => ({ day: `2020-01-${i + 10}`, count: i })),
};

it("renders Home in Spanish", async () => {
  vi.mocked(getSession).mockResolvedValue({ role: "admin", scopes: ["memory:admin"] } as never);
  vi.mocked(apiGet).mockImplementation((async (path: string) =>
    path.startsWith("/admin/stats")
      ? stats
      : path.startsWith("/timeline")
        ? { events: [], nextCursor: null }
        : { pairs: [] }) as never);
  render(<I18nProvider locale="es-419">{await HomePage()}</I18nProvider>);
  expect(screen.getByText("Recuerdos vivos")).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Recuerdos guardados por día" })).toBeInTheDocument();
  expect(screen.getByText("El día, tal como se recordó")).toBeInTheDocument();
  expect(screen.queryByText("Memories live")).not.toBeInTheDocument();
  expect(screen.queryByText("The day, as remembered")).not.toBeInTheDocument();
});

it("shows the stats error in Spanish", async () => {
  vi.mocked(getSession).mockResolvedValue({ role: "admin", scopes: ["memory:admin"] } as never);
  vi.mocked(apiGet).mockResolvedValue(null);
  render(<I18nProvider locale="es-419">{await HomePage()}</I18nProvider>);
  expect(
    screen.getByText(/No se pudieron cargar las estadísticas del espacio de trabajo\./)
  ).toBeInTheDocument();
});
