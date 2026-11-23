import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BRAND_ICONS, BRAND_IMAGES, SPINNER } from "../images";

describe("brand registry", () => {
  it("registers every brand image at its full -th size", () => {
    expect(Object.keys(BRAND_IMAGES)).toHaveLength(23);
    for (const img of Object.values(BRAND_IMAGES)) {
      expect(Math.min(img.width, img.height)).toBeGreaterThanOrEqual(180);
    }
  });

  it("reports real sizes: the panoramas are wider than tall", () => {
    for (const id of ["pano-palace", "pano-water"] as const) {
      expect(BRAND_IMAGES[id].width).toBeGreaterThan(BRAND_IMAGES[id].height);
    }
  });

  it("registers the eight brand icons and the spinner", () => {
    expect(Object.keys(BRAND_ICONS).sort()).toEqual([
      "embed",
      "forget",
      "persist",
      "recall",
      "remember",
      "search",
      "session",
      "store",
    ]);
    // Spec §1: an SVG drawn as <img> must loop (it cannot be restarted from outside).
    expect(SPINNER.width).toBeGreaterThan(0);
    const svg = readFileSync(SPINNER.src, "utf8");
    expect(svg).toMatch(/infinite|repeatCount="indefinite"/);
    expect(svg).not.toMatch(/repeatCount="(?!indefinite)/);
  });
});
