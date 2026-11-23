// Stand-in for flyctl in canary-rollout.test.mjs. Machines live in the JSON file
// at $FAKE_FLY_STATE; every call is appended to $FAKE_FLY_LOG. Understands only
// what scripts/canary-rollout.mjs runs.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_FLY_LOG, `${JSON.stringify(args)}\n`);
const state = JSON.parse(readFileSync(process.env.FAKE_FLY_STATE, "utf8"));
const flag = (name) => args[args.indexOf(name) + 1];
const save = () => writeFileSync(process.env.FAKE_FLY_STATE, JSON.stringify(state));

if (flag("--app") !== "mnemosyne") {
  console.error(`fake fly: unexpected app ${flag("--app")}`);
  process.exit(1);
}
const [cmd, sub, id] = args;
if (cmd === "machine" && sub === "list" && args.includes("--json")) {
  process.stdout.write(JSON.stringify(state.machines));
} else if (cmd === "machine" && sub === "update" && args.includes("--yes")) {
  const m = state.machines.find((x) => x.id === id);
  if (!m) {
    console.error(`fake fly: no machine ${id}`);
    process.exit(1);
  }
  m.config.image = flag("--image");
  save();
} else if (cmd === "deploy" && flag("--strategy") === "rolling") {
  for (const m of state.machines) if (m.state === "started") m.config.image = flag("--image");
  save();
} else {
  console.error(`fake fly: unsupported ${args.join(" ")}`);
  process.exit(1);
}
