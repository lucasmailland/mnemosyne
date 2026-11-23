#!/bin/bash
# Contract catalog: docs/testing/hook-output-budget.md
# Uses only local subprocesses and fake upstreams, through the repo's hook runner.
set -euo pipefail
TEST_DIR="$(cd "$(dirname "$0")" && pwd)"
python3 - "$TEST_DIR" <<'PYEOF'
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

# The canonical and bundled test have different depths. Do not depend on cwd,
# HOME, git configuration, or an installed mnemo to locate the checkout.
repo = next((p for p in Path(sys.argv[1]).resolve().parents
             if (p / "pnpm-workspace.yaml").is_file()), None)
if repo is None:
    sys.exit("FAIL: FM-HOOK-05 repository root not found")
source = repo / "packages/plugin"
# packages/cli/plugin is not versioned: the CLI's prebuild generates it. Run the
# same sync script into a private temp dir so the bundled checks exercise what a
# build ships without deleting and recreating the shared checkout copy, which
# other test workers may be reading concurrently.
bundled_tmp = tempfile.TemporaryDirectory(prefix="hook-output-mirror-")
bundled = Path(bundled_tmp.name) / "plugin"
subprocess.run(["node", str(repo / "packages/cli/scripts/sync-plugin.cjs"), str(source), str(bundled)],
               check=True, stdout=subprocess.DEVNULL)
NAMES = {source: "packages/plugin", bundled: "packages/cli/plugin"}
passed = failed = 0


def check(label, condition):
    global passed, failed
    if condition:
        passed += 1
        print(f"PASS: {label}")
    else:
        failed += 1
        print(f"FAIL: {label}")


helper = source / "scripts/_hook-output.sh"
required = ("scripts/_helpers.sh", "scripts/_hook-output.sh", "scripts/session-start.sh",
            "scripts/post-compaction.sh", "scripts/__tests__/hook-output-budget.test.sh")
trees_exist = all((copy / name).is_file() for copy in (source, bundled) for name in required)
check("FM-HOOK-05 both plugin trees contain the required hooks and test", trees_exist)
if not trees_exist:
    sys.exit("FAIL: missing plugin files; refusing to test empty trees")

# FM-HOOK-06: runtime hooks must never write files. Sourcing the helper once
# overwrote the bundled harness-hook.test.sh mirror whenever it differed,
# discarding local edits and hiding the drift FM-HOOK-04 exists to detect.
# Mirror sync belongs to the explicit sync command (scripts/sync-plugin.cjs).
# Runs before anything else sources the real helper inside the checkout.
for copy in (source, bundled):
    with tempfile.TemporaryDirectory(prefix="hook-output-nowrite-") as tmp:
        scripts = Path(tmp) / "plugin/scripts"
        mirror = Path(tmp) / "cli/plugin/scripts/__tests__/harness-hook.test.sh"
        (scripts / "__tests__").mkdir(parents=True)
        mirror.parent.mkdir(parents=True)
        shutil.copy(copy / "scripts/_hook-output.sh", scripts / "_hook-output.sh")
        (scripts / "__tests__/harness-hook.test.sh").write_text("canonical\n")
        mirror.write_text("local edit\n")
        sourced = subprocess.run(
            ["/bin/bash", "-c", 'source "$1"', "bash", str(scripts / "_hook-output.sh")],
            env={"PATH": os.environ.get("PATH", os.defpath)}, capture_output=True,
        )
        check(f"FM-HOOK-06 {NAMES[copy]} helper sources cleanly", sourced.returncode == 0)
        check(f"FM-HOOK-06 {NAMES[copy]} helper never overwrites mirror files",
              mirror.read_text() == "local edit\n")

value = subprocess.check_output(
    ["/bin/bash", "-c", 'source "$1"; printf "%s" "$HOOK_OUTPUT_BUDGET_BYTES"', "bash", str(helper)],
    env={"PATH": os.defpath},
)
budget = int(value)
# Audit 2026-11-22: the hook carries only per-session state; the protocol is
# the MCP server's instructions, so the budget dropped from 6000 to 1500.
check("FM-HOOK-01 shared named budget exists and is <= 1500", 0 < budget <= 1500)

# Compare the full shipped tree: sync-plugin.cjs copies all of it, including tests.
src_files = {p.relative_to(source) for p in source.rglob("*") if p.is_file()}
dst_files = {p.relative_to(bundled) for p in bundled.rglob("*") if p.is_file()}
check("FM-HOOK-04 identical plugin file sets", src_files == dst_files)
check("FM-HOOK-04 identical plugin file bytes", all(
    (source / p).read_bytes() == (bundled / p).read_bytes() for p in src_files & dst_files
))

session_id = "8b258f30-d014-461f-9398-c2656799409a"
# The protocol reaches the model once, as MCP server instructions. These are
# phrases of the old in-hook copy; seeing one again means it came back.
protocol_copy = ["Save proactively", "Statements:", "Fact subtype", "Pure MCP only",
                 "Conflicts:", "Workspace is fixed", "Errors:"]

with tempfile.TemporaryDirectory(prefix="hook-output-test-", dir=repo) as tmp:
    root = Path(tmp)
    project = root / "example-project"
    unconfigured_project = root / "unconfigured-project"
    bindir = root / "bin"
    for p in (project / ".git", unconfigured_project / ".git", bindir):
        p.mkdir(parents=True)
    (project / ".mnemo.json").write_text(json.dumps({"workspaceId": "ws-example", "label": "Example project"}) + "\n")
    # Only the actual shell utilities are exposed; no caller PATH entries,
    # mnemo binary, git global config, shell startup variables, or credentials.
    tool_path = os.pathsep.join((os.defpath, "/opt/homebrew/bin", "/usr/local/bin"))
    for name in ("bash", "jq", "awk", "basename", "cat", "chmod", "date", "dirname",
                 "find", "mkdir", "mktemp", "rm", "sed", "tr", "wc"):
        tool = shutil.which(name, path=tool_path)
        if tool is None:
            sys.exit(f"FAIL: FM-HOOK-05 required test utility missing: {name}")
        (bindir / name).symlink_to(tool)
    git = bindir / "git"
    git.write_text("#!/bin/bash\nexit 1\n")
    git.chmod(0o755)
    curl = bindir / "curl"
    curl.write_text(f"#!{sys.executable}\n" + '''
import json, os, sys
args = sys.argv[1:]
with open(os.environ["TEST_CURL_LOG"], "a") as log:
    log.write("called\\n")
if os.environ.get("UPSTREAM_DOWN") == "1":
    sys.exit(7)
size = int(os.environ.get("METADATA_SIZE", "1"))
if any(a.endswith("/me") for a in args):
    print(json.dumps({"workspaceId": "ws-example", "workspaceName": "Example workspace" * size, "workspaceRole": "write"}))
elif any(a.endswith("/session/start") for a in args):
    print(json.dumps({"id": os.environ["TEST_SESSION_ID"]}))
elif any(a.endswith("/health") for a in args):
    body = json.dumps({"workspaceId": "ws-example", "factsLive": 142, "factsClosed": 9, "lastWriteAt": "2026-10-21T10:30:00Z" + "界" * (size - 1)})
    if "-o" in args:
        with open(args[args.index("-o") + 1], "w") as f:
            f.write(body)
        print("200", end="")
    else:
        print(body)
else:
    sys.exit(7)
''')
    curl.chmod(0o755)
    env = dict(TMPDIR=str(root), PATH=str(bindir), LC_ALL="C", TEST_SESSION_ID=session_id)
    check("FM-HOOK-05 isolated PATH has no mnemo binary", shutil.which("mnemo", path=env["PATH"]) is None)
    payload = {"session_id": "claude-example-session", "cwd": str(project), "source": "startup",
               "hook_event_name": "SessionStart", "model": "test-model"}

    for copy in (source, bundled):
        for scenario in ("realistic", "oversized", "long-id", "oversized-id", "unavailable", "no-host-id",
                         "empty-home", "no-mapping"):
            active_id = "s" * 128 if scenario == "long-id" else "s" * 6001 if scenario == "oversized-id" else session_id
            for hook in ("session-start.sh", "post-compaction.sh"):
                home = root / NAMES[copy] / scenario / hook
                home.mkdir(parents=True)
                if scenario not in ("unavailable", "empty-home", "no-mapping"):
                    sessions = home / ".mnemo/sessions"
                    sessions.mkdir(parents=True)
                    (sessions / "claude-example-session.json").write_text(
                        json.dumps({"mnemoSessionId": active_id, "workspaceId": "ws-example"}) + "\n")
                data = dict(payload)
                cwd = unconfigured_project if scenario == "empty-home" else project
                data["cwd"] = str(cwd)
                if hook == "post-compaction.sh":
                    data["source"] = "compact"
                if scenario == "no-host-id":
                    data.pop("session_id")
                curl_log = home / "curl.log"
                child_env = dict(env, HOME=str(home), TEST_CURL_LOG=str(curl_log),
                                 METADATA_SIZE="10000" if scenario == "oversized" else "1",
                                 UPSTREAM_DOWN="1" if scenario == "unavailable" else "0", TEST_SESSION_ID=active_id)
                if scenario != "empty-home":
                    child_env.update(MNEMO_URL="http://offline.invalid", MNEMO_KEY="test-placeholder",
                                     MNEMO_WORKSPACE_ID="ws-example")
                result = subprocess.run(["bash", str(copy / "scripts" / hook)], input=json.dumps(data).encode(),
                                        capture_output=True, env=child_env, cwd=cwd, timeout=10)
                out = result.stdout
                text = out.decode("utf-8")  # Fail on a broken multibyte truncation.
                label = f"{NAMES[copy]}/{hook} {scenario}"
                print(f"MEASURE: {label}: {len(out)} bytes")
                check(f"FM-HOOK-01 {label} exits 0 and fits {budget} bytes", result.returncode == 0 and 0 < len(out) <= budget)
                check(f"FM-HOOK-01 {label} ends with newline", out.endswith(b"\n"))
                check(f"FM-HOOK-03 {label} does not repeat the protocol", not any(p in text for p in protocol_copy))
                check(f"FM-HOOK-03 {label} names memory_remember", "memory_remember" in text)
                lines = text.splitlines()
                check(f"FM-HOOK-03 {label} full skill reference last", bool(lines) and "mnemosyne:memory" in lines[-1])
                if scenario in ("realistic", "oversized", "long-id") or (scenario == "no-mapping" and hook == "session-start.sh"):
                    instruction = f'sessionId: "{active_id}"'
                    prefix = out[:600].decode("utf-8", errors="ignore")
                    check(f"FM-HOOK-02 {label} sessionId instruction in first 600 bytes", instruction in prefix and "memory_remember" in prefix)
                    check(f"FM-HOOK-02 {label} session context before protocol", 0 <= text.find(instruction) < text.find("# Mnemosyne Memory Protocol"))
                else:
                    check(f"FM-HOOK-03 {label} no invented/partial sessionId", active_id not in text and "sessionId: unavailable" in text)
                if hook == "post-compaction.sh":
                    check(f"FM-HOOK-02 {label} recovery notice first", text.startswith("## CRITICAL — POST-COMPACTION RECOVERY"))
                    check(f"FM-HOOK-02 {label} recovery preserves session", "session CONTINUES" in text[:600])
                if scenario in ("empty-home", "no-mapping"):
                    check(f"FM-HOOK-05 {label} clean stderr", result.stderr == b"")
                if scenario == "empty-home":
                    check(f"FM-HOOK-05 {label} no requests without configuration", not curl_log.exists())
                    check(f"FM-HOOK-05 {label} no invented managed episode", "Episode: open (" not in text)

print(f"Results: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
PYEOF
