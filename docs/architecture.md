# Architecture

> **Current state.** Milestone 1 implemented `src/shared`. Milestone 2 added
> `src/main`, `src/preload` and `src/renderer` as a hardened desktop shell —
> the window, the sandboxed renderer, the narrow preload bridge, and one
> health-check IPC channel. Milestone 3 added `main/paths` and
> `main/settings`: centralized user-data path resolution and non-secret
> settings storage, loaded read-only at startup. Milestone 4 added
> `main/audit`: an append-only, redacting, daily-rotating JSONL writer.
> Milestone 5 added the permission-policy runtime: `main/permissions` (the
> pure decision engine), `main/executor` (the side-effect gate),
> `main/policy` (fail-safe policy loading) and `main/action-pipeline` (the
> canonical request path, assembled into one callable function). Milestone 6
> added `main/emergency`: persisted emergency-stop state, following the same
> fail-safe load pattern as settings and policy, plus the `engageEmergencyStop`
> and `resetEmergencyStop` operations that plug into `handleActionProposal`
> as its `perform` callback for the `emergency.engage` and `emergency.reset`
> action types. `decidePermission` and `handleActionProposal` needed **no
> code changes** for this — both already took `emergencyState` as an explicit
> input since Milestone 5. Milestone 7 adds the first privileged IPC channels
> ever registered — `settings:get`, `settings:update`, `secrets:status`,
> `secrets:write`, `secrets:clear` — and, with them, the first real native
> confirmation dialog (`main/confirm.ts`), the encrypted secret store
> (`main/secrets.ts`, backed by Electron's **synchronous** `safeStorage`),
> settings/secret-store reconciliation (`main/settings-service.ts`), a small
> glue module that loads policy and emergency state fresh for every request
> (`main/action-runtime.ts`), and the first-run onboarding interface
> (`src/renderer/Onboarding.tsx`). `main/permissions.ts`,
> `main/action-pipeline.ts` and `main/executor.ts` again needed **zero code
> changes** — every new channel is routed through the unmodified
> `handleActionProposal`. This document marks which parts exist today.

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
preload API: `health`, `settings.get`/`settings.update`, and
`secrets.status`/`secrets.write`/`secrets.clear` as of Milestone 7 — every one
of them policy-gated and audited before it can perform a privileged action,
and none of them able to return a plaintext key.

## Modules

| Module                               | Responsibility                                                                                                                                    | Must not                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `shared` **(exists)**                | Zod schemas, derived types, constants. Pure data and pure functions.                                                                              | Perform I/O; import Electron or Node built-ins; depend on `main`, `preload` or `renderer`.              |
| `renderer` **(exists)**              | All interface, including first-run onboarding. Renders state, collects input, sends requests over the bridge.                                     | Touch Node APIs, the filesystem or `ipcRenderer`; read secrets; load remote content.                    |
| `preload` **(exists)**               | The single bridge. Exposes an explicitly enumerated, typed API via `contextBridge`.                                                               | Expose `ipcRenderer`; provide a generic "invoke any channel" function; expose a Node primitive.         |
| `main/ipc` **(exists)**              | Receives every request, validates its payload and its response against a schema, and routes it through `main/action-runtime.ts`.                  | Execute anything itself; call `execute` or `main/secrets.ts` directly, bypassing the permission engine. |
| `main/action-runtime` **(exists)**   | Loads the current policy and emergency state fresh per request and calls `handleActionProposal`.                                                  | Add a decision step of its own; cache policy or emergency state across requests.                        |
| `main/confirm` **(exists)**          | `showNativeConfirmation` — the real `dialog.showMessageBox`, parented to the main window.                                                         | Be called from the renderer; be rendered as HTML; describe a secret in the dialog text.                 |
| `main/permissions` **(exists)**      | Pure decision function. `(proposal, policy, emergencyState) → verdict`.                                                                           | Perform I/O, show dialogs, or log.                                                                      |
| `main/executor` **(exists)**         | The **only** module that performs side effects. Requires a permission verdict as an argument.                                                     | Be called from `renderer` or `preload`; act without a decision; make its own policy judgements.         |
| `main/action-pipeline` **(exists)**  | Assembles `permissions → [confirm] → executor → audit` into one function every IPC handler calls.                                                 | Be bypassed by a handler that wires the pieces together itself.                                         |
| `main/audit` **(exists)**            | Append-only event writer with redaction and daily rotation.                                                                                       | Expose any update or delete function; write an unredacted secret.                                       |
| `main/settings` **(exists)**         | Loads, validates and atomically writes settings. Fails closed to safe defaults.                                                                   | Store secrets; write without going through the executor.                                                |
| `main/settings-service` **(exists)** | Reconciles `hasApiKey` against the secret store on every read and write; assembles onboarding/provider settings writes.                           | Accept `hasApiKey` as caller input; skip re-validating the full document before persisting.             |
| `main/secrets` **(exists)**          | Encrypts and decrypts via the **synchronous** `safeStorage` API (Windows DPAPI). Presence is answered from the file's shape, never by decrypting. | Return a plaintext secret across IPC; log a secret; fall back to storing plaintext.                     |
| `main/policy` **(exists)**           | Loads and validates the permission policy file. Fails closed to `createDefaultPermissionPolicy()`.                                                | Merge a partially-valid document; expose a write path.                                                  |
| `main/emergency` **(exists)**        | Loads and atomically persists emergency-stop state; `engageEmergencyStop`/`resetEmergencyStop` are `perform` callbacks for the action pipeline.   | Be bypassable by the renderer, a model, or the policy file; make its own permission decision.           |
| `main/paths` **(exists)**            | Single source of truth for user-data locations.                                                                                                   | Accept a user-supplied path.                                                                            |

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

| File                               | Describes                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`                | Window creation, CSP, permission-request denial, navigation/window-open/webview hardening, lifecycle, IPC-runtime composition            |
| `src/main/ipc.ts`                  | `ipcMain` handler registration for all five channels; validates request and response against the shared schema for each                  |
| `src/preload/index.ts`             | The single `contextBridge` API: `localAgent.health()`, `localAgent.settings.{get,update}()`, `localAgent.secrets.{status,write,clear}()` |
| `src/renderer/`                    | React shell: `App.tsx` gates on `onboardingCompleted`, `Onboarding.tsx` is the first-run form                                            |
| `src/shared/schemas/ipc.schema.ts` | Every `IPC_*_CHANNEL` constant and its request/response schema, shared by `main` and `preload`                                           |

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

**Wired to IPC since Milestone 7.** `main/index.ts` still calls `loadSettings`
once at startup, read-only, to prove the real path resolves before the window
opens, but `writeSettings` is now also reachable from the running
application: `settings:get` (`settings.read`) and `settings:update`
(`settings.write`) both go through `main/settings-service.ts`'s
`readReconciledSettings`/`writeOnboardingSettings`, which call `loadSettings`
and `writeSettings` exactly as this module already exposed them — neither
function itself changed for Milestone 7.

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

**Called for real since Milestone 7.** `main/index.ts` never calls
`appendAuditRecord` directly — nothing does, by design, since it is reached
only through `handleActionProposal`. Milestone 5 added the permission engine
that decides what to record, but until Milestone 7 nothing in the running
application proposed a real action, so every write was exercised only by
tests calling `handleActionProposal` directly. Milestone 7's five registered
IPC channels now reach it from the real running application on every
`settings:get`, `settings:update`, `secrets:status`, `secrets:write` and
`secrets:clear` call — see the next section.

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

**Milestone 5 registered no IPC channel; Milestone 7 registers the first
five, and none of them bypass this engine.** `execute` structurally cannot
run `perform` without an authorizing verdict, so `main/ipc.ts`'s five
handlers — `settings:get`, `settings:update`, `secrets:status`,
`secrets:write`, `secrets:clear` — each build an `ActionProposal` and hand it
to `main/action-runtime.ts`'s `runAction`, which calls this unmodified
`handleActionProposal`. There is no code path in `main/ipc.ts` that calls
`execute`, `main/secrets.ts`, or `writeSettings` directly. `main/index.ts`
still calls `loadPermissionPolicy` read-only at startup to prove the real
policy path resolves before the window opens, but every real IPC call now
re-reads policy and emergency state fresh from disk (`runAction`, described
below) rather than trusting that startup snapshot.

## Emergency stop (implemented)

| File                    | Describes                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------- |
| `src/main/emergency.ts` | `loadEmergencyState`, `writeEmergencyState`, `engageEmergencyStop`, `resetEmergencyStop` |

**No engine or pipeline code changed.** `decidePermission` and
`handleActionProposal` both already took `emergencyState: EmergencyState` as
an explicit, required input since Milestone 5, exactly anticipating this
milestone — `main/permissions.ts` and `main/action-pipeline.ts` have zero
diff for Milestone 6. This milestone is purely the I/O layer underneath that
existing input: loading a real, persisted state from disk, and the two
`perform` callbacks that change it.

**`loadEmergencyState` distinguishes "missing" from "corrupt" — unlike every
other loader in this codebase.** `loadSettings` and `loadPermissionPolicy`
both collapse every read failure (missing, unreadable, malformed, invalid) to
the same safe defaults, because for settings and policy that is always the
correct outcome. Emergency state cannot do that: which failure happened
changes the correct result. A missing file is a legitimate first launch and
must resolve _disengaged_ (a clean install must never start permanently
blocked); an existing file that is unreadable, malformed, or fails
`emergencyStateSchema` must resolve _engaged_ (state that cannot be trusted
fails safe, not open). `loadEmergencyState` classifies `ENOENT` as `'absent'`
and every other read failure as `'unreadable'`, then hands off to the
already-pure, already-tested `resolveEmergencyState`
(`shared/schemas/emergency.schema.ts`, Milestone 1) to apply that rule — this
milestone added no new resolution logic, only the I/O that feeds it real
data. A `__proto__`/`constructor`/`prototype` key anywhere in the parsed
document is rejected the same way `main/settings.ts` and `main/policy.ts`
reject one, via a duplicated `containsForbiddenKey`, for the same reason
those two don't import each other's copy.

**`writeEmergencyState` is atomic**, following `main/settings.ts`'s exact
mechanics: re-validate against `emergencyStateSchema` immediately before
serialising, write to a uniquely named temporary file in the same directory,
flush, then a single `rename` into place, retried on a transient Windows
sharing violation. A reader only ever sees the previous complete state or the
new complete one, never a partial or truncated file. One deliberate
divergence from settings.ts's retry budget: `RENAME_MAX_ATTEMPTS` is 10 here
(not 5) and the backoff starts at 20ms (not 15ms) — measured directly while
developing this module's own 8-way concurrent-write test, which the original,
smaller budget occasionally failed once the suite also ran `settings.test.ts`'s
own concurrency test in the same run. A larger budget only ever risks a
longer delay before giving up, never a partial write, so this is a pure
robustness improvement local to this module.

**`engageEmergencyStop` and `resetEmergencyStop` make no permission
decision.** Both are plain `perform` callbacks: `engageEmergencyStop` writes
`createEngagedEmergencyState(now, REASON_EMERGENCY_ENGAGED_BY_USER)` —
`reason` is always this one fixed constant, never free text from a user or a
model, since Phase 1 has no interface for either to supply one and accepting
one would reopen the log-injection risk persisted display strings are
elsewhere deliberately narrow to avoid. `resetEmergencyStop` writes
`createInitialEmergencyState()`. Neither function decides whether it may run:
`emergency.engage` is not in `CONFIRMATION_REQUIRED_ACTION_TYPES`, so a
default policy allows it immediately — engaging must never be obstructed by a
prompt. `emergency.reset` is in **both** `CONFIRMATION_REQUIRED_ACTION_TYPES`
and `EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES`, so `decidePermission` always
resolves it to `confirm`, regardless of policy content, regardless of who or
what proposed it, and regardless of whether the emergency stop is currently
engaged (`emergency.reset` is stop-exempt) — verified by a test matrix
covering every combination of `{null, empty, hostile-allow, hostile-deny,
default}` policy × `{engaged, disengaged}` emergency state, all resolving to
`confirm`. `execute` then refuses to call `resetEmergencyStop` at all unless
that confirmation was approved; a rejected confirmation leaves the on-disk
file byte-for-byte unchanged, since `resetEmergencyStop` — and therefore
`writeEmergencyState` — is never invoked.

**The native confirmation dialog now exists, first used by `secrets.write`
and `secrets.clear`.** `main/confirm.ts`'s `showNativeConfirmation` is a real
`dialog.showMessageBox`, parented to the main window, added in Milestone 7 for
the encrypted secret store (see "Secrets and onboarding" below) — the first
two action types that actually reach a running instance of
`requestConfirmation` with a live UI behind it. `emergency.reset` itself still
has no IPC channel calling it in Phase 1, so it still has nothing to trigger a
prompt with, but whichever later milestone adds a "release the emergency
stop" control reuses this same module rather than inventing a second one; an
HTML dialog rendered by the renderer remains categorically ruled out.

**Read-only at startup, like the other two loaders — still true.**
`main/index.ts` calls `loadEmergencyState` once, read-only, alongside
`loadSettings` and `loadPermissionPolicy`, to prove the real state path
resolves and the fail-safe logic runs against the real environment before the
window opens. Milestone 7's real IPC handlers (`settings:get`,
`settings:update`, `secrets:status`, `secrets:write`, `secrets:clear`) each
re-read emergency state fresh via `main/action-runtime.ts`'s `runAction`
before deciding, so an engaged stop takes effect on the very next call — but
none of them ever calls `engageEmergencyStop` or `resetEmergencyStop`.
Nothing still writes to `state/emergency.json` from the running application:
those two functions remain exercised end-to-end only by `main/emergency.ts`'s
own tests, because Phase 1 still registers no `emergency.engage` /
`emergency.reset` channel.

**The emergency stop blocks subsequent actions; it does not cancel anything
already running.** Phase 1 has no long-running or background work of any
kind, so there is nothing for it to interrupt. Calling it a kill switch would
overstate what it does: it is a gate a future proposal must pass through, not
a task canceller, and this remains true after Milestone 6 exactly as it was
documented before persistence existed.

## Secrets and onboarding (implemented)

| File                                   | Describes                                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/main/secrets.ts`                  | `loadSecretStoreState`, `hasStoredSecret`, `writeSecret`, `clearSecret`, `readSecret` (internal only) |
| `src/main/settings-service.ts`         | `readReconciledSettings`, `writeOnboardingSettings`, `refreshHasApiKeyAfterSecretChange`              |
| `src/main/action-runtime.ts`           | `runAction` — loads policy and emergency state fresh, then calls `handleActionProposal`               |
| `src/main/confirm.ts`                  | `showNativeConfirmation` — the real `dialog.showMessageBox`                                           |
| `src/main/ipc.ts`                      | The five channel handlers, each: validate → build proposal → `runAction` → validate response          |
| `src/renderer/Onboarding.tsx`          | First-run form: assistant name, user name, language, provider, model, base URL, optional API key      |
| `src/renderer/App.tsx`                 | Calls `settings:get` on mount; renders `Onboarding` while `onboardingCompleted` is `false`            |
| `src/shared/schemas/secrets.schema.ts` | `secretStoreFileSchema` — the on-disk shape of `secrets.enc`, never a plaintext field                 |

**`safeStorage` is synchronous, verified against the installed
`electron@44.1.1` typings rather than assumed from memory or older
documentation.** `isEncryptionAvailable()` returns `boolean` directly;
`encryptString(plainText)` returns a `Buffer` directly and throws on failure;
`decryptString(encrypted)` returns a `string` directly and throws on failure.
(Electron also exposes a separate, newer asynchronous trio —
`isAsyncEncryptionAvailable`/`encryptStringAsync`/`decryptStringAsync` — which
`main/secrets.ts` deliberately does not use, to avoid a store where a value
encrypted by one encryptor might not decrypt cleanly under the other.) On
Windows this is backed by DPAPI, scoped to the current OS user account — see
`security-model.md` for what that guarantees and what it does not.

**Presence is answered from the file's shape, never by decrypting.**
`loadSecretStoreState` reads `secrets.enc`, and — mirroring
`main/emergency.ts`'s ENOENT-vs-anything-else split, not `main/settings.ts`'s
collapse-everything-to-one-outcome split — returns `'absent'` only for a
genuinely missing file or a valid document whose `ciphertext` is `null`,
`'corrupt'` for every other read, parse, prototype-pollution or schema
failure, and `'present'` with the stored ciphertext otherwise. `hasStoredSecret`
and therefore `secrets.status` and `hasApiKey` reconciliation are computed
from this alone — `'absent'` and `'corrupt'` are functionally identical to
every caller (`false`), so a corrupt store never guesses a key is present
just because _something_ is on disk. Never creates a file merely by reading.

**`writeSecret` never falls back to plaintext.** If
`safeStorage.isEncryptionAvailable()` is `false`, `writeSecret` throws
`SecretStoreUnavailableError` before touching the disk at all — there is no
code path in this module that writes an unencrypted value. When available, the
plaintext is passed to `encryptString` and the returned `Buffer` is persisted
as base64 inside the same atomic-write shape `main/settings.ts` and
`main/emergency.ts` use (temp file in the same directory → flush → single
retried `rename`). `clearSecret` persists `{schemaVersion, ciphertext: null}`
— never deletes the file — through the identical atomic path.

**`readSecret` is internal only; no IPC channel calls it.** It exists for this
module's own tests and for a future milestone that actually calls a provider.
Every failure path — nothing stored, a corrupt file, `safeStorage`
unavailable, `decryptString` itself throwing — returns `null` rather than
raising, so nothing this function can do ever puts ciphertext, a storage path,
or a raw error into a thrown message.

**`main/settings-service.ts` is the one place settings and secrets meet.**
`readReconciledSettings` and `writeOnboardingSettings` both compute
`hasApiKey` from `hasStoredSecret`, never from caller input or from whatever
was last written to `settings.json` — and additionally force it `false` for
any provider outside `PROVIDERS_REQUIRING_API_KEY` (`'none'` and `'ollama'` in
Phase 1), a stricter _service-level_ choice layered on top of, not a
weakening of, `settingsSchema`'s own floor (which only forbids `hasApiKey:
true` for `'none'`). When the on-disk value disagrees, the correction is
persisted, not just returned, so a later raw read sees the same truth. After a
successful `secrets.write` or `secrets.clear`, `main/ipc.ts`'s handlers call
`refreshHasApiKeyAfterSecretChange` **only once the store operation itself has
already succeeded** — so a failed store write can never be reported as a
present key, and a store operation that succeeds but whose settings-side
bookkeeping then fails self-heals on the very next read.

**`main/action-runtime.ts`'s `runAction` re-reads policy and emergency state
on every single call**, rather than trusting `main/index.ts`'s startup
snapshot — this is what makes a hand-edited policy file or a just-engaged
emergency stop take effect on the very next action without a restart. One
fixed timestamp is captured per IPC call (`main/ipc.ts`'s `nowFn()`, called
once) and threaded through the permission decision, the audit record and
whatever the action itself persists, so nothing inside one request reads the
clock twice and risks a mismatch.

**Every IPC handler follows the same five steps**: validate the request tuple
against its schema, build an `ActionProposal` with safe, non-secret
`parameters` (`provider`, `keyPresent`, `onboardingCompleted` — never
`apiKey`), call `runAction` with a confirmation message when the action type
requires one, and validate the response against its schema before it crosses
back to the renderer. `secrets.write`'s plaintext `apiKey` reaches only the
`perform` closure — it is never placed in `proposal.parameters`, so it can
never reach an audit record even if `main/audit.ts`'s redaction were somehow
bypassed; this is a second, independent layer on top of that redaction, not a
replacement for it.

**Onboarding is `settings:update` with `onboardingCompleted: true`, nothing
more.** There is no separate "complete onboarding" action type or IPC channel.
`writeOnboardingSettings` assembles the full `Settings` document and calls the
same `writeSettings` that already re-validates against `settingsSchema` —
which is what actually enforces "a non-empty display name once onboarding is
complete" and "`baseUrl` is required for `openai-compatible`"; onboarding adds
no validation of its own beyond assembling the candidate. `src/renderer/Onboarding.tsx`
performs the same two checks client-side only so a user sees an error before
submitting, never as the real boundary. If the user provides an API key, the
renderer calls `secrets.write` as a second, separate request only after
`settings:update` has already persisted the provider selection — `apiKey`
never appears in the `settings:update` payload's schema at all
(`settingsUpdateRequestSchema` is built from `modelProviderInputSchema`,
which has no such field), so there is no way to route a key through the
settings channel even by mistake.

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
has no time dependency whatsoever, injected or otherwise. `main/emergency.ts`
follows the `loadSettings` convention exactly: `loadEmergencyState(stateFile,
now)` and `engageEmergencyStop(stateFile, now)` both take `now` from the
caller. `main/ipc.ts` continues the pattern one layer up: `IpcHandlerRuntime.nowFn`
is the only place any Milestone 7 code reads the real clock, called exactly
once per request; the resulting `now` string is then passed explicitly into
`main/action-runtime.ts`'s `runAction` and into every `perform` closure, so a
test can supply a fixed `nowFn` and every timestamp within one simulated
request — the permission decision, the audit record, `updatedAt` on a written
`Settings` document — is guaranteed identical, not read from the clock twice.

All persisted timestamps are UTC ISO-8601 and reject a UTC offset, so records
sort correctly and compare unambiguously.
