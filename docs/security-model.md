# Security model

> **Current state.** Milestone 1 implemented the shared schema layer.
> Milestone 2 added the hardened Electron shell. Milestone 3 added non-secret
> settings storage. Milestone 4 added the append-only, redacting, daily
> rotating audit log writer. Milestone 5 added the permission-policy runtime:
> a pure decision engine, an executor gate, fail-safe policy loading, and the
> assembled canonical request path. Milestone 6 added persisted emergency-stop
> state — fail-safe loading, atomic writes, and the engage/reset operations —
> under an engine and pipeline that needed no code changes, since both already
> took emergency state as an explicit input. Milestone 7 registers the first
> five real, privileged IPC channels (`settings:get`, `settings:update`,
> `secrets:status`, `secrets:write`, `secrets:clear`), the first real
> native confirmation dialog, the encrypted secret store backed by Electron's
> synchronous `safeStorage`, `hasApiKey` reconciliation, and the first-run
> onboarding interface — again under a permission engine, executor and
> pipeline that needed **zero code changes**. Phase 2, Milestone 3 registers
> the first two channels since Phase 1 (`chat.send`, `chat.cancel`) and the
> first action type with real network egress, `chat.send` — routed through
> the same unmodified permission engine, executor and pipeline once again,
> and the first caller of `main/secrets.ts`'s `readSecret` outside that
> module's own tests. Phase 2, Milestone 4 completes the provider layer (GLM
> and Ollama, the latter refused unless its endpoint is a local address) and
> adds bounded streaming, introducing `chat:chunk` — the first and only
> main → renderer _push_ channel — while adding **no** new action type, no
> new permission decision and no new secret-store access. Phase 2, Milestone 5
> adds the **read-only coding workspace** — the first time this application
> reads a file outside `%APPDATA%\Local-Agent\` — under three new action types
> (`workspace.select`, `workspace.read`, `workspace.plan`), six new channels,
> and a permission engine, executor, pipeline and audit writer that once again
> needed **zero code changes**. Controls below are marked **[implemented]**,
> **[enforced by schema]** or **[planned, milestone N]**. Nothing here is
> claimed as working before it exists.

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

A compromised renderer therefore gains only the narrow preload API — as of
Phase 2 Milestone 4, `health`, `settings.get`, `settings.update`,
`secrets.status`, `secrets.write`, `secrets.clear`, `chat.send`,
`chat.cancel` and `chat.onChunk`, and nothing else. `chat.onChunk` is a
subscription to one fixed, one-way event channel, not a request: it can
receive bounded, schema-validated preview text for a `chat.send` the
renderer itself initiated, and can do nothing else. Every one of the
remaining privileged functions except `chat.cancel` is gated and audited
through
`main/action-pipeline.ts`'s unmodified `handleActionProposal`
(`main/ipc.ts` → `main/action-runtime.ts`'s `runAction` → `handleActionProposal`),
and none of them can return a plaintext key. `chat.cancel` has no privileged
side effect of its own to gate — it can only ask an already-authorized
`chat.send` call already in flight to abort early; see
`docs/phase-2-real-provider-architecture.md`'s Cancellation section for why
that is safe without a permission decision of its own.

### Permission model

**[enforced by schema]** The default decision is `deny` and the policy file
cannot declare anything else. An action with no matching rule is denied.

**[enforced by schema]** A confirmation floor: `secrets.write`,
`secrets.clear`, `emergency.reset`, `app.exit`, and — since Phase 2
Milestone 6 — `workspace.write`, `workspace.rollback`, `command.run` and
`git.checkpoint`, plus — since Milestone 7 — `agent.write` and `agent.run`,
and — since Milestone 8 — `memory.clear`, `memory.export` and `memory.import`,
plus — since Milestone 9 — `workflow.write` and `workflow.run`, plus — since
Milestone 10 — `automation.run`,
cannot be downgraded to `allow` by editing the policy file. The schema rejects
such a file.

`memory.read` and `memory.write` are deliberately **not** on that floor.
Saving or unpinning one note is an ordinary edit inside the application's own
data directory, reversible by the same operation that made it — the same
reasoning that keeps `settings.write` off the floor. The three that are on it
each stop being ordinary: clearing destroys a whole scope at once, exporting
writes the user's notes to a file outside the application where its
protections no longer apply, and importing brings content from outside into a
store. Prompting for every note saved would train people to click through
dialogs, which is its own security problem.

**[enforced by type]** A **workflow can never start itself.** A workflow's
`trigger` is an enum with exactly one member, `manual`. A scheduled run, a
file-change trigger, a Git trigger and an email trigger are not disabled
anywhere in the codebase — they are not representable, because the enum has no
value for them and `workflowTriggerSchema` accepts nothing else. There is no
`workflow.schedule`, `workflow.watch` or `workflow.trigger` action type
either, and a hand-edited `workflows.json` claiming a non-manual trigger fails
validation and is discarded in full. Background autonomy is therefore
prevented by the type rather than by a check someone could forget.

**[enforced by type]** A **workflow can never widen its agent.** Every step
names a tool from the fixed Milestone 7 registry, and each of those maps to an
action type Milestones 5 and 6 already defined — so a workflow introduces no
capability. It must also stay inside the allowlists of the agent profile it
selects, checked when the workflow is saved and again before every single
step, because a profile can be narrowed afterwards. The chain is
`workflow ⊆ agent profile ⊆ permission policy`, and a workflow sits at the
narrow end of it. Its steps are executed by the _same_ step runner an agent
run uses, so every one of them reaches the permission engine and the audit log
by the path Milestone 7 already established.

**[enforced by type]** A **workflow can never loop without bound.** Retries are
capped per step, and every attempt counts as a step against the run's own step
ceiling, so the retry budget cannot outlive the run budget. Conditions are a
closed three-value enum rather than an expression language: a user-editable
definition cannot ask the privileged process to evaluate arbitrary logic.

**[enforced by type]** An **automation action can never name its own target.**
A request carries a `toolId` from a fifteen-value enum, the fixed registry in
`shared/automation/registry.ts` — never a path, a URL, an argument or a
command line, because no field of the request or of a registry entry has that
shape. `launch-app` and `run-script` resolve only to a literal executable
under `%SystemRoot%\System32`, started with `shell: false`; `open-folder`
resolves only to one of four fixed special folders or the already-approved
project root; `open-website` resolves only to one of four fixed `https://`
hosts, checked again immediately before it is opened; `focus-window` reaches
only this application's own window. See `docs/phase-2-automation.md`.

**[enforced by type]** A **memory can never be written by a model.** A memory
record's `source` is an enum of exactly two members, `user` and `import`, and
both are stamped in the main process by the one handler that performs each
operation — the input schema has no `source` field at all. There is no value a
chat reply, an agent step or an inference could be stored under, so "never
silently save model output as memory" is a property of the type rather than a
check somewhere that could be forgotten. In the same way, a memory record
declares no field for a permission, a tool, an action type, a provider, a
command or a path, and nothing in the codebase reads any of those out of its
content: a note is stored, displayed and matched against a search query, and
that is the entire set of things done with it.

**[enforced by type]** An **agent profile can never grant a permission.** A
profile is user-editable configuration describing which of a fixed set of
tools an agent may reach for, and its own decision vocabulary is
`confirm | deny` — `allow` is not a member of the enum, so "permit this" is
not expressible in a profile at all. Every tool a profile may name maps to an
action type that already existed, so the maximum an agent can do is never
larger than what the permission policy already allowed, and the orchestrator
takes the stricter of the two decisions. A profile that raises a step to
`confirm` causes an **additional** native dialog in front of the pipeline; it
never replaces one. See
[phase-2-agent-profiles.md](phase-2-agent-profiles.md).

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

**[implemented, M7]** Confirmation prompts as native, main-process-owned
dialogs. Milestone 5 represented "confirmation required" and its resolution
as explicit data (`PermissionVerdict.confirmationRequired`,
`ConfirmationResult`) and an injected `requestConfirmation` callback, without
wiring it to a concrete UI. Milestone 7 does: `main/confirm.ts`'s
`showNativeConfirmation` calls the real `dialog.showMessageBox`, parented to
the main window, and `main/index.ts` is the only place that builds the
`requestConfirmation` closure `main/ipc.ts` receives — `main/ipc.ts` itself
never imports `electron`'s `dialog`. `secrets.write` and `secrets.clear` are
the first two action types to actually trigger one. The dialog text is built
by the caller (`main/ipc.ts`) from safe, fixed strings naming only the
provider — never the key itself — and `main/confirm.ts` does not inspect the
action or its parameters, so it has no way to leak one either way. An HTML
dialog rendered by the renderer remains explicitly disallowed and is not how
this is implemented.

### Network egress

**[implemented, Phase 2 Milestones 3-4]** The only network-capable code in
this codebase is `src/main/chat-completions-transport.ts` — the one HTTP
exchange shared by all three real adapters
(`openai-compatible-provider.ts`, `glm-provider.ts`, `ollama-provider.ts`) —
called only through `main/chat-provider-registry.ts`'s
`resolveMainChatProvider`, called only from `chat.send`'s `perform` callback
in `main/ipc.ts`. Three independent facts hold this to the main process
alone:

- `src/shared`'s lint-enforced purity boundary (see _Shared-layer purity_
  below) blocks `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource` as
  globals, so no file under `src/shared`, including every other
  `ChatProvider` in this codebase, can ever place a real request.
- The renderer's Content-Security-Policy sets `connect-src 'none'`
  (`main/index.ts`, unchanged since Milestone 2), independently blocking a
  network request initiated from the renderer's own script context —
  asserted by an end-to-end test.
- `src/renderer/chat/ipc-chat-provider.ts` — the only renderer file that
  reaches the real adapter at all — calls only the narrow, typed
  `chat.send`/`chat.cancel`/`chat.onChunk` preload functions, never a network
  API directly; a source-scan test asserts no file under `src/renderer/chat`
  references a network-capable global either.

**[implemented, Phase 2 Milestone 4]** The `ollama` provider is refused
unless its endpoint is local. `src/shared/chat/local-endpoint.ts` classifies
a configured `baseUrl` statically, without DNS — loopback, RFC 1918 private
and link-local literals plus `localhost`/`*.localhost` are accepted, and
every other host, **including a name that would resolve to a private
address**, is refused. A refused endpoint fails closed with
`PROVIDER_INVALID_CONFIGURATION` and never falls back to the local default,
because sending the request somewhere the user did not configure would be a
silent provider substitution. Ollama also reads no credential at all: its
config type has no key field, and `resolveMainChatProvider` skips the secret
read entirely for it, so a key stored for another provider cannot reach a
local endpoint.

**[implemented, Phase 2 Milestone 4]** Streaming adds no authority. A
streamed fragment is a preview: it is bounded (bytes read, line length,
delta size, accumulated length, whole-call duration), validated at every
hop, correlated to the request that asked for it, delivered only to the
window that made that request, and never committed to conversation state —
the message that is committed remains the whole reply `chat.send` resolves
with, validated as one document. Streamed text reaches no audit record, no
action proposal, no executor, and no privileged API; it is rendered as a
plain JSX text child, the same escaping every other message gets.

`chat.send` is a genuine privileged action, not a bypass of the model above:
it is gated by the same, unmodified `decidePermission` → `execute` →
`appendAuditRecord` pipeline every other action type uses, denied outright
while the emergency stop is engaged (it is not on the exemption list), and
recorded in the audit trail with only `{provider, messageCount}` — never
message content, never a response, never a credential. See
`docs/phase-2-real-provider-architecture.md` for the full design, including
the one deliberate policy choice this milestone made: `chat.send` is `allow`
by default rather than `confirm`, since the send itself is already a
direct, per-message user action, unlike the rare, one-time changes the
confirmation floor (`secrets.write`, `secrets.clear`, `emergency.reset`,
`app.exit`) protects.

### Filesystem access

**[implemented, Phase 2 Milestone 5]** Before this milestone, every path this
application touched derived from `app.getPath('appData')` and none was
user-supplied — "path traversal: not reachable" was literally true. The coding
workspace changes that, so the controls that make it safe are stated in full.

**The renderer cannot name a directory.** `workspace:select` takes no
arguments at all — not a path it validates, none. `main/directory-picker.ts`
opens `dialog.showOpenDialog` and whatever the _user_ clicks is the only
candidate, which is then still canonicalised, confirmed to be a directory, and
refused if it is (or contains) the application's own data directory. A
compromised renderer can ask that the user be asked, and nothing more. This is
the same reasoning that makes the confirmation dialog native rather than HTML,
and it is why `workspace.select` is `allow` by default: the picker **is** the
consent, and a stronger form of it than a renderer-side click.

**Containment is enforced twice, by two mechanisms that fail differently.**
Every renderer-supplied path is relative to the approved root and passes:

1. `src/shared/workspace/path-safety.ts` — pure and lexical. Refuses `..`,
   `.`, absolute paths, UNC prefixes, drive letters, `\` (without which
   `..\..\Windows` is a single segment that passes a `/`-oriented check while
   `path.resolve` still treats it as separators), `:` (a drive letter, and the
   NTFS alternate-data-stream separator — `notes.txt:hidden` is a different
   file no listing ever showed), wildcards, control characters, bidirectional
   overrides, Windows reserved device names, and any trailing dot or space
   (Windows strips both, so `secrets.` and `secrets` are the same file — a
   second spelling around every name-based rule).
2. `src/main/workspace-paths.ts` — joins onto the real root, checks
   containment, canonicalises with `realpath`, and **checks containment
   again**. This is the check that catches a symbolic link: a lexical rule
   cannot see one, and `realpath` cannot run on a string that has not been
   joined onto a root yet. Verified against a real filesystem with real links.

Containment comparison uses `path.relative`, not a string prefix: on Windows
that compares case-insensitively and normalises separators, and it does not
mistake `…\project-backup` for something inside `…\project`.

**The tree walk never follows a link.** It keeps only entries that are a
regular file or a real directory, which excludes symbolic links (and with them
directory loops and escapes), sockets, FIFOs and device nodes. A symlinked file
can still be opened directly by path, where the canonical check proves it stays
inside; the walk simply does not offer it.

**Excluded paths are never opened**, at any depth, and the check runs on every
segment rather than only the last — `node_modules/pkg/index.js` is refused even
though `index.js` alone would be fine. Three lists, for three reasons
(`src/shared/workspace/exclusions.ts`): dependency and build directories
(listed but never descended into, so a tree does not silently misrepresent the
project); credential files (`.env*`, `.netrc`, `.npmrc`, `id_rsa`, `*.pem`,
`*.p12`, `secrets.json` — never listed as readable, never read, never
searched); and binary extensions, as a pre-filter ahead of the real test, which
is a NUL byte in the first bytes read plus a strict UTF-8 decode.

**Everything is bounded**, and every bound reports itself rather than silently
shortening a result: tree depth (8), entries (2,000), entries per directory
(500), file size (512,000 bytes — **refused**, not truncated, for the same
reason an oversized audit record is rejected), search matches (200), files
opened by one search (1,000), and match excerpt length (240). A search query is
matched as a **literal substring, never compiled as a regular expression** —
compiling user input as a pattern is how a search box becomes a denial of
service against the process that owns every privileged operation here.

**Nothing in this milestone can modify a file**, and that is structural rather
than a policy: there is no `workspace.write` action type, no write channel, no
preload function, and no request schema field capable of carrying content or a
destination. `main/workspace-inspector.ts` imports exactly `readdir`,
`readFile` and `stat` from `node:fs/promises`, and that import list is the
whole of its filesystem capability. A test snapshots a project before and after
a full listing, read, search and plan — including when every operation fails —
and asserts it is unchanged; another asserts the module logs nothing at all.

**No path, name, query or file content reaches an audit record or an error.**
Audit parameters carry `{operation}` and at most a _length_
(`{operation: 'search', queryLength: 6}`); a directory path can name a person,
a client or an unreleased product, and a search term is user content.
Filesystem errors are mapped by `code` alone — never `message`, which contains
the full path — into a twelve-code normalized vocabulary, and the sentence a
user reads is one of the renderer's own reviewed strings, never anything that
crossed the boundary.

**The approved path is never persisted.** It lives in memory, per
`registerIpcHandlers` call, for one application run. Read access to someone's
source tree is a grant the user makes by clicking through a dialog, not a
preference restored silently on the next launch.

**A coding plan is inert.** `codingPlanSchema` pins `diff` to `null` (declared,
not omitted, so a later edit that starts producing one must change the schema
and therefore be reviewed), `approvalRequired` to `true`, and `status` to
`'awaiting-approval'`; `changeType` admits only `'modify'` and `'review'`. The
plan is produced deterministically from observation, with **no model call** —
see [phase-2-coding-workspace.md](phase-2-coding-workspace.md) for why. Nothing
in this milestone consumes a plan, so approving one unlocks nothing; the gate
exists so whichever milestone adds a modification has one to route through.

**Every workspace action is denied while the emergency stop is engaged.** None
of the three is on `EMERGENCY_STOP_EXEMPT_ACTION_TYPES`, and a test walks all
six channels to confirm it — including that the native picker is never even
shown, since `execute` never reaches `perform`.

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

**[implemented, M7]** `hasApiKey` is **derived metadata and must never be
treated as authoritative.** It is a cached answer to a question that only the
encrypted secret store can actually answer, and the two can drift — a settings
file restored from backup, an interrupted write, or a secret store cleared
outside the application all leave the flag disagreeing with reality.

`main/settings-service.ts` now discharges the obligation the schema's doc
comment described since Milestone 3:

- `readReconciledSettings` and `writeOnboardingSettings` both recompute
  `hasApiKey` from `main/secrets.ts`'s `hasStoredSecret`, for whichever
  provider is selected, on every `settings.read` and every `settings.write` —
  never from caller input, never from whatever was last written to disk;
- after a successful `secrets.write` or `secrets.clear`,
  `refreshHasApiKeyAfterSecretChange` re-reconciles it, called only once the
  store operation itself has already succeeded, so a failed store write is
  never reported as a present key;
- **where the two disagree, the secret store is the source of truth.**
  `hasApiKey` is corrected to match it, never the other way round, and the
  correction is persisted back to `settings.json`, not only returned;
- additionally forced `false` for any provider outside
  `PROVIDERS_REQUIRING_API_KEY` (`'none'` and `'ollama'`), a stricter
  service-level choice on top of, not a weakening of, the schema's own floor
  (which forbids `hasApiKey: true` only for `'none'`);
- no code path may infer that a key exists, or is usable, from `hasApiKey`
  alone — it exists so the interface can show key status without a key
  crossing the process boundary, and for nothing else.

See known limitation 12 for the one remaining gap: the settings-side
correction persisted by an _unreconciled_ read that predates this milestone.

**[implemented]** No action type returns a secret value. `secrets.read` does
not exist; the action list contains only `secrets.write`, `secrets.clear` and
`secrets.status`, the last of which returns a boolean. A unit test asserts
this.

**[implemented, M7]** Keys are stored using Electron's **synchronous**
`safeStorage` API — `isEncryptionAvailable()`, `encryptString()` and
`decryptString()` are all synchronous in the installed `electron@44.1.1`,
verified against its typings rather than assumed from older documentation —
which encrypts under Windows DPAPI for the current user account. Plaintext
exists only inside the main process, only for the lifetime of one
`secrets.write`/`readSecret` call, and is never logged, never placed in an
error message, and never included in an audit parameter (it is never even
placed in `proposal.parameters` in the first place, so redaction is a second,
independent layer rather than the only thing standing between it and the
audit log). There is no IPC channel that returns a key: `secrets.status`
returns only `{present: boolean}`.

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

**[implemented]** Corrupt settings load safe defaults. **[implemented, M5]** A
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

**[implemented, M7]** `settings:get` and `settings:update` expose settings to
the renderer, both routed through `main/settings-service.ts` and the
unmodified permission pipeline. `main/index.ts` still calls `loadSettings`
once at startup, read-only, to prove the path resolves before the window
opens; `writeSettings` is now also called for real, from `settings:update`'s
`perform` callback, gated by the same `settings.write` decision as every
other action type. The `settings:update` request schema is built from
`modelProviderInputSchema`, which has no `hasApiKey` field at all — a renderer
cannot set it even by constructing a hostile payload, since `strictObject`
rejects the extra key outright rather than silently dropping it.

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
proposal yet. Milestone 7 does not change this: it registers channels for
settings and secrets only, not for the emergency stop. The native
confirmation dialog such a control would need already exists
(`main/confirm.ts`, see _Permission model_ above) and would be reused, not
rebuilt, whenever this control arrives.

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
process, for all five channels, not only the health check: `main/ipc.ts`
parses each channel's arguments against its request schema
(`settingsGetRequestSchema`, `settingsUpdateRequestSchema`,
`secretsStatusRequestSchema`, `secretsWriteRequestSchema`,
`secretsClearRequestSchema`) and its result against the matching response
schema before either crosses the process boundary. An invalid request — an
unapproved provider identifier, an `apiKey` outside its bounds, a payload
carrying `hasApiKey` — throws before a proposal is even built, so no
permission decision and no audit record exist for it. Unknown channels are
rejected — `ipcMain` has no handler for anything else, and the preload
exposes no way to address one. No generic pass-through channel exists.

---

## Threats and status

| Threat                                                                                       | Status                                                                                                                                                                                                               |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer compromise (XSS, malicious UI dependency)                                           | Addressed, M2 — process isolation and CSP; asserted by an end-to-end test                                                                                                                                            |
| Malicious or malformed IPC payload                                                           | Addressed, M2–M7 — schema validation on every registered channel (`health`, `settings:get`, `settings:update`, `secrets:status`, `secrets:write`, `secrets:clear`); no unvalidated or generic channel exists         |
| Secret exfiltration through the interface                                                    | Addressed — no channel returns a key; asserted by test                                                                                                                                                               |
| Secret leakage into logs or errors                                                           | Addressed, M4 — schema-level redaction contract plus writer-side redaction, both verified                                                                                                                            |
| Credential persisted inside a settings _value_                                               | Addressed — `baseUrl` rejects embedded userinfo                                                                                                                                                                      |
| Log injection via a crafted user name                                                        | Addressed — control characters rejected                                                                                                                                                                              |
| Display spoofing via bidirectional overrides                                                 | Addressed — bidi overrides and isolates rejected in display strings                                                                                                                                                  |
| Forged audit record                                                                          | Addressed — biconditional cross-field integrity rules                                                                                                                                                                |
| Unbounded or non-serialisable audit payload                                                  | Addressed — bounded JSON-safe parameter schema; writer-side scan bounds the whole record                                                                                                                             |
| Audit record overwritten or truncated by a write                                             | Addressed, M4 — append-only file handle; proven under concurrent writes by test                                                                                                                                      |
| Prototype-pollution key bypassing schema validation                                          | Addressed, M4 — explicit writer-side scan; schema-only reliance was verified insufficient                                                                                                                            |
| Settings tampering or corruption                                                             | Addressed, M3 — strict validation, fail-safe loading to defaults, atomic writes                                                                                                                                      |
| Policy tampering or corruption                                                               | Addressed, M5 — fail-closed loading (`main/policy.ts`) plus engine-side floor enforcement independent of it                                                                                                          |
| Policy file removing the user's emergency controls                                           | Addressed, M5 — availability floor enforced at both the schema layer and, independently, by `decidePermission`                                                                                                       |
| Policy bypassing schema validation before reaching the engine                                | Addressed, M5 — floors re-verified by the engine regardless of validation history                                                                                                                                    |
| Corruption of a shared security default in memory                                            | Addressed — exported defaults deeply frozen; resolvers return fresh objects                                                                                                                                          |
| `src/shared` reaching the OS, network or eval                                                | Addressed — lint boundary, verified by probe; not a runtime sandbox                                                                                                                                                  |
| Privilege escalation via the executor                                                        | Addressed, M5 — `execute` requires a verdict as an explicit argument; proven by tests that no denial or rejection reaches `perform`                                                                                  |
| A side effect running without a permission decision                                          | Addressed, M5 — structural: no code path in `execute` calls `perform` without an authorizing verdict                                                                                                                 |
| Model rationale/confidence used as authorization                                             | Addressed, M5 — `decidePermission` never reads `proposal.parameters`; proven by test                                                                                                                                 |
| Emergency-stop bypass (decision logic)                                                       | Addressed, M5 — engine denies non-exempt actions when engaged, evaluated after both floors                                                                                                                           |
| Emergency-stop bypass (persistence)                                                          | Addressed, M6 — atomic writes, fail-safe loading; reset requires an approved confirmation the pipeline already enforces                                                                                              |
| Emergency-stop state corruption fails open instead of closed                                 | Addressed, M6 — malformed or unreadable state resolves engaged, not disengaged; proven by test                                                                                                                       |
| Emergency reset triggered by a model or a policy rule alone                                  | Addressed, M6 — always resolves to `confirm`; proven across a policy × emergency-state test matrix                                                                                                                   |
| Plaintext API key stored as a fallback when encryption is unavailable                        | Addressed, M7 — `writeSecret` throws `SecretStoreUnavailableError` before any disk write when `safeStorage.isEncryptionAvailable()` is `false`; proven by test                                                       |
| Plaintext API key reaching settings.json, an audit record, an error message, or the renderer | Addressed, M7 — `apiKey` never enters `proposal.parameters`; secrets IPC responses carry only `{present: boolean}`; proven by test                                                                                   |
| `hasApiKey` reported as `true` for a provider that does not use a key (`none`, `ollama`)     | Addressed, M7 — forced `false` regardless of the secret store; proven by test                                                                                                                                        |
| A denied or rejected secret operation still mutating the store or `hasApiKey`                | Addressed, M7 — `perform` is structurally unreachable on `deny`/`reject`; `hasApiKey` is only refreshed after the store write already succeeded; proven by test                                                      |
| Renderer-supplied `hasApiKey` reaching a persisted document                                  | Addressed, M7 — `settingsUpdateRequestSchema` has no such field; `strictObject` rejects the extra key outright                                                                                                       |
| Path traversal                                                                               | Addressed, Phase 2 M5 — user-supplied paths exist for the first time; contained lexically and again after `realpath`, both verified against a real filesystem                                                        |
| Symbolic link leading outside the approved project                                           | Addressed, Phase 2 M5 — refused after canonicalisation; the tree walk keeps only regular files and real directories, so it cannot follow or loop on one                                                              |
| A credential file in the user's project being read or displayed                              | Addressed, Phase 2 M5 — `.env*`, key, keystore and credential-stemmed data files are never listed as readable, opened or searched, at any depth                                                                      |
| The renderer choosing which directory becomes readable                                       | Addressed, Phase 2 M5 — `workspace.select` takes no argument; the user chooses in a native dialog the main process owns, which is then still canonicalised and validated                                             |
| The application's own data directory opened as a "project"                                   | Addressed, Phase 2 M5 — refused in both directions, with both sides canonicalised first so a short (8.3) Windows ancestor cannot defeat the comparison                                                               |
| A file modified, created or deleted by the workspace                                         | Addressed, Phase 2 M5 — structurally absent: no action type, channel, preload function or schema field can express one; proven by before/after snapshots across success and failure                                  |
| A project path, file content or search query reaching the audit log                          | Addressed, Phase 2 M5 — parameters carry `{operation}` and at most a length; asserted by test                                                                                                                        |
| Unbounded memory or time from a hostile project tree                                         | Addressed, Phase 2 M5 — depth, entry, per-directory, file-size, match and scanned-file caps, each reporting when it stopped; search is literal substring matching, never a compiled pattern                          |
| Prompt injection, untrusted model or tool output                                             | Reachable from Phase 2 M3 (a real provider replies) — no tool exists for a model to invoke, so untrusted assistant text still cannot authorize or perform an action; see the proposal/executor split                 |
| Renderer or a compromised dependency making a network request directly                       | Addressed, Phase 2 M3 — CSP `connect-src 'none'` (unmodified since M2) plus the `src/shared` and `src/renderer/chat` purity/scan boundaries; only `src/main/openai-compatible-provider.ts` can reach the network     |
| Plaintext API key reaching the renderer through a real provider call                         | Addressed, Phase 2 M3 — stays inside `resolveMainChatProvider`/`openai-compatible-provider.ts`; never in `ActionProposal.parameters`, `chatSendResponseSchema`, an audit record, or a thrown error; proven by test   |
| A real provider call bypassing the permission engine or the emergency stop                   | Addressed, Phase 2 M3 — reached only through the unmodified `runAction`/`handleActionProposal`; denied while the emergency stop is engaged                                                                           |
| Message content or a raw provider error leaking into the audit trail                         | Addressed, Phase 2 M3 — the `chat.send` proposal carries only `{provider, messageCount}`; every provider failure normalizes to one of five fixed codes first                                                         |
| A "local" provider silently reaching a cloud service                                         | Addressed, Phase 2 M4 — an Ollama endpoint must be a loopback, private or link-local literal (or localhost); a name that merely looks local is refused, and a refused endpoint never falls back to the default       |
| A credential stored for one provider being sent to another                                   | Addressed, Phase 2 M4 — the secret read is skipped entirely for providers outside PROVIDERS_REQUIRING_API_KEY, and the Ollama adapter has no config field that could carry a key                                     |
| Unbounded memory or output from a hostile streaming endpoint                                 | Addressed, Phase 2 M4 — bytes read, line length, delta size and accumulated content are each capped independently, in the main process and again in the renderer                                                     |
| Streamed model output treated as a message, or as authorization                              | Addressed, Phase 2 M4 — deltas are previews held outside the message list; the committed reply is the separately validated whole, and no path exists from either to the executor                                     |
| The renderer subscribing to arbitrary IPC events through the new push channel                | Addressed, Phase 2 M4 — chat.onChunk fixes the channel in the preload, validates every payload, hands back only an unsubscribe function, and never exposes ipcRenderer or the raw event                              |
| A file written outside the approved project                                                  | Addressed, Phase 2 M6 — the Milestone 5 containment layers are re-run at write time, after the diff and after the approval, so a link planted in between is refused rather than followed                             |
| The renderer naming what gets written, or substituting content after approval                | Addressed, Phase 2 M6 — `workspace:apply` carries a change _id_ and nothing else; the bytes written are the bytes the main process already held and already diffed                                                   |
| A change silently discarding an edit the user made in another editor                         | Addressed, Phase 2 M6 — the file's hash must still match what was diffed, or the write is refused as `WORKSPACE_CHANGE_STALE`                                                                                        |
| A half-applied multi-file change                                                             | Addressed, Phase 2 M6 — a change set is all-or-nothing; files already written are restored from the backup before the failure is reported                                                                            |
| A file created or deleted in the user's project                                              | Addressed, Phase 2 M6 — structurally absent: a change modifies files that already exist, and no action type, channel, preload function or schema field can express a create or a delete                              |
| A backup polluting the user's project or its next commit                                     | Addressed, Phase 2 M6 — backups are written under `%APPDATA%\Local-Agent\backups`, never inside the project                                                                                                          |
| An arbitrary command, a shell, PowerShell or elevation reached from the renderer             | Addressed, Phase 2 M6 — `commandId` is a five-value enum and every argument is a literal; `spawn` runs with `shell: false` in every case, and an argument carrying interpreter syntax is refused rather than escaped |
| A command running outside the approved project                                               | Addressed, Phase 2 M6 — the working directory is always the approved root; there is no parameter for anything else                                                                                                   |
| A project's build script inheriting the user's exported secrets                              | Addressed, Phase 2 M6 — only an allowlist of environment variables is passed through; no `*_TOKEN`, no `*_KEY`, no `NODE_OPTIONS`. Asserted by test with a sentinel value                                            |
| A command hanging on input, printing forever, or outliving its request                       | Addressed, Phase 2 M6 — no terminal (`stdin: 'ignore'`), timeout, byte/line caps with continued draining so a full pipe cannot wedge the child, and a process-**tree** kill on Windows                               |
| A command that was already running when the emergency stop was engaged                       | Addressed, Phase 2 M6 — the stop is polled during the run and kills the process; reported as `stopped`, never as a test failure                                                                                      |
| A repository's own hooks or diff filters executing because the user opened it                | Addressed, Phase 2 M6 — every `git` invocation redirects `core.hooksPath` to an empty directory this application owns, and diffs run `--no-ext-diff --no-textconv`; proven by a test with a real `pre-commit` hook   |
| A destructive Git operation (reset, checkout, branch delete, push, remote)                   | Addressed, Phase 2 M6 — structurally absent: no schema carries a subcommand, every vector is a literal, and a source scan asserts none of the forbidden subcommands appears in either Git module                     |
| `git add --all` staging files outside the directory the user approved                        | Addressed, Phase 2 M6 — a checkpoint is refused unless `--show-toplevel` canonically equals the approved root, so a subdirectory of a repository is never checkpointed                                               |
| A checkpoint commit that is easy to lose, or that is empty                                   | Addressed, Phase 2 M6 — refused on a detached HEAD and refused when there is nothing uncommitted                                                                                                                     |
| A diff line that renders differently from how it is stored                                   | Addressed, Phase 2 M6 — diff lines are sanitized before display and any alteration is reported in `warnings`; `diffLineSchema` refuses a control character or bidi override outright                                 |
| Unbounded CPU from diffing two unrelated files                                               | Addressed, Phase 2 M6 — a shared prefix and suffix are stripped first and the alignment matrix is capped; past the cap the differ reports one coarse replacement and says so                                         |
| A path, file content or a project script reaching the audit log                              | Addressed, Phase 2 M6 — parameters carry `{operation}` and a count; the only identifier recorded is `commandId`, an enum member. Asserted by test                                                                    |
| A project's `package.json` misleading a confirmation dialog                                  | Partly addressed, Phase 2 M6 — the script text is sanitized to one bounded single line and risk-flagged, but it is still attacker-influenced text in a security prompt; see limitation 26                            |
| Supply-chain compromise via npm                                                              | Mitigated, not eliminated — see below                                                                                                                                                                                |

---

## Known limitations

These are real and are stated plainly rather than described as solved.

0. **An agent run executes several actions after one approval.** Phase 2
   Milestone 7's `agent.run` is on the confirmation floor, so a run is
   approved in a native dialog that states the profile's tools, its workspace
   scope and its three ceilings before the first step — and every individual
   step is still decided by the permission engine on its own action type, with
   anything on the confirmation floor still prompting separately. But the
   approval is nonetheless _per run_, not per read: a person approving a run
   is approving a bounded sequence they did not see itemised. The bounds are
   what make that acceptable — a fixed seven-tool registry containing nothing
   that can write a file, apply a change or create a commit; a step ceiling; a
   time ceiling; an output ceiling; and an emergency stop re-read from disk
   between every step. It is a real widening of what one approval covers, and
   it is recorded here rather than presented as equivalent to approving each
   action.

0.5. **A memory record's content is stored in plain text, and the credential
screen is best effort.** Phase 2 Milestone 8 keeps memory in
`memory\personal.json` and `memory\projects\<key>.json`, both plain JSON
readable by anything running under the same Windows account. That is the
same exposure `settings.json` and `permissions\policy.json` already have,
and it is deliberate — these files are meant to be inspectable and
hand-editable — but memory holds notes _about a person_, which is a
different kind of content than a display name. Two consequences follow.
First, the store is not encrypted: DPAPI is reserved for the secret store,
where the whole point is that the content must never be readable. Second,
the value-level credential screen
(`src/shared/memory/secret-scan.ts`) catches _recognisable_ shapes — a
provider key with a known prefix, a pasted `Authorization: Bearer` header,
a PEM block, a `password=…` line — and cannot catch a credential that
looks like ordinary text. Someone determined to type a short database
password into a note will succeed. The control reduces accidents; it is not
a guarantee, and it is described that way in the interface as well as here.

0.6. **Clearing or deleting a memory does not securely erase it.** Every write
is one atomic rename over the previous file, so the _application_ retains
nothing and no partial document is ever left behind — but the replaced
file's old blocks are not overwritten, and on a journalling or
copy-on-write filesystem, or with Volume Shadow Copy enabled, earlier
content may survive on the disk. No application can promise otherwise from
user space. A deleted note is gone from Local Agent; it is not guaranteed
to be gone from the drive.

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

12. **Resolved, M7.** `hasApiKey` reconciliation now exists —
    `main/settings-service.ts`, described under _Secret handling_ above. One
    narrower gap remains: any `settings.json` written or last reconciled
    _before_ this milestone, then never read again through
    `readReconciledSettings`/`writeOnboardingSettings` (a raw external
    read of the file, or a build that never calls either), still shows
    whatever `hasApiKey` was last persisted, uncorrected, until the next real
    read or write. No code path in this codebase performs such a raw read,
    but a future migration or support script reading `settings.json` directly
    should not treat `hasApiKey` as authoritative without also calling
    `hasStoredSecret` itself. Kept as a numbered entry, rather than removed,
    so the references to this limitation number elsewhere do not shift.

13. **Resolved, M7, for the case that mattered.** Settings loading itself
    still cannot distinguish "no file yet" from "file existed but was
    rejected" — both still return identical fresh defaults from
    `loadSettings`, by design, and that has not changed. What Milestone 7
    resolves is the practical consequence this limitation used to describe:
    `settings:get` now routes through the full permission-and-audit pipeline,
    so every settings read is now auditable, and `App.tsx` now shows
    onboarding whenever `onboardingCompleted` is `false` — including a
    corrupted file's fresh defaults — rather than silently trusting whatever
    came back. There is still no explicit "your settings were reset because
    the file was corrupt" notice distinguishing that case from a genuine
    first launch; both simply present as onboarding.

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

15. **Resolved, M7, for settings and secrets; still open for the emergency
    stop.** Milestones 3–6 built storage, audit, permission and emergency-stop
    layers with no `ipcMain` channel and no `dialog.showMessageBox` call
    reaching any of them from the running application — every guarantee was
    verified only by tests calling `handleActionProposal` directly. Milestone
    7 registers the first five real channels and the first real dialog, both
    exercised end-to-end by `tests/unit/main/ipc.test.ts` and by the e2e
    smoke suite's static bridge-shape assertions. `emergency.engage` and
    `emergency.reset` remain exactly as before: real, tested `perform`
    callbacks with no IPC channel calling them, verified only through
    `handleActionProposal` directly — Milestone 7's scope was settings and
    secrets, not the emergency-stop UI.

16. **The emergency stop has no user-facing control at all yet.** There is no
    button, menu item, keyboard shortcut or IPC channel a user could actually
    reach to engage or reset it. `engageEmergencyStop` and
    `resetEmergencyStop` are real and fully tested, but only as functions a
    future caller passes to `handleActionProposal` — building that caller is
    UI work belonging to a later milestone, not a Milestone 6 deliverable.

17. **The encrypted secret store holds at most one key, not one per
    provider.** Switching `modelProvider.provider` does not clear a
    previously stored key: `secrets.write`/`secrets.clear` and `hasApiKey`
    reconciliation all operate on a single slot in `secrets.enc`, associated
    with whichever provider happens to be selected in `settings.json` at the
    moment each is evaluated, not with the provider that was selected when the
    key was written. This is deliberate for Phase 1's scope — nothing calls a
    provider or decrypts a key for any real use yet, so no code path can
    currently misapply a key meant for one provider to another — but it means
    a future milestone that actually calls a provider must not assume a
    present key was necessarily written for the _current_ provider selection
    without additional design. A user switching from `glm` back to
    `openai-compatible` will find their previous `openai-compatible` key (if
    one was ever stored) still present; this is intentional (re-entering a
    credential on every provider switch would be user-hostile) but is stated
    here explicitly since it was not asked for and is not obvious from
    `hasApiKey` alone.

18. **No renderer component-level automated test.** `tests/unit/main/ipc.test.ts`
    exercises the full IPC handler layer, including every path
    `Onboarding.tsx` and `App.tsx` drive, and the e2e suite asserts the
    bridge's exact static shape against the real built app — but no test
    renders the React components themselves. React Testing Library / jsdom
    are not part of this project's toolchain, and adding them for one
    component-level smoke test was judged not worth a new dependency; the
    business logic those components call is fully covered, but a rendering
    regression in the UI itself (a broken form field, a missed click handler)
    would not be caught by `npm test`.

19. **The e2e suite does not drive `settings:get`, `settings:update`, or any
    `secrets:*` channel against the real built app.** Unlike `health`, all
    five have real side effects — an audit-log write at minimum — and the
    e2e suite launches the real application with no override for
    `app.getPath('appData')`, so exercising them there would write to the
    developer's actual `%APPDATA%\Local-Agent\`. The e2e suite is limited to
    structural assertions (the bridge's exact key list, no generic invoke
    surface) that touch no side effect; full behavioural coverage of the five
    channels is in `tests/unit/main/ipc.test.ts`, against temporary
    directories, not the real application process.

20. **The workspace has a time-of-check/time-of-use gap.** Between `realpath`
    returning and the subsequent `open`/`readdir`, a path component could in
    principle be replaced with a symbolic link. Closing it properly needs
    handle-based, `O_NOFOLLOW`-style APIs that Node does not expose portably.
    The exposure is narrow — the attacker must already be able to write inside
    the user's own approved project, on the user's own machine, between two
    adjacent syscalls — and the consequence is bounded by everything else in
    the layer: the result is still read-only, still size-capped, and still
    refused if it is not text. Stated rather than described as solved.

21. **The file viewer warns about bidirectional control characters; it does
    not neutralise them.** A source file containing an override is shown
    exactly as stored, with a prominent warning, because refusing would make
    legitimate Arabic, Hebrew and Persian source unopenable and rewriting it
    would mean the viewer lied about what is on disk. The text can therefore
    still _render_ differently from how it is stored. File **names** and search
    **excerpts** are handled more strictly — a name carrying one is refused
    outright, and an excerpt is sanitised — because a name can disguise an
    extension and a results list is where a reordered line would be most
    convincing.

22. **Credential detection in a project is name-based, like the audit log's
    redaction, and inherits the same limitation.** `.env*`, known credential
    file names, key and keystore extensions, and credential-stemmed _data_
    files are excluded. A credential pasted into an ordinary source file —
    `src/config.ts` — is not caught, and the stem rule is deliberately skipped
    for source and documentation extensions so that files _about_ credential
    handling (this repository's own `src/main/secrets.ts`) stay readable. That
    is the safe direction for an inspector whose job is to show a project
    truthfully, but it is a real gap and is not closed by a value-level check.

23. **A coding plan is keyword matching, not understanding.** It is derived
    deterministically from bounded searches and the project's structure, with
    no model call (see
    [phase-2-coding-workspace.md](phase-2-coding-workspace.md) for why). It
    will miss a file that is relevant without sharing vocabulary with the
    request, and it says so in its own risks when nothing matched or when a
    search was truncated. It is a grounded starting point, not an analysis.

24. **The workspace bounds each operation, not the rate of operations.** One
    listing, read or search is capped in every dimension, but nothing limits
    how many a renderer may issue in succession. In a single-user desktop
    application whose renderer is driven by the same person who approved the
    project, this is acceptable; it would not be in a multi-user or remote
    context, neither of which this project has.

25. **No component-level render test for `Workspace.tsx`**, for the same reason
    as limitation 18 and with the same mitigation: every state transition
    (loading, empty, error, retry, staleness, the approval gate) lives in the
    framework-independent `WorkspaceController` and is fully covered there.
    What remains untested by an automated test is the JSX and event wiring
    itself. The e2e suite likewise does not drive the six workspace channels
    against the real built application — like `settings:*` and `secrets:*`
    (limitation 19), they have real side effects against the developer's actual
    `%APPDATA%\Local-Agent\`, and would additionally open a native dialog no
    headless run can answer. Their behavioural coverage is in
    `tests/unit/main/ipc.test.ts`, against temporary directories; the e2e suite
    asserts only the bridge's static shape and the absence of any mutator.

26. **Running a project's own command executes that project's code, and this
    application cannot make that safe.** This is the central limitation of
    Milestone 6 and it is inherent, not an oversight: `npm run test` runs
    whatever the project's `package.json` says, and a project is untrusted
    input in exactly the sense `AGENTS.md` §5 means. The registry restricts
    _which of five named scripts_ may be started; it cannot restrict what the
    script then does — it could delete files, reach the network, or read
    anything the user can read.

    What is actually controlled: the command must be one of five; the project
    must already declare it; `command.run` is on the confirmation floor, which
    no policy edit can downgrade; the native dialog states the exact program,
    arguments, directory and the project's own script text; risky-looking
    scripts are flagged; the run is bounded in time and output, inherits
    neither a terminal nor the parent's environment, and is killed by the
    emergency stop. The residual risk is that a user approves a command in a
    project whose `package.json` is hostile. The script preview is sanitized
    and bounded precisely because it is attacker-influenced text appearing in
    a security prompt, but a determined author can still write a plausible
    one-line script that does something else.

27. **`describeScriptRisks` is a heuristic, and its silence proves nothing.**
    It flags command chaining, common network and deletion tools, elevation
    and inline code by pattern. A script can do any of those through spellings
    it does not enumerate. It exists to warn, never to authorize — its output
    changes no decision the permission engine makes.

28. **A Git checkpoint stages everything, including work the user had
    deliberately left unstaged.** `git add --all` followed by `git commit` is
    non-destructive — nothing is lost, and the content is in the commit either
    way — but it does change the index, which could surprise someone who had
    carefully staged a subset. The confirmation dialog states both commands
    verbatim before it runs. Undoing a checkpoint is left to the user's own
    tools, because every Git command that would undo one is on the forbidden
    list.

29. **Tab characters in `git diff` output are shown as spaces.** Every line
    crossing to the renderer is sanitized, and a tab is a control character,
    so indentation in the Git diff view is approximate for tab-indented
    projects. This is a display trade-off taken deliberately rather than
    loosening the rule that no control character reaches the interface; the
    workspace's own diff is unaffected, since it is built from text this
    application decoded itself.

30. **The change store is per-session and in memory.** Proposals and the
    applied-change history do not survive a restart, so a rollback is only
    possible within the run that applied the change. The backup files
    themselves do persist under `%APPDATA%\Local-Agent\backups`, and nothing
    deletes them — recovering from an older one is a manual operation the user
    performs with their own tools.

31. **`focus-window` reaches only this application's own window, and
    `automation:cancel` cannot kill an already-launched application.**
    Focusing a window belonging to another process would need either an
    unapproved native dependency or unrestricted shell access, both of which
    this milestone's own security requirements forbid, so the tool is scoped
    to what this application can already do through Electron's own API rather
    than half-implemented. Cancelling a launch in progress abandons the
    attempt; a process that already started is left running deliberately,
    because a user who asked to open an application did not ask for the power
    to close it again. Both are stated plainly in `docs/phase-2-automation.md`
    rather than presented as complete.

32. **The installer is unsigned, and there is no update mechanism.**
    `Get-AuthenticodeSignature` on the built installer reports `NotSigned`,
    so Windows SmartScreen shows an unknown-publisher warning on first run,
    and nothing distinguishes a genuine installer from a tampered one by
    signature. There is also no way to deliver a fix to an already-installed
    copy other than asking the user to download and run a new installer by
    hand — Local Agent has no auto-updater, no update feed, and makes no
    background network call to check for one, consistent with
    [AGENTS.md](../AGENTS.md)'s prohibition on self-updating. Both are
    documented as release prerequisites, not implemented, in
    `docs/phase-3-production-readiness.md`. Phase 3 Milestone 3
    (`docs/phase-3-code-signing.md`) adds safe, environment-variable-driven
    configuration support for signing and a preflight check that fails
    loudly on an incomplete signing request — but still no certificate, so
    this limitation stands exactly as written until a real signed build
    shows `Valid` under `Get-AuthenticodeSignature`. Phase 3 Milestone 4
    (`docs/phase-3-auto-update.md`) adds the state machine and
    configuration-gating logic a future updater would sit behind —
    `src/shared/update/`, tested, with no live wiring — plus a preflight
    check that refuses to let updates be enabled without a complete signing
    configuration too. There is still no `electron-updater` dependency, no
    update feed, and no network call: this limitation remains fully
    accurate until all three exist.

---

## Reporting

If you find a security issue in this project, report it to the repository
owner directly. Do not open a public issue.
