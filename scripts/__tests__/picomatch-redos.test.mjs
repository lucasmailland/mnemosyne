// GHSA-fc5q-39xc-vjpf: picomatch <= 4.0.7 compiles repeated extglobs whose
// branch can match a variable-length string (`+(*a)`, `+(a|*a)`, ...) into
// nested quantifiers, and a short input then backtracks for seconds to hours.
// No fixed release exists; patches/picomatch@4.0.7.patch fixes the copy every
// workspace package uses, and patches/next@16.4.6.patch swaps Next's vendored
// copy for a bundle of the patched one. Patched, those patterns compile to a
// literal match, as upstream already does for the repeated extglobs it flags.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const fromRoot = createRequire(root);

// Follow a dependency chain the way Node resolves it from `from`.
const chain = (from, ...names) =>
  names.reduce(
    (req, name) => createRequire(req.resolve(`${name}/package.json`)),
    createRequire(from)
  );

const copies = {
  // What tsup loads through tinyglobby (and fdir, which takes picomatch as a peer).
  tsup: chain(root + "packages/core/package.json", "tsup", "tinyglobby")("picomatch"),
  root: fromRoot("picomatch"),
  next: createRequire(root + "packages/dashboard/package.json")("next/dist/compiled/picomatch"),
};

// Unpatched, each of these takes 0.2-0.6 s on this input and doubles with
// every extra character (at 30 characters: ~26 s each).
const EVIL = "a".repeat(26) + "/";
const SLOW = ["+(*a)", "*(*a)", "+(**a)", "+(*)"];
// Unpatched, these already take tens of seconds at 24 characters, too slow to
// run as a failing test, so they are checked by the shape of the regex: no
// quantified group (`(...)+`, `(...)*`) left to backtrack through.
const RISKY = [...SLOW, "+(a|*a)", "+(a|[a-z])", "+(a|ab|b)"];
const QUANTIFIED_GROUP = /(?<!\\)\)[+*]/;

// Patterns and paths the repo's tooling uses (tsup entries, vitest include and
// exclude globs, Next image/middleware matchers) plus extglobs that must keep
// their meaning.
const SAME = [
  ["**/*.ts", "src/a/b.ts", true],
  ["**/*.ts", "src/a/b.tsx", false],
  ["src/**/*.test.ts", "src/x/__tests__/y.test.ts", true],
  ["**/*.{test,spec}.?(c|m)[jt]s?(x)", "a/b.spec.mts", true],
  ["**/node_modules/**", "x/node_modules/y/z.js", true],
  ["**/!(*.d).ts", "a/b.d.ts", false],
  ["**/!(*.d).ts", "a/b.ts", true],
  ["*.{ts,tsx}", "a.tsx", true],
  ["[abc]*.js", "b1.js", true],
  ["/images/**", "/images/a/b.png", true],
  ["**.example.com", "cdn.example.com", true],
  ["v+([0-9]).+([0-9])", "v12.3", true],
  ["v+([0-9]).+([0-9])", "v1a.3", false],
  ["+(abc)", "abcabc", true],
  ["+(abc)", "abcab", false],
  ["+(foo|bar)", "foobarfoo", true],
  ["+([a-z])", "xyz", true],
  ["+([a-z])", "xy1", false],
  ["+(*(a)|*(b))", "abba", true],
];

for (const [name, pm] of Object.entries(copies)) {
  test(`${name} copy: risky repeated extglobs compile without a quantified group`, () => {
    for (const pattern of RISKY) {
      const { source } = pm.makeRe(pattern);
      assert.doesNotMatch(source, QUANTIFIED_GROUP, `${pattern} -> ${source}`);
    }
  });

  test(`${name} copy: the advisory's inputs finish in milliseconds`, () => {
    for (const pattern of SLOW) {
      const re = pm.makeRe(pattern);
      const start = performance.now();
      re.test(EVIL);
      const ms = performance.now() - start;
      assert.ok(ms < 50, `${pattern} took ${ms.toFixed(0)} ms (${re.source})`);
    }
  });

  test(`${name} copy: ordinary globs still match the same`, () => {
    for (const [pattern, path, expected] of SAME) {
      assert.equal(pm.isMatch(path, pattern), expected, `${pattern} vs ${path}`);
    }
  });
}
