# Phase 2 agent profiles and bounded orchestration

> **Current state.** Phase 2, Milestone 7 adds **agent profiles** — local,
> validated configuration describing which of a fixed set of tools an agent
> may reach for, which part of the approved project it may look at, and how
> long, how many steps and how much output one run may consume — plus a
> **minimal orchestrator** that executes a bounded sequence of those tools.
>
> Not one of the tools is new. Every one maps to an action type Milestones 5
> and 6 already defined, already gated by the permission engine and already
> audited. `main/permissions.ts`, `main/executor.ts`,
> `main/action-pipeline.ts`, `main/action-runtime.ts`, `main/audit.ts`,
> `main/emergency.ts`, `main/secrets.ts`, `main/settings.ts` and
> `main/policy.ts` all have **zero diff** in this milestone — the sixth
> consecutive one.
>
> Builds on [phase-2-coding-actions.md](phase-2-coding-actions.md).

---

## Summary

| Property                                    | State                                                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Agent profile schema                        | **[implemented]** — `src/shared/schemas/agent.schema.ts`, strict and bounded              |
| A profile can grant a permission            | **Never.** Its decision enum is `confirm \| deny`; `allow` is not a member                |
| A profile can name a new capability         | **Never.** `allowedTools` is a seven-value enum fixed in reviewed source                  |
| A profile can hold a credential             | **Never.** Every object is strict and declares no such field                              |
| Profile storage                             | **[implemented]** — `main/agent-profiles.ts`, atomic, fail-safe, never merges             |
| Built-in profiles                           | **[implemented]** — read from source on every load, never persisted                       |
| A stored profile can impersonate a built-in | **Never.** The store schema refuses the id and the `builtIn` claim alike                  |
| CRUD, enable, disable                       | **[implemented]** — all four write operations on the confirmation floor                   |
| Deleting or disabling the active profile    | **[implemented]** — falls back to the most restricted built-in                            |
| Bounded orchestrator                        | **[implemented]** — `shared/agent/orchestration.ts` (pure) + `main/agent-orchestrator.ts` |
| Step, time and output ceilings              | **[implemented]** — enforced in the schema _and_ at each step                             |
| Emergency stop halts a run in progress      | **[implemented]** — re-read from disk between every step                                  |
| Cancellation                                | **[implemented]** — also kills a child process the run started                            |
| An agent run can write a file               | **Never.** No tool id exists for it, so no profile can name one                           |
| A model proposes the steps                  | **Not yet.** Deterministic; the seam is documented below                                  |
| New action types                            | `agent.read`, `agent.select`, `agent.write`, `agent.run`                                  |
| Emergency stop blocks them                  | **[implemented]** — none is on the exemption list                                         |

---

## The three decisions this milestone turns on

### 1. A profile narrows; it can never grant

This is the whole security posture of the milestone, and it is a property of
the **type**, not of a check someone remembered to write.

`agentPermissionRuleSchema`'s `decision` field is `z.enum(['confirm', 'deny'])`.
There is no `'allow'`. A profile can therefore say "ask me first, even though
the policy would not have" or "refuse this, even though the policy would have
permitted it" — and it cannot say "permit this". The global permission policy
remains the only thing in the codebase that can produce an `allow`, and the
orchestrator takes the **stricter** of the two.

The consequence worth stating plainly: **reading a profile tells you the
maximum an agent could do, and that maximum is never larger than what the
permission policy already allowed.** A compromised renderer that submits a
profile granting itself everything is submitting something the schema cannot
represent.

The profile's `permissionPolicy` is applied in front of the pipeline, never
instead of it. When a profile raises a step to `confirm`, `main/ipc.ts` asks
the user in a native dialog _before_ proposing the action — and then proposes
it anyway, so the permission engine still decides, and any confirmation the
floor requires is still asked separately.

### 2. Every tool is an action type that already existed

```
workspace.inspect   -> workspace.read
workspace.search    -> workspace.read
workspace.plan      -> workspace.plan
git.status          -> git.read
command.test        -> command.run   [confirmation floor]
command.lint        -> command.run   [confirmation floor]
command.typecheck   -> command.run   [confirmation floor]
```

Seven tools, four action types, none of them new. So "what can an agent do?"
has the same answer as "what could the interface already do, with the user's
approval?" — never a larger one.

What is **absent** is the point. There is no tool for `workspace.write`, for
`workspace.rollback` or for `git.checkpoint`. An agent run in this milestone
can look at the approved project, produce an inert plan, read Git state, and
run the project's own verification scripts. It **cannot change a file, apply a
proposed change, or create a commit** — those stay exactly where Milestone 6
put them: user-driven, one at a time, behind a native confirmation. A profile
cannot name a write tool because no such id exists to name, and
`AGENT_ALLOWED_ACTION_TYPES` states the ceiling as data so a test can assert
it rather than a reader having to re-derive it.

The three tools that start a process map to `command.run`, which is on the
confirmation floor, and that is not weakened here: a verification step inside
an agent run raises the same native dialog, stating the same command line and
the same project script text, as a user-initiated run does. `main/ipc.ts`'s
`describeCommandRun` is shared by both call sites precisely so the two cannot
drift.

### 3. A run is named, never described

`agent:run` carries a run id and an objective string. It cannot carry a step
list, a tool, a path, a command or a limit — `agentRunRequestSchema` is a
`strictObject` with exactly two fields.

Everything a run is permitted to do comes from the **stored profile**, read
from disk in the main process at the moment the run starts. A renderer can ask
for a run; it cannot widen one by describing it differently. This is the same
shape Milestone 6 used for `workspace:apply` (a change id and nothing else)
and for `command:run` (an enum member and nothing else), applied to the new
surface.

---

## The orchestration loop

```
request (objective)
  -> active profile, read from the store
  -> plan            buildAgentPlan(profile, objective)   [pure, bounded]
  -> native confirmation stating tools, scope and limits  [confirmation floor]
  -> for each step:
       emergency stop? cancelled? project gone?           -> stop
       time / step / output budget exhausted?             -> stop
       tool in the profile allowlist?                     -> else stop
       target inside the profile workspace scope?         -> else stop
       profile says deny?                                 -> stop
       profile says confirm?                              -> ask, then continue
       -> runAction -> permissions -> [confirm] -> executor -> audit
  -> verification    evaluateAgentVerification(profile, steps)
  -> result          classifyAgentRun(stopReason, verification)
```

**The order of the checks is the security property.** `decideNextStep`
evaluates refusals before budgets: emergency stop, then cancellation, then the
missing project, then the disabled profile, then time, steps and output, then
the per-step allowlists. A state that satisfies more than one stop condition
reports the most authoritative one, so an engaged emergency stop is never
reported as "ran out of steps".

**Every step is re-checked, not trusted from planning time.** The plan is
untrusted input — today because a user-editable profile shaped it, and in a
later milestone because a model proposed it — so the tool allowlist and the
workspace scope are evaluated again at execution time, on every step.

**The emergency stop reaches a run in progress.** `isEmergencyEngaged` is
re-read from disk between every step rather than cached for the run, and a
running child process also receives the run's `AbortSignal`, so cancelling a
run kills the `npm test` it started rather than only declining to start
another one.

### Verification means something was observed

A verification requirement is satisfied only by its own tool completing with
`outcome: 'success'` — which, for a command, means the project's own script
ran and exited zero. A denied step, a declined confirmation, a failed command
and a step that never ran are all equally unsatisfying. Nothing here can be
satisfied by an assertion that the work was done.

A run that reaches the end of its plan but does not satisfy its stated
verification is reported as `failed` with `verification-failed`, never as a
completion. "The steps ran" is never presented as "the work is verified".

`passed` is vacuously true when a profile requires nothing, because "this
profile defines no verification" is a different statement from "verification
failed".

---

## No model proposes these steps

`buildAgentPlan` derives the sequence deterministically from the profile and
the objective, reusing the Milestone 5 keyword extractor. **Nothing in this
milestone calls a provider, and nothing parses model output into tool calls.**
No network request is made by an agent run.

`AgentPlan` is the seam through which a model-proposed plan would arrive in a
later milestone. When it does, it changes nothing about the gates: every step
is already re-validated against the profile's allowlist and workspace scope at
execution time, and every step already goes through the permission engine on
its own action type. A model-proposed plan would be untrusted input entering
at exactly the point the current plan already enters as untrusted input.

A profile's `provider` and `fallbackProviders` are validated, stored, and
resolved against the _reconciled_ settings — so a stale `hasApiKey` cannot
make an unusable provider look available — and the resolved value is recorded
on the run record for transparency about what would carry a model call. It is
recorded, not called.

Likewise, a profile's `instructions` field is validated, bounded and stored,
and is **not** sent anywhere yet. It is never authorization: nothing reads a
permission, a tool or a path out of it, and `allowedTools` and
`approvedWorkspacePaths` are the only things consulted.

---

## Bounds

| Bound                       | Value                                          |
| --------------------------- | ---------------------------------------------- |
| Profiles in the store       | 32, built-ins included                         |
| Instruction length          | 4 000 characters                               |
| Tools per profile           | 16 (the registry itself has 7)                 |
| Workspace paths per profile | 16                                             |
| Verification requirements   | 8                                              |
| Steps per run               | 1–24, profile-chosen; default 8                |
| Duration per run            | 5 s – 600 s, profile-chosen; default 120 s     |
| Output per run              | 1 000 – 200 000 bytes, profile-chosen          |
| Step summary length         | 200 characters, collapsed to one line          |
| Profile store file size     | 256 000 bytes, checked before the file is read |

The step, duration and output ceilings are **ranges**, so a profile chooses a
value _inside_ the bound rather than supplying one. The orchestrator then
enforces the chosen value as well — two layers, because the profile file is
user-editable, exactly like the permission policy.

---

## Storage

`%APPDATA%\Local-Agent\agents\profiles.json`. Its own file beside the
permission policy rather than inside `settings.json`, for the reason the
policy has its own: configuration that shapes authority does not belong in the
same document as a display name.

It mirrors `main/settings.ts` and `main/policy.ts` in detail:

- **Loading never throws and never merges.** A missing file, an unreadable
  one, an oversized one, malformed JSON, a `__proto__` key anywhere in it, or
  a document the schema rejects all resolve to the same default store: no user
  profiles, the most restricted built-in active. A document validates in full,
  as itself, or it is discarded in full — nine good profiles and one malformed
  one yields none, not nine.
- **Writing is atomic and re-validated**, with the same Windows
  sharing-violation rename retry.
- **Built-ins are never persisted.** They are rebuilt from reviewed source on
  every load, so editing this file cannot turn a shipped read-only profile
  into a permissive one. A stored profile claiming a built-in id, or claiming
  `builtIn: true`, fails validation — and `mergeAgentProfiles` drops it a
  second time, for a store that reached it without passing validation.
- **User data is preserved.** Each mutation reads the current store, changes
  the one profile it names, and writes the whole document back.

Deleting or disabling the **active** profile is allowed, and falls back to the
most restricted built-in — never to "no restrictions". The active id is
resolved on every load rather than trusted, and rewritten on disk so the file
does not keep pointing at something deleted.

---

## IPC

Eight new channels.

| Channel            | Action         | Request                | Confirmed |
| ------------------ | -------------- | ---------------------- | --------- |
| `agent:list`       | `agent.read`   | none                   | no        |
| `agent:select`     | `agent.select` | `{profileId}`          | no        |
| `agent:create`     | `agent.write`  | `{profile}`            | **yes**   |
| `agent:update`     | `agent.write`  | `{profileId, profile}` | **yes**   |
| `agent:delete`     | `agent.write`  | `{profileId}`          | **yes**   |
| `agent:setEnabled` | `agent.write`  | `{profileId, enabled}` | **yes**   |
| `agent:run`        | `agent.run`    | `{runId, objective}`   | **yes**   |
| `agent:cancel`     | —              | `{runId}`              | n/a       |

`agent:select` is deliberately **not** on the confirmation floor. Selecting a
profile cannot widen anything — every action a run takes is still decided by
the permission engine against the same policy — and a native dialog for every
selection would train people to click through dialogs, which is its own
security problem.

`agent:cancel` is the one channel with no permission gate, for the reason
`chat:cancel` and `command:cancel` have none: it cannot start anything, read
anything or reach anything.

**Audit parameters carry no objective, no instructions, no path and no
content.** Only `{operation}`, a _length_ where useful, and `profileId` — a
bounded lowercase slug the schema constrains to `[a-z0-9._-]`, recorded for
the same reason `commandId` is: it is what lets the audit trail answer "which
profile authorized this". A test asserts the objective text, the instructions
and the project path never appear in any record.

Each step inside a run writes its **own** audit record, on its own action
type, in addition to the record for the run itself.

---

## Security boundary

Everything Milestones 1–6 established holds unchanged. New in this milestone:

- **A profile can only narrow.** No schema, channel, preload function or
  storage path can express a grant.
- **An agent run cannot write, roll back, or commit.** No tool id, no action
  type mapping, no preload function. Tests assert the absence at the registry,
  at the schema, at the IPC layer and against the real built bridge.
- **The orchestrator is not a second permission engine.** It can stop a run
  earlier than the permission engine would have; it can never let one past.
- **The emergency stop halts a run mid-flight**, not only before it starts.
- **Nothing a profile contains is authorization**, including its instructions.

---

## Testing

| Area                                                                          | File                                            |
| ----------------------------------------------------------------------------- | ----------------------------------------------- |
| Every boundary shape, and what a profile cannot express                       | `tests/unit/shared/agent.schema.test.ts`        |
| The tool registry's capability ceiling; merging, fallback, and scope matching | `tests/unit/shared/agent-registry.test.ts`      |
| Plan construction, every stop condition and their ordering, verification      | `tests/unit/shared/agent-orchestration.test.ts` |
| Real filesystem: fail-safe loading, atomic writes, CRUD, safe fallback        | `tests/unit/main/agent-profiles.test.ts`        |
| Permission gating, confirmation wording, emergency stop, audit content        | `tests/unit/main/ipc-agent.test.ts`             |
| Failure wording, declining, staleness, cancellation, retry                    | `tests/unit/renderer/agent-controller.test.ts`  |
| Bridge shape and the absent functions, against the real built app             | `tests/e2e/electron-smoke.test.ts`              |

---

## What remains deferred

Genuinely absent — no action type, channel, schema, tool or function for any
of it:

- Multi-agent coordination; one run at a time, one agent per run
- A model proposing a plan or an action (the seam exists; nothing fills it)
- An agent writing a file, applying a change, or creating a commit
- Memory, embeddings, RAG, scheduling, self-updating
- Browser, email, voice, camera or screen automation
- Administrator or elevated execution
- Storing any credential in a profile
