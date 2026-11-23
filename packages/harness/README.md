# @mnemo-ai/harness

**English** · [Español](README.es.md)

Dependency-light normalization, sanitization, hashing, and secure local persistence for Mnemosyne host integrations.

## Installation

Not published to npm: `@mnemo-ai/cli` bundles it into its own `dist`. Inside this monorepo,
depend on it as a workspace package:

```bash
pnpm add @mnemo-ai/harness --workspace
```

## API

- `sanitizeMessage(content)` redacts recognized credentials and truncates oversized UTF-8 content.
- `normalizeVisibleMessage(message)` accepts only `user` and `assistant` messages and hashes sanitized content.
- `computePayloadHash(event)` hashes the canonical JSON wire body without `payloadHash`.
- `computeTerminalDigest(members)` computes the harness v1 terminal message-set digest.
- `enqueueVisibleMessage(input)` sanitizes and atomically persists one visible message.
- `readPendingEvents()` removes uncommitted crash-temporary files, latches fidelity loss, repairs validated final-event state, and returns pending events.
- `acknowledgeEvent(...)` records generation-qualified `M`/`L` terminal members, loss metadata, and retraction tombstones with a contiguous acknowledgement watermark.
- `compactTerminalState(...)` durably fixes each generation's retention deadline, enforces it against the local clock, then compacts every eligible completed generation in the acknowledged prefix.
- `inspectFilesystemCapabilities()` performs a temporary no-follow, flock, ownership, file-fsync, and directory-fsync probe.

The default capacity policy reserves 32 MiB for normal pending events and 1 MiB for loss/cancellation markers. Content-free audit records have a separate 4 MiB ceiling, and quarantined payloads have a separate 16 MiB operator/dead-letter ceiling. `OutboxOptions.capacity` can lower or raise each ceiling. Exhaustion fails closed, latches degraded fidelity, and requires operator retention or cleanup; it never evicts pending evidence automatically. Session synchronization uses a fixed 32-shard lock namespace, so caller-chosen session identities cannot create unbounded lock files.

## Local filesystem threat model

Node 20 does not expose descriptor-relative `openat(2)` traversal. The harness therefore requires a canonical HOME whose complete ancestor chain is owned by root or the current UID and is not writable by group or other users. Managed directories are current-UID `0700`; files are `0600` and opened with `O_NOFOLLOW`. Before lock acquisition, after acquisition, and after each locked operation, the harness revalidates ancestor policy plus the `dev`, `ino`, owner, type, and mode of HOME and every managed root. The capability probe proves advisory-lock exclusion with a competing child descriptor. Platforms that cannot provide no-follow opens, exclusive advisory flock, ownership checks, and file/directory fsync are reported as unavailable rather than receiving an unsafe emulation.

A malicious process already running as the same UID is outside this boundary. Such a process can replace user-owned ancestors, edit `0600` state, inject modules, debug the process, or change the harness executable itself, so pathname hardening cannot create a meaningful isolation boundary against it. The boundary checks detect replacement or policy drift that is present at a checked operation boundary; they cannot detect a transient same-UID replacement that is restored between checks and are not a defense against a compromised account.

Network delivery and host adapters remain outside this package slice.

How each host's hooks behave, with sources: [host hook contracts](../../docs/internals/host-hook-contracts.md).
