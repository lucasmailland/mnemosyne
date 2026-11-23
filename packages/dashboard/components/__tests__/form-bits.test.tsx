import { expect, it } from "vitest";

import {
  dangerButton,
  dangerGhostButton,
  ghostButton,
  inputClass,
  primaryButton,
  selectClass,
} from "../form-bits";

it("every control has a 40 px target and no half-step utilities", () => {
  for (const c of [
    inputClass,
    selectClass,
    dangerButton,
    ghostButton,
    dangerGhostButton,
    primaryButton,
  ]) {
    expect(c).toContain("min-h-10");
    expect(c).not.toMatch(/-\d+\.5\b/);
  }
});
