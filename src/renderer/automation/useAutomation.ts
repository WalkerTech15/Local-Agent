/**
 * Thin React binding over `AutomationController` (Phase 2, Milestone 10).
 *
 * Deliberately minimal, exactly like `workflow/useWorkflow.ts`: this hook
 * owns no automation logic of its own. Everything observable here is
 * delegated to the controller, which is unit-tested directly in
 * `tests/unit/renderer/automation-controller.test.ts` without React, jsdom,
 * or a filesystem.
 */

import { useEffect, useRef, useState } from 'react';

import { AutomationController, type AutomationState } from './automation-controller';
import { createIpcAutomationClient, type AutomationClient } from './ipc-automation-client';

export interface UseAutomationResult {
  readonly state: AutomationState;
  /** True while no request is in flight. */
  readonly canAct: boolean;
  readonly refresh: () => Promise<void>;
  readonly runTool: (toolId: string) => Promise<void>;
  readonly cancelRun: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly dismissError: () => void;
}

export function useAutomation(client?: AutomationClient): UseAutomationResult {
  const controllerRef = useRef<AutomationController | null>(null);
  controllerRef.current ??= new AutomationController({
    client: client ?? createIpcAutomationClient(),
  });
  const controller = controllerRef.current;

  const [state, setState] = useState<AutomationState>(() => controller.getState());

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
    canAct: state.busy === null,
    refresh: () => controller.refresh(),
    runTool: (toolId: string) => controller.runTool(toolId),
    cancelRun: () => controller.cancelRun(),
    retry: () => controller.retry(),
    dismissError: () => {
      controller.dismissError();
    },
  };
}
