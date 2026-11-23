import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkPair } from "../check-doc-translations.mjs";

const EN = `# Title

**English** · [Español](a.es.md)

## Setup

\`\`\`bash
pnpm install
\`\`\`

| a | b |
| - | - |
| 1 | 2 |

See [other](other.md#x) and [web](https://example.com) and [here](#setup).
`;
const ES = `# Título

[English](a.md) · **Español**

## Configuración

\`\`\`bash
pnpm install
\`\`\`

| a | b |
| - | - |
| 1 | 2 |

Consulta [otro](other.md#x) y [web](https://example.com) y [aquí](#configuración).
`;

// Writes a fixture dir with a.md / a.es.md (plus other.md) and returns the failures.
function run(en = EN, es = ES) {
  const d = mkdtempSync(join(tmpdir(), "doc-guard-"));
  writeFileSync(join(d, "other.md"), "# o\n");
  writeFileSync(join(d, "a.md"), en);
  if (es !== null) writeFileSync(join(d, "a.es.md"), es);
  return checkPair(join(d, "a.md"), join(d, "a.es.md"));
}
const rules = (f) => f.map((x) => x.rule);

test("passing pair has no failures", () => assert.deepEqual(run(), []));

test("missing sibling", () => assert.deepEqual(rules(run(EN, null)), ["sibling"]));

test("switch line missing or misplaced", () => {
  assert.ok(
    rules(run(EN.replace("**English** · [Español](a.es.md)", "hola"))).includes("switch-line")
  );
  assert.ok(
    rules(
      run(EN, ES.replace("[English](a.md) · **Español**", "[English](b.md) · **Español**"))
    ).includes("switch-line")
  );
});

test("code blocks differ (content, info string, order)", () => {
  assert.ok(rules(run(EN, ES.replace("pnpm install", "pnpm i"))).includes("code-blocks"));
  assert.ok(rules(run(EN, ES.replace("```bash", "```sh"))).includes("code-blocks"));
  const two = (a, b) => EN + "\n```\n" + a + "\n```\n\n~~~\n" + b + "\n~~~\n";
  assert.ok(
    rules(run(two("x", "y"), ES + "\n~~~\ny\n~~~\n\n```\nx\n```\n")).includes("code-blocks")
  );
});

test("fenced content is ignored by heading, table and vos checks", () => {
  const f = "\n```\n# not a heading\n| not | a row |\nusá esto\n```\n";
  assert.deepEqual(run(EN + f, ES + f), []);
});

test("heading counts per level", () =>
  assert.ok(
    rules(run(EN, ES.replace("## Configuración", "### Configuración"))).includes("headings")
  ));

test("table row counts", () =>
  assert.ok(rules(run(EN, ES.replace("| 1 | 2 |\n", ""))).includes("table-rows")));

test("relative links must exist", () => {
  const bad = run(EN, ES.replace("other.md#x", "missing.md#x"));
  assert.deepEqual(rules(bad), ["links"]);
  assert.match(bad[0].detail, /missing\.md/);
  assert.deepEqual(run(EN, ES.replace("(other.md#x)", '(other.md "Título")')), []);
});

test("same-file #anchor links must match a heading", () => {
  const broken = run(EN, ES.replace("(#configuración)", "(#setup)"));
  assert.deepEqual(
    broken.map((f) => f.detail),
    ["broken anchor #setup"]
  );
});

test("vos forms ending in an accented letter are caught (\\b is ASCII-only in JS)", () => {
  assert.ok(rules(run(EN, ES + "\nPrimero usá.\n")).includes("vos"));
  assert.ok(rules(run(EN, ES + "\nSi podés, avisame\n")).includes("vos"));
  assert.ok(!rules(run(EN, ES + "\nEstá bien y es más simple.\n")).includes("vos"));
});

test("vos forms in Spanish prose", () => {
  assert.ok(rules(run(EN, ES + "\nUsá esto y tenés que sos.\n")).includes("vos"));
  assert.deepEqual(run(EN, ES + "\nUsa `usá` aquí.\n"), []);
});
