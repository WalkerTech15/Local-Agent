# Phase 2 coding workspace

> **Current state.** Phase 2, Milestone 5 adds a **read-only** coding
> workspace: the user approves one project directory in a native picker, and
> the application can list, read, search and reason about what is inside it —
> and nothing else. There is no write, no patch, no terminal, no Git command
> and no shell. That absence is structural, not a policy: no action type, no
> IPC channel, no preload function and no schema in this milestone can express
> a modification.
>
> Builds on [phase-2-chat-architecture.md](phase-2-chat-architecture.md),
> [phase-2-provider-architecture.md](phase-2-provider-architecture.md),
> [phase-2-real-provider-architecture.md](phase-2-real-provider-architecture.md)
> and [phase-2-provider-completion.md](phase-2-provider-completion.md), none of
> which changed. `main/permissions.ts`, `main/executor.ts`,
> `main/action-pipeline.ts`, `main/action-runtime.ts`, `main/audit.ts`,
> `main/emergency.ts`, `main/secrets.ts`, `main/settings.ts` and
> `main/policy.ts` all have **zero diff** in this milestone.

---

## Summary

| Property                                | State                                                                                              |
| --------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Project selection                       | **[implemented]** — native `dialog.showOpenDialog`, owned by the main process                      |
| Renderer can name a directory to open   | **Never.** `workspace:select` takes no arguments at all                                            |
| Read-only listing, viewing, searching   | **[implemented]** — `src/main/workspace-inspector.ts`                                              |
| Path containment                        | **[implemented]** — two independent layers, lexical then `realpath`                                |
| Symbolic-link escape                    | **[implemented]** — refused after canonicalisation; the tree walk skips links entirely             |
| Credential and dependency exclusion     | **[implemented]** — `src/shared/workspace/exclusions.ts`                                           |
| Coding plan                             | **[implemented]** — deterministic, derived from observation; **no model call**                     |
| Plan can be applied                     | **Never.** `diff` is pinned to `null`, `status` to `'awaiting-approval'`, and nothing consumes one |
| New action types                        | **[implemented]** — `workspace.select`, `workspace.read`, `workspace.plan`                         |
| Emergency stop blocks workspace actions | **[implemented]** — none is on the exemption list                                                  |
| Approved project persisted to disk      | **Never.** In memory, for the lifetime of one application run                                      |
| File writing, terminal, Git, shell      | **Absent.** See [What remains deferred](#what-remains-deferred)                                    |

---

## The decision this milestone turns on

A read-only file browser sounds like a small feature. It is not: it is the
first time this application reads a file the user's own machine did not put
under `%APPDATA%\Local-Agent\`, and the first time a directory tree written by
someone else becomes input. `AGENTS.md` §5 already classes such content as
untrusted, in the same category as model output.

So the design question was never "how do we read files" but "what, exactly, is
the smallest thing that can be read, and who decides". Three answers shape
everything below.

### 1. The user chooses the directory, in a dialog the renderer cannot reach

`workspace:select` takes **no arguments**. Not a path it validates — none at
all. The main process opens `dialog.showOpenDialog` (`main/directory-picker.ts`),
the user clicks, and whatever comes back is the only candidate.

This is the same reasoning that makes `main/confirm.ts`'s confirmation dialog
native rather than HTML: a renderer, or anything that has compromised one, can
ask that the user be asked, and nothing more. It cannot pre-fill the dialog,
suppress it, answer it, or point it anywhere.

It is also why `workspace.select` is `allow` by default rather than being
added to the confirmation floor. A second, HTML-triggered confirmation before a
native dialog would be ceremony: the picker **is** the consent, and it is a
stronger form of consent than `chat.send`'s (which this codebase already
accepted as sufficient, on the weaker grounds that the user typed and pressed
Send in the renderer).

### 2. Two containment layers, because neither is sufficient alone

Every path the renderer sends is _relative_ to the approved root, and passes
through both:

| Layer                                   | Where                                 | Catches                                                                                           |
| --------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Lexical (pure, no filesystem)           | `src/shared/workspace/path-safety.ts` | `..`, `.`, absolute paths, UNC, drive letters, backslashes, NTFS streams, device names, bidi, NUL |
| Canonical (`realpath`, then re-checked) | `src/main/workspace-paths.ts`         | Symbolic links leading outside the project — invisible to any lexical rule                        |

A lexical rule cannot see a link: `src/notes` may be perfectly well-formed and
still point at `C:\Users\me\.ssh`. A `realpath` check cannot run on a string
that has not been joined onto a root yet — and joining is exactly the step an
absolute path or a `..` segment subverts. So the order is: validate lexically,
refuse excluded segments, join, check containment, canonicalise, **check
containment again**.

The canonical form is deliberately narrow — `/`-separated, relative, no `.` or
`..`, no `\`, no `:`, no wildcard, no trailing dot or space, no Windows device
name. Every path the renderer ever sends was produced by this codebase's own
listing in exactly that form, so refusing everything else costs nothing.

Three of those rules are worth naming because they are not obvious:

- **`\` is refused.** Without it, `..\..\Windows` is a single segment that is
  neither `.` nor `..`, so it passes a `/`-oriented segment check — while
  `path.resolve` still treats the backslashes as separators on Windows. (Lint
  caught a collapsed escape here during development, which is exactly the class
  of bug the second containment layer exists to survive.)
- **`:` is refused**, which blocks a drive letter and, less obviously,
  `notes.txt:hidden` — an NTFS alternate data stream, a different file that no
  listing would ever have shown.
- **A trailing dot or space is refused.** Windows silently strips both, so
  `secrets.` and `secrets` name the same file: a second spelling around every
  name-based rule.

### 3. The plan is derived, not generated

`workspace:plan` produces its plan **deterministically**, from what was
observed about the project. It calls no model. Two reasons:

- A model-written plan is untrusted text that would then have to be parsed back
  into a structure — new attack surface, in the exact place this milestone is
  supposed to be establishing that model output is data and never instruction,
  and for no gain while nothing can act on a plan anyway.
- It would make the workspace unusable whenever `modelProvider.provider` is
  `none`, which is the default — so the approval gate could not be demonstrated
  or reviewed without first configuring a provider.

Every risk and assumption a plan states is _observed_: emitted because a
specific fact about the project was, or was not, found. "No test tooling was
detected" appears only when no test marker exists at the root. A later
milestone that wants a model to elaborate on a plan passes this structure to it
and validates what comes back against `codingPlanSchema` — the seam is the
schema, and it already exists.

---

## Modules

| File                                             | Responsibility                                                                         |
| ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| `src/shared/workspace/path-safety.ts`            | Pure lexical path validation. The first containment layer.                             |
| `src/shared/workspace/exclusions.ts`             | What is never descended into, read or searched, and why.                               |
| `src/shared/workspace/errors.ts`                 | The twelve-code normalized error vocabulary, and the fixed messages that never travel. |
| `src/shared/workspace/plan.ts`                   | The pure plan builder. No I/O, no clock, no model.                                     |
| `src/shared/schemas/workspace.schema.ts`         | Every shape that crosses a boundary, all bounded.                                      |
| `src/main/directory-picker.ts`                   | The native picker. Takes no path.                                                      |
| `src/main/workspace-paths.ts`                    | Canonical containment. The second layer.                                               |
| `src/main/workspace-session.ts`                  | The approved project, in memory, for this run only.                                    |
| `src/main/workspace-inspector.ts`                | The only module that reads a user's file: tree, read, search.                          |
| `src/main/workspace-planner.ts`                  | Gathers observations, calls the pure builder.                                          |
| `src/renderer/workspace/ipc-workspace-client.ts` | The one renderer file permitted to call `window.localAgent`.                           |
| `src/renderer/workspace/workspace-controller.ts` | Framework-independent state: loading, empty, error, retry, approval.                   |
| `src/renderer/workspace/Workspace.tsx`           | The interface. Holds no logic of its own.                                              |

---

## Bounds

Nothing accumulates without a cap. Every one is a named constant in
`src/shared/constants.ts`, and every one reports itself rather than silently
shortening a result — a listing that quietly omits half a project is one a
reader would draw the wrong conclusion from.

| Dimension                  | Constant                              | Value        |
| -------------------------- | ------------------------------------- | ------------ |
| Relative path length       | `WORKSPACE_MAX_RELATIVE_PATH_LENGTH`  | 512          |
| Path segments              | `WORKSPACE_MAX_PATH_SEGMENTS`         | 32           |
| Tree depth                 | `WORKSPACE_MAX_TREE_DEPTH`            | 8            |
| Tree entries               | `WORKSPACE_MAX_TREE_ENTRIES`          | 2,000        |
| Entries per directory      | `WORKSPACE_MAX_DIRECTORY_ENTRIES`     | 500          |
| File size (**refused**)    | `WORKSPACE_MAX_FILE_BYTES`            | 512,000      |
| Binary sniff sample        | `WORKSPACE_BINARY_SNIFF_BYTES`        | 8,192        |
| Search matches             | `WORKSPACE_MAX_SEARCH_RESULTS`        | 200          |
| Files opened by one search | `WORKSPACE_MAX_SEARCH_FILES`          | 1,000        |
| File size searched         | `WORKSPACE_SEARCH_MAX_FILE_BYTES`     | 256,000      |
| Match excerpt              | `WORKSPACE_SEARCH_EXCERPT_MAX_LENGTH` | 240          |
| Objective                  | `WORKSPACE_OBJECTIVE_MAX_LENGTH`      | 2,000        |
| Plan steps / files / risks | `WORKSPACE_PLAN_MAX_*`                | 12 / 20 / 12 |
| Search terms used to plan  | `WORKSPACE_PLAN_MAX_SEARCH_TERMS`     | 3            |

An oversized file is **refused, not truncated** — the same reasoning the audit
log applies to an oversized record: a partial source file invites a reader to
conclude something from text that was silently cut off.

---

## Exclusions

Three lists, for three different reasons, kept separate so the rationale for
each stays readable (`src/shared/workspace/exclusions.ts`):

- **Excluded directories** — `node_modules`, `.git`, `dist`, `build`,
  `coverage`, `.venv`, `.ssh`, `.aws`, and the rest. Excluded because they are
  enormous or are not the user's source. They are still **listed**, marked
  `excluded`, and never descended into — hiding them would make the tree
  disagree with what is on disk.
- **Credential files** — `.env*`, `.netrc`, `.npmrc`, `id_rsa`, `*.pem`,
  `*.p12`, `secrets.json`. Never listed as readable, never opened, never
  searched. Reading one would put a live secret into renderer memory and onto a
  screen.
- **Binary extensions** — a cheap pre-filter. Never the only check: a NUL byte
  in the first bytes read, and a failed strict UTF-8 decode, are what actually
  decide, since an extension is only a claim a file makes about itself.

The one subtlety worth stating: the credential-stem rule (`secrets.*`,
`credentials.*`) is **skipped for source and documentation extensions**. This
repository is its own motivating example — `src/main/secrets.ts` and
`src/shared/schemas/secrets.schema.ts` are exactly the files a reader would
want to open when inspecting how secrets are handled, and hiding them would
make the inspector actively misleading about the project it is showing. The
stem rule applies to data files; a credential pasted into a `.ts` file is not
caught, which is the same limitation the audit log's name-based redaction
already has.

**`.git` is detected without being read.** Whether a project is
version-controlled comes from the mere existence of the entry, so the interface
learns it without anything listing or reading one byte inside.

---

## IPC and the permission pipeline

Six channels, all read-only, all routed through the unmodified
`runAction` → `handleActionProposal`:

| Channel            | Action             | Request                |
| ------------------ | ------------------ | ---------------------- |
| `workspace:status` | `workspace.read`   | none                   |
| `workspace:select` | `workspace.select` | **none**               |
| `workspace:tree`   | `workspace.read`   | `{path}` (`''` = root) |
| `workspace:file`   | `workspace.read`   | `{path}`               |
| `workspace:search` | `workspace.read`   | `{query, path}`        |
| `workspace:plan`   | `workspace.plan`   | `{objective}`          |

Three action types rather than one, because they are three genuinely different
decisions a user might want to make separately: granting read access to a
directory tree, reading inside one already granted, and preparing the plan that
a future modification would have to pass through. All three are `allow` by
default and **none is emergency-stop exempt**, so an engaged stop denies every
one of them — asserted by a test that walks all six channels.

**Audit parameters carry no path, no name, no query and no objective.** Only
`{operation}` and, where useful, a _length_: `{operation: 'search',
queryLength: 6}`, `{operation: 'plan', objectiveLength: 22}`. A directory path
can name a person, a client or an unreleased product; a search term is user
content. This follows `chat.send`'s own precedent of recording
`{provider, messageCount}` rather than the conversation, and a test asserts the
project path never appears in any record.

---

## What the interface shows, and how it stays safe

`src/renderer/workspace/Workspace.tsx` renders the project summary, a file
tree, a search box, a read-only viewer, file metadata, and the plan. Loading,
empty, error and retry states all come from `WorkspaceController`, which is
framework-independent and fully unit-tested without React or jsdom — the same
split `ConversationController` already uses, and for the same reason
([security-model.md](security-model.md) known limitation 18).

- **Everything from the project is a plain JSX text child.** File names, paths,
  excerpts and file contents alike. `dangerouslySetInnerHTML` appears nowhere.
- **No main-process message is ever displayed.** Failures cross as a bounded
  `WorkspaceErrorCode`; the sentence a person reads is one of the controller's
  own reviewed strings. A denial gets its own message naming the emergency stop
  and the permission policy, rather than being folded into "could not read".
- **Retry is offered only where retrying could help.** An excluded path or an
  oversized file answers the same next time, so no Retry button is shown for
  them.
- **Bidirectional overrides are handled asymmetrically, deliberately.** A file
  name carrying one is refused outright (it could disguise an extension); a
  _search excerpt_ is sanitized (it is already a lossy fragment, and a results
  list is where a reordered line would be most convincing); a _file's contents_
  are shown exactly as stored, with a warning banner — refusing would make
  Arabic, Hebrew and Persian source unopenable, and rewriting it would mean the
  viewer lied about what is on disk.
- **The read-only marker is the loudest thing in the header**, and the plan's
  approval control says plainly that approving unlocks nothing.

---

## The approval gate

`WorkspaceController.approvePlan()` sets a flag and does nothing else. There is
no modification function for it to unlock, in that module or anywhere else in
this milestone.

That is the point. The requirement — explicit user approval before any future
modification — is implemented as a real, tested state transition rather than a
promise, so whichever milestone adds a modification has a gate already in place
to route through rather than one to invent. Approval resets for every newly
generated plan, so it is never inherited by a plan the user has not seen, and
the interface states outright that nothing was changed.

`codingPlanSchema` backs this at the schema level: `diff` is pinned to `null`
(not omitted), `approvalRequired` to `true`, `status` to `'awaiting-approval'`,
and `changeType` admits only `'modify'` and `'review'` — never `'create'` or
`'delete'`. A later edit that starts producing a diff has to change the schema,
and therefore has to be reviewed.

---

## Security boundary

Everything Milestones 1–4 established holds unchanged. New in this milestone:

- **All filesystem access is in `src/main`.** `src/shared/workspace/*` is bound
  by the same lint purity boundary as the rest of `src/shared`; the renderer
  reaches the disk only through six narrow, schema-validated channels.
- **The renderer cannot name a directory to open.** `workspace:select` has no
  argument, asserted at the schema, at the IPC layer, and against the real
  built bridge.
- **Nothing can express a modification.** No action type, no channel, no
  preload function, no schema field. Tests assert the absence at each layer,
  including against the real running application's bridge.
- **The inspector never writes and never logs.** Proven, not asserted: a test
  snapshots the project before and after a full listing, read, search and plan
  — including when every operation fails — and another spies on
  `console.log`/`error`/`warn` across the same.
- **The approved path is never persisted.** Not to `settings.json`, not to the
  secret store, not across restarts. Read access to someone's source tree is a
  per-session grant made by clicking through a dialog, not a preference to be
  restored silently on the next launch.
- **The application's own data directory is refused as a project**, in both
  directions (inside it, or containing it). Both sides of the comparison are
  canonicalised first — a short (8.3) Windows ancestor such as
  `C:\Users\VUNHAT~1\…` would otherwise share no common root with its long
  form and let the guard pass silently. That was a real defect, found by a test.
- **The two renderer bridge callers are named and enforced.** A source scan
  asserts `window.localAgent` appears in exactly two files —
  `ipc-chat-provider.ts` and `ipc-workspace-client.ts` — and nowhere under
  `src/shared`.

---

## Testing

| Area                                                                                                            | File                                               |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Lexical containment: traversal, absolute, UNC, drive letters, backslashes, NTFS streams, device names, bidi     | `tests/unit/shared/workspace-path-safety.test.ts`  |
| Exclusions, in both directions: what must not be read, and what must stay readable                              | `tests/unit/shared/workspace-exclusions.test.ts`   |
| Plan building: determinism, observed risks, bounds, and the no-diff/awaiting-approval guarantees                | `tests/unit/shared/workspace-plan.test.ts`         |
| Every boundary shape, including the plan shapes that cannot describe a modification                             | `tests/unit/shared/workspace.schema.test.ts`       |
| Canonical containment and **symlink escape**, against a real filesystem                                         | `tests/unit/main/workspace-paths.test.ts`          |
| Project adoption, refusals, and the in-memory session                                                           | `tests/unit/main/workspace-session.test.ts`        |
| Tree, read and search against a real project; size, binary, excluded and missing handling; **no write, no log** | `tests/unit/main/workspace-inspector.test.ts`      |
| Observations measured from a real project; plan changes nothing on disk                                         | `tests/unit/main/workspace-planner.test.ts`        |
| Loading, empty, error, retry, staleness, the approval gate                                                      | `tests/unit/renderer/workspace-controller.test.ts` |
| Permission gating, emergency-stop denial, request validation, audit content                                     | `tests/unit/main/ipc.test.ts`                      |
| Request/response schemas and the absence of any write-shaped field                                              | `tests/unit/shared/ipc.schema.test.ts`             |
| Bridge shape, and no workspace mutator, against the real built app                                              | `tests/e2e/electron-smoke.test.ts`                 |

The symlink-escape cases create real links and detect a platform that refuses
(Windows needs Developer Mode or elevation), reporting a skip rather than a
false pass. They were genuinely exercised on the development machine. The same
escape is _also_ covered lexically, without any symlink.

---

## What remains deferred

Genuinely absent, not merely unused — there is no action type, channel, schema
or function for any of it:

- File writing, code modification, patch application
- Terminal, PowerShell, Command Prompt, shell commands
- Git commits, branches, resets, checkouts; dependency installation
- Browser automation, Windows automation, screen capture, camera, email
- Memory, embeddings, RAG, workflows, multi-agent execution
- Administrator or elevated execution
- Unrestricted filesystem access
- A model-assisted plan (the schema seam exists; nothing uses it)
- A diff or proposed file content of any kind
