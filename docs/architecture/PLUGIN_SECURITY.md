# Plugin Security — Threat Model & Isolation Design (§21)

**Date:** 2026-06-18 · **Status:** threat model approved; isolation design specified.

This is the engineering artifact the spec's §21 ("plugin isolation") asks for
*before* building a sandbox. It states what we are defending, against whom, what
is already in place, the residual risk, the decision, and the concrete design to
build when the trigger fires.

---

## 1. Assets to protect

| Asset | Why it matters |
|-------|----------------|
| `MNEMO_MASTER_KEY` / DEKs / API-key hashes | Master compromise → decrypt all PII, forge keys. |
| Cross-workspace memory | A plugin reaching another tenant's rows breaks isolation. |
| The Postgres connection / RLS GUC | Direct DB access bypasses workspace RLS. |
| `process.env` secrets (DB URL, provider keys) | Exfiltration → full lateral movement. |
| Host fs / network | Read secrets on disk, exfiltrate to attacker-controlled endpoints. |
| Availability | A runaway plugin (CPU/memory/infinite loop) degrades the service. |

## 2. Threat actors & trust levels

- **T0 — First-party built-ins (10 plugins).** Authored + reviewed in-repo. *Trusted.*
- **T1 — Operator-installed custom plugins.** Installed by the workspace operator,
  who already holds DB/secret access. *Semi-trusted* (operator can't escalate past
  what they already have).
- **T2 — Third-party / marketplace plugins.** Authored by unknown parties, installed
  without full review. *Untrusted.* **Not currently a product** — there is no plugin
  marketplace today.

## 3. Attack surface (current, in-process model)

`packages/plugins` runs plugin hooks **in the same Node process** as the server.
A malicious hook could, today, read `process.env`, touch `fs`/`net`, or reach the
DB handle if one were passed in its context. The package itself documents this:
*"There is NO sandbox, NO capability restriction, and NO isolation."*

## 4. Mitigations already in place (verified)

1. **Allowlist-gated by default (fail-safe).** Plugin code only runs if the
   operator populates the `MNEMO_PLUGINS` environment variable with an explicit
   comma-separated allowlist of plugin IDs. `createPluginLoaderFromEnv`
   (`plugins/src/index.ts`) reads this env variable directly; with an empty or
   absent `MNEMO_PLUGINS`, **no plugin code runs at all**.

   > **Note:** `parsePluginConfig` / `allowUnsandboxedPlugins` in
   > `plugins/src/config.ts` exist in the codebase but are **not called at
   > server boot** (`packages/server/src/index.ts` calls `createPluginLoaderFromEnv`
   > directly). The `allowUnsandboxedPlugins` flag is dead code at server boot and
   > MUST NOT be treated as a security control. The real gate is `MNEMO_PLUGINS`.
2. **Per-hook timeout + auto-disable.** Every hook is wrapped with a timeout; on
   timeout or repeated failure the plugin is disabled and `MNEMO_010` is logged
   (`plugins/src/index.ts:205`). Bounds the availability threat.
3. **Capability-light context.** The `PluginContext` passed to hooks does not hand
   over the raw DB handle or master key.
4. **RLS at the DB.** Even a direct query path is workspace-scoped by RLS GUC,
   unless the plugin can read the service DB URL from `process.env`.

**Residual risk (T1/T2 only):** an *enabled* plugin still shares the process, so a
malicious/compromised plugin could read `process.env` (incl. the DB URL → RLS
bypass as the service role) or open outbound sockets. This is acceptable for **T0
and T1** (the operator already has those privileges) but **NOT for T2**.

## 5. Decision

- **Today (no marketplace, T0/T1 only):** the current posture — disabled-by-default
  + timeout/auto-disable + capability-light context — is **professionally adequate**.
  Building a vm/worker sandbox now would be speculative.
- **Trigger to build the sandbox:** the moment **untrusted third-party plugins (T2)**
  enter the roadmap — a marketplace, user-uploaded plugins, or running any plugin the
  operator has not audited. At that point the in-process model is unacceptable and
  the design in §6 MUST ship before T2 plugins are enabled.

## 6. Isolation design (to build when the T2 trigger fires)

Phased, so it can land incrementally behind a `pluginIsolation: "worker"` flag:

1. **Worker harness.** Run each plugin in a `worker_threads` Worker (or a frozen
   `node:vm` realm). Reuse the existing timeout as the hard kill-switch; add a
   per-worker **memory cap** (`resourceLimits.maxOldGenerationSizeMb`) and CPU budget.
2. **Hook RPC protocol.** Define a message-passing contract for every hook
   (`beforeWrite`/`afterWrite`/`beforeRecall`/`afterRecall`/`event`/`health`/`sync`/`verify`).
   Plugin code never gets object references — only serialisable messages cross the
   boundary.
3. **Capability proxy.** Replace direct context access with an allow-listed RPC
   surface: the worker can call ONLY the storage ops its manifest declares, brokered
   by the host (which enforces workspace scope). No `process`, `fs`, `net`, or DB
   handle is reachable inside the worker.
4. **Manifest + permissions.** Each plugin declares the capabilities it needs; the
   host denies anything outside the manifest (deny-by-default).
5. **Migrate built-ins** to the sandboxed runner; keep the in-process path only
   behind `allowUnsandboxedPlugins` for audited first-party use.
6. **Adversarial tests.** A hostile test plugin attempts `process.env`, `fs`, `net`,
   and direct DB access — all must be denied; built-ins still pass; timeout still disables.

**Acceptance (when built):** a malicious plugin cannot read secrets, touch fs/net,
or reach the DB outside the capability proxy; first-party built-ins keep working;
the availability kill-switch (timeout → disable → `MNEMO_010`) still fires.

---

## Summary

§21 is **threat-model-complete**. Operationally the system is safe for first-party
and operator-installed plugins (disabled-by-default + timeout/disable). True
vm/worker isolation is **specified and ready to build**, gated on the introduction
of untrusted third-party plugins — building it before then is over-engineering, per
this model.
