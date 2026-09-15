/**
 * The renderer's one seam to workflows (Phase 2, Milestone 9).
 *
 * This is the only file under `src/renderer/workflow` permitted to reference
 * `window.localAgent` — `tests/unit/shared/chat-boundary-scan.test.ts`
 * asserts that no other file in this directory does, exactly as it already
 * does for the chat, workspace, agent and memory seams. Every other workflow
 * file in the renderer talks to this module, never to the bridge.
 *
 * **Nothing that crossed the boundary is trusted as text.** A failure yields
 * only the bounded `WorkflowErrorCode` enum; the sentence a user reads is
 * always one of `workflow-controller.ts`'s own reviewed strings, never
 * anything reconstructed from a main-process message.
 */

import type { WorkflowErrorCode } from '../../shared/workflow';
import { isWorkflowErrorCode } from '../../shared/workflow';
import type {
  Workflow,
  WorkflowInput,
  WorkflowProgressEvent,
  WorkflowRun,
} from '../../shared/schemas';

/**
 * Why a request did not produce a value.
 *
 * `'denied'` and `'declined'` are kept apart from every error code for the
 * reason every other client in this renderer keeps them apart: a refusal by
 * the permission engine and a refusal by the user are not failures of the
 * operation, and reporting either as an error would misinform.
 */
export type WorkflowFailure =
  | { readonly kind: 'denied' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'error'; readonly code: WorkflowErrorCode };

export type WorkflowResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly failure: WorkflowFailure };

interface OutcomeCarrier {
  readonly outcome: string;
  readonly errorCode?: string | undefined;
}

function failureFrom(response: OutcomeCarrier): WorkflowFailure {
  if (response.outcome === 'denied') return { kind: 'denied' };
  // `aborted` is what `execute` returns for a rejected confirmation.
  if (response.outcome === 'aborted') return { kind: 'declined' };
  const code = response.errorCode;
  return {
    kind: 'error',
    // An unrecognised code degrades to the generic run failure rather than
    // being shown, so a value that somehow bypassed the response schema still
    // cannot reach the interface as text.
    code: code !== undefined && isWorkflowErrorCode(code) ? code : 'WORKFLOW_RUN_FAILED',
  };
}

function unwrap<TValue>(
  response: OutcomeCarrier,
  value: TValue | undefined,
): WorkflowResult<TValue> {
  if (response.outcome === 'success' && value !== undefined) return { ok: true, value };
  return { ok: false, failure: failureFrom(response) };
}

/**
 * The typed operations `WorkflowController` depends on.
 *
 * An interface rather than a direct import so the controller can be tested
 * against a fake with no `window` at all — the same injection every other
 * renderer controller in this codebase uses.
 */
export interface WorkflowClient {
  list(): Promise<WorkflowResult<readonly Workflow[]>>;
  create(workflow: WorkflowInput): Promise<WorkflowResult<readonly Workflow[]>>;
  update(workflowId: string, workflow: WorkflowInput): Promise<WorkflowResult<readonly Workflow[]>>;
  duplicate(workflowId: string, newId: string): Promise<WorkflowResult<readonly Workflow[]>>;
  remove(workflowId: string): Promise<WorkflowResult<readonly Workflow[]>>;
  setEnabled(workflowId: string, enabled: boolean): Promise<WorkflowResult<readonly Workflow[]>>;
  /** Starts one manual run. Carries an objective, never a step or a tool. */
  run(runId: string, workflowId: string, objective: string): Promise<WorkflowResult<WorkflowRun>>;
  pause(runId: string): Promise<void>;
  cancel(runId: string): Promise<void>;
  onProgress(listener: (event: WorkflowProgressEvent) => void): () => void;
}

export function createIpcWorkflowClient(): WorkflowClient {
  return {
    async list() {
      const response = await window.localAgent.workflow.list();
      return unwrap(response, response.workflows);
    },
    async create(workflow) {
      const response = await window.localAgent.workflow.create(workflow);
      return unwrap(response, response.workflows);
    },
    async update(workflowId, workflow) {
      const response = await window.localAgent.workflow.update(workflowId, workflow);
      return unwrap(response, response.workflows);
    },
    async duplicate(workflowId, newId) {
      const response = await window.localAgent.workflow.duplicate(workflowId, newId);
      return unwrap(response, response.workflows);
    },
    async remove(workflowId) {
      const response = await window.localAgent.workflow.remove(workflowId);
      return unwrap(response, response.workflows);
    },
    async setEnabled(workflowId, enabled) {
      const response = await window.localAgent.workflow.setEnabled(workflowId, enabled);
      return unwrap(response, response.workflows);
    },
    async run(runId, workflowId, objective) {
      const response = await window.localAgent.workflow.run(runId, workflowId, objective);
      return unwrap(response, response.run);
    },
    async pause(runId) {
      await window.localAgent.workflow.pause(runId);
    },
    async cancel(runId) {
      await window.localAgent.workflow.cancel(runId);
    },
    onProgress(listener) {
      return window.localAgent.workflow.onProgress(listener);
    },
  };
}
