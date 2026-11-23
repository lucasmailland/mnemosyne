// Also fails on rounded corners (owner ruling 2026-11-17: the brand is square): any rounded-*
// utility but rounded-none inside a string, and round SVG corners and caps (rx/ry, round
// linecap or linejoin). The radius tokens in app/globals.css are 0.
//
// Fails on Tailwind arbitrary values (`foo-[...]`) and on fractional spacing/size
// utilities (`p-1.5`, `-mt-0.5`, `sm:gap-2.5`, `w-0.25`: off the 4 px scale) in app/, components/
// and lib/ unless the exact class is listed in lib/tokens-allowlist.json
// ([{ "class": "<exact class>", "reason": "<one line>" }]; a missing file is []).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const allowFile = join(root, "lib/tokens-allowlist.json");
const entries = existsSync(allowFile) ? JSON.parse(readFileSync(allowFile, "utf8")) : [];
// Every exception says why: an entry without a class or a one-line reason fails the check.
const unexplained = entries.filter(
  (e) =>
    typeof e?.class !== "string" ||
    !e.class.trim() ||
    typeof e.reason !== "string" ||
    !e.reason.trim()
);
if (unexplained.length) {
  console.error(
    `lib/tokens-allowlist.json entries need a "class" and a non-empty "reason":\n${unexplained
      .map((e) => JSON.stringify(e))
      .join("\n")}`
  );
  process.exit(1);
}
const allowed = new Set(entries.map((e) => e.class));

function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}

const FRACTIONAL_STEP = new RegExp(
  "(?<![\\w.\\[-])(?:[a-z0-9-]+:)*-?(?:" +
    "p|px|py|pt|pb|pl|pr|ps|pe|m|mx|my|mt|mb|ml|mr|ms|me|gap-x|gap-y|gap|space-x|space-y|size|" +
    "min-w|min-h|max-w|max-h|w|h|top|right|bottom|left|start|end|inset-x|inset-y|inset-s|inset-e|inset|" +
    "translate-x|translate-y|basis|indent|scroll-m[xytblrse]?|scroll-p[xytblrse]?" +
    ")-\\d+\\.\\d+(?![\\w.\\]-])",
  "g"
);

const ROUNDED = /^(?:[a-z0-9-]+:)*rounded(?:-(?!none$)[a-z0-9-]+)?$/;
const ROUND_SVG = /\b(?:rx|ry)=|stroke-?[Ll]ine(?:cap|join)="round"/g;

const found = [];
for (const dir of ["app", "components", "lib"]) {
  for (const file of files(join(root, dir))) {
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, i) => {
        for (const re of [/\b[a-z-]+-\[[^\]]+\]/g, FRACTIONAL_STEP]) {
          for (const m of line.matchAll(re)) {
            if (!allowed.has(m[0])) found.push(`${relative(root, file)}:${i + 1}  ${m[0]}`);
          }
        }
        for (const literal of line.matchAll(/"[^"]*"|'[^']*'|`[^`]*`/g))
          for (const cls of literal[0].slice(1, -1).split(/\s+/))
            if (ROUNDED.test(cls)) found.push(`${relative(root, file)}:${i + 1}  ${cls}`);
        for (const m of line.matchAll(ROUND_SVG))
          found.push(`${relative(root, file)}:${i + 1}  ${m[0]}`);
      });
  }
}

if (found.length) {
  console.error(
    `Arbitrary or fractional-step Tailwind values (outside lib/tokens-allowlist.json) or rounded corners:\n${found.join("\n")}`
  );
  process.exit(1);
}
