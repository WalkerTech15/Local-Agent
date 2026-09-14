/**
 * Thin React binding over `AgentController` (Phase 2, Milestone 7).
 *
 * Deliberately minimal, exactly like `chat/useConversation.ts` and
 * `workspace/useWorkspace.ts`: this hook owns no agent logic of its own.
 * Everything observable here is delegated to the controller, which is
 * unit-tested directly in `tests/unit/renderer/agent-controller.test.ts`
 * without React, jsdom, or a filesystem.
 */

import { useEffect, useRef, useState } from 'react';

import { createIpcAgentClient, type AgentClient } from './ipc-agent-client';
import { AgentController, type AgentState } from './agent-controller';
import type { AgentProfileInput } from '../../shared/schemas';

export interface UseAgentResult {
  readonly state: AgentState;
  /** True while no request is in flight. */
  readonly canAct: boolean;
  readonly refresh: () => Promise<void>;
  readonly selectProfile: (profileId: string) => Promise<void>;
  readonly createProfile: (profile: AgentProfileInput) => Promise<void>;
  readonly updateProfile: (profileId: string, profile: AgentProfileInput) => Promise<void>;
  readonly deleteProfile: (profileId: string) => Promise<void>;
  readonly setProfileEnabled: (profileId: string, enabled: boolean) => Promise<void>;
  readonly startRun: (objective: string) => Promise<void>;
  readonly cancelRun: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly dismissError: () => void;
}

/**
 * One controller for the component's whole lifetime, created via lazy
 * `useRef` initialisation rather than `useMemo` — React documents `useMemo` as
 * a performance optimisation, not a guarantee it runs exactly once, and this
 * controller carries live state a remount must not discard.
 */
export function useAgent(client?: AgentClient): UseAgentResult {
  const controllerRef = useRef<AgentController | null>(null);
  controllerRef.current ??= new AgentController({ client: client ?? createIpcAgentClient() });
  const controller = controllerRef.current;

  const [state, setState] = useState<AgentState>(() => controller.getState());

  useEffect(() => {
    setState(controller.getState());
    const unsubscribe = controller.subscribe(setState);
    void controller.initialize();
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  return {
    state,
    // Derived from the same `state` this hook re-renders on, never read
    // imperatively from the controller, so it cannot lag a render behind what
    // is displayed.
    canAct: state.busy === null,
    refresh: () => controller.refresh(),
    selectProfile: (profileId: string) => controller.selectProfile(profileId),
    createProfile: (profile: AgentProfileInput) => controller.createProfile(profile),
    updateProfile: (profileId: string, profile: AgentProfileInput) =>
      controller.updateProfile(profileId, profile),
    deleteProfile: (profileId: string) => controller.deleteProfile(profileId),
    setProfileEnabled: (profileId: string, enabled: boolean) =>
      controller.setProfileEnabled(profileId, enabled),
    startRun: (objective: string) => controller.startRun(objective),
    cancelRun: () => controller.cancelRun(),
    retry: () => controller.retry(),
    dismissError: () => {
      controller.dismissError();
    },
  };
}
