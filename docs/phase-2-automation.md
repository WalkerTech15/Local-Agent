# Phase 2, Milestone 10 — Windows automation

A bounded, permission-controlled layer over a fixed handful of reversible
desktop actions: launching an approved application, opening an approved
folder, opening an approved website, focusing this application's own window,
and running a registered script.

This document explains what the automation layer is here, what it
deliberately is **not**, and why each decision was made. It complements
[architecture.md](architecture.md) and [security-model.md](security-model.md);
where those disagree with this file, they were written to cover the whole
system and they win.

---

## The registry is the whole vocabulary

```
shared/automation/registry.ts
```

Fifteen tools, fixed in reviewed source — not configuration, not a setting,
and not anything a renderer, a project or a model can extend at runtime. A
request names an id from this closed enum and nothing else: no path, no URL,
no argument, no window handle, no command line. "What can automation do?" has
the same answer as "what is in this one array", never a larger one.

Every tool routes through a single action type, `automation.run`, exactly as
every `command.run` entry does for a project's own scripts — one permission
decision, one confirmation-floor entry, one audit shape, whatever the tool
actually does.

## The five kinds

- **`launch-app`** and **`run-script`** are mechanically identical: each
  resolves to one literal executable name under `%SystemRoot%\System32` and a
  literal, empty argument vector, started with `spawn(..., { shell: false })`
  — the same rule `main/process-runner.ts` already applies. The only
  difference is which list a tool appears in, so "an application" (Notepad,
  Calculator, File Explorer, Paint) and "a registered script" (Task Manager,
  System Information) read as what they are in the interface.
- **`open-folder`** resolves to one of the current user's own special
  folders (Desktop, Documents, Downloads), or to the already-approved
  project root. There is no field, anywhere, that can carry an arbitrary
  filesystem path.
- **`open-website`** resolves to one literal, fixed `https://` URL to one of
  four allowed hosts (github.com, developer.mozilla.org, npmjs.com,
  nodejs.org). `shared/automation/validation.ts`'s `isSafeAutomationUrl`
  checks this again immediately before the URL is opened — defence in depth
  against a registry entry that, in a later edit, stopped being a literal.
- **`focus-window`** brings this application's own window to the foreground.

## What automation is not

**It cannot run an arbitrary command.** There is no field for a program path,
an argument, a working directory or a shell — not "disabled", not
representable. `windows-automation.ts` never imports `child_process` outside
`launchDetached`, which takes a resolved absolute path and a literal argument
array, never a string.

**It cannot reach an arbitrary path or URL.** A folder is one of four fixed
targets; a website is one of four fixed hosts. Neither is ever built from
renderer input.

**It cannot focus an arbitrary window.** Focusing a window that belongs to
another process would need either an unapproved native dependency (there is
no Win32 API surface reachable from plain Node/Electron for this) or
unrestricted shell access — both of which this milestone's own security
requirements forbid. `focus-window` is scoped to this application's own
window, stated plainly here rather than half-implemented. See **Known
limitations** below.

**It cannot escalate.** No tool runs with elevation, touches a credential, a
registry key, a security setting, or reads keystrokes, the camera or the
microphone. Nothing here starts a background timer, a watcher, or anything
that runs without an explicit `automation:run` call the user just approved.

**It cannot be scheduled.** There is no `automation.schedule`, no
`automation.watch` and no cron-like field anywhere in the request or the
registry. Every run is one `automation:run` call, answered once.

---

## The canonical request path

```
request → plan → permission check → confirmation → execute → verify → audit
```

- **request** — `automation:run` carries a `runId` and a `toolId` from the
  closed enum. Validated by `automationRunRequestSchema` before anything else
  runs.
- **plan** — `findAutomationTool(toolId)` resolves the fixed definition; this
  is also what `describeAutomationRun` uses to build the confirmation text.
- **permission check** — `automation.run` is decided by the unmodified
  `decidePermission`, on the same action type every tool uses, against
  whatever the current permission policy says.
- **confirmation** — `automation.run` is on the confirmation floor
  (`CONFIRMATION_REQUIRED_ACTION_TYPES`), so no policy edit can turn it into
  an unconfirmed `allow`. The native dialog states the tool's own label and
  description, never a raw path or URL.
- **execute** — `main/windows-automation.ts`'s `runAutomationTool` performs
  exactly one registered action, through the same `handleActionProposal` →
  `execute` boundary every other privileged action uses.
- **verify** — a run is `verified: true` only when Local Agent observed a
  concrete success signal: the launched process did not fail or exit
  immediately, the OS shell reported no error opening a folder or a website,
  or the window was actually brought to the foreground. Anything else throws
  a typed `AutomationError` and is reported as a failure, never silently
  treated as success.
- **audit** — one record per call, carrying the tool id and its kind — both
  literals from reviewed source — and nothing that could identify a resolved
  path, a URL or a window title.

## Bounds

| Dimension                   | Bound                       | Constant                         |
| --------------------------- | --------------------------- | -------------------------------- |
| Launch attempts             | 1 initial + up to 2 retries | `AUTOMATION_MAX_ATTEMPTS`        |
| Launch grace window         | 5s per attempt              | `AUTOMATION_LAUNCH_TIMEOUT_MS`   |
| Shell call (folder/website) | 10s                         | `AUTOMATION_SHELL_TIMEOUT_MS`    |
| Concurrent actions          | 1                           | `AUTOMATION_MAX_CONCURRENT_RUNS` |

An unbounded retry loop is not representable: attempts are capped
independently of any run duration, and a cancelled or emergency-stopped
attempt stops retrying immediately rather than exhausting the bound.

## Cancellation is not "kill the program"

`automation:cancel` aborts the run's `AbortSignal`. For `open-folder`,
`open-website` and `focus-window` this is a real, immediate stop — nothing
has been handed to the OS shell yet, or the wait for it to answer is
abandoned. For `launch-app` and `run-script` it can only ever **abandon a
launch attempt in progress**: if the process already started, it is
deliberately left running. A user who asked Local Agent to open Notepad did
not ask for the power to close it again, and killing a just-launched GUI
process out from under someone would be a worse surprise than letting the
cancel be a no-op past that point. This mirrors the honest scope reduction
`docs/phase-2-workflows.md` already documents for workflow pause: a real
control, stated for exactly what it does and no more.

If Cancel is pressed while the native confirmation is still open, the request
is marked cancelled before execution. Electron does not expose a way to
dismiss that native dialog programmatically, so it remains until the user
chooses an answer; approving it afterward still cannot start the action.

## Known limitations

- **`focus-window` only reaches this application's own window.** Focusing an
  arbitrary third-party window needs a capability this codebase does not
  have and this milestone does not add one to get it.
- **A launch attempt cannot be killed once it has started.** See above.
- **The tool registry is fixed in source, not user-editable.** There is no
  UI to add, remove or rename a registered application, folder, website or
  script. Widening the registry is a reviewed source change, not a runtime
  configuration change — deliberately, since a user-editable allowlist of
  launchable programs would be a materially larger attack surface than a
  fixed one.
