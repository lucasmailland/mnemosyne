#!/bin/bash
# SS02 — tests packages/plugin/scripts/_subagent-payload.py. Run: bash scripts/__tests__/subagent-payload.test.sh
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
READER="$ROOT/packages/plugin/scripts/_subagent-payload.py"
FIXTURE="$ROOT/packages/harness/fixtures/claude-code-subagent-stop.json"
PASS=0; FAIL=0; LEAK="LEAK_MARKER_7f3"
pass() { PASS=$((PASS + 1)); echo "  ok - $1"; }
fail() { FAIL=$((FAIL + 1)); echo "  FAIL - $1"; }
# expect <name> <stdin> <expected code, or "ok">
expect() {
  local out
  out=$(printf '%s' "$2" | python3 "$READER")
  if [ "$3" = ok ]; then
    jq -e '.ok == true' <<<"$out" >/dev/null && pass "$1" || fail "$1: $out"
  else
    jq -e --arg c "$3" '.ok == false and .code == $c' <<<"$out" >/dev/null && pass "$1" || fail "$1: $out"
  fi
  if grep -q "$LEAK\|/etc/\|transcript" <<<"$out"; then fail "$1 leaks content or path"; fi
}

BASE='"hook_event_name":"SubagentStop","session_id":"s1","agent_id":"a1"'

# 1. SS01 contract: only final visible text plus IDs come back.
PAYLOAD=$(python3 -c 'import json,sys; print(json.dumps(json.load(open(sys.argv[1]))["observedPayload"]))' "$FIXTURE")
expect "SS01 fixture accepted" "$PAYLOAD" ok
out=$(printf '%s' "$PAYLOAD" | python3 "$READER")
jq -e '.text == "SS01_CANARY\nDONE_SS01" and .agent_id == "<redacted-agent-id>" and .session_id == "<redacted-session-id>" and ((keys | sort) == ["agent_id","ok","session_id","text"])' <<<"$out" >/dev/null \
  && pass "fixture yields final text + IDs only" || fail "fixture shape: $out"
# 2. Empty and unknown payloads.
expect "empty input" "" empty
expect "non-JSON input" "{$LEAK" invalid_json
expect "non-object JSON" "[\"$LEAK\"]" unknown_payload
expect "missing IDs" '{"hook_event_name":"SubagentStop","last_assistant_message":"hi"}' unknown_payload
expect "wrong event (wrong agent hook)" "{\"hook_event_name\":\"Stop\",\"session_id\":\"s1\",\"agent_id\":\"a1\",\"last_assistant_message\":\"$LEAK\"}" wrong_event

# 3. Retracted / tool-only subagent: no visible text, transcript path never echoed.
expect "empty final message" "{$BASE,\"last_assistant_message\":\"\",\"agent_transcript_path\":\"/etc/$LEAK\"}" no_visible_text

# 4. Bounds.
expect "oversize final text" "$(python3 -c 'import json; print(json.dumps({"hook_event_name":"SubagentStop","session_id":"s1","agent_id":"a1","last_assistant_message":"A"*65537}))')" oversize
expect "oversize input" "$(python3 -c 'print("x"*(256*1024+1))')" oversize

# 5. SS04 mirrors: packages/cli/plugin is generated from packages/plugin by sync-plugin.cjs.
SRC_PLUGIN="$ROOT/packages/plugin/scripts"
MIRROR_PLUGIN="$ROOT/packages/cli/plugin/scripts"
for rel in subagent-stop.sh _subagent-payload.py __tests__/subagent-stop.test.sh; do
  cmp -s "$SRC_PLUGIN/$rel" "$MIRROR_PLUGIN/$rel" && pass "mirror identical: $rel" || fail "mirror differs: $rel (run node packages/cli/scripts/sync-plugin.cjs)"
done

# Both hook copies process the native canary the same way: no consent -> exit 0, nothing posted.
# With full consent they must agree on whether /capture is called.
run_copy() { # <hook path> <mode>
  local home fake out
  home=$(mktemp -d); fake=$(mktemp -d)
  mkdir -p "$home/.mnemo/harness/capture" "$home/.mnemo/sessions"
  if [ "$2" = full ]; then
    printf '%s' '{"version":1,"host":"claude-code","mode":"full","consentedAt":"x","hostVersion":"1","packageHash":"x"}' > "$home/.mnemo/harness/capture/claude-code.json"
  fi
  printf '%s' "{\"mnemoSessionId\":\"sess_parent\",\"workspaceId\":\"\",\"createdAt\":\"2026-07-31T00:00:00Z\"}" > "$home/.mnemo/sessions/s1.json"
  cat > "$fake/curl" <<PROBE
#!/bin/bash
for arg in "\$@"; do case "\$arg" in */capture) touch "$home/capture-called" ;; esac; done
exit 0
PROBE
  chmod +x "$fake/curl"
  local rc posted=no
  printf '%s' "$PAYLOAD" | HOME="$home" PATH="$fake:$PATH" MNEMO_URL=http://localhost:3939 MNEMO_KEY=mns_test_fake bash "$1" >/dev/null 2>&1
  rc=$?
  [ -f "$home/capture-called" ] && posted=yes
  rm -rf "$home" "$fake"
  echo "rc=$rc posted=$posted"
}
for mode in none full; do
  src_res=$(run_copy "$SRC_PLUGIN/subagent-stop.sh" "$mode")
  mir_res=$(run_copy "$MIRROR_PLUGIN/subagent-stop.sh" "$mode")
  [ "$src_res" = "$mir_res" ] && pass "hook copies agree on native canary ($mode consent): $src_res" || fail "hook copies disagree ($mode consent): source=$src_res mirror=$mir_res"
  case "$src_res" in rc=0\ *) pass "canary exit code 0 ($mode consent)" ;; *) fail "canary exit non-zero ($mode consent): $src_res" ;; esac
done

# The mirrored consent test must pass on its own (it resolves the mirror hook from its own location).
bash "$MIRROR_PLUGIN/__tests__/subagent-stop.test.sh" >/dev/null 2>&1 && pass "mirrored consent test passes" || fail "mirrored consent test fails"

# 6. SS07 binding: the hook resolves the parent through read_session_mapping under the
# active workspace and posts to a real local HTTP recorder. Absent or foreign mappings
# post nothing, open no session and log only a reason code.
BIND=$(mktemp -d)
trap 'rm -rf "$BIND"' EXIT
cat > "$BIND/rec.py" <<'PY'
import http.server, json, sys
out = sys.argv[1]
class H(http.server.BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', 0))).decode()
        with open(out, 'a') as f:
            f.write(json.dumps({"path": self.path, "auth": self.headers.get('Authorization'), "ws": self.headers.get('X-Workspace-Id'), "body": body}) + "\n")
        self.send_response(200); self.send_header('Content-Type', 'application/json'); self.end_headers()
        self.wfile.write(b'{"extracted":0,"skipped":0}')
    def log_message(self, *a): pass
srv = http.server.HTTPServer(('127.0.0.1', 0), H)
open(out + '.port', 'w').write(str(srv.server_port))
srv.serve_forever()
PY
python3 "$BIND/rec.py" "$BIND/posts.jsonl" &
REC_PID=$!
for _ in $(seq 50); do [ -s "$BIND/posts.jsonl.port" ] && break; sleep 0.1; done
REC_PORT=$(cat "$BIND/posts.jsonl.port" 2>/dev/null)

PROJ="$BIND/proj-ss07"; mkdir -p "$PROJ" && git -C "$PROJ" init -q 2>/dev/null
SS07_TEXT="SS07_CANARY bound subagent text"
BOUND_PAYLOAD=$(jq -cn --arg cwd "$PROJ" --arg text "$SS07_TEXT" '{hook_event_name:"SubagentStop",session_id:"host-ss07",agent_id:"agent-ss07",agent_type:"general-purpose",cwd:$cwd,last_assistant_message:$text}')

# run_bound <hook> <mapping-json or "none"> [workspace-id-env] [traffic-origin-env]
run_bound() {
  local home hook="$1" mapping="$2" ws="${3:-}" origin="${4:-}" rc
  home=$(mktemp -d -p "$BIND")
  mkdir -p "$home/.mnemo/harness/capture" "$home/.mnemo/sessions"
  printf '%s' '{"version":1,"host":"claude-code","mode":"full","consentedAt":"x","hostVersion":"1","packageHash":"x"}' > "$home/.mnemo/harness/capture/claude-code.json"
  [ "$mapping" = none ] || printf '%s' "$mapping" > "$home/.mnemo/sessions/host-ss07.json"
  rm -f "$BIND/posts.jsonl"
  printf '%s' "$BOUND_PAYLOAD" | HOME="$home" MNEMO_WORKSPACE_ID="$ws" MNEMO_TRAFFIC_ORIGIN="$origin" \
    MNEMO_URL="http://127.0.0.1:$REC_PORT" MNEMO_KEY=mns_test_fake bash "$hook" >/dev/null 2>"$BIND/stderr"
  rc=$?
  echo "$home" > "$BIND/last-home"
  echo "$rc"
}
posts() { [ -f "$BIND/posts.jsonl" ] && wc -l < "$BIND/posts.jsonl" || echo 0; }

BOUND_OK='{"mnemoSessionId":"sess_parent_ss07","workspaceId":"","createdAt":"2026-07-31T00:00:00Z"}'
for hook in "$SRC_PLUGIN/subagent-stop.sh" "$MIRROR_PLUGIN/subagent-stop.sh"; do
  label=$( [ "$hook" = "$SRC_PLUGIN/subagent-stop.sh" ] && echo source || echo mirror )
  rc=$(run_bound "$hook" "$BOUND_OK" "" evaluation)
  [ "$rc" = 0 ] && pass "$label: bound run exits 0" || fail "$label: bound run rc=$rc"
  if [ "$(posts)" = 1 ]; then
    body=$(jq -r '.body' "$BIND/posts.jsonl")
    jq -e --arg t "$SS07_TEXT" '
      .path == "/capture" and .auth == "Bearer mns_test_fake" and
      (.body | fromjson) as $b |
      $b.parentSessionId == "sess_parent_ss07" and $b.parentSessionId != "host-ss07" and
      $b.scopeRef == "proj-ss07" and $b.agentId == "agent-ss07" and
      ($b.sourceMessageId | contains("agent-ss07")) and
      $b.trafficOrigin == "evaluation" and $b.source == "subagent-stop" and
      ($b.content == $t)' "$BIND/posts.jsonl" >/dev/null \
      && pass "$label: POST carries mapped parent, project, agent, source id and origin" \
      || fail "$label: bound POST body wrong: $body"
  else
    fail "$label: bound run did not POST exactly once ($(posts))"
  fi

  rc=$(run_bound "$hook" none)
  [ "$(posts)" = 0 ] && pass "$label: absent mapping posts nothing" || fail "$label: absent mapping posted"
  grep -q 'reason: no_session_mapping' "$BIND/stderr" && ! grep -q 'SS07_CANARY' "$BIND/stderr" \
    && pass "$label: absent mapping diagnostic is a reason code" || fail "$label: absent mapping diagnostic"
  home=$(cat "$BIND/last-home")
  [ ! -e "$home/.mnemo/sessions/host-ss07.json" ] && pass "$label: absent mapping opens no session" || fail "$label: absent mapping created a session"

  rc=$(run_bound "$hook" '{"mnemoSessionId":"sess_foreign","workspaceId":"ws-other","createdAt":"2026-07-31T00:00:00Z"}' "ws-active")
  [ "$(posts)" = 0 ] && pass "$label: foreign mapping posts nothing" || fail "$label: foreign mapping posted"
  grep -q 'reason: binding_mismatch' "$BIND/stderr" && ! grep -q 'SS07_CANARY' "$BIND/stderr" \
    && pass "$label: foreign mapping diagnostic is binding_mismatch" || fail "$label: foreign mapping diagnostic"
  home=$(cat "$BIND/last-home")
  grep -q 'sess_foreign' "$home/.mnemo/sessions/host-ss07.json" && ! grep -q 'sess_parent' "$home/.mnemo/sessions/host-ss07.json" \
    && pass "$label: foreign mapping is left untouched" || fail "$label: foreign mapping rewritten"
done

# 7. SS09 subscription pin. The SS01 fixture (packages/harness/fixtures/claude-code-subagent-stop.json,
# observedPayload) is the payload evidence that the host emits SubagentStop with agent_id and
# last_assistant_message. The manifest must subscribe to that event exactly once: one async command
# running subagent-stop.sh with a 10-second ceiling. The other events must stay unchanged, and the
# mirror must match the source byte for byte.
SRC_HOOKS="$ROOT/packages/plugin/hooks/hooks.json"
MIRROR_HOOKS="$ROOT/packages/cli/plugin/hooks/hooks.json"
[ "$(jq -r '.observedPayload.hook_event_name' "$FIXTURE")" = SubagentStop ] \
  && pass "SS01 fixture is SubagentStop payload evidence" || fail "SS01 fixture event mismatch"
cmp -s "$SRC_HOOKS" "$MIRROR_HOOKS" && pass "hooks.json mirror identical to source" || fail "hooks.json mirror differs (regenerate from packages/plugin/hooks/hooks.json)"
for manifest in "$SRC_HOOKS" "$MIRROR_HOOKS"; do
  label=$( [ "$manifest" = "$SRC_HOOKS" ] && echo source || echo mirror )
  jq -e '
    (.hooks.SubagentStop | length == 1) and
    (.hooks.SubagentStop[0].hooks | length == 1) and
    (.hooks.SubagentStop[0].hooks[0] | .type == "command" and .async == true and .timeout == 10 and
      (.command == "bash \"${CLAUDE_PLUGIN_ROOT}/scripts/subagent-stop.sh\"")) and
    ((.hooks | keys | sort) == ["PreCompact","SessionEnd","SessionStart","Stop","SubagentStop","UserPromptSubmit"]) and
    (.hooks.SessionStart | length == 2) and (.hooks.UserPromptSubmit[0].hooks[0].timeout == 10) and
    (.hooks.Stop[0].hooks[0] | .timeout == 5 and .async == true) and
    (.hooks.PreCompact[0].hooks[0].command | endswith("harness-hook.sh\" PreCompact")) and
    (.hooks.SessionEnd[0].hooks[0].command | endswith("harness-hook.sh\" SessionEnd"))' "$manifest" >/dev/null \
    && pass "$label: SubagentStop pinned (one async command, timeout 10); other events unchanged" \
    || fail "$label: SubagentStop subscription or other events drifted"
done

# 8. SS11 end-to-end: the observed SS01 fixture (cwd pointed at a real scratch project) runs through
# both hook copies against the loopback recorder. Exact visible text plus parent/project/agent/source
# fields arrive exactly once with full consent; missing consent and empty or incomplete payloads post nothing.
E2E_PROJ="$BIND/ss11-project"; mkdir -p "$E2E_PROJ" && git -C "$E2E_PROJ" init -q 2>/dev/null
E2E_TEXT=$(jq -r '.observedPayload.last_assistant_message' "$FIXTURE")
E2E_PAYLOAD=$(jq -c --arg cwd "$E2E_PROJ" '.observedPayload | .cwd = $cwd' "$FIXTURE")
E2E_MAP='{"mnemoSessionId":"sess_parent_ss11","workspaceId":"","createdAt":"2026-07-31T00:00:00Z"}'
E2E_FULL='{"version":1,"host":"claude-code","mode":"full","consentedAt":"x","hostVersion":"1","packageHash":"x"}'
E2E_USER='{"version":1,"host":"claude-code","mode":"user-only","consentedAt":"x","hostVersion":"1","packageHash":"x"}'

# e2e_run <hook> <marker json or none> <payload>: fresh HOME, one hook run, prints its exit code.
e2e_run() {
  local home; home=$(mktemp -d -p "$BIND")
  mkdir -p "$home/.mnemo/harness/capture" "$home/.mnemo/sessions"
  [ "$2" = none ] || printf '%s' "$2" > "$home/.mnemo/harness/capture/claude-code.json"
  printf '%s' "$E2E_MAP" > "$home/.mnemo/sessions/<redacted-session-id>.json"
  rm -f "$BIND/posts.jsonl"
  printf '%s' "$3" | HOME="$home" MNEMO_WORKSPACE_ID="" MNEMO_TRAFFIC_ORIGIN=evaluation \
    MNEMO_URL="http://127.0.0.1:$REC_PORT" MNEMO_KEY=mns_test_fake bash "$1" >/dev/null 2>"$BIND/stderr"
  echo $?
}
# e2e_diag <hook> <payload> <reason>: no consent-free post, reason code only, no canary text in diagnostics.
e2e_diag() {
  local rc; rc=$(e2e_run "$1" "$E2E_FULL" "$2")
  [ "$rc" = 0 ] && [ "$(posts)" = 0 ] && grep -q "reason: $3" "$BIND/stderr" && ! grep -q 'SS01_CANARY\|DONE_SS01' "$BIND/stderr"
}

for hook in "$SRC_PLUGIN/subagent-stop.sh" "$MIRROR_PLUGIN/subagent-stop.sh"; do
  label=$( [ "$hook" = "$SRC_PLUGIN/subagent-stop.sh" ] && echo source || echo mirror )
  rc=$(e2e_run "$hook" "$E2E_FULL" "$E2E_PAYLOAD")
  [ "$rc" = 0 ] && pass "$label: SS01 fixture run exits 0" || fail "$label: SS01 fixture rc=$rc"
  if [ "$(posts)" = 1 ]; then
    jq -e --arg t "$E2E_TEXT" '
      (.body | fromjson) as $b |
      .path == "/capture" and .auth == "Bearer mns_test_fake" and
      $b.content == $t and $b.source == "subagent-stop" and
      $b.parentSessionId == "sess_parent_ss11" and $b.scopeRef == "ss11-project" and
      $b.agentId == "<redacted-agent-id>" and
      $b.sourceMessageId == "<redacted-session-id>:<redacted-agent-id>" and
      $b.trafficOrigin == "evaluation"' "$BIND/posts.jsonl" >/dev/null \
      && pass "$label: one POST with exact visible text, parent, project, agent, source and origin" \
      || fail "$label: SS01 POST fields wrong: $(cat "$BIND/posts.jsonl")"
    jq -cS '.body | fromjson' "$BIND/posts.jsonl" > "$BIND/$label.body"
  else
    fail "$label: SS01 fixture did not POST exactly once ($(posts))"
  fi

  e2e_run "$hook" "$E2E_USER" "$E2E_PAYLOAD" >/dev/null
  [ "$(posts)" = 0 ] && pass "$label: user-only consent posts nothing" || fail "$label: user-only consent posted"
  e2e_run "$hook" none "$E2E_PAYLOAD" >/dev/null
  [ "$(posts)" = 0 ] && pass "$label: no consent posts nothing" || fail "$label: no consent posted"

  e2e_diag "$hook" "" empty && pass "$label: empty payload diagnostic" || fail "$label: empty payload diagnostic"
  e2e_diag "$hook" "$(jq -c 'del(.agent_id)' <<<"$E2E_PAYLOAD")" unknown_payload && pass "$label: missing agent_id diagnostic" || fail "$label: missing agent_id diagnostic"
  e2e_diag "$hook" "$(jq -c '.last_assistant_message = ""' <<<"$E2E_PAYLOAD")" no_visible_text && pass "$label: missing visible text diagnostic" || fail "$label: missing visible text diagnostic"
done

[ -f "$BIND/source.body" ] && cmp -s "$BIND/source.body" "$BIND/mirror.body" \
  && pass "source and bundled hooks send identical /capture bodies" \
  || fail "source and bundled /capture bodies differ"

kill "$REC_PID" 2>/dev/null; wait "$REC_PID" 2>/dev/null

echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
