# Architecture

> **Current state.** Milestone 1 implemented `src/shared`. Milestone 2 adds
> `src/main`, `src/preload` and `src/renderer` as a hardened desktop shell —
> the window, the sandboxed renderer, the narrow preload bridge, and one
> health-check IPC channel. `main/permissions`, `main/executor`, `main/audit`,
> `main/settings`, `main/secrets` and `main/emergency` described below do not
> exist yet; they are the approved design for Milestones 3–6. This document
> marks which parts exist today.

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

| Module                           | Responsibility                                                                                                                                                        | Must not                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `shared` **(exists)**            | Zod schemas, derived types, constants. Pure data and pure functions.                                                                                                  | Perform I/O; import Electron or Node built-ins; depend on `main`, `preload` or `renderer`.      |
| `renderer` **(exists)**          | All interface. Renders state, collects input, sends requests over the bridge.                                                                                         | Touch Node APIs, the filesystem or `ipcRenderer`; read secrets; load remote content.            |
| `preload` **(exists)**           | The single bridge. Exposes an explicitly enumerated, typed API via `contextBridge`.                                                                                   | Expose `ipcRenderer`; provide a generic "invoke any channel" function; expose a Node primitive. |
| `main/ipc` **(exists, partial)** | Receives every request, validates its payload against a schema. Today: one health-check channel, no privileged action, so nothing to hand to a permission engine yet. | Execute anything itself; bypass the permission engine once one exists.                          |
| `main/permissions`               | Pure decision function. `(action, policy, emergencyState) → decision + reason`.                                                                                       | Perform I/O, show dialogs, or log.                                                              |
| `main/executor`                  | The **only** module that performs side effects. Requires a permission decision as an argument.                                                                        | Be called from `renderer` or `preload`; act without a decision; make its own policy judgements. |
| `main/audit`                     | Append-only event writer with redaction and daily rotation.                                                                                                           | Expose any update or delete function; write an unredacted secret.                               |
| `main/settings`                  | Loads, validates and atomically writes settings. Fails closed to safe defaults.                                                                                       | Store secrets; write without going through the executor.                                        |
| `main/secrets`                   | Encrypt and decrypt via the asynchronous `safeStorage` API.                                                                                                           | Return a plaintext secret across IPC; log a secret; write plaintext to disk.                    |
| `main/emergency`                 | Owns and persists emergency-stop state; supplies it to the permission engine.                                                                                         | Be bypassable by the renderer or by the policy file.                                            |
| `main/paths`                     | Single source of truth for user-data locations.                                                                                                                       | Accept a user-supplied path.                                                                    |

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

## Timestamps and clocks

`src/shared` contains no clock access. Functions that need a timestamp take it
as a parameter (`createDefaultSettings(updatedAt)`,
`resolveEmergencyState(source, now)`). This keeps the shared layer pure and
its tests deterministic.

All persisted timestamps are UTC ISO-8601 and reject a UTC offset, so records
sort correctly and compare unambiguously.
