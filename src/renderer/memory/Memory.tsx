/**
 * The Memory Centre (Phase 2, Milestone 8).
 *
 * A fourth sibling next to Chat, Workspace and Agents, not a redesign: it
 * reuses the existing panel, badge, hint, field and error classes rather than
 * introducing a visual language of its own.
 *
 * What it is for, in the milestone's own terms: listing and searching
 * memories, showing each one's scope and source, pinning, editing, deleting,
 * clearing a scope, exporting and importing — and **stating plainly that this
 * is local-only**. That last point is why the privacy line is part of the
 * header rather than buried in a settings page: someone looking at a list of
 * notes about themselves should be able to see, without navigating anywhere,
 * that the notes are on this machine and that nothing here uploads them.
 *
 * Nothing here is a security control. The form validates before sending
 * purely so a person sees a mistake immediately; the main process
 * re-validates everything it receives, runs its own credential screen, and is
 * the only thing that decides what is stored.
 */

import { useState } from 'react';

import { useMemory } from './useMemory';
import {
  MEMORY_CATEGORIES,
  MEMORY_CONFIDENCE_DEFAULT,
  MEMORY_CONFIDENCE_MAX,
  MEMORY_CONFIDENCE_MIN,
  MEMORY_CONTENT_MAX_LENGTH,
  MEMORY_IMPORTANCE_DEFAULT,
  MEMORY_IMPORTANCE_MAX,
  MEMORY_IMPORTANCE_MIN,
  MEMORY_SCOPES,
} from '../../shared/constants';
import { memoryRecordInputSchema } from '../../shared/schemas';
import type { MemoryRecord, MemoryRecordInput, MemoryScopeValue } from '../../shared/schemas';

/** One sentence per scope, describing where its records actually live. */
const SCOPE_DESCRIPTIONS: Readonly<Record<MemoryScopeValue, string>> = {
  session:
    'Held in memory for this run of Local Agent only. Never written to disk — closing the application ends it.',
  project:
    'Stored in a file belonging to the project you approved in the Workspace. Another project never opens it.',
  personal:
    'Stored on this machine, in Local Agent’s own data folder. The only scope that outlives both the session and the project.',
};

const SCOPE_LABELS: Readonly<Record<MemoryScopeValue, string>> = {
  session: 'Session',
  project: 'Project',
  personal: 'Personal',
};

/** A blank record for the create form, in the scope currently shown. */
function emptyDraft(scope: MemoryScopeValue): MemoryRecordInput {
  return {
    scope,
    category: 'user-preference',
    content: '',
    importance: MEMORY_IMPORTANCE_DEFAULT,
    confidence: MEMORY_CONFIDENCE_DEFAULT,
    expiresAt: null,
    pinned: false,
  };
}

/** Strips the derived fields so an existing record can seed the form. */
function draftFrom(record: MemoryRecord): MemoryRecordInput {
  const {
    id: _id,
    source: _source,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    ...input
  } = record;
  return input;
}

/** The date part of an ISO timestamp, for display and for a `date` input. */
function isoDate(value: string): string {
  return value.slice(0, 10);
}

function MemoryCard(props: {
  readonly record: MemoryRecord;
  readonly canAct: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onTogglePinned: () => void;
}) {
  const { record, canAct } = props;

  return (
    <article className={`memory-card${record.pinned ? ' memory-card--pinned' : ''}`}>
      <header className="memory-card__head">
        <span className="workspace-badge">{SCOPE_LABELS[record.scope]}</span>
        <span className="workspace-badge">{record.category}</span>
        {/* Source is always shown: whether a note was typed here or came
            from an imported file is exactly the kind of provenance a reader
            needs in order to weigh it. */}
        <span className="workspace-badge">
          {record.source === 'user' ? 'Typed here' : 'Imported'}
        </span>
        {record.pinned && <span className="workspace-badge workspace-badge--strong">Pinned</span>}
      </header>

      <p className="memory-card__content">{record.content}</p>

      <p className="workspace-hint">
        Importance {record.importance}/{MEMORY_IMPORTANCE_MAX} · confidence {record.confidence}% ·
        updated {isoDate(record.updatedAt)}
        {record.expiresAt !== null && ` · expires ${isoDate(record.expiresAt)}`}
      </p>

      <div className="memory-card__actions">
        <button type="button" disabled={!canAct} onClick={props.onTogglePinned}>
          {record.pinned ? 'Unpin' : 'Pin'}
        </button>
        <button type="button" disabled={!canAct} onClick={props.onEdit}>
          Edit
        </button>
        <button type="button" disabled={!canAct} onClick={props.onDelete}>
          Delete
        </button>
      </div>
    </article>
  );
}

export function Memory() {
  const memory = useMemory();
  const { state, canAct } = memory;

  const [queryText, setQueryText] = useState('');
  const [draft, setDraft] = useState<MemoryRecordInput | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Validated here only so a mistake is visible immediately. The main process
  // re-validates everything it receives and is what actually decides.
  const validation = draft === null ? null : memoryRecordInputSchema.safeParse(draft);
  const draftIssues =
    validation === null || validation.success
      ? []
      : validation.error.issues.map(
          (issue) => `${issue.path.join('.') || 'memory'}: ${issue.message}`,
        );

  function updateDraft(changes: Partial<MemoryRecordInput>): void {
    setDraft((current) => (current === null ? current : { ...current, ...changes }));
  }

  function closeDraft(): void {
    setDraft(null);
    setEditingId(null);
  }

  async function submitDraft(): Promise<void> {
    if (draft === null || validation === null || !validation.success) return;
    if (editingId === null) await memory.addMemory(validation.data);
    else await memory.updateMemory(editingId, validation.data);
    closeDraft();
  }

  return (
    <section className="workspace memory">
      <header className="workspace__header">
        <div>
          <h2>Memory</h2>
          <p className="workspace-hint">
            Short notes you write about how you want to be worked with. Nothing here is written by a
            model, and nothing here grants a permission.
          </p>
          {/* The privacy status the milestone requires, stated where it
              cannot be missed rather than in a settings page. */}
          <p className="workspace-hint memory__privacy">
            <strong>Local only.</strong> These notes stay on this machine. Local Agent never uploads
            them, never syncs them, and never sends the whole store anywhere — only a handful of
            relevant notes are ever retrieved at a time.
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
              <button type="button" onClick={() => void memory.retry()}>
                Retry
              </button>
            )}
            <button type="button" onClick={memory.dismissError}>
              Dismiss
            </button>
          </span>
        </div>
      )}

      <nav className="memory__scopes" aria-label="Memory scopes">
        {MEMORY_SCOPES.map((scope) => (
          <button
            key={scope}
            type="button"
            aria-pressed={state.scope === scope}
            disabled={!canAct}
            onClick={() => {
              setQueryText('');
              closeDraft();
              void memory.setScope(scope);
            }}
          >
            {SCOPE_LABELS[scope]}
          </button>
        ))}
      </nav>

      <p className="workspace-hint">{SCOPE_DESCRIPTIONS[state.scope]}</p>

      <div className="workspace__panels">
        <div className="workspace__panel">
          <div className="workspace__panel-head">
            <h3>
              {SCOPE_LABELS[state.scope]} memories ({state.total})
            </h3>
            <button
              type="button"
              disabled={!canAct || draft !== null}
              onClick={() => {
                setDraft(emptyDraft(state.scope));
                setEditingId(null);
              }}
            >
              New memory
            </button>
          </div>

          <form
            className="memory__search"
            onSubmit={(event) => {
              event.preventDefault();
              void memory.search(queryText);
            }}
          >
            <label htmlFor="memory-search">Search these memories</label>
            <input
              id="memory-search"
              type="search"
              value={queryText}
              disabled={!canAct}
              onChange={(event) => {
                setQueryText(event.target.value);
              }}
            />
            <button type="submit" disabled={!canAct}>
              Search
            </button>
            {state.query.length > 0 && (
              <button
                type="button"
                disabled={!canAct}
                onClick={() => {
                  setQueryText('');
                  void memory.clearSearch();
                }}
              >
                Show all
              </button>
            )}
          </form>

          {!state.initialized && <p className="workspace-empty">Loading memories…</p>}

          {state.initialized && state.records.length === 0 && (
            <p className="workspace-empty">
              {state.query.length > 0
                ? 'No memory matches that search.'
                : 'Nothing is remembered in this scope yet.'}
            </p>
          )}

          {state.records.map((record) => (
            <MemoryCard
              key={record.id}
              record={record}
              canAct={canAct}
              onEdit={() => {
                setDraft(draftFrom(record));
                setEditingId(record.id);
              }}
              onDelete={() => void memory.deleteMemory(record.id)}
              onTogglePinned={() => void memory.setPinned(record.id, !record.pinned)}
            />
          ))}

          {state.truncated && (
            <p className="workspace-hint">
              Showing the first {state.records.length} of {state.total}. Narrow the list with a
              search.
            </p>
          )}
        </div>

        <div className="workspace__panel">
          <h3>This scope</h3>
          <p className="workspace-hint">
            Clearing, exporting and importing each ask for confirmation in a dialog the main process
            owns. Export and import choose the file in a native dialog — Local Agent never picks a
            file for you.
          </p>
          <div className="memory-card__actions">
            <button type="button" disabled={!canAct} onClick={() => void memory.exportScope()}>
              Export…
            </button>
            <button type="button" disabled={!canAct} onClick={() => void memory.importScope()}>
              Import…
            </button>
            <button type="button" disabled={!canAct} onClick={() => void memory.clearScope()}>
              Clear scope
            </button>
          </div>
          <p className="workspace-hint">
            An imported file is untrusted: every record is validated, given a fresh identifier,
            labelled as imported, and anything that looks like a key, token or password is refused.
          </p>

          {draft !== null && (
            <div className="memory-editor">
              <h3>{editingId === null ? 'New memory' : 'Edit memory'}</h3>

              <div className="field">
                <label htmlFor="memory-content">What should be remembered?</label>
                <textarea
                  id="memory-content"
                  rows={4}
                  maxLength={MEMORY_CONTENT_MAX_LENGTH}
                  value={draft.content}
                  onChange={(event) => {
                    updateDraft({ content: event.target.value });
                  }}
                />
              </div>

              <div className="field">
                <label htmlFor="memory-category">Category</label>
                <select
                  id="memory-category"
                  value={draft.category}
                  onChange={(event) => {
                    updateDraft({
                      category: event.target.value as MemoryRecordInput['category'],
                    });
                  }}
                >
                  {MEMORY_CATEGORIES.map((category) => (
                    <option key={category} value={category}>
                      {category}
                    </option>
                  ))}
                </select>
              </div>

              <div className="memory-editor__row">
                <div className="field">
                  <label htmlFor="memory-importance">Importance</label>
                  <input
                    id="memory-importance"
                    type="number"
                    min={MEMORY_IMPORTANCE_MIN}
                    max={MEMORY_IMPORTANCE_MAX}
                    value={draft.importance}
                    onChange={(event) => {
                      updateDraft({ importance: Number(event.target.value) });
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor="memory-confidence">Confidence (%)</label>
                  <input
                    id="memory-confidence"
                    type="number"
                    min={MEMORY_CONFIDENCE_MIN}
                    max={MEMORY_CONFIDENCE_MAX}
                    value={draft.confidence}
                    onChange={(event) => {
                      updateDraft({ confidence: Number(event.target.value) });
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor="memory-expires">Expires (optional)</label>
                  <input
                    id="memory-expires"
                    type="date"
                    value={draft.expiresAt === null ? '' : isoDate(draft.expiresAt)}
                    onChange={(event) => {
                      const value = event.target.value;
                      updateDraft({
                        // A date input gives a day, not an instant. It is
                        // widened to the end of that day in UTC so a note set
                        // to expire "today" survives today.
                        expiresAt: value === '' ? null : `${value}T23:59:59.000Z`,
                      });
                    }}
                  />
                </div>
              </div>

              <label className="memory-editor__check">
                <input
                  type="checkbox"
                  checked={draft.pinned}
                  onChange={(event) => {
                    updateDraft({ pinned: event.target.checked });
                  }}
                />
                Pinned — always considered relevant
              </label>

              {draftIssues.length > 0 && (
                <ul className="agent-editor__issues" role="alert">
                  {draftIssues.map((issue) => (
                    <li key={issue}>{issue}</li>
                  ))}
                </ul>
              )}

              <div className="memory-card__actions">
                <button
                  type="button"
                  disabled={!canAct || draftIssues.length > 0}
                  onClick={() => void submitDraft()}
                >
                  {editingId === null ? 'Save memory' : 'Save changes'}
                </button>
                <button type="button" onClick={closeDraft}>
                  Cancel
                </button>
              </div>

              <p className="workspace-hint">
                Never put a key, token or password here. Local Agent screens for them and refuses
                what it recognises, but it cannot recognise everything — credentials belong in the
                encrypted key store.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
