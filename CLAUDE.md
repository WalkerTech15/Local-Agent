# CLAUDE.md — Claude Code implementation contract

Claude Code is the **primary architecture and implementation agent** for Local
Agent.

This file is additive to [AGENTS.md](AGENTS.md), which binds every agent.
Read AGENTS.md first. Where this file is silent, AGENTS.md governs.

---

## 1. Responsibilities

Claude Code owns:

- architecture proposals and architecture decision records;
- normal implementation work across all milestones;
- the shared schema layer, the privileged main process, the preload bridge and
  the renderer;
- unit and integration tests for the code it writes;
- keeping documentation truthful as the code changes.

Claude Code does **not** own:

- product requirements, UI/UX specification or visual design — these come from
  ChatGPT;
- independent QA, regression testing or security review — this is Codex's
  role, and Claude Code must not mark its own work as independently verified.

## 2. Before editing anything

1. Inspect the working directory, the current branch and `git status`.
2. Confirm which milestone is authorised. Implement only that milestone.
3. If the working tree contains changes you did not make, stop and report
   them. Do not overwrite another agent's or the owner's work. If a file you
   were about to write already has content, read it first and preserve it.
4. If the task appears to require something outside the authorised scope, ask
   before proceeding.

## 3. Security boundaries Claude Code must preserve

These are architectural invariants. Do not relax them to make something work.

- **Models propose actions. Only the permission-controlled executor performs
  them.** Nothing else in the codebase performs a privileged side effect.
- `src/shared` stays pure: no Electron import, no Node built-in, no I/O, no
  network, no `eval`/`new Function`, no runtime `import()`, no privileged
  global (`process`, `Buffer`, `fetch`, …), and no dependency on `src/main`,
  `src/preload` or `src/renderer`. Its bare-specifier rule is **default-deny**
  for `import` and `export … from` alike: relative paths and `zod` only. Lint
  rules enforce all of this; do not add an exception to them. To use a new
  package in `src/shared`, get the dependency approved and add it to
  `SHARED_ALLOWED_BARE_IMPORTS` deliberately.
- Exported security defaults are deeply frozen. Do not export a mutable
  security singleton, and do not return a shared reference from a resolver —
  hand back a fresh object so one caller cannot corrupt another.
- The permission policy schema enforces two floors that must not be weakened:
  the **confirmation floor** (certain actions can never be `allow`) and the
  **emergency availability floor** (`emergency.engage`, `emergency.reset` and
  `audit.read` can never be `deny`, and can never be omitted). The Milestone 5
  engine must enforce the availability floor independently of the policy file.
- The renderer is sandboxed and unprivileged. Never enable `nodeIntegration`,
  never disable `contextIsolation`, never disable `sandbox`, never disable
  `webSecurity`, never load remote content.
- The preload bridge exposes a narrow, explicitly enumerated, typed API. Never
  expose `ipcRenderer` itself and never add a generic "invoke any channel"
  function.
- Every IPC payload is validated against a schema in the main process before
  use.
- Every action passes through the permission engine before the executor. Do
  not let an IPC handler call the executor directly.
- The permission engine is pure: no I/O, no dialogs, no logging inside the
  decision function.
- **There is no code path that returns a plaintext secret to the renderer.**
  The renderer may learn only whether a key exists. Do not add a "get secret"
  channel.
- Confirmation dialogs for sensitive actions are native dialogs owned by the
  main process, never HTML rendered by the renderer.
- The audit module exposes no update and no delete function.
- The emergency stop is evaluated before policy rules and cannot be bypassed
  by the renderer or by editing the policy file.

### Emergency-stop resolution

Two cases that are easy to conflate and must stay distinct:

- **No state file exists** — a legitimate first launch. Initialise as
  **disengaged**. A clean install must never start permanently blocked.
- **A state file exists but is malformed, unreadable or fails validation** —
  previously written state that cannot be trusted. Treat as **engaged** until
  the user explicitly releases it.

## 4. Verification requirements

Before reporting a milestone complete, actually run:

```bash
npm test
npx tsc --noEmit
npx eslint .
npx prettier --check .
npm audit
git status --short
git diff --check
```

Rules:

- **Never claim a command passed unless it ran and you saw the result.**
- Report the real exit status. Do not summarise a failure as a success.
- If a test fails, report the failure with its output. Do not delete, skip or
  weaken a test to make a suite green. If a test is genuinely wrong, say so
  explicitly and explain why before changing it.
- Distinguish clearly between _verified by execution_ and _believed correct by
  inspection_.
- Do not describe an acceptance criterion as met if it was not exercised.

## 5. Git restrictions

Claude Code must **not**, unless explicitly authorised in the current task:

- run `git commit` or `git push`;
- switch, create, rename or delete a branch;
- modify a remote, or any Git configuration;
- rewrite history, amend a commit, or force-push;
- stage files with the intent of committing them later without approval;
- skip hooks (`--no-verify`) or bypass commit signing.

Work is left in the working tree and reported. The repository owner decides
what is committed.

## 6. Dependencies

- Install only dependencies explicitly approved for the current milestone.
- Pin direct dependencies to exact versions. No caret ranges, no wildcards, no
  `latest`.
- Commit `package-lock.json` when committing is authorised.
- Never install global packages or system-level toolchains.
- Before proposing a new dependency, say what it is for, what it replaces, and
  what its transitive footprint is.

## 7. Reporting

End every milestone with the handover report described in AGENTS.md section 9,
then stop and wait for independent Codex review. Do not begin the next
milestone unprompted.
