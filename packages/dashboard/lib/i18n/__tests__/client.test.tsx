import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { I18nProvider, useT } from "../client";

function Probe() {
  return <p>{useT()("common.signOut")}</p>;
}

describe("I18nProvider", () => {
  it("defaults to English without a provider", () => {
    render(<Probe />);
    expect(screen.getByText("Sign out")).toBeTruthy();
  });
  it("renders Spanish inside an es-419 provider", () => {
    render(
      <I18nProvider locale="es-419">
        <Probe />
      </I18nProvider>
    );
    expect(screen.getByText("Cerrar sesión")).toBeTruthy();
  });
});
