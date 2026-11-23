// Ships @mnemo-ai/harness inside the CLI (it is not on npm). Runs after tsup,
// whose dts step deletes every .d.ts under dist/ and would strip them from the
// copy. Host capture is only enabled when the digest of the harness dist that
// runs matches its qualification record, so the copy is the harness build
// byte for byte, plus its records and fixtures, under a package.json named
// @mnemo-ai/harness, which is how the harness finds its own root.
const fs = require("node:fs");
const path = require("node:path");

const src = path.resolve(__dirname, "../../harness");
// Optional destination: the test copies into a temp dir instead of dist/.
const dst = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(__dirname, "../dist/harness");
const manifest = JSON.parse(fs.readFileSync(path.join(src, "package.json"), "utf8"));

fs.rmSync(dst, { recursive: true, force: true });
for (const dir of ["dist", "qualifications", "fixtures"]) {
  fs.cpSync(path.join(src, dir), path.join(dst, dir), { recursive: true });
}
fs.writeFileSync(
  path.join(dst, "package.json"),
  JSON.stringify(
    { name: manifest.name, version: manifest.version, type: "module", private: true },
    null,
    2
  ) + "\n"
);
console.log(`Copied packages/harness -> ${path.relative(process.cwd(), dst) || dst}`);
