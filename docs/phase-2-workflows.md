# Phase 2, Milestone 9 — the workflow engine

A saved, named, repeatable recipe for running an agent profile that already
exists. Started by a person, bounded in every dimension, and incapable of
doing anything its agent could not already do.

This document explains what a workflow is here, what it deliberately is
**not**, and why each decision was made. It complements
[architecture.md](architecture.md), [security-model.md](security-model.md) and
[phase-2-agent-profiles.md](phase-2-agent-profiles.md); where those disagree
with this file, they were written to cover the whole system and they win.

---

## The authority chain

```
workflow  ⊆  agent profile  ⊆  permission policy
```

This is the whole design in one line, and every other decision follows from
it.

A workflow step names a **tool from the Milestone 7 agent registry** — seven
ids, fixed in reviewed source — and each of those maps to an action type
Milestones 5 and 6 already defined. So a workflow introduces no capability:
"what can a workflow do?" has the same answer as "what could an agent already
do, with the user's approval?", never a larger one.

A workflow also selects an agent profile, and may only use tools and paths
**that profile already allows**. This is enforced twice:

- `workflowStepsWithinProfile` when the workflow is **saved**, so a definition
  that could never run is refused while someone can still fix it;
- `decideNextWorkflowStep` before **every single step**, because a profile can
  be narrowed after a workflow was written, and the workflow file is
  user-editable in between.

The second is the control; the first is a courtesy.

Nothing in either layer can produce an authorization. A `run` decision means
"the workflow declared this and the profile permits it" — `main/permissions.ts`
then decides the action itself, unchanged, on its own action type, and may
still deny it or require a confirmation the workflow knows nothing about.

---

## What a workflow is not

**It cannot start itself.** `trigger` is an enum with exactly one member,
`manual`. A schedule, a file watch, a Git hook and an inbox are not disabled
anywhere — they are not representable, and there is no `workflow.schedule`,
`workflow.watch` or `workflow.trigger` action type either. Adding background
autonomy later is a deliberate, reviewable edit to a named constant.

**It cannot loop without bound.** Retries are capped per step
(`WORKFLOW_MAX_STEP_RETRIES`), and — the part that matters — **every attempt
counts as a step against `limits.maxSteps`**. There is no combination of
values that produces an unbounded loop, because the retry budget cannot
outlive the run budget.

**It cannot evaluate an expression.** `condition` is a closed three-value
vocabulary: `always`, `if-previous-succeeded`, `if-previous-failed`. A
workflow definition is untrusted input — a user-editable file — and an
expression evaluator reading one would be a way to spend unbounded CPU in the
process that owns every privileged operation in this application.

**It cannot carry a credential.** Every object is a `strictObject` with no
field capable of holding one, so a definition containing `apiKey`, `token` or
`password` is rejected outright rather than stored and quietly ignored.

**It cannot run more than one at a time.** A second `workflow:run` while one
is in flight is refused, never queued — so "cancel" is never ambiguous about
what it cancels.

---

## Execution

```
workflow → agent → plan → permission check → approved step → verification → result
```

The runner (`main/workflow-runner.ts`) is deliberately small. Every decision —
what to do next, whether a limit was reached, whether the agent permits the
step, whether a failure should be retried, whether the result counts as
verified — is made by the pure functions in `shared/workflow/execution.ts`,
testable with plain Vitest against a table of states.

**The steps are executed by the agent step runner.** `main/ipc.ts` hands the
workflow runner the _same_ `createAgentStepRunner` closure an agent run uses,
with the same `AgentStepRequest` shape, dispatched through the same
`runWorkspaceAction`. There is no execution path in this milestone that
Milestone 7 did not already have — which is why "every privileged step passes
through the existing permission and audit pipeline" is true by construction
rather than by inspection.

### The check order is the security property

`decideNextWorkflowStep` evaluates its stop conditions before it ever returns
a step, in a fixed order:

1. emergency stop
2. cancellation
3. pause
4. no approved project
5. workflow disabled
6. agent profile disabled
7. time ceiling
8. step ceiling
9. output ceiling
10. retry allowance
11. step condition (skip, not stop)
12. tool inside the agent's allowlist
13. path inside the agent's scope
14. the agent profile's own `deny`

A state that satisfies more than one reports the most authoritative one. The
first three are refusals a person or the system made, so they outrank every
budget.

### What is re-read between steps

The emergency stop, the workflow definition and the agent profile — every
single iteration. Engaging the stop, disabling the workflow or disabling its
agent therefore takes effect on the **next step**, not at the end of the run.
"Stop" has to mean "stop what is happening", not only "start nothing new".

In practice the emergency stop usually bites even earlier: the permission
engine refuses the step itself, so the run records a `denied` step and stops
with `step-denied`. The runner's own between-steps re-read is the backstop for
the window after a step finishes.

### A refusal always stops the run

`afterStepOutcome` treats a denial, a declined confirmation and an emergency
block as terminal, **whatever `failureBehavior` says**. Continuing past a
refusal would be the run arguing with an answer it had already received. This
is the milestone's "never continue after a failed safety check", and it is not
configurable — there is no value of `failureBehavior` that reaches it.

`failureBehavior` applies only to a step that **ran and reported a failure** —
a lint script exiting non-zero, say, which is often exactly what the workflow
was written to find out.

### Confirmation checkpoints

A step with `checkpoint: true` raises a native dialog **before the action is
proposed at all**, naming the workflow, the step number, the tool, the action
type and the scope. So does a step the selected profile marks `confirm`.

Both can only ever _add_ a prompt. Neither vocabulary has an `allow`, so
nothing here can remove a confirmation the floor requires or turn a denial
into a permission. Declining a checkpoint stops the run with `step-declined`.

### Pause and cancel

Two different things, deliberately:

- **Pause** (`workflow:pause`) is cooperative. The run stops at the **next
  step boundary**, keeping every step it already completed, and reports
  `paused`. A step already under way finishes and is recorded.
- **Cancel** (`workflow:cancel`) aborts the run's `AbortSignal`, which also
  kills a child process the run had started.

Neither is permission-gated, for the reason `chat:cancel`, `command:cancel`
and `agent:cancel` are not: neither can start anything, read anything or reach
anything.

> **There is no resume.** A paused run ends; starting again starts a new run
> from the first step. An indefinite suspension inside a time-bounded run
> would either be killed by the duration ceiling or be an unbounded wait, and
> neither is a useful "pause". This is a deliberate scope reduction and is
> stated rather than implied.

### Progress

`workflow:progress` is the **second** main → renderer push channel in this
codebase, and it carries the same four properties `chat:chunk` does: sent only
to the `WebContents` that started the run, bounded and validated before
sending, dropped silently on a validation failure, and **advisory** — the
authoritative record is the one `workflow:run` resolves with, never the sum of
these events.

Its payload is counts, an index and two enums. There is no field for a
summary, a path, a command line or any output, because an advisory channel is
the wrong place to be the first thing that carries content.

---

## Verification and success criteria

A requirement is satisfied only by its own tool completing with
`outcome: 'success'`, and by nothing else. A denied step, a declined
confirmation, a failed command and a step that never ran are all equally
unsatisfying. **Nothing here can be satisfied by an assertion that the work
was done** — the vocabulary is inherited unchanged from Milestone 7 for
exactly that reason.

A run that reached the end of its steps but did not meet its criteria is
reported as `failed` with `criteria-not-met`, so "the steps ran" is never
mistaken for "the work is verified". `requireAllStepsSucceed` is the second
half: a run with a failed step in it does not pass merely because its
verification tools happened to succeed.

The schema refuses a requirement no step in the workflow can satisfy, so an
unsatisfiable definition is caught when it is written rather than at the end
of a run.

---

## Rollback

`rollback` is `none` or `restore-run-changes`, and the decision is made by a
tested pure function (`planWorkflowRollback`).

**`restore-run-changes` restores change sets this run applied, and nothing
else** — never a change the user made by hand, never one from an earlier run.
The caller passes the ids the run itself collected, and the function has no
way to reach any other.

> **In this milestone that list is always empty, and the honest consequence is
> reported rather than hidden.** No agent tool can write a file — there is no
> `workspace.write` tool for a workflow step to name — so a workflow run
> cannot produce a change set. A configured rollback therefore always resolves
> to `nothing-to-roll-back`, which is what the run record says and what the
> dashboard displays.
>
> The decision function's `restore` branch is real, reviewed and unit-tested,
> so the behaviour is already correct if a write tool is ever added. There is
> deliberately **no rollback executor**: writing one that could never fire
> would be dead code in the privileged process, which is worse than an honest
> declaration.
>
> The milestone brief asked for rollback "only for reversible operations
> already supported by the project". The project supports exactly one —
> `workspace.rollback`, restoring the backup taken before a `workspace.write`
> — and no workflow step can reach it. This is the faithful implementation of
> that instruction, not a gap in it.

---

## Storage

`workflows/workflows.json`, with the pattern `main/agent-profiles.ts`
established:

- **Loading never throws and never merges.** A missing file, an unreadable
  one, an oversized one, malformed JSON, a `__proto__` key anywhere in it, or
  a document the schema rejects all resolve to an empty store. A document
  either validates in full, as itself, or it is discarded in full.
- **The size check happens before the read.**
- **Writing is atomic and re-validated** — temp file, flush, single rename.
- **Nothing is created by reading.**

A hand-edited file claiming `trigger: "schedule"` fails validation and the
whole document is discarded — the store cannot be talked into background
autonomy by editing it.

### A running workflow is protected

`WORKFLOW_RUNNING` refuses an **edit** or a **delete** of a workflow with a run
in flight. The predicate is supplied by `main/ipc.ts` from the in-flight run
map, which is the only thing that knows what is actually executing — never a
flag on disk that a crash could leave stale.

**Disabling one while it runs is deliberately permitted.** The runner re-reads
the definition between steps, so that is how someone stops a run without
cancelling it outright; the run ends with `workflow-disabled`. Editing and
deleting stay refused, because those change what the run is executing rather
than only whether it may continue.

### Duplicate creates a disabled copy

Whatever the original was. A duplicate is a starting point someone is about to
edit, and a runnable copy appearing the moment it is duplicated is a surprise
in the permissive direction.

---

## Security summary

| Control                          | Where it lives                                                          |
| -------------------------------- | ----------------------------------------------------------------------- |
| No new capability                | Every step tool is a Milestone 7 agent tool                             |
| No widening                      | `workflowStepsWithinProfile` at save; `decideNextWorkflowStep` per step |
| No background start              | `WORKFLOW_TRIGGERS` has one member                                      |
| No unbounded loop                | Per-step retry cap × every attempt counts as a step                     |
| No unregistered tool or command  | `z.enum(AGENT_TOOL_IDS)`; no command string field anywhere              |
| Permission + audit on every step | The shared `createAgentStepRunner` → `runWorkspaceAction`               |
| Confirmation floor               | `workflow.write`, `workflow.run`                                        |
| Checkpoints                      | Per-step, additive only                                                 |
| Emergency stop                   | Engine refuses the step; runner re-reads between steps                  |
| Bounded audit metadata           | Ids, counts and lengths — never the objective or a path                 |
| No credential                    | `strictObject` everywhere; no field can hold one                        |

---

## Files

**Shared (pure).** `shared/workflow/errors.ts`,
`shared/workflow/execution.ts`, `shared/workflow/index.ts`,
`shared/schemas/workflow.schema.ts`.

**Main.** `main/workflow-store.ts` (CRUD, atomic, fail-safe),
`main/workflow-runner.ts` (the loop and the dialog text).

**Renderer.** `renderer/workflow/ipc-workflow-client.ts` — the single file in
that directory permitted to touch `window.localAgent`, asserted by
`tests/unit/shared/chat-boundary-scan.test.ts` —
`renderer/workflow/workflow-controller.ts` (framework-independent, where the
testable behaviour lives), `renderer/workflow/useWorkflow.ts`,
`renderer/workflow/Workflows.tsx`.
