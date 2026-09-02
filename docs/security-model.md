# Security model

> **Current state.** Milestone 1 implemented the shared schema layer.
> Milestone 2 added the hardened Electron shell. Milestone 3 added non-secret
> settings storage. Milestone 4 added the append-only, redacting, daily
> rotating audit log writer. Milestone 5 added the permission-policy runtime:
> a pure decision engine, an executor gate, fail-safe policy loading, and the
> assembled canonical request path. Milestone 6 added persisted emergency-stop
> state — fail-safe loading, atomic writes, and the engage/reset operations —
> under an engine and pipeline that needed no code changes, since both already
> took emergency state as an explicit input. None of it is reachable from the
> running application yet, since no new IPC channel exists to reach it
> through. Controls below are marked **[implemented]**, **[enforced by
> schema]** or **[planned, milestone N]**. Nothing here is claimed as working
> before it exists.

---

## Assets

- The user's API keys and any other credential.
- The integrity of the settings file and the permission policy.
- The integrity and completeness of the audit trail.
- The user's filesystem and execution environment. Not reachable in Phase 1,
  but the boundary is built now so it holds when tools arrive.

## Trust boundaries

1. renderer → preload → main
2. files on disk → main
3. npm dependencies → the application
4. external and model input → main (Phase 2 onward)

---

## Controls

### Process isolation

**[implemented]** The window is created with `sandbox: true`,
`contextIsolation: true`, `nodeIntegration: false`, `webSecurity: true`,
`webviewTag: false` and `nodeIntegrationInSubFrames: false`. A strict
Content-Security-Policy — `default-src 'self'`, no `unsafe-inline`, no
`unsafe-eval`, `connect-src 'none'`, `object-src 'none'`,
`frame-ancestors 'none'` — is applied to every response in the default
session. Navigation away from the packaged bundle is blocked via
`will-navigate`, every `window.open` request is denied via
`setWindowOpenHandler`, and `will-attach-webview` is denied too, all
registered globally via `app.on('web-contents-created', …)` rather than
per-window, so nothing Electron creates can slip past them. No remote content
is loaded; the renderer's own outbound network access is blocked by the CSP.
Every OS permission request (camera, microphone, geolocation, notifications,
…) is denied outright, since Phase 1 needs none of them. All of this is
asserted by an end-to-end Playwright test against the built application, not
only declared in source.

A compromised renderer therefore gains only the narrow preload API. Today
that API is still one liveness check with no side effect — Milestone 5 built
the permission engine every future privileged function must be gated and
audited through (`main/action-pipeline.ts`'s `handleActionProposal`), but
added no such function to the preload API itself, since none has a real,
safe side effect yet.

### Permission model

**[enforced by schema]** The default decision is `deny` and the policy file
cannot declare anything else. An action with no matching rule is denied.

**[enforced by schema]** A confirmation floor: `secrets.write`,
`secrets.clear`, `emergency.reset` and `app.exit` cannot be downgraded to
`allow` by editing the policy file. The schema rejects such a file.

**[enforced by schema]** An **emergency availability floor**: the policy file
is user-editable, so without a floor it could remove the user's own emergency
controls. A valid policy must declare a rule for `emergency.engage`,
`emergency.reset` and `audit.read`, and none of them may be `deny`.

Both halves matter. Denying one of these actions and simply _omitting_ it have
exactly the same effect, because an unmatched action falls through to
default-deny — so omission is rejected just as firmly as explicit denial. An
empty rule list is therefore not a valid complete policy, even though
default-deny remains the posture for any action outside the floor.

Note how the two floors compose: `emergency.reset` is on both, so it can be
neither `allow` nor `deny`. It is pinned to `confirm` — recovery from an
engaged emergency stop stays possible, but only through the deliberate
confirmation flow.

**[implemented]** `main/permissions.ts`'s `decidePermission` enforces both
the confirmation floor and the emergency availability floor **independently
of the policy file and independently of whether it ever passed
`permissionPolicySchema`**. Schema validation is the first line of defence,
not the only one: tests construct a `PermissionPolicy` object that violates
a floor outright — something `permissionPolicySchema` would reject — and
confirm the engine still corrects it, proving the engine does not merely
trust that validation already ran. Ordering matters here: the emergency stop
gate is evaluated _after_ both floors, so it can still override a
floor-forced `allow` for a non-exempt action (`emergency.engage` while
already engaged is denied, not floor-protected — the floor's real guarantee,
inspecting via `audit.read` and recovering via `emergency.reset`, is
unaffected, since both of those remain stop-exempt).

**[implemented]** `execute` (`main/executor.ts`) is the only function
permitted to run a privileged action's side effect, and requires a
`PermissionVerdict` as an explicit argument. There is no code path in it
that runs the side effect without one: `deny` never calls it, a `confirm`
verdict requires an already-resolved, non-rejected confirmation answer
first, and only `allow` or an approved `confirm` reaches it.
`main/action-pipeline.ts`'s `handleActionProposal` assembles
`decidePermission → [confirm] → execute → audit` into the one function a
future IPC handler must call — Milestone 5 registers no new IPC channel of
its own, since nothing yet has a real, safe side effect to offer one, so
this is proven by integration tests calling the assembled path directly
rather than by a live channel. The guarantee is structural, not a
convention: `execute` cannot be made to run a side effect without an
authorizing verdict, so whichever milestone registers the first privileged
channel has no way to accidentally bypass the engine as long as it calls
`handleActionProposal`.

**[not yet implemented]** Confirmation prompts as native, main-process-owned
dialogs. Milestone 5 represents "confirmation required" and its resolution
as explicit data (`PermissionVerdict.confirmationRequired`,
`ConfirmationResult`) and an injected `requestConfirmation` callback, but
does not wire that callback to Electron's `dialog.showMessageBox` or any
other concrete UI — there is no confirmation-requiring action reachable from
the running application yet for a dialog to serve. Whichever future
milestone adds the first such action must implement it as a native dialog
owned by the main process; an HTML dialog rendered by the renderer remains
explicitly disallowed regardless of which milestone builds it.

### Secret handling

**[enforced by schema]** The settings schema is strict and declares no field
capable of holding a credential. A settings file containing `apiKey` is
rejected rather than silently accepted.

**[enforced by schema]** A credential cannot be smuggled into the settings file
through a _value_ either. The provider `baseUrl` rejects embedded userinfo —
`https://user:password@host`, `https://:password@host` and `https://user@host`
are all refused, as is the empty separator `http://@host` that `URL`
normalises to blank credentials. The value is **rejected, never stripped**:
silently rewriting it would accept the user's secret, discard it, and leave
them believing the endpoint was stored as typed.

Field-name checks and value checks are complementary and neither is
sufficient alone. A name denylist cannot see a credential hidden inside a
value, which is what the `baseUrl` rule covers; a value rule cannot see a
credential stored under an unexpected field name, which is what the strict
schema and `SECRET_FIELD_NAMES` cover.

**[enforced by schema]** `baseUrl` is validated for control and bidirectional
characters **on the original string, before parsing**. This ordering matters:
the WHATWG `URL` parser silently removes tab, newline and carriage return, so
`https://exa<TAB>mple.com` would otherwise parse cleanly as
`https://example.com` and a hostile value would survive validation looking
benign.

**[implemented]** The only secret-related value the settings file carries is
the boolean `hasApiKey`.

**[planned, M7]** `hasApiKey` is **derived metadata and must never be
treated as authoritative.** It is a cached answer to a question that only the
encrypted secret store can actually answer, and the two can drift — a settings
file restored from backup, an interrupted write, or a secret store cleared
outside the application all leave the flag disagreeing with reality.

The obligation this creates, to be discharged when the secret store (M7)
exists — the settings store (M3) now does:

- the settings loader reconciles `hasApiKey` against the secret store on load,
  and the writer refreshes it whenever a secret is written or cleared;
- **where the two disagree, the secret store is the source of truth.**
  `hasApiKey` is corrected to match it, never the other way round;
- no code path may infer that a key exists, or is usable, from `hasApiKey`
  alone. It exists so the interface can show key status without a key crossing
  the process boundary, and for nothing else.

Nothing reconciles the two today, because the secret store doesn't exist yet.
The settings store persists whatever `hasApiKey` a caller last wrote, exactly
as written, no more and no less. See known limitation 12.

**[implemented]** No action type returns a secret value. `secrets.read` does
not exist; the action list contains only `secrets.write`, `secrets.clear` and
`secrets.status`, the last of which returns a boolean. A unit test asserts
this.

**[planned, M7]** Keys are stored using Electron's **asynchronous**
`safeStorage` API, which encrypts under Windows DPAPI for the current user
account. Plaintext exists only inside the main process. There is no IPC
channel that returns a key.

**[implemented]** No secret appears in `.env`, `.env.example`, any settings
file, any test fixture or any committed file. `.env` is git-ignored.

### Audit integrity

**[enforced by schema]** Audit consistency rules are **biconditional**, closed
in both directions. A one-directional rule leaves the opposite contradiction
writable: forbidding "deny decision, success outcome" while still permitting
"allow decision, denied outcome" would let a record claim an action was
blocked when policy never blocked it. The enforced pairings are:

| Rule                                                  | Both directions enforced |
| ----------------------------------------------------- | ------------------------ |
| `decision = deny` ⟺ `outcome = denied`                | yes                      |
| `confirmationResult = rejected` ⟺ `outcome = aborted` | yes                      |
| `decision = confirm` ⟺ `confirmationResult` present   | yes                      |
| approved confirmation ⇒ outcome is success or failure | yes                      |
| `outcome = failure` ⟺ `errorCode` present             | yes                      |

A failure must carry a stable `errorCode`, so an incident leaves a record of
_what_ went wrong and not merely _that_ something did.

**[enforced by schema]** Audit `parameters` are bounded and JSON-safe rather
than an open `Record<string, unknown>`. Only strings, finite numbers,
booleans, `null`, plain objects and arrays are accepted — no functions,
symbols, `undefined`, `BigInt`, `Date`, `Map`, `Set` or class instances — and
cycles are detected rather than left to fail during serialisation. Depth, key
count, key length, array length, string length and total node count are all
capped, so a hostile or runaway payload cannot produce an unbounded log line.
Non-finite numbers are rejected specifically because `JSON.stringify` turns
them into `null`, which would quietly falsify a record.

**[enforced by schema]** The redaction contract is enforced at the schema
level: a parameter whose _name_ matches `SECRET_FIELD_NAMES` is accepted only
when its value is exactly `[REDACTED]`. The Milestone 4 writer performs the
redaction; the schema is the backstop that fails loudly if the writer is ever
bypassed or regresses. Name matching is normalised — case, underscores and
hyphens are ignored, and matching is by substring — so `apiKey`, `api_key`,
`API-KEY`, `accessToken` and `clientSecret` are all caught by a short list of
roots.

Matching deliberately **over-matches**: a name such as `tokenizer` is flagged
even though it is harmless. That is the safe direction of error — a false
positive is a loudly rejected audit record, whereas a false negative is a
silently logged credential. Callers rename the field. One consequence worth
knowing: boolean key-presence metadata must not be logged as `hasApiKey`, and
should use a neutral name such as `keyPresent`.

**[enforced by schema]** `errorCode` must match `^[A-Z][A-Z0-9_]{2,63}$`. Free
text is rejected, which prevents a raw error message, stack trace or
filesystem path from reaching the log. A test asserts that realistic leaky
strings are rejected.

**[enforced by schema]** Display strings reject control characters, so a user
name cannot inject a forged newline-delimited log line.

**[implemented]** Append-only writer (`main/audit.ts`) with UTC daily
rotation and field-name redaction before serialisation. `appendAuditRecord`
is the module's only export capable of a side effect; there is no update,
delete or truncate function anywhere in it. Every write opens the target file
with the append flag, never a write-truncate flag, so a write can never
overwrite or lose bytes already on disk, proven under concurrent writes by a
test that fires many writes at one file and parses every resulting line back.
Rotation reads the UTC calendar day directly from the record's own validated
`timestamp`, so the writer has no clock dependency of its own.

**[implemented]** A dedicated scan (`findCandidateSafetyIssue`) rejects a
candidate containing a `__proto__`/`constructor`/`prototype` key at any
depth, or a cyclic reference, before redaction or schema validation ever see
it — neither is a safe backstop for this on its own. Verified empirically: a
JSON-parsed document carrying a top-level `"__proto__"` key passes
`auditRecordSchema.safeParse` **unrejected**, because Zod's `strictObject`
decides whether an input key is "known" in a way that resolves a literal
`"__proto__"` key through the inherited accessor on its shape object rather
than as an explicit key lookup — even though `Object.keys` on that same
input correctly lists the key. Settings loading (M3) has the equivalent
`containsForbiddenKey` backstop for the same underlying reason; this is a
second, independent instance of the same defence for the audit format.

**[implemented — no OS-level file permissions applied]** The writer does not
set restrictive Windows ACLs on the log file or directory beyond what the
per-user `%APPDATA%` location already provides by default. This was
considered and deliberately deferred rather than attempted without a
specific, reviewed design: the audit log's own stated limitation is that it
is append-only by API, not tamper-proof against a local user with the same
account privileges, so an unset ACL narrows nothing that limitation doesn't
already cover today. See known limitation 1.

**[implemented, M5]** `main/action-pipeline.ts`'s `handleActionProposal`
appends exactly one audit record per proposal — a denial, a rejected
confirmation, a success and a failure are all recorded through the same
`appendAuditRecord` call, so a blocked action leaves as clear a trace as a
successful one. Tests prove a secret-named parameter is redacted before
writing regardless of whether the action was allowed, denied, or its
confirmation was rejected — the M4 writer's redaction runs unconditionally,
not only on the success path.

### Shared-layer purity

**[implemented]** `src/shared` is consumed by every process, including the
sandboxed renderer, so it must not be able to reach the operating system, the
network, or execute code. This is enforced by lint rules in
`eslint.config.js`, verified during remediation with temporary probe files
that were removed afterwards.

Exactly what is enforced, and nothing more:

| Control                                                                                                                          | Rule                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Every Node built-in, bare and `node:`-prefixed, read from `builtinModules` at config load                                        | `no-restricted-imports` (exact paths)                                           |
| Electron, and any Electron sub-path                                                                                              | `no-restricted-imports`                                                         |
| Any bare specifier other than `zod`, in an `import` or an `export … from` — covers `fs/promises`, future built-ins, new packages | `no-restricted-syntax` (default-deny)                                           |
| `process`, `Buffer`, `__dirname`, `__filename`, `require`, `module`, `exports`, `global`                                         | `no-restricted-globals`                                                         |
| `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`, `navigator`, `importScripts`                                              | `no-restricted-globals`                                                         |
| `globalThis.process`, `globalThis.Buffer`, `globalThis.require`, `globalThis.fetch`                                              | `no-restricted-properties`                                                      |
| `eval`, `new Function`, `javascript:` URLs, implied eval                                                                         | `no-eval`, `no-new-func`, `no-script-url`, `@typescript-eslint/no-implied-eval` |
| Runtime `import()`                                                                                                               | `no-restricted-syntax`                                                          |

Two design notes:

- The bare-specifier rule is **default-deny**, not a denylist, and it covers
  `import` declarations and `export … from` re-exports alike. A re-export pulls
  a package into the module graph exactly as an import does and runs its
  top-level side effects in every process that loads the shared barrel, so
  matching only imports would have left `export * from 'axios'` open. A
  denylist can only ever be as complete as the list; inverting it means a new
  built-in, a built-in sub-path, or a newly added npm package is blocked
  without anyone remembering to add it.
- `globalThis` itself is **not** blocked. Blocking it outright makes the
  configuration brittle for no security gain; only the privileged properties
  hanging off it are closed.

Node built-ins are matched **exactly**, not by pattern. ESLint's pattern
matching is gitignore-style, so a bare pattern matches any path segment: the
pattern `constants` — a real, deprecated Node built-in — also matches the local
import `../constants`. Several built-ins have names that generic (`url`,
`path`, `events`, `assert`, `domain`), so exact matching is the only form that
cannot produce false positives on local files.

**Limits, stated plainly.** This is a static lint boundary. It is not a
sandbox: it constrains what this repository's own source may be written to do,
and it does not constrain a compromised dependency at runtime. Runtime
isolation of the renderer is a separate control, planned for Milestone 2.

Nor can a lint rule follow a value through an alias. `const g = globalThis;`
followed by `g.process`, or `Reflect.get(globalThis, 'process')`, defeats the
property rules above, and no static rule set closes that class completely. The
boundary raises the cost of reaching a privilege from zero to deliberate, and
makes any such attempt conspicuous in review — it does not make it impossible.

### Configuration integrity

**[enforced by schema]** Every persisted file carries a `schemaVersion` and is
validated strictly. Unknown keys are rejected rather than ignored.

**[implemented]** Exported security defaults are deeply frozen.
`DEFAULT_PERMISSION_POLICY` and `INITIAL_EMERGENCY_STATE` are module
singletons, and a mutable singleton is a shared mutable security control: one
caller editing it silently changes what every later caller sees. Mutating
either now throws. Callers needing a mutable copy use
`createDefaultPermissionPolicy()` or `createInitialEmergencyState()`, and
`resolveEmergencyState` returns a fresh object rather than a shared reference,
so one caller cannot corrupt another's emergency state.

**[implemented]** Corrupt settings load safe defaults. **[planned, M5]** A
corrupt policy file fails closed to deny-all and never regenerates a
permissive default.

### Settings storage

**[implemented]** `main/settings.ts` loads and writes `settings.json`. Every
failure mode collapses to the same fail-safe outcome — fresh defaults from
`createDefaultSettings` — with no partial-trust path: a missing file, an
unreadable one, malformed JSON, a `__proto__`/`constructor`/`prototype` key
anywhere in the parsed document, and a document `settingsSchema` rejects for
any reason are all indistinguishable to the caller. No raw parse error,
filesystem path, or file content is ever returned; only a validated `Settings`
value or the defaults. `loadSettings` never creates a file or a directory.

**[implemented]** The loaded document is never merged into the defaults. It
either validates in full, as itself, and is returned as itself, or it is
discarded in full. This is what keeps a `__proto__`/`constructor`/`prototype`
key inert even before the explicit `containsForbiddenKey` check runs: nothing
downstream ever assigns through an untrusted key, because nothing downstream
ever touches the untrusted object at all once it has been rejected — and even
when it validates, `settingsSchema`'s strict objects at every level accept
only their declared keys, so a document carrying `__proto__` alongside
otherwise-valid fields is rejected as an unrecognised key on its own. The
explicit walk is defence in depth, not the only thing standing between a
hostile file and the running process.

**[implemented]** Writes are atomic: a validated document is serialised to a
uniquely named temporary file in the settings directory, flushed to disk,
then moved into place with a single `rename`. A reader therefore only ever
observes the previous complete document or the new complete one, never a
partial write, regardless of when a crash or a concurrent write happens. A
transient Windows sharing violation on the final rename (`EPERM`/`EBUSY`/
`EACCES`) is retried a bounded number of times rather than surfaced as a
failure; on any failure that persists, the temporary file is removed before
the error propagates. Verified against a real filesystem, not a mock,
including two writes racing for the same target file.

**[implemented]** Path resolution never accepts a user-supplied or
renderer-supplied path, and never hardcodes a username: `main/paths.ts`
derives every path from `app.getPath('appData')`, joined with the reviewed
constant `APP_DATA_DIR_NAME`, not from `app.getPath('userData')` — whose
folder name instead follows Electron's `app.name`, which this project does
not pin.

**[planned, M7]** No IPC channel exposes settings yet — this is deliberate;
the onboarding interface that will need one does not exist yet. `main/index.ts`
calls `loadSettings` once at startup, read-only, to prove the path resolves
and the load path executes against the real environment, and `writeSettings`
is not called from the running application at all in Milestone 3.

### Emergency stop

**[implemented]** `resolveEmergencyState` distinguishes two cases that are
easy to conflate:

| On disk                              | Resolution     | Rationale                                                                      |
| ------------------------------------ | -------------- | ------------------------------------------------------------------------------ |
| No file                              | **disengaged** | A legitimate first launch. A clean install must not start permanently blocked. |
| File exists, malformed or unreadable | **engaged**    | Previously written state that cannot be trusted fails safe.                    |
| File exists, valid                   | as stored      | State persists across restart.                                                 |

**[implemented]** `decidePermission` takes `emergencyState` as an explicit
input and, when `engaged` is true, denies every action outside
`EMERGENCY_STOP_EXEMPT_ACTION_TYPES` (`settings.read`, `audit.read`,
`emergency.reset`, `app.exit`), evaluated after both permission floors so it
can still override a floor-forced `allow` for a non-exempt floor action
(`emergency.engage`). The exemptions exist so an engaged stop is not an
unrecoverable state.

**[implemented, M6]** `main/emergency.ts` persists state to
`state/emergency.json`, applying the two-case table above against the real
filesystem: `loadEmergencyState` classifies a missing file as `'absent'` and
every other read failure (permission denial, a directory where the file
should be, any I/O error), malformed JSON, or a
`__proto__`/`constructor`/`prototype` key anywhere in the parsed document as
`'unreadable'`, before handing off to the unchanged, already-tested
`resolveEmergencyState` to apply the resolution rule. Neither branch's
`reason` field ever contains the underlying error message or the file's
path — the unreadable branch always uses the fixed
`REASON_EMERGENCY_STATE_UNREADABLE` constant.

**[implemented, M6]** `writeEmergencyState` is atomic, matching
`main/settings.ts`'s mechanics exactly: write to a uniquely named temporary
file in the same directory, flush, then replace the target with a single
`rename`, retried on a transient Windows sharing violation. A failed write
never truncates or partially overwrites a valid prior state, since nothing
ever writes through the original path until the replacement is fully ready —
proven under concurrent writes by a test that fires many writes at one file
and confirms the result is always exactly one complete, valid document.

**[implemented, M6]** `engageEmergencyStop` and `resetEmergencyStop` are
`perform` callbacks for the Milestone 5 pipeline, not permission decisions
of their own. `emergency.engage` is not confirmation-required, so it runs
immediately once policy allows it — stopping the assistant must never be
obstructed by a prompt. `emergency.reset` is both confirmation-required
**and** an availability-floor action, so `decidePermission` always resolves
it to `confirm`, independent of policy content, independent of the proposal's
`actor` or `parameters` (a proposal claiming to be `actor: 'model'` with a
"the model has determined it is safe to resume" rationale resolves
identically to any other), and independent of whether the stop is currently
engaged, since `emergency.reset` is itself stop-exempt. `execute` will not
call `resetEmergencyStop` without an approved confirmation; a rejected one
means the function — and therefore any write — never runs, leaving the
persisted file byte-for-byte identical to before the proposal, verified by a
test that compares the file's raw bytes before and after a rejected reset.

**[not yet implemented]** An IPC path or UI control to engage or reset the
stop. `engageEmergencyStop` and `resetEmergencyStop` are real, tested `perform`
callbacks, but nothing in the running application calls
`handleActionProposal` with a real `emergency.engage` or `emergency.reset`
proposal yet — consistent with Milestone 5 registering no new IPC channel,
and with the confirmation-dialog limitation already noted under
_Permission model_ above.

### Input validation

**[enforced by schema]** A `baseUrl` must be empty or an absolute `http`/`https`
URL. `file:`, `data:`, `javascript:` and `ftp:` are rejected at the boundary,
before any later milestone builds a request from the value. It must also be
free of embedded credentials and of control and bidirectional characters — see
_Secret handling_ above.

**[enforced by schema]** Persisted display strings — the assistant name and the
user name — reject both C0/C7F control characters and Unicode bidirectional
overrides and isolates (`U+202A`–`U+202E`, `U+2066`–`U+2069`).

Control characters prevent forging a newline-delimited audit line from a user
name. Bidirectional overrides are the basis of "Trojan Source" spoofing: they
reorder how text _renders_ without changing what is stored, so a name can
display as something other than what will later be compared.

The bidi block is deliberately narrow. Ordinary accented French and Vietnamese
text — including every combining character — is unaffected, and no
general-purpose script is blocked. Tests assert that names such as
`Nguyễn Thị Ánh Nguyệt` and `Éloïse Lefèvre-Gaütier` round-trip unchanged.

**[implemented]** Every IPC payload is validated against a schema in the main
process: `main/ipc.ts` parses the health-check channel's arguments and its
result against `healthCheckRequestSchema` / `healthCheckResponseSchema`
before either crosses the process boundary. Unknown channels are rejected —
`ipcMain` has no handler for anything else, and the preload exposes no way to
address one. No generic pass-through channel exists.

---

## Threats and status

| Threat                                                        | Status                                                                                                                              |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Renderer compromise (XSS, malicious UI dependency)            | Addressed, M2 — process isolation and CSP; asserted by an end-to-end test                                                           |
| Malicious or malformed IPC payload                            | Addressed, M2 — schema validation on the one registered channel; no other channel exists                                            |
| Secret exfiltration through the interface                     | Addressed — no channel returns a key; asserted by test                                                                              |
| Secret leakage into logs or errors                            | Addressed, M4 — schema-level redaction contract plus writer-side redaction, both verified                                           |
| Credential persisted inside a settings _value_                | Addressed — `baseUrl` rejects embedded userinfo                                                                                     |
| Log injection via a crafted user name                         | Addressed — control characters rejected                                                                                             |
| Display spoofing via bidirectional overrides                  | Addressed — bidi overrides and isolates rejected in display strings                                                                 |
| Forged audit record                                           | Addressed — biconditional cross-field integrity rules                                                                               |
| Unbounded or non-serialisable audit payload                   | Addressed — bounded JSON-safe parameter schema; writer-side scan bounds the whole record                                            |
| Audit record overwritten or truncated by a write              | Addressed, M4 — append-only file handle; proven under concurrent writes by test                                                     |
| Prototype-pollution key bypassing schema validation           | Addressed, M4 — explicit writer-side scan; schema-only reliance was verified insufficient                                           |
| Settings tampering or corruption                              | Addressed, M3 — strict validation, fail-safe loading to defaults, atomic writes                                                     |
| Policy tampering or corruption                                | Addressed, M5 — fail-closed loading (`main/policy.ts`) plus engine-side floor enforcement independent of it                         |
| Policy file removing the user's emergency controls            | Addressed, M5 — availability floor enforced at both the schema layer and, independently, by `decidePermission`                      |
| Policy bypassing schema validation before reaching the engine | Addressed, M5 — floors re-verified by the engine regardless of validation history                                                   |
| Corruption of a shared security default in memory             | Addressed — exported defaults deeply frozen; resolvers return fresh objects                                                         |
| `src/shared` reaching the OS, network or eval                 | Addressed — lint boundary, verified by probe; not a runtime sandbox                                                                 |
| Privilege escalation via the executor                         | Addressed, M5 — `execute` requires a verdict as an explicit argument; proven by tests that no denial or rejection reaches `perform` |
| A side effect running without a permission decision           | Addressed, M5 — structural: no code path in `execute` calls `perform` without an authorizing verdict                                |
| Model rationale/confidence used as authorization              | Addressed, M5 — `decidePermission` never reads `proposal.parameters`; proven by test                                                |
| Emergency-stop bypass (decision logic)                        | Addressed, M5 — engine denies non-exempt actions when engaged, evaluated after both floors                                          |
| Emergency-stop bypass (persistence)                           | Addressed, M6 — atomic writes, fail-safe loading; reset requires an approved confirmation the pipeline already enforces             |
| Emergency-stop state corruption fails open instead of closed  | Addressed, M6 — malformed or unreadable state resolves engaged, not disengaged; proven by test                                      |
| Emergency reset triggered by a model or a policy rule alone   | Addressed, M6 — always resolves to `confirm`; proven across a policy × emergency-state test matrix                                  |
| Path traversal                                                | Not reachable — all paths derive from the app-data directory; none is user-supplied                                                 |
| Prompt injection, untrusted model or tool output              | Not reachable in Phase 1 — no model call exists. The proposal/executor split pre-empts it                                           |
| Supply-chain compromise via npm                               | Mitigated, not eliminated — see below                                                                                               |

---

## Known limitations

These are real and are stated plainly rather than described as solved.

1. **The audit log is append-only by API, not tamper-proof.** A local user
   with the same privileges can edit the file directly with a text editor.
   Tamper-evidence (hash chaining or signing) is deferred beyond Phase 1. The
   Milestone 4 writer does not apply a restrictive Windows ACL to the log
   directory or file either; doing so would narrow who on the machine can
   reach the file, but would not change this limitation, since the threat
   here is the same user account, not a different one.

2. **Windows DPAPI does not protect a secret from every application running
   under the same Windows user account.** `safeStorage` encrypts under the
   current user's account, which defends against another _user_ on the machine
   and against the file being copied elsewhere. It does **not** defend against
   malware already running as that same user: such code can ask DPAPI to
   decrypt the blob exactly as Local Agent does. If the Windows account is
   compromised, the stored key must be considered compromised.

3. **Secrets are not portable.** DPAPI ciphertext is bound to the Windows user
   account. It cannot be moved to another machine or user profile. This is
   acceptable, arguably desirable, for a local single-user assistant.

4. **npm supply chain is the largest realistic Phase 1 risk.** Mitigated by a
   deliberately minimal dependency set, exact version pinning, a committed
   lockfile, `npm audit` in verification, and human review before any new
   dependency. Not eliminated.

5. **No code signing.** Phase 1 ships as an unsigned development build.
   Windows SmartScreen will warn on any distributed binary.

6. **The emergency stop is a gate, not a task canceller.** No long-running or
   background work exists in Phase 1, so there is nothing to interrupt. It
   blocks subsequent actions and persists across restart. Calling it a kill
   switch would overstate it.

7. **The redaction field list is a denylist over _names_.** A secret stored
   under an unanticipated field name is not caught by name matching alone.
   Matching normalises spelling and matches by substring, and errs toward
   over-matching, which narrows the gap but does not close it. Value-level
   controls are separate and cover only the cases they were written for — at
   present, `baseUrl` userinfo. A credential pasted into a free-text field such
   as `model` would still be stored.

8. **The shared-layer purity boundary is a lint rule, not a sandbox.** It
   constrains what this repository's own source may be written to do. It does
   not constrain a compromised dependency at runtime, and it does not apply to
   `src/main`, which is privileged by design. Runtime isolation of the
   renderer is a separate control, planned for Milestone 2.

9. **Resolved, M5.** Through Milestone 4, the availability floor was enforced
   only at schema validation: a policy object that reached a future engine
   without passing validation would not have been caught. Milestone 5's
   `decidePermission` now re-enforces both floors independently at decision
   time, verified by tests that construct a policy violating a floor outright
   and confirm the engine still corrects it — see _Permission model_ above.
   Kept as a numbered entry, rather than removed, so the two references to
   later limitation numbers below do not shift.

10. **The audit parameter limits are fixed constants, not adaptive.** A record
    legitimately exceeding them is rejected rather than truncated. Rejection is
    the safe direction — a truncated audit record is a misleading one — and the
    Milestone 4 writer (`appendAuditRecord`) does exactly that: its safety scan
    rejects a candidate that exceeds its own (deliberately looser) depth/size
    budget before redaction runs, so nothing is ever written. The `[TRUNCATED]`
    marker that `redactSecrets`'s internal walk can produce exists only as a
    defensive fallback for that function used directly, independent of the
    writer, or as a second layer should the scan's identical budget ever be
    bypassed; through `appendAuditRecord` it is not expected to be reachable in
    ordinary operation, because the scan already rejects first.

11. **Windows 10 is unverified.** Development and verification target
    Windows 11.

12. **`hasApiKey` can drift from the secret store.** It is derived metadata
    with no reconciliation behind it yet, so nothing currently guarantees the
    flag matches what the encrypted store actually holds. The settings store
    (M3) persists whatever value a caller last wrote, exactly as written;
    reconciliation against the secret store as the source of truth is a
    required Milestone 7 deliverable, since the secret store does not exist
    until then. Until then the flag is a hint, not a fact, and no security
    decision may rest on it.

13. **Settings loading cannot distinguish "no file yet" from "file existed
    but was rejected".** Both a genuine first launch and a corrupted or
    invalid `settings.json` return identical fresh defaults from
    `loadSettings`, by design — there is deliberately no partial-trust path.
    The cost: nothing today tells the user their settings were reset because
    the file was corrupt rather than absent. The audit format and writer
    (M4) and the pipeline that would call them for a real action (M5) both
    now exist, but `loadSettings` still is not called through either — it
    runs once, read-only, directly from `main/index.ts` at startup, outside
    the permission engine entirely, since Milestone 3 predates it and no
    later milestone has revisited that wiring. Surfacing this distinction to
    the user still belongs to a future onboarding notice (M7).

14. **`decidePermission`'s defensive `REASON_UNKNOWN_ACTION_TYPE` denial
    cannot itself be audited through `handleActionProposal`.** If a proposal
    with an `actionType` outside `ACTION_TYPES` somehow reached the pipeline
    — it should not, in practice, since IPC request validation rejects one
    long before a proposal is constructed — the engine denies it correctly,
    but `appendAuditRecord`'s own call to `auditRecordSchema` then rejects
    the record, because `actionType` there is `z.enum(ACTION_TYPES)` and
    cannot represent an unrecognised value. `handleActionProposal` lets that
    validation error propagate rather than silently discarding it or writing
    a mismatched record; a test in `action-pipeline.test.ts` documents this
    exact interaction. The action is still denied and `perform` is still
    never called — only the audit trail for that specific, expected-to-be-
    unreachable case is incomplete.

15. **No real IPC channel or native confirmation dialog exists yet.**
    Milestone 5 built the permission engine, the executor gate, and the
    assembled request path, but registered no new `ipcMain` channel and
    wired no `dialog.showMessageBox` call, because nothing yet has a real,
    safe side effect or a real confirmation-requiring action reachable from
    the running application. Milestone 6 does not change this: `main/index.ts`
    calls `loadEmergencyState` read-only at startup, but nothing calls
    `engageEmergencyStop` or `resetEmergencyStop` from the running app.
    Every guarantee above is verified by tests that call
    `handleActionProposal` directly, not by driving the real app end-to-end
    through IPC. This is consistent with Milestone 3's and Milestone 4's own
    storage-only, not-yet-wired scope, not a shortcut specific to any one
    milestone.

16. **The emergency stop has no user-facing control at all yet.** There is no
    button, menu item, keyboard shortcut or IPC channel a user could actually
    reach to engage or reset it. `engageEmergencyStop` and
    `resetEmergencyStop` are real and fully tested, but only as functions a
    future caller passes to `handleActionProposal` — building that caller is
    UI work belonging to a later milestone, not a Milestone 6 deliverable.

---

## Reporting

If you find a security issue in this project, report it to the repository
owner directly. Do not open a public issue.
