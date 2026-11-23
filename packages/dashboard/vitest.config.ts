import { defineConfig } from "vitest/config";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// next/image static imports resolve to StaticImageData at build time; tests get a stub
// with the file's REAL dimensions, read from its header (so size rules are enforceable).
function imageSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  if (/\.png$/.test(file)) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (/\.jpe?g$/.test(file)) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1]!;
      // Fill bytes (FF FF…) and standalone markers (TEM, RSTn, SOI, EOI) carry no length.
      if (marker === 0xff) {
        i++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        i += 2;
        continue;
      }
      // Every start-of-frame (baseline, progressive, lossless, arithmetic): C0–CF except the
      // Huffman table (C4), JPG extension (C8) and arithmetic conditioning (CC) markers.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  } else {
    const tag = buf.toString("utf8", 0, 2000).match(/<svg[^>]*>/s)?.[0] ?? "";
    const w = tag.match(/\swidth="([\d.]+)/);
    const h = tag.match(/\sheight="([\d.]+)/);
    if (w && h) return { width: parseFloat(w[1]), height: parseFloat(h[1]) };
    const vb = tag.match(/viewBox="[\d.\-]+[ ,]+[\d.\-]+[ ,]+([\d.]+)[ ,]+([\d.]+)/);
    if (vb) return { width: parseFloat(vb[1]), height: parseFloat(vb[2]) };
  }
  throw new Error(`static-image-stub: cannot read size of ${file}`);
}

const staticImageStub = {
  name: "static-image-stub",
  enforce: "pre" as const,
  resolveId(id: string) {
    return /\.(jpe?g|png|svg)$/.test(id) ? `\0img:${id.replace(/^@\//, `${__dirname}/`)}` : null;
  },
  load(id: string) {
    if (!id.startsWith("\0img:")) return null;
    const file = id.slice(5);
    return `export default ${JSON.stringify({ src: file, ...imageSize(file) })};`;
  },
};

/**
 * TEST-2 — MVP test scaffold.
 *
 * NO @vitejs/plugin-react on purpose. It was here to transform JSX, and vitest
 * does that itself: esbuild reads `"jsx": "react-jsx"` from tsconfig and emits
 * the automatic runtime. What the plugin adds on top is Fast Refresh, which
 * means nothing in a test run.
 *
 * Removed while looking at dependabot #209 (plugin-react 4 -> 6), which broke
 * the test startup outright: plugin-react 6 imports `vite/internal`, and the
 * vite that vitest brings (6.4.3) does not export it. The upgrade path was a
 * vite 7 major; the actual fix was that nothing needed the plugin. Dropping it
 * took the suite from 5 passing with one file unable to start, to 7 passing. No coverage thresholds by design (per the
 * audit remediation plan: "MVP only, do NOT try for coverage thresholds
 * in this pass"). jsdom is only needed by the component test; the
 * server-api test runs fine under it too (no DOM APIs used).
 */
export default defineConfig({
  plugins: [staticImageStub],
  resolve: {
    alias: {
      "@": resolve(__dirname, "."),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    // e2e/ holds Playwright specs (`pnpm test:e2e`), not vitest tests.
    exclude: ["**/node_modules/**", "**/.next/**", "e2e/**"],
  },
});
