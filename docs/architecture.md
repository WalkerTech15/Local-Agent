# Architecture

> **Current state.** Milestone 1 implemented `src/shared`. Milestone 2 added
> `src/main`, `src/preload` and `src/renderer` as a hardened desktop shell —
> the window, the sandboxed renderer, the narrow preload bridge, and one
> health-check IPC channel. Milestone 3 added `main/paths` and
> `main/settings`: centralized user-data path resolution and non-secret
> settings storage, loaded read-only at startup. Milestone 4 added
> `main/audit`: an append-only, redacting, daily-rotating JSONL writer.
> Milestone 5 adds the permission-policy runtime: `main/permissions` (the pure
> decision engine), `main/executor` (the side-effect gate), `main/policy`
> (fail-safe policy loading, loaded read-only at startup) and
> `main/action-pipeline` (the canonical request path, assembled into one
> callable function). None of it is reachable from the running application
> yet — no new IPC channel was registered, because nothing has a real, safe
> side effect to offer one; every module is exercised directly by this
> milestone's own tests instead. `main/secrets` and `main/emergency` described
> below do not exist yet; they are the approved design for Milestones 6-7.
> This document marks which parts exist today.

---

## Process model

Local Agent uses Electron's process separation as its privilege boundary. This
is the reason Electron was chosen; see
[adr/0001-desktop-stack.md](adr/0001-desktop-stack.md).

```
┌─────────────────────────────────────────────────────────────┐
│ renderer  (sandboxed, unprivileged)                         │
│   React interface. No Node. No filesystem. No remote content│
└───────────────────────────┬─────────────────────────────────┘
                            │ narrow, typed, allowlisted bridge
┌───────────────────────────▼─────────────────────────────────┐
│ preload   (contextBridge only)                              │
│   Enumerated functions. Never exposes ipcRenderer itself.    │
└───────────────────────────┬─────────────────────────────────┘
                            │ IPC
┌───────────────────────────▼─────────────────────────────────┐
│ main      (privileged — the only layer with OS access)      │
│   ipc → permissions → [confirm] → executor → audit          │
└─────────────────────────────────────────────────────────────┘
```

The renderer cannot perform a privileged action. Not "should not" — it has no
mechanism to. With `sandbox: true`, `contextIsolation: true` and
`nodeIntegration: false`, a fully compromised renderer gains only the narrow
preload API. Today that API is one liveness check with no side effect; every
function added to it from Milestone 3 onward will be policy-gated and
audited before it can perform a privileged action.

## Modules

| Module                              | Responsibility                                                                                                                                                        | Must not                                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `shared` **(exists)**               | Zod schemas, derived types, constants. Pure data and pure functions.                                                                                                  | Perform I/O; import Electron or Node built-ins; depend on `main`, `preload` or `renderer`.      |
| `renderer` **(exists)**             | All interface. Renders state, collects input, sends requests over the bridge.                                                                                         | Touch Node APIs, the filesystem or `ipcRenderer`; read secrets; load remote content.            |
| `preload` **(exists)**              | The single bridge. Exposes an explicitly enumerated, typed API via `contextBridge`.                                                                                   | Expose `ipcRenderer`; provide a generic "invoke any channel" function; expose a Node primitive. |
| `main/ipc` **(exists, partial)**    | Receives every request, validates its payload against a schema. Today: one health-check channel, no privileged action, so nothing to hand to a permission engine yet. | Execute anything itself; bypass the permission engine once one exists.                          |
| `main/permissions` **(exists)**     | Pure decision function. `(proposal, policy, emergencyState) → verdict`.                                                                                               | Perform I/O, show dialogs, or log.                                                              |
| `main/executor` **(exists)**        | The **only** module that performs side effects. Requires a permission verdict as an argument.                                                                         | Be called from `renderer` or `preload`; act without a decision; make its own policy judgements. |
| `main/action-pipeline` **(exists)** | Assembles `permissions → [confirm] → executor → audit` into one function every future IPC handler must call.                                                          | Be bypassed by a handler that wires the pieces together itself.                                 |
| `main/audit` **(exists)**           | Append-only event writer with redaction and daily rotation.                                                                                                           | Expose any update or delete function; write an unredacted secret.                               |
| `main/settings` **(exists)**        | Loads, validates and atomically writes settings. Fails closed to safe defaults.                                                                                       | Store secrets; write without going through the executor once one exists.                        |
| `main/policy` **(exists)**          | Loads and validates the permission policy file. Fails closed to `createDefaultPermissionPolicy()`.                                                                    | Merge a partially-valid document; expose a write path.                                          |
| `main/secrets`                      | Encrypt and decrypt via the asynchronous `safeStorage` API.                                                                                                           | Return a plaintext secret across IPC; log a secret; write plaintext to disk.                    |
| `main/emergency`                    | Owns and persists emergency-stop state; supplies it to the permission engine.                                                                                         | Be bypassable by the renderer or by the policy file.                                            |
| `main/paths` **(exists)**           | Single source of truth for user-data locations.                                                                                                                       | Accept a user-supplied path.                                                                    |

## Dependency direction

Dependencies point inward toward `shared`. Nothing depends on `renderer`.
Nothing outside `main/ipc` depends on `main/executor`.

```
renderer ──▶ shared ◀── main
preload  ──▶ shared
```

### Enforcement

The `src/shared` purity rule is enforced today by `eslint.config.js`. It covers
imports, globals, `globalThis` properties and code execution — the full list
and its rationale are in
[security-model.md](security-model.md#shared-layer-purity).

The bare-specifier rule is **default-deny** and applies to `import`
declarations and `export … from` re-exports alike: `src/shared` may reference
relative paths and `zod`, and nothing else. A denylist would only ever be as
complete as its list; inverting it means a new Node built-in, a built-in
sub-path such as `fs/promises`, or a newly added npm package is blocked without
anyone remembering to list it. Re-exports are covered because
`export * from 'axios'` pulls a package into the module graph exactly as an
import does.

Verified by execution during the Milestone 1 remediation passes, by linting
probe sources against the project's own resolved configuration: `node:fs`,
`net`, `vm`, `worker_threads`, `fs/promises`, `electron`, `lodash`,
`process.env`, `Buffer`, `fetch()`, `globalThis.process`, `globalThis.fetch`,
`eval()`, `new Function()`, dynamic `import()`, and the re-export forms
`export * from 'lodash'` and `export { x } from 'axios'` were each rejected by
the intended rule. `zod`, relative imports, relative re-exports and ordinary
source-less exports such as `export const a = 1` all passed. No probe file
remains in the repository.

This is a static boundary on this repository's own source. It is not a runtime
sandbox — see the limitations note in the security model.

`src/renderer` has no equivalent _static_ lint boundary yet — its purity is
enforced today only by Electron's runtime sandbox (`sandbox: true`,
`contextIsolation: true`, `nodeIntegration: false`), asserted by the
Milestone 2 end-to-end test. A lint-level renderer boundary and the
executor-side boundary rule remain open hardening for a later milestone.

## The canonical request path

Every privileged action follows this path, without exception:

```
renderer
  → preload bridge
  → main/ipc            validate payload against a schema
  → main/permissions    decide: allow | confirm | deny
  → [confirm]           native dialog owned by the main process
  → main/executor       perform the side effect
  → main/audit          record the decision and the outcome
  → typed result back to the renderer
```

Notes on the parts that matter:

- **Validation happens before the decision.** A malformed payload is rejected
  without ever reaching the policy engine.
- **The confirmation dialog is native and owned by `main`.** An HTML dialog
  rendered by the renderer could be faked or auto-dismissed by compromised
  renderer code.
- **The audit record is written for every decision**, including denials and
  rejected confirmations. A blocked action leaves as clear a trace as a
  successful one.
- **The emergency stop is evaluated before policy rules**, so an engaged stop
  cannot be overridden by a policy file.

## Shared schema layer (implemented)

| File                                            | Describes                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| `src/shared/constants.ts`                       | Product identity, action types, decisions, limits, redaction field list |
| `src/shared/schemas/settings.schema.ts`         | `settings.json`, plus `createDefaultSettings`                           |
| `src/shared/schemas/permissions.schema.ts`      | `policy.json`, plus `DEFAULT_PERMISSION_POLICY`                         |
| `src/shared/schemas/audit.schema.ts`            | One audit log line                                                      |
| `src/shared/schemas/audit-parameters.schema.ts` | Bounded, JSON-safe audit parameters and the redaction contract          |
| `src/shared/schemas/emergency.schema.ts`        | Emergency state, plus `resolveEmergencyState`                           |
| `src/shared/freeze.ts`                          | `deepFreeze` and `DeepReadonly`, for immutable security defaults        |
| `src/shared/types/index.ts`                     | `ActionProposal`, `PermissionVerdict`, `ActionResult`                   |

Several invariants are enforced in the schemas themselves rather than left to
the modules that will use them, so that a hand-edited file on disk cannot
create an unsafe state:

- the permission policy cannot downgrade a confirmation-required action to
  `allow`;
- the permission policy cannot deny — or silently omit — the user's emergency
  controls, so a valid policy can never leave the user unable to stop the
  assistant, recover, or read the audit trail;
- an audit record cannot describe a denied action as successful, or a rejected
  confirmation as successful, and the same rules hold in reverse so the
  opposite contradiction is equally unwritable;
- an audit `errorCode` must be a stable symbolic code, so a raw error message
  or filesystem path cannot leak into the log;
- audit parameters are bounded and JSON-safe, and a secret-named field is
  accepted only when already redacted;
- settings cannot carry a field capable of holding a credential, because the
  schema is strict and no such field is declared;
- a settings `baseUrl` must be empty or an absolute `http`/`https` URL with no
  embedded credentials, so neither `file:`/`data:`/`javascript:` nor
  `https://user:password@host` can reach a later request builder;
- persisted display strings cannot contain control characters or bidirectional
  overrides, while remaining fully open to accented French and Vietnamese text.

Exported security defaults are additionally deeply frozen, so a valid state
cannot be turned into an unsafe one in memory after loading.

## Desktop shell (implemented)

| File                               | Describes                                                                                            |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`                | Window creation, CSP, permission-request denial, navigation/window-open/webview hardening, lifecycle |
| `src/main/ipc.ts`                  | `ipcMain` handler registration; validates request and response against the shared schema             |
| `src/preload/index.ts`             | The single `contextBridge` API: `localAgent.health()`                                                |
| `src/renderer/`                    | React shell; reads `window.localAgent.health()` on mount                                             |
| `src/shared/schemas/ipc.schema.ts` | `IPC_HEALTH_CHANNEL`, request/response schemas shared by `main` and `preload`                        |

Build layout, and why it is not uniform across the three layers:

- **`main` compiles to CommonJS** (`tsconfig.electron.json`, `tsc`).
  `require('electron')` is Electron's original, stable mechanism for
  reaching its API from the main process; this project's main process was
  briefly ESM and that proved unreliable once the compile unit pulled in a
  second real dependency (`zod`, via `src/shared`). See
  [adr/0001-desktop-stack.md](adr/0001-desktop-stack.md) for the full account.
  `scripts/write-electron-package-json.mjs` writes `out/package.json` with
  `{"type": "commonjs"}` after every build, overriding the root
  `package.json`'s `"type": "module"` for just that directory — Node
  resolves module format from the nearest `package.json`, and without this
  override the compiled CommonJS output would be loaded as ES modules and
  every `require` in it would throw.
- **`preload` is bundled by Vite** (`vite.preload.config.ts`) into one
  self-contained CommonJS file, `electron` kept external. A sandboxed
  preload script (`sandbox: true`) runs inside a restricted loader that
  resolves only `electron` and a short built-in allowlist —
  `require('../shared/schemas')` fails there with "module not found" even
  though the identical code runs fine in the unsandboxed main process. `zod`
  and everything the preload touches under `src/shared` must therefore be
  inlined rather than left as a `require()` resolved at runtime.
- **`renderer` is bundled by Vite** (`vite.config.ts`) as it was before this
  milestone — ordinary browser-target ESM, unaffected by either constraint
  above.

`npm run build` runs all three: `tsc` for `main`, then Vite for `preload`,
then Vite for `renderer`.

## Settings storage (implemented)

| File                   | Describes                                                               |
| ---------------------- | ----------------------------------------------------------------------- |
| `src/main/paths.ts`    | `resolveUserDataPaths(appDataDir)` — every user-data path from one root |
| `src/main/settings.ts` | `loadSettings`, `writeSettings`, `containsForbiddenKey`                 |

Both functions in `main/settings.ts` take a plain settings-file path rather
than an `UserDataPaths` object or Electron's `app` module, so a test points
at a file inside a temporary directory and configures nothing else — no test
touches the real `%APPDATA%`. `main/index.ts` resolves the real path once,
from `app.getPath('appData')`, and passes the single resulting string in.

**Loading fails safe, unconditionally.** A missing file, an unreadable one
(permissions, or a directory sitting where the file should be), malformed
JSON, a `__proto__`/`constructor`/`prototype` key anywhere in the parsed
document, or a document `settingsSchema` rejects for any reason — all five
resolve exactly the same way: fresh defaults from `createDefaultSettings`.
There is no partial-trust path: a loaded document either validates in full,
as itself, and is returned as itself, or it is discarded in full and replaced
with defaults. Nothing is ever merged into the defaults, which is what keeps
a prototype-pollution key inert even before `containsForbiddenKey` rejects
it explicitly — see the note in `main/settings.ts` for why the explicit
check exists anyway rather than relying on that alone. `loadSettings` never
creates a file or a directory; a first launch is indistinguishable, by
design, from a corrupted one, and both return the same fresh defaults.

**Writing is atomic.** The document is re-validated against `settingsSchema`
immediately before serialising — a caller cannot persist a value that only
_claims_ the `Settings` type at compile time. It is written to a uniquely
named temporary file in the same directory as the target (required for the
final rename to be atomic on the same volume), flushed to disk, then moved
into place with a single `rename`. Any process observing `settingsFile`
therefore only ever sees the previous complete document or the new complete
one, never a partial write, regardless of when a crash or a concurrent write
happens. A destination rename can transiently fail on Windows — `EPERM`,
`EBUSY` or `EACCES` — when something else briefly holds the destination
open, which two of this module's own writes racing for the same file is a
real, tested example of; `renameWithRetry` retries a bounded number of times
before giving up, without ever weakening atomicity, since each attempt is
still one whole-file rename. On any failure after the temporary file is
created, it is removed before the error propagates. The parent directory is
created (`{ recursive: true }`) on write, never on read.

**Not wired to IPC.** Milestone 3 is storage only. `main/index.ts` calls
`loadSettings` once at startup, read-only, to prove the real path resolves
and loads (or safely falls back) before the window opens — nothing exposes
the result to the renderer yet, and `writeSettings` is not called from the
running application at all. Both are ready for the onboarding flow (M7) to
call through a future IPC channel, validated the same way `main/ipc.ts`
already validates the health-check channel.

## Audit log (implemented)

| File                | Describes                                                                             |
| ------------------- | ------------------------------------------------------------------------------------- |
| `src/main/audit.ts` | `appendAuditRecord`, `redactSecrets`, `AuditRecordValidationError`, `AuditWriteError` |

`appendAuditRecord(auditLogDir, candidate)` is the module's only exported
capability. There is no read, update, delete or truncate function anywhere in
it — appending is all it can do. `auditLogDir` is a plain directory path,
exactly as `main/settings.ts` takes a plain file path, so a test points at a
temporary directory and configures nothing else. `candidate` is untrusted
structured input, never assumed to already be a valid `AuditRecord`.

**Two independent defences run before anything reaches disk**, matching the
instruction that schema validation alone must not be assumed to replace
writer-side redaction:

1. **Redaction** (`redactSecrets`) walks the whole candidate recursively and
   replaces the entire value of any field whose _name_ matches
   `SECRET_FIELD_NAMES` with `[REDACTED]`, at any depth, including inside
   arrays. A caller that accidentally passes a real credential under a
   secret-looking key is scrubbed rather than rejected outright.
2. **Schema validation** (`auditRecordSchema`) is the backstop: if redaction
   were ever bypassed, skipped or regressed, a secret-named field whose value
   is not the placeholder still fails validation, and nothing is written.

**A dedicated safety scan runs before either of those**, over the raw
candidate: `findCandidateSafetyIssue` rejects a candidate containing a
`__proto__`/`constructor`/`prototype` key at any depth, or a cyclic
reference, before redaction or validation ever see it. This exists because
neither downstream step reliably catches both on its own. Zod's
`strictObject` decides whether an input key is "known" in a way that, for a
literal own property named `"__proto__"`, resolves through the inherited
accessor on its shape object rather than an explicit key list — verified
empirically: a JSON-parsed document carrying a top-level `"__proto__"` key
passes `auditRecordSchema.safeParse` unrejected, even though `Object.keys`
on that same input correctly lists the key. And because redaction builds a
_new_ object graph rather than mutating in place, a cycle left for the
schema to discover only after redaction would be a cycle in a tree the
original circular reference never actually reaches — the schema would never
see it. The scan catches both while they are still visible, on the input as
it actually arrived. Redaction keeps its own independent cycle-tracking and
depth/node budget as a second layer regardless, rather than relying on the
scan alone.

Building redacted objects with `Object.create(null)` rather than `{}` matters
for the same reason: `JSON.parse` creates a literal `"__proto__"` key as an
ordinary _own_ property, not a prototype write, but assigning through
_bracket notation_ on an ordinary `{}` (`result[key] = value` where
`key === '__proto__'`) does trigger `Object.prototype`'s `__proto__` setter,
because `{}` inherits it. A null-prototype target has no such accessor to
inherit, so the same assignment creates a harmless own data property, just as
`JSON.parse` did.

**Rotation is by UTC calendar day, taken from the record itself.** The target
file, `audit-<YYYY-MM-DD>.jsonl`, is derived from the first ten characters of
the record's own already-validated `timestamp` field — no `Date` parsing, no
timezone logic, and no clock dependency anywhere in this module. This is also
what keeps every test deterministic without an injected clock: the caller's
choice of `timestamp` fully determines which file a record lands in.

**Writing is append-only, never a rewrite.** Every write opens the target
file with the `'a'` flag, never `'w'`: the OS positions each write at
end-of-file, so a write can never truncate or overwrite bytes already there,
including when several callers race to append to the same file — proven, not
assumed, by a test that fires many concurrent writes at one file and parses
every resulting line back. A JSON object is serialised compactly (never
pretty-printed, since a multi-line object would break the one-line-per-record
JSONL contract) and a single `\n`-terminated line is appended per call. A
filesystem failure after validation succeeds raises `AuditWriteError` with a
fixed, generic message; the underlying error is attached as `Error.cause` for
local, main-process-only debugging and never appears in `message`, is never
sent over IPC, and never reaches the renderer. Because appending never
touches bytes already on disk, a failed write cannot corrupt or lose a record
written by an earlier, successful call.

**Not called from the running application.** `main/index.ts` still does not
call `appendAuditRecord` directly. Milestone 5 added the permission engine
that decides what to record, but nothing in the running application proposes
a real action yet — see the next section.

## Permission engine (implemented)

| File                          | Describes                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `src/main/permissions.ts`     | `decidePermission` — the pure decision function                                    |
| `src/main/executor.ts`        | `execute`, `ActionExecutionError`, `ExecutorInvariantError` — the side-effect gate |
| `src/main/policy.ts`          | `loadPermissionPolicy` — fail-safe policy loading, loaded read-only at startup     |
| `src/main/action-pipeline.ts` | `handleActionProposal` — the canonical request path, assembled                     |

**`decidePermission` is pure.** No filesystem access, no dialogs, no logging,
no network, no Electron import, no clock — every one of its inputs
(`proposal`, `policy`, `emergencyState`) is supplied by the caller, and the
same three inputs always produce the same `PermissionVerdict`. Its internal
ordering matches the canonical request path exactly:

1. A `proposal.actionType` outside `ACTION_TYPES` is denied
   (`REASON_UNKNOWN_ACTION_TYPE`) before anything else runs — the engine does
   not trust the type system alone for a value that may have reached it
   through an untrusted boundary.
2. The policy's rules are matched for that action type: highest `priority`
   wins, a tie keeps the first matching rule, no match (or no policy at all)
   is `deny`.
3. **The confirmation floor** downgrades an effective `allow` to `confirm`
   for `secrets.write`, `secrets.clear`, `emergency.reset` and `app.exit`. An
   effective `deny` for one of these is left as `deny` — the floor only
   forbids `allow`.
4. **The emergency availability floor** replaces an effective `deny` for
   `emergency.engage`, `emergency.reset` or `audit.read` with the same safe
   value `createDefaultPermissionPolicy` already assigns it (`confirm` for
   `emergency.reset`, `allow` for the other two) — regardless of whether that
   `deny` came from an explicit rule, default-deny, or `policy` being `null`.
5. **The emergency stop gate** runs last, so it can override even a
   floor-forced `allow`: while `emergencyState.engaged` is true, any action
   outside `EMERGENCY_STOP_EXEMPT_ACTION_TYPES` is denied
   (`REASON_EMERGENCY_STOP`). `emergency.engage` is deliberately **not**
   stop-exempt — engaging an already-engaged stop has nothing left to do, and
   the floor's real guarantee (inspect via `audit.read`, recover via
   `emergency.reset`) is unaffected, since both of those _are_ exempt.

Both floors are enforced here **independently of `permissionPolicySchema`
ever having run** — verified by tests that construct a `PermissionPolicy`
object which violates a floor outright (something the schema would reject)
and confirm the engine still corrects it. This is not redundant with the
schema: it is the explicit backstop the schema's own documentation already
calls for, in case a policy object reaches the engine by some path that
bypassed validation.

**`execute` is the only function that may run a side effect**, and only
given a `PermissionVerdict` as an explicit argument. `deny` never calls
`perform`. `confirm` requires an already-resolved `confirmationResult` —
`execute` does not show a dialog or wait for one itself; a `'rejected'`
result never calls `perform` either, and returns `aborted`. Only `'approved'`
or an outright `allow` runs `perform`. `perform` is supplied by the caller,
so this module makes no policy judgement of its own and needs no changes as
new action types arrive. A thrown `ActionExecutionError(code)` reports a
specific, stable `errorCode`; an ordinary thrown `Error` (or a rejected
promise) reports the generic `EXECUTION_FAILED` instead — `execute` never
inspects `Error.message`, so a caller that throws a raw error still fails
safely rather than leaking it.

**`loadPermissionPolicy` mirrors `loadSettings` exactly.** A missing file, an
unreadable one, malformed JSON, a `__proto__`/`constructor`/`prototype` key
anywhere in it, or a document `permissionPolicySchema` rejects for any
reason — including one that omits or denies a floor action, or downgrades a
confirmation-floor action to `allow` — all resolve to
`createDefaultPermissionPolicy()`. No partial-trust path, never creates a
file. Deliberately duplicates `main/settings.ts`'s small
`containsForbiddenKey` check rather than importing it, so this milestone does
not add a new runtime dependency on an already-reviewed module from an
earlier one — the same choice Milestone 4 made for the equivalent check in
`main/audit.ts`.

**`handleActionProposal` is the canonical request path, assembled.**
`decidePermission → [requestConfirmation] → execute → appendAuditRecord`, in
that order, as one function, so no future IPC handler can wire the pieces
together itself and risk skipping a step. `requestConfirmation` is called if,
and only if, the verdict requires confirmation — never for an already-denied
or already-allowed action. Exactly one audit record is appended per call,
covering a denial, a rejected confirmation, a success or a failure alike,
through the same `appendAuditRecord` call that redacts and validates it
before anything reaches disk (see the audit log section above). If that
write itself throws, the error propagates rather than returning a result
that was never actually recorded.

**Registers no new IPC channel.** Milestone 5 adds no privileged channel to
`main/ipc.ts` — nothing yet has a real, safe side effect to offer one, and
every real action type Phase 1 could plausibly wire up first (filesystem
tools, shell execution, secret storage, provider calls) is explicitly out of
scope until a later milestone. `handleActionProposal` is exercised directly
by this milestone's own integration tests instead, which is what proves no
bypass is possible: `execute` structurally cannot run `perform` without an
authorizing verdict, so whichever milestone registers the first privileged
channel has no way to accidentally skip the engine as long as it calls this
function. `main/index.ts` calls `loadPermissionPolicy` read-only at startup,
mirroring the Milestone 3 settings pattern, to prove the real policy path
resolves and loads (or safely falls back) before the window opens.

## Timestamps and clocks

`src/shared` contains no clock access. Functions that need a timestamp take it
as a parameter (`createDefaultSettings(updatedAt)`,
`resolveEmergencyState(source, now)`). This keeps the shared layer pure and
its tests deterministic. `main/settings.ts`'s `loadSettings(settingsFile, now)`
follows the same convention one layer up, even though it does perform I/O:
the caller supplies `now`, so a test never depends on the wall clock either.
`main/audit.ts`'s `appendAuditRecord` goes one step further and takes no
clock parameter at all: the UTC calendar day used for rotation is read
directly from the candidate's own required `timestamp` field, so the module
has no time dependency whatsoever, injected or otherwise.

All persisted timestamps are UTC ISO-8601 and reject a UTC offset, so records
sort correctly and compare unambiguously.
