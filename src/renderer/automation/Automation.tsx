/**
 * The Windows automation surface (Phase 2, Milestone 10).
 *
 * A sibling next to Chat, Workspace, Agents, Memory and Workflows, not a
 * redesign: it reuses the existing panel, badge, hint and error classes
 * rather than introducing a visual language of its own.
 *
 * What it is for, in the milestone's own terms: listing the fixed tool
 * registry, running one manually, showing the awaiting-confirmation and
 * in-progress state, showing success, failure and cancellation plainly, and
 * showing the limits every action runs under. There is no form here that
 * names a path, a URL or a command — every action is one button per
 * registered tool.
 */

import { AUTOMATION_LAUNCH_TIMEOUT_MS, AUTOMATION_SHELL_TIMEOUT_MS } from '../../shared/constants';
import type { AutomationTool } from '../../shared/schemas';
import { useAutomation } from './useAutomation';

const KIND_LABELS: Readonly<Record<AutomationTool['kind'], string>> = {
  'launch-app': 'Application',
  'open-folder': 'Folder',
  'open-website': 'Website',
  'focus-window': 'Window',
  'run-script': 'Script',
};

function ToolCard(props: {
  readonly tool: AutomationTool;
  readonly running: boolean;
  readonly canAct: boolean;
  readonly onRun: () => void;
}) {
  const { tool, running, canAct } = props;
  return (
    <article className={`agent-card${running ? ' agent-card--active' : ''}`}>
      <header className="agent-card__head">
        <h4>{tool.label}</h4>
        <span className="workspace-badge">{KIND_LABELS[tool.kind]}</span>
        {tool.requiresProject && <span className="workspace-badge">Needs a project</span>}
        {running && <span className="workspace-badge workspace-badge--strong">Running</span>}
      </header>
      <p className="workspace-hint">{tool.description}</p>
      <button type="button" disabled={!canAct || running} onClick={props.onRun}>
        Run
      </button>
    </article>
  );
}

export function Automation() {
  const automation = useAutomation();
  const { state } = automation;
  const canAct = automation.canAct && !state.remoteBusy;

  return (
    <section className="workspace automation">
      <header className="workspace__header">
        <div>
          <h2>Automation</h2>
          <p className="workspace-hint">
            Every action below is one of a fixed, registered set — launching an approved
            application, opening an approved folder or website, focusing this window, or running a
            registered script. Nothing here can run an arbitrary command or reach an arbitrary path.
            Each one asks for confirmation first and is recorded in the audit log.
          </p>
          <p className="workspace-hint">
            A launch is given up to {Math.round(AUTOMATION_LAUNCH_TIMEOUT_MS / 1000)}s to prove it
            did not fail immediately; opening a folder or a website is given up to{' '}
            {Math.round(AUTOMATION_SHELL_TIMEOUT_MS / 1000)}s. Only one action may run at a time.
          </p>
        </div>
        <div className="workspace__status">
          <p className="workspace-hint">
            {state.busy === null ? 'Idle' : `Working: ${state.busy}`}
            {state.remoteBusy && state.busy === null ? ' — an action is already running' : ''}
          </p>
          {state.activity !== null && <p className="workspace-hint">{state.activity}</p>}
        </div>
      </header>

      {state.error !== null && (
        <div className="workspace__error" role="alert">
          <p>{state.error.message}</p>
          <span>
            {state.error.retryable && (
              <button type="button" onClick={() => void automation.retry()}>
                Retry
              </button>
            )}
            <button type="button" onClick={automation.dismissError}>
              Dismiss
            </button>
          </span>
        </div>
      )}

      {!state.initialized && <p className="workspace-empty">Loading the tool registry…</p>}

      <div className="workspace__panels">
        <div className="workspace__panel">
          <div className="workspace__panel-head">
            <h3>Registered tools</h3>
          </div>

          {state.tools.map((tool) => (
            <ToolCard
              key={tool.id}
              tool={tool}
              running={state.runningToolId === tool.id}
              canAct={canAct}
              onRun={() => void automation.runTool(tool.id)}
            />
          ))}

          {state.initialized && state.tools.length === 0 && (
            <p className="workspace-empty">No automation tools are registered.</p>
          )}
        </div>

        <div className="workspace__panel">
          <h3>Last result</h3>
          {state.runningToolId !== null && (
            <div className="agent-run">
              <p className="workspace-hint">Waiting for confirmation, or running…</p>
              <button type="button" onClick={() => void automation.cancelRun()}>
                Cancel
              </button>
            </div>
          )}
          {state.lastRun === null ? (
            <p className="workspace-empty">No action has run yet.</p>
          ) : (
            <div className="agent-run">
              <h4>
                {state.lastRun.toolId} — {state.lastRun.outcome}
              </h4>
              <p className="workspace-hint">
                {state.lastRun.attempts} attempt(s), {Math.round(state.lastRun.durationMs / 1000)}s.
                {state.lastRun.timedOut && ' Timed out.'}
                {state.lastRun.cancelled && ' Cancelled.'}
                {state.lastRun.stoppedByEmergency && ' Stopped by the emergency stop.'}
              </p>
              <p className="workspace-hint">
                {state.lastRun.verified ? 'Verified.' : 'Not verified.'}
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
