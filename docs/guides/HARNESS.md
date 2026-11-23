# The host harness

**English** · [Español](HARNESS.es.md)

Automatic session capture for OpenCode, Claude Code and Codex, without relying on
a model remembering to call a tool.

## What it captures, and what it does not

The harness records the **visible conversation**: user messages and assistant
replies. It does not record tool calls, tool output, file contents, system
prompts or anything else the two of you did not say to each other.

Capture is **opt-in per host**. Installing the plugin does not start it; without
explicit consent every entry point is a no-op.

### What leaves the machine without `--capture`

One thing carries your words: the Claude Code plugin's automatic recall. On the
**first prompt of each session** `user-prompt-submit.sh` sends that prompt to
`POST /recall` as the query, so relevant memory reaches the model without a tool
call. It is not capture, so it does not wait for consent, but it is not sent
raw: secrets are redacted first (the same shapes `redact_secrets` removes from
captured turns — keys, tokens, PEM blocks, URL credentials, `password=`-style
assignments) and the result is cut to **500 characters**. The server keeps that
query in `mnemo_recall_log.query_text` when the recall returns facts. Later
prompts are not sent.

Everything else the hooks send without consent carries no conversation text:
`/me` and `/health` reads, and `POST /session/start` with a label made of the
host's session id. Subagent output and assistant replies are captured only with
a `full`-mode marker; user prompts only with `full` or `user-only`.

## Turning it on

    mnemo install --capture opencode,claude-code,codex
    mnemo install --capture codex --accept-degraded

`--capture` takes a comma-separated list of `opencode`, `claude-code` and
`codex`, and installs capture for exactly those. Each host is configured the way
that host installs things: OpenCode gets an entry in its `plugin` array, Claude
Code's manifest comes with the plugin copy, and Codex is installed through its own
marketplace (`codex plugin marketplace add` + `codex plugin add`) rather than by
writing into the cache its plugin manager owns. Hosts you do not name are not
mentioned again. Anything ambiguous is refused rather than guessed: `--capture`
given twice, an empty entry, an unknown host name, or `--accept-degraded`
without `--capture` all stop the command before it writes anything.

A host that resolves to `full` or `user-only` is installed without a second
question — asking for it was the consent. A host that can only reach `mcp-only`
or `unavailable` is **asked about**, because you would otherwise be agreeing to
something other than what you asked for. `--accept-degraded` answers that
question in advance, for automation. If there is no terminal to ask on and the
flag was not given, that host is skipped and the command exits non-zero: nobody
was asked, so nobody consented.

For Codex specifically, capture also needs `features.hooks = true` in
`~/.codex/config.toml`, which defaults off. When that is what limits the mode,
the installer offers to set it — a **separate** question, never implied by
`--accept-degraded`, because it changes a global Codex setting that other
plugins observe rather than just adding our own entry.

That gate is read on **your** machine, at install time and by `mnemo harness
doctor`; it is not baked into the shipped qualification record. The record says
what the build proved (`user-only` today) and keeps the qualifying machine's own
gate only as `qualifierGate`, for the record. A record that took `mcp-only` from
the gate of whoever ran the qualifier was a ceiling no user could lift by
enabling hooks (APP-035).

Each requested host is reported with its mode, the reason for that mode, and the
one concrete next step if there is one. Declining a host is not a failure and
does not affect the exit code.

### Do not copy the OpenCode plugin by hand

`mnemo install --capture opencode` registers an absolute path in the `plugin`
array of `opencode.json`, and the plugin resolves `@mnemo-ai/harness` from there.

Copying `mnemosyne.ts` into OpenCode's drop-in `~/.config/opencode/plugins/`
directory instead does not work: `@mnemo-ai/harness` does not resolve from that
directory (`Cannot find module`), and because the import is at the top of the
file the failure happens before any of the plugin's own code runs — so it cannot
degrade gracefully or explain itself. Verified against a live OpenCode 1.18.29.

## What actually turns capture on

One file per host:

    ~/.mnemo/harness/capture/<host>.json

Written by `mnemo install --capture` after the artifacts are in place, and
removed by `mnemo harness disable <host>`. Every entry point checks it: the
OpenCode plugin, `harness-hook.sh` for the two hook hosts, and the Claude Code
plugin's own hooks. Only a marker whose `mode` is `full` or `user-only` is
consent; one recorded as `mcp-only` or `unavailable` captures nothing.

`MNEMO_HARNESS_V1_ENABLED` is the **server's** feature flag. On the client it is
only a kill switch: `MNEMO_HARNESS_V1_ENABLED=false` (or `0`) in the host's
environment stops capture whatever the marker says, without touching the
filesystem. Setting it to `true` there grants nothing; it used to stand in for
the marker, which let a variable meant for the server turn capture on.

The marker exists because an installer cannot set an environment variable in a
host process that starts tomorrow. When the variable was the only gate, the hook
manifest installed cleanly, reported success, and captured nothing.

For Claude Code the marker also picks **one writer**. A `full` install writes
`"writer": "managed"`, and only then do the plugin's hooks route to
`harness-hook.sh`; any other marker leaves capture to the legacy writer, and the
managed runtime refuses the event (`legacy_writer_selected`). The two never both
capture the same turn.

Hooks run with whatever `PATH` the host was launched with, which under launchd or
systemd usually lacks the npm bin directory. The installer therefore records the
`node` binary and CLI entry point it used in the plugin's `.mnemo-runtime.json`,
and `harness-hook.sh` runs exactly those. A stale record is ignored, never
executed.

## Where things live

    ~/.mnemo/harness/
      outbox/       one file per undelivered event
      state/        acknowledgements, generation mappings, binding, retry schedule
      quarantine/   events the server will never accept
      audit/        content-free records of what was dropped and why

The outbox holds conversations, so the whole tree is created `0700`, every file
`0600`, and the harness refuses to run at all if it finds otherwise. It never
follows a symlink into it.

## Capture modes

A host gets the mode it has **earned**, from a qualification record produced by
running against that exact build:

| Mode          | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `full`        | User and assistant capture, reconciliation, and close       |
| `user-only`   | User messages only; transcript or deletion was never proven |
| `mcp-only`    | No capture at all; MCP tools still work                     |
| `unavailable` | The harness cannot run here safely                          |

Anything unverifiable resolves **downward**. A record that does not match the
installed version, platform, package or fixture hashes grants nothing. This is
deliberate: subscribing to host events that do not exist captures nothing, gives
no error, and has cost other projects months.

The version rule depends on what the qualifier read:

- **OpenCode:** the qualifier inspects the installed host, so its record covers
  only the version it was qualified on.
- **Codex:** a record without `hostVersionMatch` is read as `same-major`
  (`DEFAULT_VERSION_MATCH` in `harness/src/adapters/capabilities.ts`). Codex
  ships a minor release every few days, and its qualifier reads the host only
  for its version string and its `features.hooks` gate; the event set comes from
  the checked-in fixture. So the qualified version is a floor, every later
  `codex-cli 0.x` release is covered while Codex is pre-1.0, a new major or a
  different binary name never is, and the package, fixture and platform checks
  still pin what was proven. A record that says `"exact"` keeps its pin.
- **Claude Code:** the record carries `hostVersionMatch: "same-major"`, because
  its qualifier never reads the host. It checks the plugin's own `hooks.json`
  against the checked-in fixture. The record covers its version and every later
  release of that major; an earlier release or a new major grants nothing.
  Before this, every Claude Code update turned capture off with no evidence
  gained.

Re-qualify after changing anything the capture artifacts are built from — the
harness package or a host's plugin files. The digest is computed from those bytes
at run time, so a stale record simply stops matching and the host silently drops
to `mcp-only`. Both packages must be built first: you cannot qualify an artifact
you have not built.

    pnpm build
    node scripts/qualify-harness-host.mjs <host>
    node scripts/qualify-harness-host.mjs validate-all

## Diagnosing

    mnemo harness doctor           # queue, retries, binding, filesystem, capture mode
    mnemo harness doctor --self-test   # proves the local queue end to end, no network
    mnemo harness queue list       # metadata only, never content
    mnemo harness probe            # is the bound server accepting?

`doctor` is the fast way to tell a local problem from a server one. Its report
contains no API key, no message content and no transcript path, so it is safe to
paste into an issue.

It ends with one line per host: the mode capture is really at, and why. That is
the lowest of the consented mode, the artifacts the consent was given for, the
qualification record (host version, platform, package and fixture hashes) and
the live host gate, and the reason is the first of those that lowered it — for
example `codex: mcp-only — qualification: qualification is for host version
codex-cli 0.163.0, this is codex-cli 0.170.0`. A consented host that dropped
below its consent is reported as a problem (`capture_dropped_<host>`).

### What the artifact hash does not cover

The digest a record and a consent marker are matched on is computed from the
harness `dist/` plus each host's capture files (`hooks/hooks.json` and
`scripts/harness-hook.sh` for Claude Code) **in the plugin payload bundled with
the CLI**. Two gaps follow, both known and not yet closed:

- Claude Code runs the copy its own marketplace installed, which can be a
  different version from the CLI's bundle. A change that reaches users only
  through the marketplace is not seen by the hash.
- The legacy writer's scripts (`user-prompt-submit.sh`, `_helpers.sh`,
  `session-stop.sh`, …) are not in the digest, and the legacy writer does not
  re-check it on each event; only the managed writer (`harness-hook.sh`) does.

Closing them means hashing the installed plugin at consent time, at hook time
and in the qualifier alike.

## When delivery stops

Nothing is lost. The queue is durable across restarts and crashes, and delivery
retries transient failures forever with jittered backoff.

Three cases are not transient, and `doctor` names them:

- **blocked** — the server rejected the credential (401/403). Delivery stops
  rather than retrying, because hammering a rejected key can lock the account
  out. Fix the key, then `mnemo harness retry`.
- **quarantined** — the server said the queue belongs to a different binding
  (409), or a single event is too large for it. Delivering another workspace's
  conversation is worse than losing it.
- **capture incomplete** — something could not be captured durably. The gap is
  recorded rather than papered over.

## Rolling it back

The order matters, and each step guards the next:

    mnemo harness disable <host>   # stop capturing; the queue keeps its destination
    mnemo harness drain            # deliver the queue, to zero
    mnemo harness quiesce          # fence the server; wait for zero leases
    mnemo harness uninstall <host> # remove Mnemosyne's artifacts, and only those

Removing the artifacts while capture is still on leaves a host writing into a
queue nothing will deliver. Draining before disabling races the host, which is
still adding to it. Uninstalling before quiescing leaves the server holding
leases for a client that no longer exists.

`uninstall` refuses unless those steps are done. Overriding it requires saying
what happens to the queued conversations — `--discard-queued`, plus a
confirmation — and it reports exactly how many were thrown away.

## Retention

Managed transcripts have their own window, separate from the sensitivity tiers
that govern extracted knowledge, because the verbatim conversation is the most
sensitive thing stored and the shortest-lived.

    MNEMO_RETENTION_TRANSCRIPT_DAYS   # default 30
    PUT /config/retention             # { "transcriptDays": 7 }

The nightly purge measures from when the session went terminal, not from the age
of each turn. It leaves a content-free tombstone carrying the message identity
and its original acknowledgement, so a message replayed months later is still
recognised without the words coming back.

Forgetting an episode erases its transcript too, immediately and by the same
path. Otherwise "forgotten" would mean only that the summary was gone while the
raw conversation stayed replayable.

## Deploying

Server first, always. The server accepts and stores harness events before any
host is enabled to send them; the reverse leaves a host queueing against a server
that will reject it.

Then enable **one** qualified host, on one installation, observe it, and rehearse
the rollback above before promoting others. Hosts are independently gated, so
there is no reason to enable them together.

Environment gates:

    MNEMO_HARNESS_V1_ENABLED=true   # server: runs the managed-session worker; client: only =false counts (kill switch)
