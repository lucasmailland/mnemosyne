// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  Checkbox,
  ConfirmDialog,
  Field,
  RecordRow,
  Records,
  Section,
  StatusDot,
  StatusTag,
} from "../keeper";

afterEach(cleanup);

it("Section is a region named by its h2, with the title and the action", () => {
  render(
    <Section title="Members" action={<button>Invite</button>}>
      body
    </Section>
  );
  const heading = screen.getByRole("heading", { level: 2, name: "Members" });
  expect(screen.getByRole("region", { name: "Members" })).toBeTruthy();
  // Focus can be moved to it (after a row it held is gone), but Tab skips it.
  expect(heading.getAttribute("tabindex")).toBe("-1");
  expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
  expect(screen.getByText("body")).toBeTruthy();
});

it("Records is a labelled list of records", () => {
  render(
    <Records label="People">
      <RecordRow>Ana</RecordRow>
      <RecordRow>Luis</RecordRow>
    </Records>
  );
  expect(screen.getByRole("list", { name: "People" })).toBeTruthy();
  expect(screen.getAllByRole("listitem")).toHaveLength(2);
});

it("StatusTag is outline only, never a background fill", () => {
  render(<StatusTag tone="good">Active</StatusTag>);
  expect(screen.getByText("Active").className).not.toMatch(/(^|\s)bg-/);
});

it("StatusDot shows its label as text", () => {
  render(<StatusDot tone="bad" label="Down" />);
  expect(screen.getByText("Down")).toBeTruthy();
});

it("Field associates the label with its control and wires the hint", () => {
  render(
    <Field label="Name" hint="Shown to others">
      <input />
    </Field>
  );
  const input = screen.getByLabelText("Name");
  expect(input.tagName).toBe("INPUT");
  const hint = screen.getByText("Shown to others");
  expect(input.getAttribute("aria-describedby")).toBe(hint.id);
});

it("Field honors an explicit htmlFor", () => {
  render(
    <Field label="Email" htmlFor="mail">
      <input id="mail" />
    </Field>
  );
  expect(screen.getByLabelText("Email").id).toBe("mail");
});

it("Checkbox is labelled", () => {
  render(<Checkbox label="Remember" />);
  expect(screen.getByRole("checkbox", { name: "Remember" })).toBeTruthy();
});

it("ConfirmDialog confirms, closes on Escape and focuses Cancel first when dangerous", () => {
  const onConfirm = vi.fn();
  const onClose = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Delete key"
      body="This cannot be undone."
      confirmLabel="Delete"
      tone="danger"
      onConfirm={onConfirm}
      onClose={onClose}
    />
  );
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
  fireEvent(
    screen.getByRole("dialog", { hidden: true }),
    new Event("cancel", { cancelable: true })
  );
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("ConfirmDialog disables confirm while busy; Field keeps an existing describedby", () => {
  const onConfirm = vi.fn();
  const { rerender } = render(
    <ConfirmDialog
      open
      title="T"
      body="b"
      confirmLabel="Go"
      busy
      onConfirm={onConfirm}
      onClose={() => {}}
    />
  );
  const go = screen.getByRole("button", { name: "Go" }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  expect(go.getAttribute("aria-busy")).toBe("true");
  rerender(<div />);
  render(
    <Field label="N" hint="h">
      <input aria-describedby="other" />
    </Field>
  );
  expect(screen.getByLabelText("N").getAttribute("aria-describedby")).toMatch(/^other /);
});

it("ConfirmDialog while busy: Cancel is disabled and Escape does not close it", () => {
  const onClose = vi.fn();
  render(
    <ConfirmDialog
      open
      title="Revoke"
      body="b"
      confirmLabel="Revoke"
      tone="danger"
      busy
      onConfirm={() => {}}
      onClose={onClose}
    />
  );
  expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent(
    screen.getByRole("dialog", { hidden: true }),
    new Event("cancel", { cancelable: true })
  );
  expect(onClose).not.toHaveBeenCalled();
});

it("Dialog is a square panel on the type scale that fades in", () => {
  render(
    <ConfirmDialog
      open
      title="T"
      body="b"
      confirmLabel="Go"
      onConfirm={() => {}}
      onClose={() => {}}
    />
  );
  const dialog = screen.getByRole("dialog", { hidden: true });
  // Square, like every corner of the dashboard.
  expect(dialog.className).not.toMatch(/\brounded/);
  expect(dialog.className).toMatch(/\bmodal\b/);
  expect(screen.getByRole("heading", { name: "T" }).className).toMatch(/\btext-ui-lg\b/);
});

/**
 * AUD-002: a Server Component page hands its Field children across the RSC boundary, and the
 * client can receive them as a lazy node (not yet a React element) depending on chunk timing.
 * Field read `children.props.id` and the page fell into the error boundary on ~40% of loads.
 */
const lazyNode = (element: ReactElement) =>
  ({
    $$typeof: Symbol.for("react.lazy"),
    _payload: element,
    _init: (payload: ReactElement) => payload,
  }) as unknown as ReactElement<{ id?: string }>;

it("Field renders a lazy (RSC) child without reading its props, labelled by htmlFor", () => {
  render(
    <Field label="From" htmlFor="audit-from">
      {lazyNode(<input id="audit-from" name="from" />)}
    </Field>
  );
  expect(screen.getByLabelText("From").getAttribute("name")).toBe("from");
});

it("Field without htmlFor does not crash on a lazy (RSC) child", () => {
  render(
    <Field label="To" hint="Inclusive">
      {lazyNode(<input name="to" />)}
    </Field>
  );
  expect(document.querySelector('input[name="to"]')).not.toBeNull();
  expect(screen.getByText("To").tagName).toBe("LABEL");
});

it("every Field in a Server Component file passes htmlFor (its child may arrive lazy)", () => {
  const root = join(__dirname, "..", "..", "app");
  const offenders: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "__tests__") walk(path);
      } else if (name.endsWith(".tsx")) {
        const src = readFileSync(path, "utf8");
        if (/^\s*["']use client["']/.test(src)) continue;
        for (const tag of src.match(/<Field\b[^>]*>/g) ?? [])
          if (!tag.includes("htmlFor")) offenders.push(`${path}: ${tag}`);
      }
    }
  };
  walk(root);
  expect(offenders).toEqual([]);
});
