import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const refresh = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { LanguageSwitch } from "@/components/language-switch";
import { PreferencesForm } from "../preferences-form";

window.history.pushState({}, "", "/dashboard/account"); // cookie Path=/dashboard

afterEach(() => {
  cleanup();
  refresh.mockClear();
  document.cookie = "mnemo_theme=; Max-Age=0";
  document.cookie = "mnemo_locale=; Max-Age=0";
});

it("LanguageSwitch marks the active language and refreshes on change", () => {
  render(<LanguageSwitch />);
  expect(screen.getByRole("button", { name: "English" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Español" }));
  expect(document.cookie).toContain("mnemo_locale=es-419");
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("PreferencesForm exposes labelled radio groups and applies the theme", () => {
  render(<PreferencesForm locale="en-US" theme="light" />);
  expect(screen.getByRole("radiogroup", { name: "Language" })).toBeTruthy();
  expect(screen.getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
  expect(document.cookie).toContain("mnemo_theme=dark");
  expect(refresh).toHaveBeenCalledTimes(1);
});

it("PreferencesForm radios follow the props after a re-render", () => {
  const { rerender } = render(<PreferencesForm locale="en-US" theme="light" />);
  expect((screen.getByRole("radio", { name: "Light" }) as HTMLInputElement).checked).toBe(true);
  rerender(<PreferencesForm locale="es-419" theme="dark" />);
  expect((screen.getByRole("radio", { name: "Dark" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("radio", { name: "Light" }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("radio", { name: "Español" }) as HTMLInputElement).checked).toBe(true);
});

it("PreferencesForm language radios set the locale cookie, show the choice at once and refresh", () => {
  render(<PreferencesForm locale="en-US" theme="light" />);
  const spanish = screen.getByRole("radio", { name: "Español" }) as HTMLInputElement;
  expect(spanish.checked).toBe(false);
  fireEvent.click(spanish);
  expect(document.cookie).toContain("mnemo_locale=es-419");
  expect(refresh).toHaveBeenCalledTimes(1);
});
