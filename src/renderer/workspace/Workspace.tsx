import { useState, type FormEvent } from 'react';

import { useWorkspace } from './useWorkspace';
import { describeChatProviderStatus } from '../../shared/chat';
import type {
  CodingPlan,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceSearchResult,
  ModelProviderSettings,
} from '../../shared/schemas';

interface WorkspaceProps {
  readonly assistantName: string;
  readonly modelProvider: ModelProviderSettings;
}

/**
 * How deep an entry is allowed to indent before the indentation stops
 * growing. Purely visual; the tree's own depth bound is enforced in the main
 * process.
 */
const MAX_INDENT_DEPTH = 8;

function indentStyle(depth: number): { readonly paddingInlineStart: string } {
  return { paddingInlineStart: `${String(Math.min(depth, MAX_INDENT_DEPTH) * 14)}px` };
}

/**
 * One row of the file tree.
 *
 * `entry.name` is rendered as a plain JSX text child — React escapes every
 * string child, so a file name, however hostile, cannot inject markup. The
 * name has additionally already been refused by the main process if it
 * carried a control character or a bidirectional override, so what reaches
 * here renders as what it is.
 */
function TreeRow({
  entry,
  onOpen,
  disabled,
  isOpen,
}: {
  readonly entry: WorkspaceEntry;
  readonly onOpen: (entry: WorkspaceEntry) => void;
  readonly disabled: boolean;
  readonly isOpen: boolean;
}) {
  const openable = entry.kind === 'directory' ? !entry.excluded : entry.readable;
  const classes = ['workspace-tree__row'];
  if (entry.excluded) classes.push('workspace-tree__row--excluded');
  if (isOpen) classes.push('workspace-tree__row--current');

  return (
    <li className={classes.join(' ')} style={indentStyle(entry.depth)}>
      <button
        type="button"
        className="workspace-tree__button"
        disabled={disabled || !openable}
        onClick={() => {
          onOpen(entry);
        }}
      >
        <span aria-hidden="true" className="workspace-tree__icon">
          {entry.kind === 'directory' ? '▸' : '·'}
        </span>
        <span className="workspace-tree__name">{entry.name}</span>
      </button>
      {entry.excluded && <span className="workspace-tree__tag">excluded</span>}
      {entry.kind === 'file' && entry.size !== undefined && (
        <span className="workspace-tree__size">{entry.size} B</span>
      )}
    </li>
  );
}

/**
 * The read-only file viewer.
 *
 * `file.content` is a plain JSX text child, never `dangerouslySetInnerHTML`,
 * and `white-space: pre` in the stylesheet preserves the layout without
 * turning newlines into markup — the same treatment assistant messages get in
 * `chat/Chat.tsx`, for the same reason: this is someone else's file, and it
 * is untrusted input.
 */
function FileViewer({ file }: { readonly file: WorkspaceFile }) {
  return (
    <div className="workspace-file">
      <div className="workspace-file__meta">
        <strong>{file.metadata.name}</strong>
        <span>{file.metadata.path}</span>
        <span>
          {file.metadata.size} bytes · {file.metadata.lineCount} lines · {file.metadata.encoding}
        </span>
        <span className="workspace-badge">read-only</span>
      </div>
      {file.metadata.warnings.includes('bidirectional-control-characters') && (
        <p className="workspace-file__warning" role="note">
          This file contains bidirectional control characters. They can make the text read
          differently from how it is stored — compare carefully before trusting what you see.
        </p>
      )}
      <pre className="workspace-file__content">{file.content}</pre>
    </div>
  );
}

function SearchResults({
  results,
  onOpen,
  disabled,
}: {
  readonly results: WorkspaceSearchResult;
  readonly onOpen: (path: string) => void;
  readonly disabled: boolean;
}) {
  if (results.matches.length === 0) {
    return <p className="workspace-empty">No match for “{results.query}”.</p>;
  }

  return (
    <>
      <p className="workspace-hint">
        {results.matches.length} match(es) in {results.filesScanned} file(s)
        {results.truncated ? ' — results were truncated at the limit.' : '.'}
      </p>
      <ul className="workspace-matches">
        {results.matches.map((match) => (
          <li key={`${match.path}:${String(match.line)}:${String(match.column)}`}>
            <button
              type="button"
              className="workspace-matches__button"
              disabled={disabled}
              onClick={() => {
                onOpen(match.path);
              }}
            >
              <span className="workspace-matches__path">
                {match.path}:{match.line}
              </span>
              <span className="workspace-matches__excerpt">{match.excerpt}</span>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The inert coding plan.
 *
 * Everything here is text produced by `src/shared/workspace/plan.ts` from
 * observations about the project. There is no diff, because nothing generated
 * file content to diff against — see `codingPlanSchema`, which pins `diff` to
 * `null` so that stays true by construction rather than by omission.
 */
function PlanView({
  plan,
  approved,
  onApprove,
  disabled,
}: {
  readonly plan: CodingPlan;
  readonly approved: boolean;
  readonly onApprove: () => void;
  readonly disabled: boolean;
}) {
  return (
    <div className="workspace-plan">
      <h3>Proposed approach</h3>
      <p className="workspace-plan__summary">{plan.objective.summary}</p>

      <h4>Project context</h4>
      <p className="workspace-hint">
        {plan.context.projectName} · {plan.context.filesInspected} file(s) inspected ·{' '}
        {plan.context.hasGitMetadata ? 'version-controlled' : 'no version control detected'} ·{' '}
        {plan.context.hasTestTooling ? 'test tooling detected' : 'no test tooling detected'}
        {plan.context.searchTruncated ? ' · inspection was truncated' : ''}
      </p>

      <h4>Steps</h4>
      <ol className="workspace-plan__steps">
        {plan.steps.map((step) => (
          <li key={step.order}>
            <strong>{step.title}</strong>
            <span>{step.detail}</span>
          </li>
        ))}
      </ol>

      <h4>Files this would touch</h4>
      {plan.expectedChanges.length === 0 ? (
        <p className="workspace-empty">No file was identified for change.</p>
      ) : (
        <ul className="workspace-plan__files">
          {plan.expectedChanges.map((change) => (
            <li key={change.path}>
              <code>{change.path}</code>
              <span className="workspace-badge">{change.changeType}</span>
              <span>{change.rationale}</span>
            </li>
          ))}
        </ul>
      )}

      <h4>Change summary</h4>
      <p>{plan.changeSummary}</p>

      <h4>Risks</h4>
      <ul className="workspace-plan__list">
        {plan.risks.map((risk) => (
          <li key={risk}>{risk}</li>
        ))}
      </ul>

      <h4>Assumptions</h4>
      <ul className="workspace-plan__list">
        {plan.assumptions.map((assumption) => (
          <li key={assumption}>{assumption}</li>
        ))}
      </ul>

      <div className="workspace-plan__approval">
        {approved ? (
          <p role="status" className="workspace-plan__approved">
            Plan approved. Nothing was changed — this version of Local Agent has no ability to
            modify a file, and approval unlocks none.
          </p>
        ) : (
          <>
            <p>
              This plan is a proposal. Approving it records your consent; it does not apply
              anything, and no code path in this version can.
            </p>
            <button type="button" onClick={onApprove} disabled={disabled}>
              Approve plan
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/**
 * The read-only coding workspace (Phase 2, Milestone 5).
 *
 * Reaches the filesystem only through `useWorkspace` → `WorkspaceController`
 * → `ipc-workspace-client.ts` → the preload bridge, and therefore only inside
 * the approved project the user chose in a native picker. This component has
 * no path of its own to a file, and nothing it renders can modify one.
 *
 * Every piece of text below that came from the project — a file name, a path,
 * a search excerpt, a file's contents — is rendered as a plain JSX text
 * child. `dangerouslySetInnerHTML` appears nowhere in this file, exactly as
 * it appears nowhere in `chat/Chat.tsx`.
 */
export function Workspace({ assistantName, modelProvider }: WorkspaceProps) {
  const {
    state,
    canAct,
    selectProject,
    refreshTree,
    openFile,
    search,
    createPlan,
    approvePlan,
    retry,
  } = useWorkspace();
  const [query, setQuery] = useState('');
  const [objective, setObjective] = useState('');

  const providerStatus = describeChatProviderStatus(modelProvider);
  const agentStatus = state.busy === null ? 'Idle' : `Working — ${state.busy}…`;

  function handleOpenEntry(entry: WorkspaceEntry): void {
    if (entry.kind === 'directory') {
      void refreshTree(entry.path);
      return;
    }
    void openFile(entry.path);
  }

  function handleSearch(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void search(query);
  }

  function handlePlan(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void createPlan(objective);
  }

  return (
    <section className="workspace" aria-label={`Coding workspace for ${assistantName}`}>
      <header className="workspace__header">
        <div>
          <h2>Coding workspace</h2>
          <p className="workspace-badge workspace-badge--strong">Read-only</p>
        </div>
        <div className="workspace__status">
          <p className="workspace-hint">Model: {providerStatus.summary}</p>
          <p className="workspace-hint" aria-live="polite">
            Agent: {agentStatus}
          </p>
          {state.activity !== null && (
            <p className="workspace-hint" aria-live="polite">
              Last activity: {state.activity}
            </p>
          )}
        </div>
      </header>

      <div className="workspace__project">
        <button type="button" onClick={() => void selectProject()} disabled={!canAct}>
          {state.project === null ? 'Select a project…' : 'Change project…'}
        </button>
        {state.project === null ? (
          <p className="workspace-hint">
            No project is open. Local Agent can only read inside a directory you approve, and can
            never modify it.
          </p>
        ) : (
          <p className="workspace-hint">
            <strong>{state.project.name}</strong> — <span>{state.project.path}</span>
            {state.project.markers.length > 0 && <span> · {state.project.markers.join(', ')}</span>}
            {state.project.hasGitMetadata && <span> · Git</span>}
          </p>
        )}
      </div>

      {state.error && (
        <div className="workspace__error" role="alert">
          <p>{state.error.message}</p>
          {state.error.retryable && (
            <button type="button" onClick={() => void retry()} disabled={!canAct}>
              Retry
            </button>
          )}
        </div>
      )}

      {!state.initialized && <p className="workspace-hint">Loading workspace…</p>}

      {state.initialized && state.project === null && (
        <p className="workspace-empty">
          Select a project to list its files, read them, and prepare a coding plan.
        </p>
      )}

      {state.project !== null && (
        <div className="workspace__panels">
          <div className="workspace__panel workspace__panel--tree">
            <div className="workspace__panel-head">
              <h3>Files</h3>
              <button type="button" onClick={() => void refreshTree('')} disabled={!canAct}>
                Project root
              </button>
            </div>
            {state.busy === 'tree' && <p className="workspace-hint">Listing…</p>}
            {state.tree === null && state.busy !== 'tree' && (
              <p className="workspace-empty">No listing yet.</p>
            )}
            {state.tree !== null && state.tree.entries.length === 0 && (
              <p className="workspace-empty">This folder is empty.</p>
            )}
            {state.tree !== null && state.tree.entries.length > 0 && (
              <>
                {state.tree.root.length > 0 && (
                  <p className="workspace-hint">In {state.tree.root}</p>
                )}
                <ul className="workspace-tree">
                  {state.tree.entries.map((entry) => (
                    <TreeRow
                      key={entry.path}
                      entry={entry}
                      onOpen={handleOpenEntry}
                      disabled={!canAct}
                      isOpen={state.openFile?.metadata.path === entry.path}
                    />
                  ))}
                </ul>
                {state.tree.truncated && (
                  <p className="workspace-hint">
                    The listing reached its limit; some entries are not shown.
                  </p>
                )}
              </>
            )}

            <form className="workspace__search" onSubmit={handleSearch}>
              <label htmlFor="workspace-search-input">Search this project</label>
              <input
                id="workspace-search-input"
                type="search"
                value={query}
                maxLength={200}
                placeholder="Find text…"
                disabled={!canAct}
                onChange={(event) => {
                  setQuery(event.target.value);
                }}
              />
              <button type="submit" disabled={!canAct || query.trim().length < 2}>
                Search
              </button>
            </form>
            {state.busy === 'search' && <p className="workspace-hint">Searching…</p>}
            {state.search !== null && state.busy !== 'search' && (
              <SearchResults
                results={state.search}
                onOpen={(path) => void openFile(path)}
                disabled={!canAct}
              />
            )}
          </div>

          <div className="workspace__panel workspace__panel--viewer">
            <h3>Viewer</h3>
            {state.busy === 'file' && <p className="workspace-hint">Opening…</p>}
            {state.openFile === null && state.busy !== 'file' && (
              <p className="workspace-empty">Select a file to read it.</p>
            )}
            {state.openFile !== null && <FileViewer file={state.openFile} />}

            <form className="workspace__plan-form" onSubmit={handlePlan}>
              <label htmlFor="workspace-objective-input">Describe a coding task</label>
              <textarea
                id="workspace-objective-input"
                value={objective}
                rows={3}
                maxLength={2000}
                placeholder="What would you like to change in this project?"
                disabled={!canAct}
                onChange={(event) => {
                  setObjective(event.target.value);
                }}
              />
              <button type="submit" disabled={!canAct || objective.trim().length < 4}>
                Prepare a plan
              </button>
            </form>
            {state.busy === 'plan' && <p className="workspace-hint">Preparing a plan…</p>}
            {state.plan !== null && state.busy !== 'plan' && (
              <PlanView
                plan={state.plan}
                approved={state.planApproved}
                onApprove={approvePlan}
                disabled={!canAct}
              />
            )}
          </div>
        </div>
      )}
    </section>
  );
}
