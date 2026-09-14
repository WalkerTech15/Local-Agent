/**
 * The agent profile surface (Phase 2, Milestone 7).
 *
 * A third sibling next to Chat and Workspace, not a redesign: it reuses the
 * existing panel, badge, hint and error classes rather than introducing a
 * visual language of its own.
 *
 * What it is for, in the milestone's own terms: listing profiles, choosing
 * the active one, showing each profile's provider and capability summary, and
 * **stating plainly what the active profile is permitted to do and what
 * bounds it runs under**. That last point is why every profile card spells
 * out its tools, the action type each tool routes through, its workspace
 * scope and its three ceilings, rather than summarising them as a count.
 *
 * Nothing here is a security control. The form validates before sending
 * purely so a person sees a mistake immediately; the main process re-validates
 * everything it receives and is the only thing that decides what is stored.
 */

import { useState } from 'react';

import { useAgent } from './useAgent';
import {
  AGENT_TOOLS,
  AGENT_VERIFICATION_REQUIREMENTS,
  DEFAULT_AGENT_PROFILE_ID,
  describeProfileTools,
} from '../../shared/agent';
import type { AgentToolId, AgentVerificationRequirement } from '../../shared/agent';
import {
  AGENT_DEFAULT_MAX_DURATION_MS,
  AGENT_DEFAULT_MAX_OUTPUT_BYTES,
  AGENT_DEFAULT_MAX_STEPS,
  AGENT_MAX_DURATION_MS,
  AGENT_MAX_OUTPUT_BYTES,
  AGENT_MAX_STEPS,
  AGENT_MIN_DURATION_MS,
  AGENT_MIN_OUTPUT_BYTES,
  AGENT_MIN_STEPS,
  MODEL_PROVIDERS,
  WORKSPACE_OBJECTIVE_MIN_LENGTH,
} from '../../shared/constants';
import { agentProfileInputSchema } from '../../shared/schemas';
import type { AgentProfile, AgentProfileInput, AgentRun } from '../../shared/schemas';

/** A blank profile for the create form: no tools, nothing in scope. */
function emptyDraft(): AgentProfileInput {
  return {
    id: '',
    name: '',
    description: '',
    instructions: '',
    provider: 'none',
    fallbackProviders: [],
    allowedTools: [],
    approvedWorkspacePaths: [''],
    permissionPolicy: [],
    verification: [],
    limits: {
      maxSteps: AGENT_DEFAULT_MAX_STEPS,
      maxDurationMs: AGENT_DEFAULT_MAX_DURATION_MS,
      maxOutputBytes: AGENT_DEFAULT_MAX_OUTPUT_BYTES,
    },
    enabled: true,
  };
}

/** Strips the derived fields so an existing profile can seed the form. */
function draftFrom(profile: AgentProfile): AgentProfileInput {
  const { builtIn: _builtIn, createdAt: _createdAt, updatedAt: _updatedAt, ...input } = profile;
  return input;
}

function formatScope(paths: readonly string[]): string {
  if (paths.length === 0) return 'nothing';
  return paths.map((path) => (path === '' ? 'the whole project' : path)).join(', ');
}

function toggle<TValue>(values: readonly TValue[], value: TValue): TValue[] {
  return values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value];
}

function ProfileCard(props: {
  readonly profile: AgentProfile;
  readonly active: boolean;
  readonly canAct: boolean;
  readonly onSelect: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onToggleEnabled: () => void;
}) {
  const { profile, active, canAct } = props;
  const tools = describeProfileTools(profile);
  const startsProcess = tools.some((tool) => tool.commandId !== null);

  return (
    <article className={`agent-card${active ? ' agent-card--active' : ''}`}>
      <header className="agent-card__head">
        <h4>{profile.name}</h4>
        <span className="workspace-badge">{profile.builtIn ? 'Built in' : 'Custom'}</span>
        {active && <span className="workspace-badge workspace-badge--strong">Active</span>}
        {!profile.enabled && <span className="workspace-badge">Disabled</span>}
      </header>

      <p className="workspace-hint">{profile.description}</p>

      <dl className="agent-card__facts">
        <dt>Provider</dt>
        <dd>
          {profile.provider}
          {profile.fallbackProviders.length > 0 &&
            ` (falls back to ${profile.fallbackProviders.join(', ')})`}
        </dd>

        <dt>Allowed tools</dt>
        <dd>
          {tools.length === 0 ? (
            'none — this profile can do nothing'
          ) : (
            <ul className="agent-card__tools">
              {tools.map((tool) => (
                <li key={tool.id}>
                  {tool.label} <code>{tool.actionType}</code>
                </li>
              ))}
            </ul>
          )}
        </dd>

        <dt>Workspace scope</dt>
        <dd>{formatScope(profile.approvedWorkspacePaths)}</dd>

        <dt>Limits</dt>
        <dd>
          {profile.limits.maxSteps} steps · {Math.round(profile.limits.maxDurationMs / 1000)}s ·{' '}
          {profile.limits.maxOutputBytes} bytes
        </dd>

        <dt>Verification</dt>
        <dd>
          {profile.verification.length === 0 ? 'none required' : profile.verification.join(', ')}
        </dd>
      </dl>

      <p className="workspace-hint">
        {startsProcess
          ? 'Can run the project’s own scripts. Each one is confirmed separately before it starts.'
          : 'Cannot start a process, change a file, or create a commit.'}
      </p>

      <div className="agent-card__actions">
        <button
          type="button"
          disabled={!canAct || active || !profile.enabled}
          onClick={props.onSelect}
        >
          Make active
        </button>
        <button type="button" disabled={!canAct || profile.builtIn} onClick={props.onEdit}>
          Edit
        </button>
        <button type="button" disabled={!canAct || profile.builtIn} onClick={props.onToggleEnabled}>
          {profile.enabled ? 'Disable' : 'Enable'}
        </button>
        <button type="button" disabled={!canAct || profile.builtIn} onClick={props.onDelete}>
          Delete
        </button>
      </div>
    </article>
  );
}

function RunReport(props: { readonly run: AgentRun }) {
  const { run } = props;
  return (
    <div className="agent-run">
      <h4>
        {run.profileName} — {run.status}
      </h4>
      <p className="workspace-hint">
        Stopped because: {run.stopReason}. {run.totals.steps} step(s), {run.totals.outputBytes}{' '}
        bytes, {Math.round(run.totals.durationMs / 1000)}s. Provider recorded: {run.provider}.
      </p>
      <p className="workspace-hint">
        Verification:{' '}
        {run.verification.required.length === 0
          ? 'none required'
          : `${run.verification.satisfied.length}/${run.verification.required.length} satisfied (${run.verification.required.join(', ')})`}
      </p>
      <ol className="agent-run__steps">
        {run.steps.map((step) => (
          <li key={step.index} className={`agent-run__step agent-run__step--${step.outcome}`}>
            <span className="agent-run__step-tool">{step.tool}</span>
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

export function Agents() {
  const agent = useAgent();
  const { state, canAct } = agent;

  const [objective, setObjective] = useState('');
  const [draft, setDraft] = useState<AgentProfileInput | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Validated here only so a mistake is visible immediately. The main process
  // re-validates everything it receives and is what actually decides.
  const validation = draft === null ? null : agentProfileInputSchema.safeParse(draft);
  const draftIssues =
    validation === null || validation.success
      ? []
      : validation.error.issues.map(
          (issue) => `${issue.path.join('.') || 'profile'}: ${issue.message}`,
        );

  const activeProfile =
    state.profiles.find((profile) => profile.id === state.activeProfileId) ?? null;

  function updateDraft(changes: Partial<AgentProfileInput>): void {
    setDraft((current) => (current === null ? current : { ...current, ...changes }));
  }

  async function submitDraft(): Promise<void> {
    if (draft === null || validation === null || !validation.success) return;
    if (editingId === null) await agent.createProfile(validation.data);
    else await agent.updateProfile(editingId, validation.data);
    setDraft(null);
    setEditingId(null);
  }

  return (
    <section className="workspace agent">
      <header className="workspace__header">
        <div>
          <h2>Agents</h2>
          <p className="workspace-hint">
            A profile narrows what an agent may reach for. It can never grant a permission the
            policy does not already allow.
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
              <button type="button" onClick={() => void agent.retry()}>
                Retry
              </button>
            )}
            <button type="button" onClick={agent.dismissError}>
              Dismiss
            </button>
          </span>
        </div>
      )}

      {!state.initialized && <p className="workspace-empty">Loading profiles…</p>}

      <div className="workspace__panels">
        <div className="workspace__panel">
          <div className="workspace__panel-head">
            <h3>Profiles</h3>
            <button
              type="button"
              disabled={!canAct || draft !== null}
              onClick={() => {
                setDraft(emptyDraft());
                setEditingId(null);
              }}
            >
              New profile
            </button>
          </div>

          {state.profiles.map((profile) => (
            <ProfileCard
              key={profile.id}
              profile={profile}
              active={profile.id === state.activeProfileId}
              canAct={canAct}
              onSelect={() => void agent.selectProfile(profile.id)}
              onEdit={() => {
                setDraft(draftFrom(profile));
                setEditingId(profile.id);
              }}
              onDelete={() => void agent.deleteProfile(profile.id)}
              onToggleEnabled={() => void agent.setProfileEnabled(profile.id, !profile.enabled)}
            />
          ))}

          {state.initialized && state.profiles.length === 0 && (
            <p className="workspace-empty">No profiles are available.</p>
          )}
        </div>

        <div className="workspace__panel">
          <h3>Run</h3>
          {activeProfile === null ? (
            <p className="workspace-empty">No profile is active.</p>
          ) : (
            <>
              <p className="workspace-hint">
                Active: <strong>{activeProfile.name}</strong> —{' '}
                {describeProfileTools(activeProfile).length} tool(s), scope{' '}
                {formatScope(activeProfile.approvedWorkspacePaths)}, at most{' '}
                {activeProfile.limits.maxSteps} steps.
              </p>
              <p className="workspace-hint">
                A run inspects, plans and verifies. It cannot write a file, undo a write, or create
                a commit — no tool exists for any of those.
              </p>
              <div className="workspace__plan-form">
                <label htmlFor="agent-objective">What should the agent look into?</label>
                <textarea
                  id="agent-objective"
                  value={objective}
                  rows={3}
                  disabled={!canAct}
                  onChange={(event) => {
                    setObjective(event.target.value);
                  }}
                />
                <span>
                  <button
                    type="button"
                    disabled={!canAct || objective.trim().length < WORKSPACE_OBJECTIVE_MIN_LENGTH}
                    onClick={() => void agent.startRun(objective.trim())}
                  >
                    Run agent
                  </button>
                  <button
                    type="button"
                    disabled={state.runningRunId === null}
                    onClick={() => void agent.cancelRun()}
                  >
                    Cancel run
                  </button>
                </span>
              </div>
            </>
          )}

          {state.run !== null && <RunReport run={state.run} />}
        </div>
      </div>

      {draft !== null && (
        <div className="workspace__panel agent-editor">
          <h3>{editingId === null ? 'New profile' : `Editing ${editingId}`}</h3>

          <div className="field">
            <label htmlFor="agent-id">Identifier</label>
            <input
              id="agent-id"
              value={draft.id}
              disabled={editingId !== null}
              onChange={(event) => {
                updateDraft({ id: event.target.value });
              }}
            />
          </div>

          <div className="field">
            <label htmlFor="agent-name">Name</label>
            <input
              id="agent-name"
              value={draft.name}
              onChange={(event) => {
                updateDraft({ name: event.target.value });
              }}
            />
          </div>

          <div className="field">
            <label htmlFor="agent-description">Description</label>
            <input
              id="agent-description"
              value={draft.description}
              onChange={(event) => {
                updateDraft({ description: event.target.value });
              }}
            />
          </div>

          <div className="field">
            <label htmlFor="agent-instructions">
              Instructions (stored and shown; never treated as authorization)
            </label>
            <textarea
              id="agent-instructions"
              rows={3}
              value={draft.instructions}
              onChange={(event) => {
                updateDraft({ instructions: event.target.value });
              }}
            />
          </div>

          <div className="field">
            <label htmlFor="agent-provider">Primary provider</label>
            <select
              id="agent-provider"
              value={draft.provider}
              onChange={(event) => {
                updateDraft({
                  provider: event.target.value as AgentProfileInput['provider'],
                  fallbackProviders: [],
                });
              }}
            >
              {MODEL_PROVIDERS.map((provider) => (
                <option key={provider} value={provider}>
                  {provider}
                </option>
              ))}
            </select>
          </div>

          <fieldset className="agent-editor__group">
            <legend>Allowed tools</legend>
            {AGENT_TOOLS.map((tool) => (
              <label key={tool.id} className="agent-editor__check">
                <input
                  type="checkbox"
                  checked={draft.allowedTools.includes(tool.id)}
                  onChange={() => {
                    updateDraft({
                      allowedTools: toggle<AgentToolId>(draft.allowedTools, tool.id),
                    });
                  }}
                />
                {tool.label} <code>{tool.actionType}</code>
              </label>
            ))}
          </fieldset>

          <fieldset className="agent-editor__group">
            <legend>Verification required</legend>
            {AGENT_VERIFICATION_REQUIREMENTS.map((requirement) => (
              <label key={requirement} className="agent-editor__check">
                <input
                  type="checkbox"
                  checked={draft.verification.includes(requirement)}
                  onChange={() => {
                    updateDraft({
                      verification: toggle<AgentVerificationRequirement>(
                        draft.verification,
                        requirement,
                      ),
                    });
                  }}
                />
                {requirement}
              </label>
            ))}
          </fieldset>

          <div className="field">
            <label htmlFor="agent-scope">
              Workspace scope — one project-relative path per line, blank line means the whole
              project
            </label>
            <textarea
              id="agent-scope"
              rows={3}
              value={draft.approvedWorkspacePaths.join('\n')}
              onChange={(event) => {
                updateDraft({ approvedWorkspacePaths: event.target.value.split('\n') });
              }}
            />
          </div>

          <div className="agent-editor__limits">
            <div className="field">
              <label htmlFor="agent-max-steps">Max steps</label>
              <input
                id="agent-max-steps"
                type="number"
                min={AGENT_MIN_STEPS}
                max={AGENT_MAX_STEPS}
                value={draft.limits.maxSteps}
                onChange={(event) => {
                  updateDraft({
                    limits: { ...draft.limits, maxSteps: Number(event.target.value) },
                  });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="agent-max-duration">Max duration (ms)</label>
              <input
                id="agent-max-duration"
                type="number"
                min={AGENT_MIN_DURATION_MS}
                max={AGENT_MAX_DURATION_MS}
                value={draft.limits.maxDurationMs}
                onChange={(event) => {
                  updateDraft({
                    limits: { ...draft.limits, maxDurationMs: Number(event.target.value) },
                  });
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="agent-max-output">Max output (bytes)</label>
              <input
                id="agent-max-output"
                type="number"
                min={AGENT_MIN_OUTPUT_BYTES}
                max={AGENT_MAX_OUTPUT_BYTES}
                value={draft.limits.maxOutputBytes}
                onChange={(event) => {
                  updateDraft({
                    limits: { ...draft.limits, maxOutputBytes: Number(event.target.value) },
                  });
                }}
              />
            </div>
          </div>

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
              {editingId === null ? 'Create profile' : 'Save profile'}
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
            this profile would be allowed to do. The built-in{' '}
            <code>{DEFAULT_AGENT_PROFILE_ID}</code> profile is what every failed lookup falls back
            to, and cannot be edited.
          </p>
        </div>
      )}
    </section>
  );
}
