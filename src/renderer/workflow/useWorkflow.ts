/**
 * Thin React binding over `WorkflowController` (Phase 2, Milestone 9).
 *
 * Deliberately minimal, exactly like `chat/useConversation.ts`,
 * `workspace/useWorkspace.ts`, `agent/useAgent.ts` and `memory/useMemory.ts`:
 * this hook owns no workflow logic of its own. Everything observable here is
 * delegated to the controller, which is unit-tested directly in
 * `tests/unit/renderer/workflow-controller.test.ts` without React, jsdom, or
 * a filesystem.
 */

import { useEffect, useRef, useState } from 'react';

import { createIpcWorkflowClient, type WorkflowClient } from './ipc-workflow-client';
import { WorkflowController, type WorkflowState } from './workflow-controller';
import type { WorkflowInput } from '../../shared/schemas';

export interface UseWorkflowResult {
  readonly state: WorkflowState;
  /** True while no request is in flight. */
  readonly canAct: boolean;
  readonly refresh: () => Promise<void>;
  readonly createWorkflow: (workflow: WorkflowInput) => Promise<void>;
  readonly updateWorkflow: (workflowId: string, workflow: WorkflowInput) => Promise<void>;
  readonly duplicateWorkflow: (workflowId: string, newId: string) => Promise<void>;
  readonly deleteWorkflow: (workflowId: string) => Promise<void>;
  readonly setWorkflowEnabled: (workflowId: string, enabled: boolean) => Promise<void>;
  readonly startRun: (workflowId: string, objective: string) => Promise<void>;
  readonly pauseRun: () => Promise<void>;
  readonly cancelRun: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly dismissError: () => void;
}

/**
 * One controller for the component's whole lifetime, created via lazy
 * `useRef` initialisation rather than `useMemo` — React documents `useMemo`
 * as a performance optimisation, not a guarantee it runs exactly once, and
 * this controller carries live state, and a progress subscription, that a
 * remount must not discard silently.
 */
export function useWorkflow(client?: WorkflowClient): UseWorkflowResult {
  const controllerRef = useRef<WorkflowController | null>(null);
  controllerRef.current ??= new WorkflowController({
    client: client ?? createIpcWorkflowClient(),
  });
  const controller = controllerRef.current;

  const [state, setState] = useState<WorkflowState>(() => controller.getState());

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
    createWorkflow: (workflow: WorkflowInput) => controller.createWorkflow(workflow),
    updateWorkflow: (workflowId: string, workflow: WorkflowInput) =>
      controller.updateWorkflow(workflowId, workflow),
    duplicateWorkflow: (workflowId: string, newId: string) =>
      controller.duplicateWorkflow(workflowId, newId),
    deleteWorkflow: (workflowId: string) => controller.deleteWorkflow(workflowId),
    setWorkflowEnabled: (workflowId: string, enabled: boolean) =>
      controller.setWorkflowEnabled(workflowId, enabled),
    startRun: (workflowId: string, objective: string) => controller.startRun(workflowId, objective),
    pauseRun: () => controller.pauseRun(),
    cancelRun: () => controller.cancelRun(),
    retry: () => controller.retry(),
    dismissError: () => {
      controller.dismissError();
    },
  };
}
