import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import AuditPage from "../audit/page";
import HealthPage from "../health/page";
import { apiGet, apiRead } from "@/lib/server-api";

vi.mock("@/lib/server-api", () => {
  const apiGet = vi.fn();
  // The pages read their main source with the status; by default that is apiGet's answer, a 200.
  const apiRead = vi.fn(async (path: string) => ({ data: await apiGet(path), status: 200 }));
  return { apiGet, apiRead };
});
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

const entry = (id: string, factKind: string) => ({
  id,
  factId: `f${id}`,
  factStatement: `statement ${id}`,
  factSubject: "s",
  factKind,
  action: "forgotten",
  actorKind: "system",
  actorName: null,
  timestamp: "2026-11-14T10:00:00Z",
  revertible: false,
});

it("audit: kinds use the shared labels (raw when unknown) and the lead has no jargon", async () => {
  vi.mocked(apiGet).mockResolvedValue({
    items: [entry("1", "preference"), entry("2", "brand-new-kind")],
    total: 2,
  });
  render(await AuditPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText("preferencia")).toBeInTheDocument();
  expect(screen.getByText("brand-new-kind")).toBeInTheDocument();
  expect(screen.getByText(/hasta 100 entradas/)).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/janitor/);
});

it("health: a status the dashboard does not know reads as unknown, not as a key path", async () => {
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path === "/doctor"
      ? { status: "degraded", checks: [{ name: "db", status: "flaky" }], timestamp: "" }
      : {}
  );
  render(await HealthPage());
  expect(screen.getAllByText(/DESCONOCIDO/)).toHaveLength(2);
  expect(document.body.textContent).not.toMatch(/health\.status/);
});

it("audit: the filters are GET form fields named as the URL, and the API query is unchanged", async () => {
  vi.mocked(apiGet).mockResolvedValue({ items: [], total: 0 });
  render(
    await AuditPage({
      searchParams: Promise.resolve({ actorKind: "user", from: "2026-11-01", q: "x y" }),
    })
  );
  const form = screen.getByRole("searchbox", { name: "Buscar…" }).closest("form")!;
  const fields = new FormData(form);
  expect(fields.get("actorKind")).toBe("user");
  expect(fields.get("from")).toBe("2026-11-01");
  expect(fields.get("to")).toBe("");
  expect(fields.get("q")).toBe("x y");
  // Three filters on, and Clear goes back to the bare page. (The kit's own copy is English here:
  // the test renders without the I18nProvider the layout gives it.)
  expect(screen.getByRole("group", { name: "Filtros" })).toHaveTextContent("3 filters");
  expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
    "href",
    "/admin/audit"
  );
  expect(vi.mocked(apiGet).mock.calls[0]?.[0]).toBe(
    "/audit?limit=100&actorKind=user&from=2026-11-01T00%3A00%3A00.000Z&q=x+y"
  );
});

it("audit: the picked end day is inclusive (from=X&to=X returns that day)", async () => {
  vi.mocked(apiGet).mockResolvedValue({ items: [], total: 0 });
  render(
    await AuditPage({
      searchParams: Promise.resolve({ from: "2026-11-01", to: "2026-11-01" }),
    })
  );
  const url = new URLSearchParams(String(vi.mocked(apiGet).mock.calls[0]?.[0]).split("?")[1]);
  expect(url.get("from")).toBe("2026-11-01T00:00:00.000Z");
  expect(url.get("to")).toBe("2026-11-01T23:59:59.999Z");
});

it("audit: the actor is a segmented radio group with the URL's value checked", async () => {
  vi.mocked(apiGet).mockResolvedValue({ items: [], total: 0 });
  render(await AuditPage({ searchParams: Promise.resolve({ actorKind: "user" }) }));
  const actor = screen.getByRole("radiogroup", { name: "Actor" });
  expect(within(actor).getByRole("radio", { name: "usuario" })).toBeChecked();
  expect(within(actor).getByRole("radio", { name: "todos" })).not.toBeChecked();
  expect(screen.getByRole("button", { name: "Dates: any" })).toBeInTheDocument();
});

it("health: each status maps to a tone with a visible label; vitals use localized numbers", async () => {
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path === "/doctor"
      ? {
          status: "error",
          checks: [
            { name: "a", status: "ok" },
            { name: "b", status: "warn" },
            { name: "c", status: "error" },
            { name: "d", status: "unknown" },
          ],
          timestamp: "",
        }
      : { factsLive: 12345 }
  );
  const { container } = render(await HealthPage());
  const lines = screen.getAllByRole("listitem");
  const tone = (el: HTMLElement) =>
    ["bg-green", "bg-yellow", "bg-red", "bg-text-faint"].find((c) => el.querySelector(`.${c}`));
  expect(lines.map(tone)).toEqual(["bg-green", "bg-yellow", "bg-red", "bg-text-faint"]);
  expect(lines[0]).toHaveTextContent("OK");
  expect(container.querySelector("dd")).toHaveTextContent("12,345");
});

it("audit: a malformed or impossible day in the URL is dropped, not a RangeError", async () => {
  vi.mocked(apiGet).mockResolvedValue({ items: [], total: 0 });
  render(await AuditPage({ searchParams: Promise.resolve({ from: "nope", to: "2026-02-31" }) }));
  expect(vi.mocked(apiGet).mock.calls[0]?.[0]).toBe("/audit?limit=100");
});

it("audit: the filters and the entries are keeper sections, as on the installation audit", async () => {
  vi.mocked(apiGet).mockResolvedValue({ items: [entry("1", "preference")], total: 1 });
  render(await AuditPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole("region", { name: "Filtros" })).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Entradas" })).toBeInTheDocument();
});

it("health: the overall status line says what it is", async () => {
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path === "/doctor" ? { status: "ok", checks: [], timestamp: "" } : {}
  );
  render(await HealthPage());
  expect(screen.getByText("Estado general")).toBeInTheDocument();
});

it("health: vitals come from the bridge's /health, with the last recall and write times", async () => {
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path === "/health"
      ? {
          workspaceId: "w",
          factsLive: 3,
          factsClosed: 1,
          pinnedCount: 0,
          lastRecallAt: "2026-11-14T10:00:00.000Z",
          lastWriteAt: null,
          embeddings: { indexed: 3, pending: 0 },
        }
      : null
  );
  const { container } = render(await HealthPage());
  expect(vi.mocked(apiGet).mock.calls.map((c) => c[0])).toEqual([
    "/doctor",
    "/health",
    "/health/snapshots?days=30",
    "/health/history",
  ]);
  expect(screen.getByText("Última recuperación")).toBeInTheDocument();
  expect(container.querySelector("time")).toHaveAttribute("dateTime", "2026-11-14T10:00:00.000Z");
  expect(screen.getByText("Última escritura").nextElementSibling).toHaveTextContent("Nunca");
});

it("health: the failure copy does not show endpoint paths", async () => {
  vi.mocked(apiGet).mockResolvedValue(null);
  render(await HealthPage());
  expect(document.body.textContent).not.toMatch(/\/(vitals|health|doctor)/);
});

it("health: a long unbroken doctor message wraps instead of running off a phone screen", async () => {
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path === "/doctor"
      ? {
          status: "warn",
          checks: [
            {
              name: "migration_version",
              status: "warn",
              message: "0058_relation_recent_index.sql_is_the_latest_applied_migration_file",
            },
          ],
          timestamp: "",
        }
      : null
  );
  render(await HealthPage());
  const message = screen.getByText(/0058_relation_recent_index/);
  expect(message).toHaveClass("wrap-anywhere", "min-w-0", "basis-full");
});

it("health: a long message shows one line and opens in place with all of it", async () => {
  const long =
    "Latest: 0059_dashboard_session_revocation.sql applied at 2026-11-17 22:22:07.234666+00, with eleven more lines";
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path === "/doctor"
      ? {
          status: "ok",
          checks: [{ name: "migration_version", status: "ok", message: long }],
          timestamp: "",
        }
      : null
  );
  render(await HealthPage());
  const summary = screen.getByText(long);
  expect(summary.tagName).toBe("SUMMARY");
  expect(summary).toHaveClass("truncate", "group-open:whitespace-normal");
  expect(summary.closest("details")).not.toHaveAttribute("open");
});

it("audit: each filter field is labelled through an explicit id (safe across the RSC boundary)", async () => {
  vi.mocked(apiGet).mockResolvedValue({ items: [], total: 0 });
  render(await AuditPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByLabelText("From")).toHaveAttribute("name", "from");
  expect(screen.getByLabelText("To")).toHaveAttribute("name", "to");
  expect(screen.getByLabelText("Buscar…")).toHaveAttribute("id", "audit-q");
});

it("APP-040 health: a 403 shows one access panel and no chart asks to reload", async () => {
  vi.mocked(apiRead).mockResolvedValue({ data: null, status: 403 });
  render(await HealthPage());
  expect(screen.getByTestId("access-denied")).toHaveTextContent("memory:admin");
  expect(document.body.textContent).not.toMatch(/Recarga/);
});

it("APP-040 audit: a 403 shows one access panel instead of the filters and the feed", async () => {
  vi.mocked(apiRead).mockResolvedValue({ data: null, status: 403 });
  render(await AuditPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByTestId("access-denied")).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Filtros" })).toBeNull();
  expect(document.body.textContent).not.toMatch(/Recarga/);
});

it("APP-043 health: a doctor answer of the wrong shape is a load error, not a crash", async () => {
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path === "/doctor" ? { status: "ok", checks: "nope" } : null
  );
  render(await HealthPage());
  expect(
    screen.getByText("No se pudieron ejecutar las verificaciones del doctor.")
  ).toBeInTheDocument();
  expect(screen.queryByText("Estado general")).toBeNull();
});

it("APP-043 audit: a feed of the wrong shape is a load error, not a crash", async () => {
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path.startsWith("/audit?") ? { items: "nope", total: 3 } : null
  );
  render(await AuditPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText("No se pudo cargar el registro de auditoría.")).toBeInTheDocument();
});

it("APP-043 audit: a timeout says the server took too long", async () => {
  vi.mocked(apiRead).mockResolvedValue({ data: null, status: null, timedOut: true });
  render(await AuditPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText(/El servidor tardó demasiado/)).toBeInTheDocument();
});

it("APP-043 audit: a capped feed says how many of the total it shows", async () => {
  vi.mocked(apiGet).mockImplementation(async (path: string) =>
    path.startsWith("/audit?")
      ? { items: Array.from({ length: 100 }, (_, i) => entry(String(i), "preference")), total: 340 }
      : null
  );
  render(await AuditPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText("Se muestran 100 de 340.")).toBeInTheDocument();
});

it("5.4 audit: an entry that names a fact links to it in the catalog; one without does not", async () => {
  vi.mocked(apiGet).mockResolvedValue({
    items: [entry("1", "preference"), { ...entry("2", "preference"), factId: "" }],
    total: 2,
  });
  render(await AuditPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByRole("link", { name: "statement 1" })).toHaveAttribute(
    "href",
    "/browser?open=f1"
  );
  expect(screen.queryByRole("link", { name: "statement 2" })).toBeNull();
  expect(screen.getByText("statement 2")).toBeInTheDocument();
});
