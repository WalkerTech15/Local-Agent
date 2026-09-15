/**
 * Workflow storage (Phase 2, Milestone 9).
 *
 * Reads and writes `workflows/workflows.json`. It mirrors
 * `main/agent-profiles.ts` deliberately and in detail, because a workflow
 * file is the same *kind* of thing a profile file is: user-editable
 * configuration that shapes what the application will later do.
 *
 * The properties carried over:
 *
 *  - **Loading never throws and never merges.** A missing file, an unreadable
 *    one, an oversized one, malformed JSON, a `__proto__` key anywhere in it,
 *    or a document the schema rejects all resolve the same way: an empty
 *    store. A document either validates in full, as itself, or it is
 *    discarded in full. There is no partial-trust path, so a file with nine
 *    good workflows and one malformed one yields none of them rather than
 *    nine.
 *  - **Writing is atomic and re-validated.** The document is checked against
 *    the schema immediately before serialising, written to a uniquely named
 *    temporary file in the same directory, flushed, and moved into place with
 *    a single rename — so a crash or a concurrent write leaves either the
 *    previous complete document or the new one, never a partial write.
 *  - **User data is preserved across every operation.** Each mutation reads
 *    the current store, changes exactly the one workflow it names, and writes
 *    the whole document back. No operation regenerates the list.
 *
 * And one rule of its own:
 *
 *  - **A workflow with a run in flight is not editable.** Every mutation is
 *    given a predicate that says whether the workflow is currently executing,
 *    and refuses if it is. The predicate is supplied by `main/ipc.ts`, which
 *    owns the in-flight run map and is the only thing that knows what is
 *    actually running.
 *
 * Every function takes a plain file path rather than a `UserDataPaths`, for
 * the reason `loadSettings` does: a test points at a temporary directory and
 * configures nothing else.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { FORBIDDEN_OBJECT_KEYS, WORKFLOW_MAX_WORKFLOWS } from '../shared/constants';
import { WORKFLOW_STORE_MAX_BYTES } from '../shared/constants';
import { WorkflowError } from '../shared/workflow/errors';
import {
  createEmptyWorkflowStore,
  workflowSchema,
  workflowStoreSchema,
} from '../shared/schemas/workflow.schema';
import type { Workflow, WorkflowInput, WorkflowStore } from '../shared/schemas/workflow.schema';

/**
 * Mirrors the copies in `main/policy.ts`, `main/agent-profiles.ts` and
 * `main/memory-store.ts` exactly, including the reasoning: `JSON.parse` does
 * not fall for a literal `__proto__` key, but nothing downstream of this
 * loader is allowed to assume that. A fifth independent copy rather than a
 * shared import, so this module gains no runtime dependency on an
 * already-reviewed module from an earlier milestone for one small,
 * self-contained, pure check.
 */
const MAX_WORKFLOW_JSON_DEPTH = 64;

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_WORKFLOW_JSON_DEPTH) return true;
  if (value === null || typeof value !== 'object') return false;

  if (Array.isArray(value)) {
    return value.some((element) => containsForbiddenKey(element, depth + 1));
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_OBJECT_KEYS.includes(key)) return true;
    if (containsForbiddenKey(record[key], depth + 1)) return true;
  }
  return false;
}

/**
 * A destination-file rename can transiently fail on Windows when something
 * else briefly holds the destination open. The same sharing-violation retry
 * `main/settings.ts` performs, and for the same reason: each attempt is one
 * whole-file rename, so retrying risks a delayed write, never a partial one.
 */
const RENAME_MAX_ATTEMPTS = 10;
const RENAME_RETRY_DELAY_MS = 20;

function isTransientRenameError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const { code } = error;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt === RENAME_MAX_ATTEMPTS || !isTransientRenameError(error)) throw error;
      await delay(RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}

/**
 * Loads `storeFile`, failing safe on every problem.
 *
 * Never throws, and never creates a file. A first launch is indistinguishable,
 * by design, from a corrupted one: both return an empty store, which is the
 * most restricted state rather than the most convenient one.
 *
 * The size check happens before the read, not after: a file that grew without
 * bound should not be pulled into memory to discover that it is too large.
 */
export async function loadWorkflowStore(storeFile: string): Promise<WorkflowStore> {
  try {
    const stats = await stat(storeFile);
    if (stats.size > WORKFLOW_STORE_MAX_BYTES) return createEmptyWorkflowStore();
  } catch {
    // Missing file (first launch) and any other stat failure fail the same
    // way as an unreadable one. Neither the error nor the path is surfaced.
    return createEmptyWorkflowStore();
  }

  let raw: string;
  try {
    raw = await readFile(storeFile, 'utf8');
  } catch {
    return createEmptyWorkflowStore();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return createEmptyWorkflowStore();
  }

  if (containsForbiddenKey(parsed)) return createEmptyWorkflowStore();

  const result = workflowStoreSchema.safeParse(parsed);
  if (!result.success) return createEmptyWorkflowStore();

  return result.data;
}

/**
 * Writes `store` to `storeFile` atomically.
 *
 * Re-validated against the schema immediately before serialising, so a caller
 * cannot persist a document that only *claims* the type at compile time —
 * which matters here because the value being persisted describes what a run
 * will later reach for.
 */
export async function writeWorkflowStore(storeFile: string, store: WorkflowStore): Promise<void> {
  const validated = workflowStoreSchema.parse(store);
  const payload = JSON.stringify(validated, null, 2);

  const dir = dirname(storeFile);
  await mkdir(dir, { recursive: true });

  const tempFile = join(dir, `${basename(storeFile)}.${randomUUID()}.tmp`);

  try {
    const handle = await open(tempFile, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await renameWithRetry(tempFile, storeFile);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** The workflow with that id, or `null`. */
export function findWorkflow(workflows: readonly Workflow[], id: string): Workflow | null {
  return workflows.find((workflow) => workflow.id === id) ?? null;
}

/** Every stored workflow, in the order they were written. */
export async function readWorkflows(storeFile: string): Promise<readonly Workflow[]> {
  return (await loadWorkflowStore(storeFile)).workflows;
}

/** Reads one workflow, or throws the normalized "not found" error. */
export async function requireWorkflow(storeFile: string, id: string): Promise<Workflow> {
  const existing = findWorkflow(await readWorkflows(storeFile), id);
  if (existing === null) throw new WorkflowError('WORKFLOW_NOT_FOUND');
  return existing;
}

/**
 * Persists a changed store and answers with the workflows as written.
 *
 * The list comes from the document that was *written*, not from the caller's
 * in-memory idea of it, so the answer reflects what the next load will see.
 */
async function commit(storeFile: string, store: WorkflowStore): Promise<readonly Workflow[]> {
  try {
    await writeWorkflowStore(storeFile, store);
  } catch {
    // The underlying error never crosses a boundary; the caller gets the
    // normalized code and the store on disk is unchanged.
    throw new WorkflowError('WORKFLOW_STORE_FAILED');
  }
  return store.workflows;
}

/**
 * Whether a workflow is executing right now.
 *
 * Supplied by `main/ipc.ts` from the in-flight run map. Every mutation below
 * consults it, which is how "do not delete the active workflow during
 * execution" is enforced against what is actually running rather than
 * against a flag on disk that a crash could leave stale.
 */
export type IsWorkflowRunning = (workflowId: string) => boolean;

function requireNotRunning(id: string, isRunning: IsWorkflowRunning): void {
  if (isRunning(id)) throw new WorkflowError('WORKFLOW_RUNNING');
}

/**
 * Adds a workflow.
 *
 * `createdAt` and `updatedAt` are supplied here, never by the caller —
 * `workflowInputSchema` has no field for either.
 */
export async function createWorkflow(
  storeFile: string,
  input: WorkflowInput,
  now: string,
): Promise<readonly Workflow[]> {
  const store = await loadWorkflowStore(storeFile);

  if (findWorkflow(store.workflows, input.id) !== null) {
    throw new WorkflowError('WORKFLOW_EXISTS');
  }
  if (store.workflows.length >= WORKFLOW_MAX_WORKFLOWS) {
    throw new WorkflowError('WORKFLOW_LIMIT_REACHED');
  }

  const workflow = workflowSchema.safeParse({ ...input, createdAt: now, updatedAt: now });
  if (!workflow.success) throw new WorkflowError('WORKFLOW_INVALID');

  return commit(storeFile, { ...store, workflows: [...store.workflows, workflow.data] });
}

/**
 * Replaces a workflow in place.
 *
 * `createdAt` is carried over from the existing definition rather than taken
 * from the request, so an update cannot rewrite when a workflow was created.
 * The submitted id must match the addressed one — a mismatch is a refusal,
 * not a rename.
 */
export async function updateWorkflow(
  storeFile: string,
  workflowId: string,
  input: WorkflowInput,
  now: string,
  isRunning: IsWorkflowRunning,
): Promise<readonly Workflow[]> {
  requireNotRunning(workflowId, isRunning);

  const store = await loadWorkflowStore(storeFile);
  const existing = findWorkflow(store.workflows, workflowId);
  if (existing === null) throw new WorkflowError('WORKFLOW_NOT_FOUND');
  if (input.id !== workflowId) throw new WorkflowError('WORKFLOW_INVALID');

  const workflow = workflowSchema.safeParse({
    ...input,
    createdAt: existing.createdAt,
    updatedAt: now,
  });
  if (!workflow.success) throw new WorkflowError('WORKFLOW_INVALID');

  return commit(storeFile, {
    ...store,
    workflows: store.workflows.map((entry) => (entry.id === workflowId ? workflow.data : entry)),
  });
}

/**
 * Copies a workflow under a new id.
 *
 * The copy is created **disabled**, whatever the original was. A duplicate is
 * a starting point someone is about to edit, and a runnable copy of a
 * workflow appearing the moment it is duplicated is a surprise in the
 * permissive direction.
 */
export async function duplicateWorkflow(
  storeFile: string,
  workflowId: string,
  newId: string,
  now: string,
): Promise<readonly Workflow[]> {
  const store = await loadWorkflowStore(storeFile);
  const existing = findWorkflow(store.workflows, workflowId);
  if (existing === null) throw new WorkflowError('WORKFLOW_NOT_FOUND');
  if (findWorkflow(store.workflows, newId) !== null) throw new WorkflowError('WORKFLOW_EXISTS');
  if (store.workflows.length >= WORKFLOW_MAX_WORKFLOWS) {
    throw new WorkflowError('WORKFLOW_LIMIT_REACHED');
  }

  const copy = workflowSchema.safeParse({
    ...existing,
    id: newId,
    enabled: false,
    createdAt: now,
    updatedAt: now,
  });
  if (!copy.success) throw new WorkflowError('WORKFLOW_INVALID');

  return commit(storeFile, { ...store, workflows: [...store.workflows, copy.data] });
}

/**
 * Removes a workflow.
 *
 * Refused while a run of it is in flight — the milestone's "do not delete the
 * active workflow during execution" rule. The run re-reads the definition
 * between steps, so deleting one mid-run would leave the runner unable to
 * describe what it was doing.
 */
export async function deleteWorkflow(
  storeFile: string,
  workflowId: string,
  isRunning: IsWorkflowRunning,
): Promise<readonly Workflow[]> {
  requireNotRunning(workflowId, isRunning);

  const store = await loadWorkflowStore(storeFile);
  if (findWorkflow(store.workflows, workflowId) === null) {
    throw new WorkflowError('WORKFLOW_NOT_FOUND');
  }

  return commit(storeFile, {
    ...store,
    workflows: store.workflows.filter((entry) => entry.id !== workflowId),
  });
}

/**
 * Enables or disables a workflow.
 *
 * Disabling one **while it runs** is deliberately permitted: the runner
 * re-reads the definition between steps, so this is how someone stops a run
 * without cancelling it outright, and the run ends with `workflow-disabled`.
 * Editing and deleting stay refused, because those change what the run is
 * executing rather than only whether it may continue.
 */
export async function setWorkflowEnabled(
  storeFile: string,
  workflowId: string,
  enabled: boolean,
  now: string,
): Promise<readonly Workflow[]> {
  const store = await loadWorkflowStore(storeFile);
  const existing = findWorkflow(store.workflows, workflowId);
  if (existing === null) throw new WorkflowError('WORKFLOW_NOT_FOUND');

  const updated: Workflow = { ...existing, enabled, updatedAt: now };
  return commit(storeFile, {
    ...store,
    workflows: store.workflows.map((entry) => (entry.id === workflowId ? updated : entry)),
  });
}
