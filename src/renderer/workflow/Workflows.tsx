/**
 * The Workflow Dashboard (Phase 2, Milestone 9).
 *
 * A fifth sibling next to Chat, Workspace, Agents and Memory, not a redesign:
 * it reuses the existing panel, badge, hint, field and error classes rather
 * than introducing a visual language of its own.
 *
 * What it is for, in the milestone's own terms: listing workflows, creating,
 * editing and deleting them, enabling and disabling them, running one
 * manually, pausing or cancelling an active run, showing step progress and
 * the awaiting-confirmation state, showing success, failure and rollback, and
 * **stating plainly what each workflow may do and under what limits**. That
 * last point is why every card spells out its agent, its ordered steps, the
 * action type each step routes through, its three ceilings and where it will
 * stop to ask again — rather than summarising them as a count.
 *
 * Nothing here is a security control. The form validates before sending
 * purely so a person sees a mistake immediately; the main process
 * re-validates everything it receives, re-checks every step against the
 * selected agent, and is the only thing that decides what runs.
 */

import { useState } from 'react';

import { useWorkflow } from './useWorkflow';
import { AGENT_TOOLS } from '../../shared/agent';
import {
  WORKFLOW_DEFAULT_MAX_DURATION_MS,
  WORKFLOW_DEFAULT_MAX_OUTPUT_BYTES,
  WORKFLOW_DEFAULT_MAX_STEPS,
  WORKFLOW_MAX_DURATION_MS,
  WORKFLOW_MAX_OUTPUT_BYTES,
  WORKFLOW_MAX_STEP_RETRIES,
  WORKFLOW_MAX_STEPS,
  WORKFLOW_MIN_DURATION_MS,
  WORKFLOW_MIN_OUTPUT_BYTES,
  WORKFLOW_MIN_STEPS,
  WORKFLOW_STEP_CONDITIONS,
  WORKSPACE_OBJECTIVE_MIN_LENGTH,
} from '../../shared/constants';
import { workflowInputSchema } from '../../shared/schemas';
import type { Workflow, WorkflowInput, WorkflowRun, WorkflowStep } from '../../shared/schemas';

/** A blank workflow for the create form: one read-only step, nothing else. */
function emptyDraft(): WorkflowInput {
  return {
    id: '',
    name: '',
    description: '',
    trigger: 'manual',
    agentProfileId: 'reviewer',
    steps: [
      {
        tool: 'workspace.inspect',
        target: '',
        query: null,
        condition: 'always',
        maxRetries: 0,
        checkpoint: false,
      },
    ],
    limits: {
      maxSteps: WORKFLOW_DEFAULT_MAX_STEPS,
      maxDurationMs: WORKFLOW_DEFAULT_MAX_DURATION_MS,
      maxOutputBytes: WORKFLOW_DEFAULT_MAX_OUTPUT_BYTES,
    },
    failureBehavior: 'stop',
    rollback: 'none',
    successCriteria: { verification: [], requireAllStepsSucceed: true },
    enabled: false,
  };
}

/** Strips the derived fields so an existing workflow can seed the form. */
function draftFrom(workflow: Workflow): WorkflowInput {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = workflow;
  return input;
}

function actionTypeOf(tool: string): string {
  return AGENT_TOOLS.find((entry) => entry.id === tool)?.actionType ?? tool;
}

function describeScope(target: string): string {
  return target === '' ? 'the whole approved project' : target;
}

function WorkflowCard(props: {
  readonly workflow: Workflow;
  readonly canAct: boolean;
  readonly onRun: () => void;
  readonly onEdit: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
  readonly onToggleEnabled: () => void;
}) {
  const { workflow, canAct } = props;
  const checkpoints = workflow.steps.filter((step) => step.checkpoint).length;

  return (
    <article className={`workflow-card${workflow.enabled ? '' : ' workflow-card--disabled'}`}>
      <header className="workflow-card__head">
        <h4>{workflow.name}</h4>
        <span className="workspace-badge">{workflow.trigger}</span>
        {workflow.enabled ? (
          <span className="workspace-badge workspace-badge--strong">Enabled</span>
        ) : (
          <span className="workspace-badge">Disabled</span>
        )}
      </header>

      <p className="workspace-hint">{workflow.description}</p>

      <dl className="agent-card__facts">
        <dt>Agent</dt>
        <dd>{workflow.agentProfileId}</dd>

        <dt>Steps</dt>
        <dd>
          <ol className="workflow-card__steps">
            {workflow.steps.map((step, index) => (
              <li key={`${step.tool}-${String(index)}`}>
                {step.tool} <code>{actionTypeOf(step.tool)}</code> on {describeScope(step.target)}
                {step.condition !== 'always' && ` — ${step.condition}`}
                {step.maxRetries > 0 && ` — up to ${String(step.maxRetries)} retries`}
                {step.checkpoint && (
                  <span className="workspace-badge workspace-badge--strong"> asks first</span>
                )}
              </li>
            ))}
          </ol>
        </dd>

        <dt>Limits</dt>
        <dd>
          {workflow.limits.maxSteps} steps · {Math.round(workflow.limits.maxDurationMs / 1000)}s ·{' '}
          {workflow.limits.maxOutputBytes} bytes
        </dd>

        <dt>On failure</dt>
        <dd>
          {workflow.failureBehavior === 'stop' ? 'stop the run' : 'continue to the next step'} ·
          rollback {workflow.rollback}
        </dd>

        <dt>Success criteria</dt>
        <dd>
          {workflow.successCriteria.verification.length === 0
            ? 'none required'
            : workflow.successCriteria.verification.join(', ')}
          {workflow.successCriteria.requireAllStepsSucceed && ' · every step must succeed'}
        </dd>
      </dl>

      <p className="workspace-hint">
        {checkpoints > 0
          ? `${String(checkpoints)} step(s) stop and ask before running.`
          : 'No step is marked as a checkpoint.'}{' '}
        A workflow can never grant a permission: every step is decided by the permission policy, and
        it can only use tools its agent already allows.
      </p>

      <div className="agent-card__actions">
        <button type="button" disabled={!canAct || !workflow.enabled} onClick={props.onRun}>
          Run
        </button>
        <button type="button" disabled={!canAct} onClick={props.onEdit}>
          Edit
        </button>
        <button type="button" disabled={!canAct} onClick={props.onDuplicate}>
          Duplicate
        </button>
        <button type="button" disabled={!canAct} onClick={props.onToggleEnabled}>
          {workflow.enabled ? 'Disable' : 'Enable'}
        </button>
        <button type="button" disabled={!canAct} onClick={props.onDelete}>
          Delete
        </button>
      </div>
    </article>
  );
}

function RunReport(props: { readonly run: WorkflowRun }) {
  const { run } = props;
  return (
    <div className="agent-run">
      <h4>
        {run.workflowName} — {run.status}
      </h4>
      <p className="workspace-hint">
        Stopped because: {run.stopReason}. {run.totals.steps} step(s), {run.totals.outputBytes}{' '}
        bytes, {Math.round(run.totals.durationMs / 1000)}s. Agent: {run.agentProfileId}. Provider
        recorded: {run.provider}.
      </p>
      <p className="workspace-hint">
        Success criteria:{' '}
        {run.verification.required.length === 0
          ? 'none required'
          : `${String(run.verification.satisfied.length)}/${String(run.verification.required.length)} met (${run.verification.required.join(', ')})`}
        {' · '}Rollback: {run.rollback.result}
        {run.rollback.result === 'nothing-to-roll-back' &&
          ' (no step in this milestone can change a file, so there is never anything to restore)'}
      </p>
      <ol className="agent-run__steps">
        {run.steps.map((step) => (
          <li key={step.index} className={`agent-run__step agent-run__step--${step.outcome}`}>
            <span className="agent-run__step-tool">
              {String(step.stepIndex + 1)}.{step.attempt} {step.tool}
            </span>
            <code>{step.actionType}</code>
            <span className="agent-run__step-outcome">{step.outcome}</span>
            <span>{step.summary}</span>
          </li>
        ))}
      </ol>
      {run.steps.length === 0 && <p className="workspace-empty">No step ran.</p>}
    </div>
  );
}

export function Workflows() {
  const workflow = useWorkflow();
  const { state, canAct } = workflow;

  const [objective, setObjective] = useState('');
  const [runTarget, setRunTarget] = useState<string | null>(null);
  const [draft, setDraft] = useState<WorkflowInput | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Validated here only so a mistake is visible immediately. The main process
  // re-validates everything it receives and is what actually decides.
  const validation = draft === null ? null : workflowInputSchema.safeParse(draft);
  const draftIssues =
    validation === null || validation.success
      ? []
      : validation.error.issues.map(
          (issue) => `${issue.path.join('.') || 'workflow'}: ${issue.message}`,
        );

  function updateDraft(changes: Partial<WorkflowInput>): void {
    setDraft((current) => (current === null ? current : { ...current, ...changes }));
  }

  function updateStep(index: number, changes: Partial<WorkflowStep>): void {
    setDraft((current) => {
      if (current === null) return current;
      return {
        ...current,
        steps: current.steps.map((step, position) =>
          position === index ? ({ ...step, ...changes } as WorkflowStep) : step,
        ),
      };
    });
  }

  function addStep(): void {
    setDraft((current) => {
      if (current === null) return current;
      return {
        ...current,
        steps: [
          ...current.steps,
          {
            tool: 'workspace.inspect',
            target: '',
            query: null,
            condition: 'always',
            maxRetries: 0,
            checkpoint: false,
          },
        ],
      };
    });
  }

  function removeStep(index: number): void {
    setDraft((current) => {
      if (current === null || current.steps.length <= 1) return current;
      return { ...current, steps: current.steps.filter((_step, position) => position !== index) };
    });
  }

  async function submitDraft(): Promise<void> {
    if (draft === null || validation === null || !validation.success) return;
    if (editingId === null) await workflow.createWorkflow(validation.data);
    else await workflow.updateWorkflow(editingId, validation.data);
    setDraft(null);
    setEditingId(null);
  }

  const progress = state.progress;

  return (
    <section className="workspace workflow">
      <header className="workspace__header">
        <div>
          <h2>Workflows</h2>
          <p className="workspace-hint">
            A saved, repeatable recipe for running an agent you already have. A workflow can only
            narrow what its agent permits — never widen it — and it runs only when you start it.
          </p>
        </div>
        <div className="workspace__status">
          <p className="workspace-hint">
            {state.busy === null ? 'Idle' : `Working: ${state.busy}`}
          </p>
          {state.activity !== null && <p className="workspace-hint">{state.activity}</p>}
        </div>
      </header>

      {state.error !== null && (
        <div className="workspace__error" role="alert">
          <p>{state.error.message}</p>
          <span>
            {state.error.retryable && (
              <button type="button" onClick={() => void workflow.retry()}>
                Retry
              </button>
            )}
            <button type="button" onClick={workflow.dismissError}>
              Dismiss
            </button>
          </span>
        </div>
      )}

      {!state.initialized && <p className="workspace-empty">Loading workflows…</p>}

      {state.runningRunId !== null && (
        <div
          className={`workflow-progress${progress?.awaitingConfirmation === true ? ' workflow-progress--waiting' : ''}`}
          role="status"
        >
          <p>
            {progress === null
              ? 'Starting…'
              : progress.awaitingConfirmation
                ? `Waiting for your confirmation — step ${String((progress.stepIndex ?? 0) + 1)} of ${String(progress.totalSteps)}`
                : `Step ${String((progress.stepIndex ?? 0) + 1)} of ${String(progress.totalSteps)} (attempt ${String(progress.attempt)}) — ${progress.completedSteps} done`}
          </p>
          <span>
            <button type="button" onClick={() => void workflow.pauseRun()}>
              Pause after this step
            </button>
            <button type="button" onClick={() => void workflow.cancelRun()}>
              Cancel now
            </button>
          </span>
        </div>
      )}

      <div className="workspace__panels">
        <div className="workspace__panel">
          <div className="workspace__panel-head">
            <h3>Workflows</h3>
            <button
              type="button"
              disabled={!canAct || draft !== null}
              onClick={() => {
                setDraft(emptyDraft());
                setEditingId(null);
              }}
            >
              New workflow
            </button>
          </div>

          {state.workflows.map((entry) => (
            <WorkflowCard
              key={entry.id}
              workflow={entry}
              canAct={canAct}
              onRun={() => {
                setRunTarget(entry.id);
              }}
              onEdit={() => {
                setDraft(draftFrom(entry));
                setEditingId(entry.id);
              }}
              onDuplicate={() => void workflow.duplicateWorkflow(entry.id, `${entry.id}.copy`)}
              onDelete={() => void workflow.deleteWorkflow(entry.id)}
              onToggleEnabled={() => void workflow.setWorkflowEnabled(entry.id, !entry.enabled)}
            />
          ))}

          {state.initialized && state.workflows.length === 0 && (
            <p className="workspace-empty">No workflow has been created yet.</p>
          )}
        </div>

        <div className="workspace__panel">
          <h3>Run</h3>
          {runTarget === null ? (
            <p className="workspace-empty">Choose a workflow and select Run.</p>
          ) : (
            <>
              <p className="workspace-hint">
                Running <strong>{runTarget}</strong>. You will be shown the agent, the ordered
                steps, the scope and the limits in a dialog before anything happens.
              </p>
              <div className="workspace__plan-form">
                <label htmlFor="workflow-objective">What is this run about?</label>
                <textarea
                  id="workflow-objective"
                  rows={3}
                  value={objective}
                  onChange={(event) => {
                    setObjective(event.target.value);
                  }}
                />
                <div className="agent-card__actions">
                  <button
                    type="button"
                    disabled={!canAct || objective.trim().length < WORKSPACE_OBJECTIVE_MIN_LENGTH}
                    onClick={() => void workflow.startRun(runTarget, objective.trim())}
                  >
                    Start run
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setRunTarget(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            </>
          )}

          {state.run !== null && <RunReport run={state.run} />}
        </div>
      </div>

      {draft !== null && (
        <div className="workflow-editor">
          <h3>{editingId === null ? 'New workflow' : 'Edit workflow'}</h3>

          <div className="workflow-editor__row">
            <div className="field">
              <label htmlFor="workflow-id">Identifier</label>
              <input
                id="workflow-id"
                value={draft.id}
                disabled={editingId !== null}
                onChange={(event) => {
                  updateDraft({ id: event.target.value });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="workflow-name">Name</label>
              <input
                id="workflow-name"
                value={draft.name}
                onChange={(event) => {
                  updateDraft({ name: event.target.value });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="workflow-agent">Agent profile id</label>
              <input
                id="workflow-agent"
                value={draft.agentProfileId}
                onChange={(event) => {
                  updateDraft({ agentProfileId: event.target.value });
                }}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="workflow-description">Description</label>
            <input
              id="workflow-description"
              value={draft.description}
              onChange={(event) => {
                updateDraft({ description: event.target.value });
              }}
            />
          </div>

          <h4>Steps</h4>
          {draft.steps.map((step, index) => (
            <div className="workflow-editor__step" key={`step-${String(index)}`}>
              <div className="workflow-editor__row">
                <div className="field">
                  <label htmlFor={`step-tool-${String(index)}`}>Tool</label>
                  <select
                    id={`step-tool-${String(index)}`}
                    value={step.tool}
                    onChange={(event) => {
                      const tool = event.target.value as WorkflowStep['tool'];
                      updateStep(index, {
                        tool,
                        // A query belongs to the search tool and to no other,
                        // so switching away from it clears one rather than
                        // leaving a field that would fail validation.
                        query: tool === 'workspace.search' ? (step.query ?? 'todo') : null,
                      });
                    }}
                  >
                    {AGENT_TOOLS.map((tool) => (
                      <option key={tool.id} value={tool.id}>
                        {tool.id} ({tool.actionType})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`step-target-${String(index)}`}>Target (relative path)</label>
                  <input
                    id={`step-target-${String(index)}`}
                    value={step.target}
                    onChange={(event) => {
                      updateStep(index, { target: event.target.value });
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`step-condition-${String(index)}`}>Condition</label>
                  <select
                    id={`step-condition-${String(index)}`}
                    value={step.condition}
                    onChange={(event) => {
                      updateStep(index, {
                        condition: event.target.value as WorkflowStep['condition'],
                      });
                    }}
                  >
                    {WORKFLOW_STEP_CONDITIONS.map((condition) => (
                      <option key={condition} value={condition}>
                        {condition}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor={`step-retries-${String(index)}`}>Retries</label>
                  <input
                    id={`step-retries-${String(index)}`}
                    type="number"
                    min={0}
                    max={WORKFLOW_MAX_STEP_RETRIES}
                    value={step.maxRetries}
                    onChange={(event) => {
                      updateStep(index, { maxRetries: Number(event.target.value) });
                    }}
                  />
                </div>
              </div>

              {step.tool === 'workspace.search' && (
                <div className="field">
                  <label htmlFor={`step-query-${String(index)}`}>Search term</label>
                  <input
                    id={`step-query-${String(index)}`}
                    value={step.query ?? ''}
                    onChange={(event) => {
                      updateStep(index, { query: event.target.value });
                    }}
                  />
                </div>
              )}

              <label className="agent-editor__check">
                <input
                  type="checkbox"
                  checked={step.checkpoint}
                  onChange={(event) => {
                    updateStep(index, { checkpoint: event.target.checked });
                  }}
                />
                Checkpoint — stop and ask before this step
              </label>

              <button
                type="button"
                disabled={draft.steps.length <= 1}
                onClick={() => {
                  removeStep(index);
                }}
              >
                Remove step
              </button>
            </div>
          ))}

          <button type="button" onClick={addStep}>
            Add step
          </button>

          <div className="workflow-editor__row">
            <div className="field">
              <label htmlFor="workflow-max-steps">Max steps (incl. retries)</label>
              <input
                id="workflow-max-steps"
                type="number"
                min={WORKFLOW_MIN_STEPS}
                max={WORKFLOW_MAX_STEPS}
                value={draft.limits.maxSteps}
                onChange={(event) => {
                  updateDraft({
                    limits: { ...draft.limits, maxSteps: Number(event.target.value) },
                  });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="workflow-max-duration">Max duration (ms)</label>
              <input
                id="workflow-max-duration"
                type="number"
                min={WORKFLOW_MIN_DURATION_MS}
                max={WORKFLOW_MAX_DURATION_MS}
                value={draft.limits.maxDurationMs}
                onChange={(event) => {
                  updateDraft({
                    limits: { ...draft.limits, maxDurationMs: Number(event.target.value) },
                  });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="workflow-max-output">Max output (bytes)</label>
              <input
                id="workflow-max-output"
                type="number"
                min={WORKFLOW_MIN_OUTPUT_BYTES}
                max={WORKFLOW_MAX_OUTPUT_BYTES}
                value={draft.limits.maxOutputBytes}
                onChange={(event) => {
                  updateDraft({
                    limits: { ...draft.limits, maxOutputBytes: Number(event.target.value) },
                  });
                }}
              />
            </div>
          </div>

          <div className="workflow-editor__row">
            <div className="field">
              <label htmlFor="workflow-failure">On a failed step</label>
              <select
                id="workflow-failure"
                value={draft.failureBehavior}
                onChange={(event) => {
                  updateDraft({
                    failureBehavior: event.target.value as WorkflowInput['failureBehavior'],
                  });
                }}
              >
                <option value="stop">stop the run</option>
                <option value="continue">continue to the next step</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="workflow-rollback">Rollback</label>
              <select
                id="workflow-rollback"
                value={draft.rollback}
                onChange={(event) => {
                  updateDraft({ rollback: event.target.value as WorkflowInput['rollback'] });
                }}
              >
                <option value="none">none</option>
                <option value="restore-run-changes">restore changes this run applied</option>
              </select>
            </div>
          </div>

          <label className="agent-editor__check">
            <input
              type="checkbox"
              checked={draft.successCriteria.requireAllStepsSucceed}
              onChange={(event) => {
                updateDraft({
                  successCriteria: {
                    ...draft.successCriteria,
                    requireAllStepsSucceed: event.target.checked,
                  },
                });
              }}
            />
            Every step must succeed for the run to count as a success
          </label>

          <label className="agent-editor__check">
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(event) => {
                updateDraft({ enabled: event.target.checked });
              }}
            />
            Enabled
          </label>

          {draftIssues.length > 0 && (
            <ul className="agent-editor__issues" role="alert">
              {draftIssues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          )}

          <div className="agent-card__actions">
            <button
              type="button"
              disabled={!canAct || draftIssues.length > 0}
              onClick={() => void submitDraft()}
            >
              {editingId === null ? 'Create workflow' : 'Save workflow'}
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setEditingId(null);
              }}
            >
              Cancel
            </button>
          </div>

          <p className="workspace-hint">
            Saving asks for confirmation in a dialog the main process owns, stating exactly what
            this workflow would be allowed to do. A step outside the selected agent’s allowlist is
            refused when you save, and again before it would run.
          </p>
        </div>
      )}

      <p className="workspace-hint">
        Rollback only ever restores changes a run itself applied. In this milestone no step can
        change a file, so there is never anything to restore — the mode is validated and reported,
        and it always resolves to “nothing to roll back”.
      </p>
    </section>
  );
}
