/**
 * The renderer's one seam to agent profiles and runs (Phase 2, Milestone 7).
 *
 * This is the only file under `src/renderer/agent` permitted to reference
 * `window.localAgent` — `tests/unit/shared/chat-boundary-scan.test.ts`
 * asserts that no other file in this directory does, exactly as it already
 * does for `ipc-chat-provider.ts` and `ipc-workspace-client.ts`. Every other
 * agent file in the renderer talks to this module, never to the bridge.
 *
 * **Nothing that crossed the boundary is trusted as text.** A failure yields
 * only the bounded `AgentErrorCode` enum; the sentence a user reads is always
 * one of `agent-controller.ts`'s own reviewed strings, never anything
 * reconstructed from a main-process message.
 */

import type { AgentProfile, AgentProfileInput, AgentRun } from '../../shared/schemas';
import { isAgentErrorCode } from '../../shared/agent';
import type { AgentErrorCode } from '../../shared/agent';

/**
 * Why a request did not produce a value.
 *
 * `'denied'` and `'declined'` are kept apart from every error code for the
 * reason `ipc-workspace-client.ts` keeps them apart: a refusal by the
 * permission engine and a refusal by the user are not failures of the
 * operation, and reporting either as an error would misinform.
 */
export type AgentFailure =
  | { readonly kind: 'denied' }
  | { readonly kind: 'declined' }
  | { readonly kind: 'error'; readonly code: AgentErrorCode };

export type AgentResult<TValue> =
  | { readonly ok: true; readonly value: TValue }
  | { readonly ok: false; readonly failure: AgentFailure };

/** The registry as the interface holds it. */
export interface AgentRegistryView {
  readonly activeProfileId: string;
  readonly profiles: readonly AgentProfile[];
}

interface OutcomeCarrier {
  readonly outcome: string;
  readonly errorCode?: string | undefined;
}

function failureFrom(response: OutcomeCarrier): AgentFailure {
  if (response.outcome === 'denied') return { kind: 'denied' };
  // `aborted` is what `execute` returns for a rejected confirmation.
  if (response.outcome === 'aborted') return { kind: 'declined' };
  const code = response.errorCode;
  return {
    kind: 'error',
    // An unrecognised code degrades to the generic run failure rather than
    // being shown, so a value that somehow bypassed the response schema still
    // cannot reach the interface as text.
    code: code !== undefined && isAgentErrorCode(code) ? code : 'AGENT_RUN_FAILED',
  };
}

function unwrap<TValue>(response: OutcomeCarrier, value: TValue | undefined): AgentResult<TValue> {
  if (response.outcome === 'success' && value !== undefined) return { ok: true, value };
  return { ok: false, failure: failureFrom(response) };
}

/**
 * The typed operations `AgentController` depends on.
 *
 * An interface rather than a direct import so the controller can be tested
 * against a fake with no `window` at all — the same injection
 * `WorkspaceController` uses for its `WorkspaceClient`.
 */
export interface AgentClient {
  list(): Promise<AgentResult<AgentRegistryView>>;
  select(profileId: string): Promise<AgentResult<AgentRegistryView>>;
  create(profile: AgentProfileInput): Promise<AgentResult<AgentRegistryView>>;
  update(profileId: string, profile: AgentProfileInput): Promise<AgentResult<AgentRegistryView>>;
  remove(profileId: string): Promise<AgentResult<AgentRegistryView>>;
  setEnabled(profileId: string, enabled: boolean): Promise<AgentResult<AgentRegistryView>>;
  /** Starts one bounded run. Carries an objective, never a step or a tool. */
  run(runId: string, objective: string): Promise<AgentResult<AgentRun>>;
  cancel(runId: string): Promise<void>;
}

export function createIpcAgentClient(): AgentClient {
  return {
    async list() {
      const response = await window.localAgent.agent.list();
      return unwrap(response, response.registry);
    },
    async select(profileId: string) {
      const response = await window.localAgent.agent.select(profileId);
      return unwrap(response, response.registry);
    },
    async create(profile: AgentProfileInput) {
      const response = await window.localAgent.agent.create(profile);
      return unwrap(response, response.registry);
    },
    async update(profileId: string, profile: AgentProfileInput) {
      const response = await window.localAgent.agent.update(profileId, profile);
      return unwrap(response, response.registry);
    },
    async remove(profileId: string) {
      const response = await window.localAgent.agent.remove(profileId);
      return unwrap(response, response.registry);
    },
    async setEnabled(profileId: string, enabled: boolean) {
      const response = await window.localAgent.agent.setEnabled(profileId, enabled);
      return unwrap(response, response.registry);
    },
    async run(runId: string, objective: string) {
      const response = await window.localAgent.agent.run(runId, objective);
      return unwrap(response, response.run);
    },
    async cancel(runId: string) {
      await window.localAgent.agent.cancel(runId);
    },
  };
}
