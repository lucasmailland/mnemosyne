const fs = require("node:fs");
const path = require("node:path");

const args = process.argv.slice(2);
const isCheck = args.includes("--check");
// Positional arguments: `<dst>` (tests sync into a temp dir instead of the shared copy) or
// `<src> <dst>`; both default to packages/plugin -> packages/cli/plugin.
const positional = args.filter((a) => !a.startsWith("--"));
const [srcArg, dstArg] = positional.length >= 2 ? positional : [undefined, positional[0]];
const src = path.resolve(srcArg || path.resolve(__dirname, "../../plugin"));
const dst = path.resolve(dstArg || path.resolve(__dirname, "../plugin"));

function listFiles(dir, prefix = "") {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((e) => {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    const full = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(full, rel) : e.isFile() ? [rel] : [];
  });
}

if (isCheck) {
  if (!fs.existsSync(src)) {
    console.error(`Source directory not found: ${src}`);
    process.exit(1);
  }
  const srcFiles = new Set(listFiles(src));
  const dstFiles = new Set(listFiles(dst));
  const missing = [...srcFiles].filter((f) => !dstFiles.has(f));
  const extra = [...dstFiles].filter((f) => !srcFiles.has(f));
  const different = [...srcFiles].filter(
    (f) =>
      dstFiles.has(f) &&
      !fs.readFileSync(path.join(src, f)).equals(fs.readFileSync(path.join(dst, f)))
  );

  if (missing.length || extra.length || different.length) {
    missing.forEach((f) => console.error(`Missing mirror file: ${f}`));
    extra.forEach((f) => console.error(`Extra mirror file: ${f}`));
    different.forEach((f) => console.error(`Byte-different mirror file: ${f}`));
    process.exit(1);
  }
  console.log("Plugin mirror is up to date");
  process.exit(0);
}

if (fs.existsSync(src)) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
  console.log(`Synced packages/plugin -> ${path.relative(process.cwd(), dst) || dst}`);
} else {
  console.warn("Warning: packages/plugin not found to sync");
}
