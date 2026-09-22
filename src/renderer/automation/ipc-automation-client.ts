/**
 * The renderer's one seam to Windows automation (Phase 2, Milestone 10).
 *
 * This is the only file under `src/renderer/automation` permitted to
 * reference `window.localAgent` — `tests/unit/shared/chat-boundary-scan.test.ts`
 * asserts that no other file in this directory does, exactly as it already
 * does for the chat, workspace, agent, memory and workflow seams. Every other
 * automation file in the renderer talks to this module, never to the bridge.
 *
 * **Nothing that crossed the boundary is trusted as text.** A failure yields
 * only the bounded `AutomationErrorCode` enum; the sentence a user reads is
 * always one of `automation-controller.ts`'s own reviewed strings, never
 * anything reconstructed from a main-process message.
 */

import type { AutomationErrorCode } from '../../shared/automation';
import { isAutomationErrorCode } from '../../shared/automation';
import type { AutomationCatalog, AutomationRunResult } from '../../shared/schemas';

export type AutomationFailure =
  | { readonly kind: 'denied' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'error'; readonly code: AutomationErrorCode };

export type AutomationResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly failure: AutomationFailure };

interface OutcomeCarrier {
  readonly outcome: string;
  readonly errorCode?: string | undefined;
}

function failureFrom(response: OutcomeCarrier): AutomationFailure {
  if (response.outcome === 'denied') return { kind: 'denied' };
  // `aborted` is what `execute` returns for a rejected confirmation.
  if (response.outcome === 'aborted') return { kind: 'declined' };
  const code = response.errorCode;
  return {
    kind: 'error',
    code: code !== undefined && isAutomationErrorCode(code) ? code : 'AUTOMATION_RUN_FAILED',
  };
}

function unwrap<TValue>(
  response: OutcomeCarrier,
  value: TValue | undefined,
): AutomationResult<TValue> {
  if (response.outcome === 'success' && value !== undefined) return { ok: true, value };
  return { ok: false, failure: failureFrom(response) };
}

/**
 * The typed operations `AutomationController` depends on.
 *
 * An interface rather than a direct import so the controller can be tested
 * against a fake with no `window` at all — the same injection every other
 * renderer controller in this codebase uses.
 */
export interface AutomationClient {
  list(): Promise<AutomationResult<AutomationCatalog>>;
  /** Runs one registered tool. Carries an id, never a path, URL or argument. */
  run(runId: string, toolId: string): Promise<AutomationResult<AutomationRunResult>>;
  cancel(runId: string): Promise<void>;
}

export function createIpcAutomationClient(): AutomationClient {
  return {
    async list() {
      const response = await window.localAgent.automation.list();
      return unwrap(response, response.catalog);
    },
    async run(runId, toolId) {
      const response = await window.localAgent.automation.run(runId, toolId);
      return unwrap(response, response.run);
    },
    async cancel(runId) {
      await window.localAgent.automation.cancel(runId);
    },
  };
}
