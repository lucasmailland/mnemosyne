// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { I18nProvider } from "@/lib/i18n/client";
import { ROOMS } from "@/lib/rooms";

import { SceneHeading } from "../scene-heading";

afterEach(cleanup);
const home = ROOMS.find((r) => r.id === "home")!;

it("names the h1 after the nav entry, then the room title, with a numeral eyebrow", () => {
  render(<SceneHeading room={home} />);
  expect(screen.getByRole("heading", { level: 1, name: "Home — The atrium" })).toBeTruthy();
  expect(screen.getByText("I · Home")).toBeTruthy();
});

it("speaks Spanish", () => {
  render(
    <I18nProvider locale="es-419">
      <SceneHeading room={home} />
    </I18nProvider>
  );
  expect(screen.getByRole("heading", { level: 1, name: "Inicio — El atrio" })).toBeTruthy();
});
