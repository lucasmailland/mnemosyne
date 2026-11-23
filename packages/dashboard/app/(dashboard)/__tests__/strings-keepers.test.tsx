import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { I18nProvider } from "@/lib/i18n/client";
import { WorkspacesView } from "../installation/workspaces/workspaces-view";
import { InvitationsSection, MemberControls } from "../admin/members/member-actions";
import { UsersView } from "../installation/users/users-view";
import { SettingsForm } from "../installation/settings/settings-form";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
afterEach(cleanup);

it("renders the members controls in Spanish", () => {
  render(
    <I18nProvider locale="es-419">
      <InvitationsSection invitations={[]} viewerRole="owner" />
      <MemberControls
        userId="u1"
        email="r@e2e.test"
        role="read"
        viewerRole="owner"
        isSelf={false}
      />
    </I18nProvider>
  );
  expect(screen.getByText("No hay invitaciones pendientes.")).toBeInTheDocument();
  expect(screen.getByRole("option", { name: "Lector", selected: true })).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Acciones para r@e2e.test" }));
  expect(screen.getByRole("menuitem", { name: "Quitar a r@e2e.test" })).toBeInTheDocument();
  expect(screen.queryByText("No pending invitations.")).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /Remove/ })).not.toBeInTheDocument();
});

it("renders the installation workspaces list in Spanish with the shared role labels", () => {
  render(
    <I18nProvider locale="es-419">
      <WorkspacesView
        workspaces={[
          {
            id: "w1",
            name: "Equipo",
            tenantName: "t",
            isPersonal: false,
            visibility: "private",
            memberCount: 1,
            owners: [{ id: "u1", email: "o@e2e.test", displayName: null }],
          },
        ]}
      />
    </I18nProvider>
  );
  expect(screen.getByRole("listitem")).toHaveTextContent(/1 miembro · propietario: o@e2e\.test/);
  expect(screen.getByRole("button", { name: "Miembros de Equipo" })).toBeInTheDocument();
  expect(screen.queryByText(/members/)).not.toBeInTheDocument();
});

it("renders the installation users in Spanish: never signed in, and the superadmin role in words", () => {
  render(
    <I18nProvider locale="es-419">
      <UsersView
        viewerId="me"
        users={[
          {
            id: "u1",
            email: "n@e2e.test",
            displayName: null,
            createdAt: "2026-11-01T00:00:00Z",
            lastLoginAt: null,
            disabledAt: null,
            isSuperadmin: false,
            workspaces: [],
          },
        ]}
      />
    </I18nProvider>
  );
  expect(screen.getByText("Nunca inició sesión")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Acciones para n@e2e.test" }));
  expect(
    screen.getByRole("menuitem", { name: "Otorgar el rol de superadministrador a n@e2e.test" })
  ).toHaveTextContent("Otorgar el rol de superadministrador");
});

it("renders the installation settings in Spanish: sections, source tags and the closed registration", () => {
  render(
    <I18nProvider locale="es-419">
      <SettingsForm
        initial={{
          invitationsEnabled: true,
          publicBaseUrl: null,
          registrationMode: "closed",
          workspaceLlmOverride: false,
          workspaceLimitPerUser: 3,
          source: {
            invitationsEnabled: "default",
            publicBaseUrl: "env",
            registrationMode: "default",
            workspaceLlmOverride: "default",
            workspaceLimitPerUser: "global",
          },
        }}
      />
    </I18nProvider>
  );
  expect(screen.getByRole("heading", { name: "Invitaciones y enlaces" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Espacios de trabajo" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "Registro" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Guardar configuración" })).toBeInTheDocument();
  expect(screen.queryByText("Save settings")).not.toBeInTheDocument();
});
