import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PasswordForm } from "../password-form.js";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("AUTH-08 sends current/new password and clears fields on success", async () => {
  const fetchMock = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PasswordForm />);
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "the current password" },
  });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "the replacement password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith(
      "/dashboard/auth/password",
      expect.objectContaining({
        body: JSON.stringify({
          currentPassword: "the current password",
          newPassword: "the replacement password",
        }),
      })
    )
  );
  expect(await screen.findByRole("status")).toHaveTextContent("Password changed");
  expect(screen.getByLabelText("Current password")).toHaveValue("");
});
it("AUTH-11 focuses and announces password change errors", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "invalid_credentials" }, { status: 401 }))
  );
  render(<PasswordForm />);
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "the wrong password" },
  });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "the replacement password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("Could not verify your current password");
  // APP-058: announced once (role="alert", no extra live region); the field it is about is
  // marked invalid, points at the message and takes focus.
  expect(alert).not.toHaveAttribute("aria-live");
  const current = screen.getByLabelText("Current password");
  expect(current).toHaveAttribute("aria-invalid", "true");
  expect(current).toHaveAttribute("aria-errormessage", alert.id);
  await waitFor(() => expect(current).toHaveFocus());
  expect(screen.getByLabelText("New password")).not.toHaveAttribute("aria-invalid");
});

it("APP-058 a too-short new password marks the new password field, not the current one", async () => {
  vi.stubGlobal("fetch", vi.fn());
  render(<PasswordForm />);
  fireEvent.change(screen.getByLabelText("Current password"), { target: { value: "x" } });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  const alert = await screen.findByRole("alert");
  const next = screen.getByLabelText("New password");
  expect(next).toHaveAttribute("aria-invalid", "true");
  expect(next).toHaveAttribute("aria-errormessage", alert.id);
  expect(screen.getByLabelText("Current password")).not.toHaveAttribute("aria-invalid");
  // Typing again clears the mark with the message.
  fireEvent.change(next, { target: { value: "shorter" } });
  expect(next).not.toHaveAttribute("aria-invalid");
});

it("AUTH-16 clears stale server feedback before validating the edited password", async () => {
  const fetchMock = vi.fn(async () => Response.json({}, { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  render(<PasswordForm />);
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "wrong password" },
  });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "replacement password" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not verify");
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "short" } });
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("at least 12 characters");
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
it("AUTH-16 validates Unicode byte limits without sending the password", async () => {
  const fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  render(<PasswordForm />);
  fireEvent.change(screen.getByLabelText("Current password"), {
    target: { value: "current password" },
  });
  fireEvent.change(screen.getByLabelText("New password"), { target: { value: "é".repeat(37) } });
  fireEvent.click(screen.getByRole("button", { name: "Change password" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("at most 72 UTF-8 bytes");
  expect(fetchMock).not.toHaveBeenCalled();
});
