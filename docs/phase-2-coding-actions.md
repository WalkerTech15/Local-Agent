# Phase 2 controlled coding actions

> **Current state.** Phase 2, Milestone 6 gives the coding workspace the
> ability to **change three things**, each behind a native confirmation the
> renderer cannot forge or answer: it can overwrite files inside the approved
> project, it can run one of five named commands the project itself declares,
> and it can create one Git checkpoint commit. Everything Milestone 5
> established about _reading_ is unchanged.
>
> Builds on [phase-2-coding-workspace.md](phase-2-coding-workspace.md).
> `main/permissions.ts`, `main/executor.ts`, `main/action-pipeline.ts`,
> `main/action-runtime.ts`, `main/audit.ts`, `main/emergency.ts`,
> `main/secrets.ts`, `main/settings.ts` and `main/policy.ts` all have **zero
> diff** in this milestone — the fifth consecutive one.

---

## Summary

| Property                                  | State                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| Proposed change, shown as a diff          | **[implemented]** — `src/shared/workspace/diff.ts`, pure and bounded                 |
| Approval before writing                   | **[implemented]** — confirmation floor, enforced in code, not policy                 |
| Renderer can name what gets written       | **Never.** `workspace:apply` carries a change _id_ and nothing else                  |
| Writes restricted to the approved project | **[implemented]** — the Milestone 5 containment layers, re-run at write time         |
| Backup before every change                | **[implemented]** — outside the project, under `%APPDATA%\Local-Agent\backups`       |
| Rollback of the latest applied change     | **[implemented]** — `workspace:rollback`, itself confirmed                           |
| File creation or deletion                 | **Never.** A change modifies files that already exist                                |
| Command registry                          | **[implemented]** — five entries, `src/shared/workspace/command-registry.ts`         |
| Renderer can name a command string        | **Never.** `commandId` is an enum member; every argument is a literal                |
| Shell, PowerShell, `cmd`, elevation       | **Absent.** `spawn` with `shell: false`, always                                      |
| Timeout, output caps, step limit, cancel  | **[implemented]** — `src/main/process-runner.ts`                                     |
| Emergency stop kills a _running_ command  | **[implemented]** — polled during the run, not only before it                        |
| Git status and diff                       | **[implemented]** — read-only                                                        |
| Git checkpoint                            | **[implemented]** — one commit, on the branch already checked out, after approval    |
| Git reset, checkout, branch, push, remote | **Absent.** No schema, no channel, no argument vector                                |
| Repository hooks run                      | **Never.** `core.hooksPath` is redirected to an empty directory                      |
| New action types                          | `workspace.write`, `workspace.rollback`, `command.run`, `git.read`, `git.checkpoint` |
| Emergency stop blocks them                | **[implemented]** — none is on the exemption list                                    |

---

## The three decisions this milestone turns on

### 1. A change is proposed once and applied by reference

This is the single most important shape in the milestone.

`workspace:propose` is the only channel that carries file content. It reads
what is currently on disk, records a SHA-256 of it, builds the diff, and keeps
the whole change set **in the main process**, keyed by an id the main process
generated. It writes nothing.

`workspace:apply` then takes **that id and nothing else** — no path, no
content, no destination. `workspaceApplyRequestSchema` is a `strictObject`
with one `uuid` field, so a request carrying a `path` or a `content` is
rejected outright rather than ignored.

The consequence is worth stating plainly: **the bytes written are necessarily
the bytes that were diffed and shown.** A renderer that is compromised between
the diff appearing on screen and the user approving it can ask for an
already-reviewed change to be applied again; it cannot substitute a different
one, because there is no parameter through which to do so. Had `apply` taken
`{path, content}`, an approval would have meant only "the user approved
something a moment ago", which is not the same claim at all.

Two further checks run at the moment of writing, not at proposal time:

- **Containment, again.** Every path is resolved through
  `resolveProjectPath` a second time — lexical rules, exclusion rules, join,
  `realpath`, and the containment check _after_ canonicalisation. A symbolic
  link planted between the proposal and the approval is refused, not followed.
- **Content, again.** The file's hash must still match what was diffed. If the
  user changed it in another editor, or a build touched it, the write is
  refused as `WORKSPACE_CHANGE_STALE` rather than silently discarding their
  work. This is the content half of time-of-check/time-of-use, and unlike the
  path half it can be closed completely.

A change set is **all-or-nothing**: if the third of five writes fails, the two
that already succeeded are restored from the backup before the failure is
reported. A half-applied change is the one outcome a user could not reason
about.

### 2. A command is named, never spelled

`commandRunRequestSchema` carries `{runId, commandId}` where `commandId` is
one of five enum members. There is no field anywhere for a command string, an
argument, a working directory, an environment variable or a shell — so "no
arbitrary command strings" is a property of the type rather than a filter
applied to one. Every argument vector is a literal in
`src/shared/workspace/command-registry.ts`; the project supplies the script
_body_, never the command line.

**The honest limit.** `npm run test` runs whatever the project's
`package.json` says it should, and a project is untrusted input in exactly the
sense `AGENTS.md` §5 means. No registry can change that — running the
project's own test command _is_ the requested feature. So the controls are
placed where they can actually work:

- the command must be one of the five;
- the project must already declare that script, so nothing is invented;
- `command.run` is on the **confirmation floor**, which no policy edit can
  downgrade, so the user approves it in a native dialog the main process owns;
- that dialog states the exact program, the exact arguments, the exact
  directory, and the project's own script text — sanitized to one bounded
  line, because a multi-line script must not be able to push the real question
  off the screen;
- `describeScriptRisks` flags a script that chains commands, reaches the
  network, deletes files, asks for elevation or runs inline code, so the
  dialog can say what is unusual about this one. Advisory, never authorizing:
  their absence proves nothing, because a script can do any of those through
  spellings the list does not enumerate.

This is recorded as the milestone's central limitation in
[security-model.md](security-model.md) rather than described as solved.

### 3. Git can commit, and cannot do anything else

Six argument vectors exist, all built in `src/shared/workspace/git.ts` from
literals: `rev-parse --is-inside-work-tree`, `rev-parse --show-toplevel`,
`rev-parse --abbrev-ref HEAD`, `rev-parse --short HEAD`,
`status --porcelain=v1 --branch --untracked-files=all`,
`diff --no-color --no-ext-diff --no-textconv --unified=3 -- <path>`,
`add --all --`, and `commit --message <generated> --no-verify`.

There is no `reset`, `checkout`, `switch`, `restore`, `clean`, `rm`, `branch`,
`push`, `fetch`, `pull`, `remote`, `rebase`, `merge`, `stash`,
`filter-branch`, `reflog` or `config`. `FORBIDDEN_GIT_SUBCOMMANDS` states the
list as data, and a test asserts none of them appears as a quoted literal in
either Git module — with the declaration of the list itself stripped first, or
the scan would match itself and mean nothing.

Three refusals protect a checkpoint from costing the user anything:

- **The project must be the repository root.** If the user approved a
  _subdirectory_ of a repository, `git add --all` from there would still stage
  the whole repository — files outside the directory they approved.
  `--show-toplevel` is compared against the approved root, both sides
  canonicalised first (a short 8.3 Windows ancestor shares no common root with
  its long form, the same defect Milestone 5 found in its user-data guard).
- **HEAD must be on a branch.** A commit on a detached HEAD is trivially lost,
  and a checkpoint exists precisely so that nothing is.
- **There must be something to commit**, or the checkpoint is noise in
  someone's history.

**Repository hooks never run.** A repository carries its own executable hooks
in `.git/hooks`, and a checkpoint commit would otherwise execute them —
running code out of a directory the user merely _opened_. Every invocation
therefore passes `-c core.hooksPath=<an empty directory this application
owns>`. `--no-verify` alone would not do it: it suppresses some hooks, not all
of them. A test proves this by installing a real `pre-commit` hook, confirming
with a control commit that hooks execute on the machine at all, and then
asserting the product's checkpoint does not run it.

---

## No shell, ever

`spawn` is called with `shell: false` in every case.

Windows makes this awkward rather than impossible: `npm` is a `.cmd` script,
and Node refuses to spawn one without a shell (the fix for CVE-2024-27980).
`resolveProgram` therefore finds the real file on `PATH` itself, and a batch
file is run through the command interpreter with an explicit argument array.

Two details there are not cosmetic:

- **`cmd /s /c` strips the first and last quote** of everything after `/c`, so
  `/c "C:\Program Files\nodejs\npm.cmd" run test` becomes the command
  `C:\Program Files\nodejs\npm.cmd" run test` — split at the space, failing
  with `'C:\Program' is not recognized`. The fix, and what Node's own
  `shell: true` does, is to wrap the whole remainder in one further pair of
  quotes. **This was a real defect, caught by a test on a machine whose Node
  lives under `C:\Program Files`**, and it is now covered by a regression test
  that asserts the exact string handed to the interpreter.
- **Every argument is checked against `SAFE_ARGUMENT_PATTERN` first.** A run
  whose arguments are not all free of `&`, `|`, `<`, `>`, `^`, `%`, `!`, `"`,
  backtick, `$`, `;` and control characters is **refused**, not escaped —
  because escaping correctly for two different interpreters is a problem this
  application does not need to have. In practice no argument ever fails it:
  every one is a registry literal or a path this codebase built.

---

## What a child process does not get

| Withheld               | Why                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| A terminal             | `stdin: 'ignore'`, so a command that prompts reads end-of-file and exits rather than hanging      |
| The parent environment | Only `INHERITED_ENVIRONMENT_NAMES` passes through — no `*_TOKEN`, no `*_KEY`, no `NODE_OPTIONS`   |
| Unbounded time         | `COMMAND_TIMEOUT_MS`; the process **tree** is killed, via `taskkill /T` on Windows                |
| Unbounded output       | Byte, line and line-length caps — and output past the cap is still **drained**, never left unread |
| Concurrency            | One command at a time, checked and claimed in the same step so two requests cannot both pass      |

Withholding the parent environment is not incidental: a user who has exported
an API token into their shell must not hand it to a project's build script
because they asked Local Agent to run one. A test asserts a sentinel value in
the parent is absent from the child.

Draining past the cap matters for a different reason: a child whose stdout
pipe fills up blocks forever, so output that is no longer being kept must
still be read. A test runs a process that prints twenty thousand lines with a
five-line cap and asserts it exits on its own, with its own exit code, rather
than only at its timeout.

---

## The emergency stop reaches a running process

The permission engine already refuses to _start_ an action while the stop is
engaged. That is only half of what "emergency stop" should mean, so
`runProcess` polls `isEmergencyEngaged` while the process runs and kills it if
the stop is engaged mid-run. The result is reported as `stopped`, distinct
from `failed`, so the interface never tells a user their tests failed when in
fact the run was cut short.

---

## Bounds

| Dimension                        | Constant                          | Value                  |
| -------------------------------- | --------------------------------- | ---------------------- |
| Files in one change set          | `WORKSPACE_MAX_CHANGE_FILES`      | 10                     |
| Bytes of proposed content        | `WORKSPACE_MAX_WRITE_BYTES`       | 256,000                |
| Pending proposals held           | `WORKSPACE_MAX_PENDING_CHANGES`   | 5                      |
| Applied change sets remembered   | `WORKSPACE_MAX_APPLIED_CHANGES`   | 20                     |
| Diff lines, whole change set     | `WORKSPACE_DIFF_MAX_LINES`        | 4,000                  |
| One diff line                    | `WORKSPACE_DIFF_MAX_LINE_LENGTH`  | 500                    |
| Line-alignment matrix cells      | `WORKSPACE_DIFF_MAX_MATRIX_CELLS` | 1,000,000              |
| Command wall-clock time          | `COMMAND_TIMEOUT_MS`              | 300,000                |
| Captured output bytes / lines    | `COMMAND_MAX_OUTPUT_*`            | 200,000 / 2,000        |
| Concurrent commands              | `COMMAND_MAX_CONCURRENT_RUNS`     | 1                      |
| Git time / status entries / diff | `GIT_TIMEOUT_MS`, `GIT_MAX_*`     | 30,000 / 500 / 200,000 |

The diff's matrix cap is the one worth explaining. Line alignment is quadratic
in the number of _differing_ lines, so a shared prefix and suffix are stripped
first — an ordinary one-line edit in a five-thousand-line file never
approaches the bound. Two genuinely unrelated files are the pathological case,
and past the cap the differ reports one coarse replacement and **says so**
(`coarse: true`) rather than spending the privileged process's CPU.

---

## Backups

Backups go to `%APPDATA%\Local-Agent\backups\<change id>\`, **outside the
user's project**. A backup written into the project would appear in its file
tree, in its `git status`, and eventually in one of its commits — the
application would be leaving litter in someone else's repository as a side
effect of protecting it.

Rollback restores only the **most recent applied** change. Restoring an older
one would silently undo everything applied after it, which is not what "undo
the change I just made" means to anyone.

**Nothing is ever deleted.** Evicting an old change set from memory leaves its
backup on disk; the user's own files are never removed by any code path in
this milestone. `main/workspace-changes.ts` imports `mkdir`, `open`,
`readFile`, `rename`, `rm` and `stat` — and `rm` is used for exactly one
thing: removing the module's own temporary file when an atomic write fails.

---

## What a person actually reads before approving

Two gates, and they are not the same thing:

1. **The interface's gate.** `WorkspaceController.approveChange()` records
   that the user has read the diff. `applyChange()` refuses without it, and it
   resets for every newly proposed change set, so approval is never inherited
   by a diff the user has not seen.
2. **The security control.** The native confirmation the main process owns,
   built from the change set the main process is holding — never from the
   request. A compromised renderer can skip the first; it cannot skip the
   second.

Diff lines are **sanitized before display**, unlike whole-file content in the
Milestone 5 viewer, and the asymmetry is deliberate: the viewer shows a file
exactly as stored because reading it is all that happens, while the diff
screen is where someone decides to _write_. Text that renders differently from
how it is stored would do the most damage there. Any alteration is reported in
`warnings`, so a sanitized diff never passes itself off as a verbatim one, and
`diffLineSchema` refuses a control character or a bidi override outright — the
schema is the check _on_ the sanitizer, not a second implementation of it.

Declining a confirmation comes back as `outcome: 'aborted'`, which the
controller reports as an ordinary activity note rather than an error banner.
Telling someone their own deliberate refusal had failed would be its own kind
of misinformation.

---

## IPC

Ten new channels. Four can change something, and every one of those is on the
confirmation floor.

| Channel              | Action               | Request                      | Confirmed |
| -------------------- | -------------------- | ---------------------------- | --------- |
| `workspace:propose`  | `workspace.plan`     | `{edits: [{path, content}]}` | no        |
| `workspace:apply`    | `workspace.write`    | `{changeId}`                 | **yes**   |
| `workspace:rollback` | `workspace.rollback` | `{changeId}`                 | **yes**   |
| `workspace:changes`  | `workspace.read`     | none                         | no        |
| `command:list`       | `workspace.read`     | none                         | no        |
| `command:run`        | `command.run`        | `{runId, commandId}`         | **yes**   |
| `command:cancel`     | —                    | `{runId}`                    | n/a       |
| `git:status`         | `git.read`           | none                         | no        |
| `git:diff`           | `git.read`           | `{path \| null}`             | no        |
| `git:checkpoint`     | `git.checkpoint`     | **none**                     | **yes**   |

`command:cancel` is the one channel with no permission gate, for exactly the
reason `chat:cancel` has none: it cannot start anything, read anything or
reach anything — it can only ask an already-authorized run to stop early.

**Audit parameters carry no path, no name, no query and no content.** Only
`{operation}` and, where useful, a _count_: `{operation: 'apply',
fileCount: 1}`, `{operation: 'diff', scoped: true}`. The one exception is
`{operation: 'run', commandId: 'lint'}` — a command id is an enum member, not
user content, and recording it is what lets the audit trail answer "what did
it run". A test asserts the project path, the file paths and the proposed
content never appear in any record.

---

## Security boundary

Everything Milestones 1–5 established holds unchanged. New in this milestone:

- **Only one module writes a project file.** `main/workspace-changes.ts`, and
  it can only overwrite files that already exist.
- **Only one module starts a process.** `main/process-runner.ts`, always with
  `shell: false`, always in the approved project, always bounded.
- **The renderer cannot name what is written or what is run.** A change id and
  an enum member, asserted at the schema, at the IPC layer, and against the
  real built bridge.
- **Nothing creates or deletes a project file.** No action type, no channel,
  no preload function, no schema field. Tests assert the absence at each
  layer.
- **Repository hooks and diff filters are disabled** for every Git
  invocation.
- **The child process inherits neither a terminal nor the parent's secrets.**

---

## Testing

| Area                                                                                   | File                                                   |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Diff correctness, sanitization, the coarse fallback and every bound                    | `tests/unit/shared/workspace-diff.test.ts`             |
| The registry, what is absent from it, and script-risk flags                            | `tests/unit/shared/workspace-command-registry.test.ts` |
| Git argument vectors, forbidden subcommands, porcelain parsing                         | `tests/unit/shared/workspace-git.test.ts`              |
| Every boundary shape, and what cannot be expressed                                     | `tests/unit/shared/coding.schema.test.ts`              |
| Propose/apply/rollback against a real filesystem: containment, symlinks, stale, backup | `tests/unit/main/workspace-changes.test.ts`            |
| Real processes: timeout, output caps, draining, cancel, emergency kill, environment    | `tests/unit/main/process-runner.test.ts`               |
| `package.json` as untrusted input; running a real `npm` script                         | `tests/unit/main/project-commands.test.ts`             |
| A real repository: status, diff, checkpoint, refusals, **hooks do not run**            | `tests/unit/main/git-runner.test.ts`                   |
| Permission gating, confirmation, emergency stop, audit content                         | `tests/unit/main/ipc-coding.test.ts`                   |
| The approval gate, declining, cancellation, retry                                      | `tests/unit/renderer/workspace-controller.test.ts`     |
| Bridge shape and the absent functions, against the real built app                      | `tests/e2e/electron-smoke.test.ts`                     |

The symbolic-link and Git cases run against real links and real repositories,
and report a skip rather than a false pass when a platform refuses. Both were
genuinely exercised on the development machine.

---

## What remains deferred

Genuinely absent — no action type, channel, schema or function for any of it:

- Creating or deleting a file; applying an externally supplied patch
- An arbitrary command, a shell, PowerShell, `cmd`, or elevated execution
- Dependency installation
- Any Git operation that resets, checks out, switches, cleans, deletes a
  branch, rewrites history, or contacts a remote
- Browser automation, Windows automation, screen capture, camera, email
- Memory, embeddings, RAG, workflows, multi-agent execution
- A model that writes the proposed content (the change still comes from the
  interface; the schema seam exists and nothing uses it)
