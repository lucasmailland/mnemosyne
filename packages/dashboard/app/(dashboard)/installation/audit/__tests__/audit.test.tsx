/**
 * The security audit: the API query and the filter form are pinned; every action code has an
 * English and a Spanish label, option values and the code in each entry stay raw.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";

import { SECURITY_AUDIT_ACTIONS } from "@/lib/audit-actions";
import { translate } from "@/lib/i18n/core";
import { en } from "@/lib/i18n/messages/en";
import { es } from "@/lib/i18n/messages/es";
import { apiGet } from "@/lib/server-api";
import SecurityAuditPage from "../page";

let locale: "en-US" | "es-419" = "en-US";
vi.mock("@/lib/server-api", () => ({ apiGet: vi.fn(), requireSuperadmin: vi.fn() }));
vi.mock("@/lib/i18n/server", async () => {
  const { translate } = await import("@/lib/i18n/core");
  const { en } = await import("@/lib/i18n/messages/en");
  const { es } = await import("@/lib/i18n/messages/es");
  return {
    getLocale: async () => locale,
    getT: async () => (key: string, vars?: Record<string, string | number>) =>
      translate(locale === "es-419" ? es : en, key as never, vars, locale),
    roomTitle: () => async () => ({}),
  };
});
afterEach(() => {
  cleanup();
  locale = "en-US";
  vi.resetAllMocks();
});

const entry = (id: string, action: string, over: Record<string, unknown> = {}) => ({
  id,
  workspaceId: "w1",
  actorType: "user",
  actorId: "u1",
  actorEmail: "admin@e2e.test",
  action,
  resourceKind: "user",
  resourceId: "u2",
  detail: { role: "read" },
  createdAt: "2026-11-14T10:00:00Z",
  ...over,
});
const render_ = async (searchParams: Record<string, string> = {}) =>
  render(await SecurityAuditPage({ searchParams: Promise.resolve(searchParams) }));

describe("the query and the filters (unchanged)", () => {
  it("sends UTC instants, the actor and the cursor, and keeps the filters in the form", async () => {
    vi.mocked(apiGet).mockResolvedValue({ entries: [], nextCursor: null });
    await render_({
      action: "login_failure",
      actor: " u1 ",
      from: "2026-11-01",
      to: "2026-11-14",
      cursor: "c1",
    });
    expect(apiGet).toHaveBeenCalledWith(
      "/instance/audit?action=login_failure&actor=u1&from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-14T23%3A59%3A59.999Z&cursor=c1"
    );
    // The filters are fields of a GET form named as the URL: the action is a radio behind the
    // Action button, the days sit behind the Dates button, the actor is the search field.
    const form = screen.getByRole("form", { name: "Filter the security audit" }) as HTMLFormElement;
    const fields = new FormData(form);
    expect(fields.get("action")).toBe("login_failure");
    expect(fields.get("actor")).toBe(" u1 ");
    expect(fields.get("from")).toBe("2026-11-01");
    expect(fields.get("to")).toBe("2026-11-14");
    expect(
      screen.getByRole("button", { name: `Action: ${en.installation.audit.actions.login_failure}` })
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Dates: / })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Apply", hidden: true })).toHaveAttribute(
      "type",
      "submit"
    );
    expect(screen.getByRole("link", { name: "Clear filters" })).toHaveAttribute(
      "href",
      "/installation/audit"
    );
    expect(screen.getByRole("link", { name: "Newest entries" })).toHaveAttribute(
      "href",
      "/installation/audit?action=login_failure&actor=+u1+&from=2026-11-01&to=2026-11-14"
    );
  });

  it("shows the empty and the error states, and the older link with the cursor", async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ entries: [], nextCursor: null });
    await render_();
    expect(screen.getByText("No entries match.")).toBeInTheDocument();
    cleanup();
    vi.mocked(apiGet).mockResolvedValueOnce(null);
    await render_();
    expect(screen.getByText(/Could not load the audit/)).toBeInTheDocument();
    cleanup();
    vi.mocked(apiGet).mockResolvedValueOnce({
      entries: [entry("1", "login_success")],
      nextCursor: "n2",
    });
    await render_();
    expect(screen.getByRole("link", { name: "Older entries" })).toHaveAttribute(
      "href",
      "/installation/audit?cursor=n2"
    );
  });

  it("an entry shows who, what, the resource and the details", async () => {
    vi.mocked(apiGet).mockResolvedValue({
      entries: [entry("1", "member_added"), entry("2", "login_failure", { actorEmail: null })],
      nextCursor: null,
    });
    await render_();
    const items = within(screen.getByRole("list", { name: "Audit entries" })).getAllByRole(
      "listitem"
    );
    expect(items[0]).toHaveTextContent("admin@e2e.test");
    expect(items[0]).toHaveTextContent("→ user u2");
    expect(items[0]).toHaveTextContent("Role: Viewer");
    expect(items[1]).toHaveTextContent("user:u1");
  });
});

describe("the action names", () => {
  it.each([
    ["en-US", en],
    ["es-419", es],
  ] as const)("every code has a %s label, and none is the raw code", (loc, messages) => {
    for (const code of SECURITY_AUDIT_ACTIONS) {
      const key = `installation.audit.actions.${code}` as never;
      const label = translate(messages, key, undefined, loc);
      expect(label, code).not.toBe(key);
      expect(label, code).not.toBe(code);
      expect(label.trim(), code).not.toBe("");
    }
  });

  it("the options show the name and keep the raw code as their value", async () => {
    vi.mocked(apiGet).mockResolvedValue({ entries: [], nextCursor: null });
    await render_();
    const options = screen.getAllByRole("radio", { hidden: true });
    expect(options.map((o) => o.getAttribute("value"))).toEqual(["", ...SECURITY_AUDIT_ACTIONS]);
    const label = (o: HTMLElement) => o.closest("label")!.textContent;
    expect(label(options[0]!)).toBe("All actions");
    expect(label(options[1]!)).toBe(en.installation.audit.actions.login_success);
    expect(options.map(label)).not.toContain("login_success");
  });

  it("an entry shows the localized name; the raw code is hidden text after the name and a title", async () => {
    locale = "es-419";
    vi.mocked(apiGet).mockResolvedValue({
      entries: [entry("1", "superadmin_granted"), entry("2", "brand_new_action")],
      nextCursor: null,
    });
    await render_();
    const items = within(screen.getByRole("list", { name: "Entradas de auditoría" })).getAllByRole(
      "listitem"
    );
    const first = items[0]!;
    expect(first).toHaveTextContent(es.installation.audit.actions.superadmin_granted);
    // The raw code stays in the text (assistive tech, e2e) but not as the visible label.
    expect(first).toHaveTextContent("superadmin_granted");
    expect(first.querySelector("[title='superadmin_granted']")).not.toBeNull();
    expect(first.querySelector(".sr-only")?.textContent).toBe(" (superadmin_granted)");
    // An unknown code falls back to itself.
    expect(items[1]).toHaveTextContent("brand_new_action");
  });
});

describe("the resource and the details are localized (AUD-005)", () => {
  const rows = () =>
    within(screen.getByRole("list", { name: "Entradas de auditoría" })).getAllByRole("listitem");

  it("in Spanish, target types and known payload keys and values read as Spanish", async () => {
    locale = "es-419";
    vi.mocked(apiGet).mockResolvedValue({
      entries: [
        entry("1", "member_role_changed"),
        entry("2", "invitation_created", { resourceKind: "invitation", resourceId: "i1" }),
        entry("3", "key_revoke", {
          resourceKind: "api_key",
          resourceId: "k1",
          detail: { revokedAt: "2026-11-14T10:00:00.000Z" },
        }),
        entry("4", "login_failure", {
          resourceKind: "login",
          resourceId: null,
          detail: { identifier: "x@e.test", reason: "invalid_credentials" },
        }),
      ],
      nextCursor: null,
    });
    await render_();
    const [role, invitation, key, login] = rows();
    expect(role).toHaveTextContent("→ usuario u2");
    expect(role).toHaveTextContent("Rol: Lector");
    expect(invitation).toHaveTextContent("→ invitación i1");
    expect(key).toHaveTextContent("→ clave de API k1");
    expect(key).toHaveTextContent("Revocada: 14 nov 2026, 10:00 UTC");
    expect(login).toHaveTextContent("Motivo: credenciales incorrectas");
    const text = document.body.textContent ?? "";
    for (const raw of ["→ user", "→ invitation", "→ api_key", "role=", "revokedAt", "reason="])
      expect(text).not.toContain(raw);
  });

  it("an unknown type or key shows as a code, labelled, not as broken copy", async () => {
    locale = "es-419";
    vi.mocked(apiGet).mockResolvedValue({
      entries: [
        entry("1", "member_added", {
          resourceKind: "widget",
          detail: { brandNewKey: "v", role: "galactic" },
        }),
      ],
      nextCursor: null,
    });
    await render_();
    const [row] = rows();
    expect(within(row!).getByText("widget").tagName).toBe("CODE");
    expect(within(row!).getByText("brandNewKey:").tagName).toBe("CODE");
    expect(row).toHaveTextContent("Rol: galactic");
    // Prose labels wrap at word boundaries; only raw codes break anywhere.
    expect(row!.querySelector("dl")).not.toHaveClass("break-all");
    expect(within(row!).getByText("v")).toHaveClass("break-all");
    // The actor → resource line too: break-all is only ever on a raw code.
    const breakAll = [...row!.querySelectorAll(".break-all")].map((el) => el.tagName);
    expect(new Set(breakAll)).toEqual(new Set(["CODE"]));
  });

  it.each([
    ["en-US", en],
    ["es-419", es],
  ] as const)("every resource kind the server writes has a %s label", (loc, messages) => {
    for (const kind of [
      "user",
      "invitation",
      "api_key",
      "login",
      "link",
      "workspace",
      "settings",
      "llm_config",
    ]) {
      const key = `installation.audit.resources.${kind}` as never;
      expect(translate(messages, key, undefined, loc), kind).not.toBe(key);
    }
  });
});
