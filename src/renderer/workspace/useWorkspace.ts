/**
 * Thin React binding over `WorkspaceController` (Phase 2, Milestone 5).
 *
 * Deliberately minimal, exactly like `chat/useConversation.ts`: this hook
 * owns no workspace logic of its own. Everything observable here is
 * delegated to the controller, which is unit-tested directly in
 * `tests/unit/renderer/workspace-controller.test.ts` without React, jsdom, or
 * a filesystem.
 */

import { useEffect, useRef, useState } from 'react';

import { createIpcWorkspaceClient, type WorkspaceClient } from './ipc-workspace-client';
import { WorkspaceController, type WorkspaceState } from './workspace-controller';

export interface UseWorkspaceResult {
  readonly state: WorkspaceState;
  /** True while no request is in flight. */
  readonly canAct: boolean;
  readonly selectProject: () => Promise<void>;
  readonly refreshTree: (path: string) => Promise<void>;
  readonly openFile: (path: string) => Promise<void>;
  readonly search: (query: string) => Promise<void>;
  readonly createPlan: (objective: string) => Promise<void>;
  readonly approvePlan: () => void;
  readonly retry: () => Promise<void>;
  readonly dismissError: () => void;
}

/**
 * One controller for the component's whole lifetime, created via lazy
 * `useRef` initialisation rather than `useMemo` — React documents `useMemo`
 * as a performance optimisation, not a guarantee it runs exactly once, and
 * this controller carries live state a remount must not discard.
 *
 * `client` is injectable purely so a future test or a Storybook-style harness
 * can supply a fake; the application always uses the real IPC client.
 */
export function useWorkspace(client?: WorkspaceClient): UseWorkspaceResult {
  const controllerRef = useRef<WorkspaceController | null>(null);
  controllerRef.current ??= new WorkspaceController({
    client: client ?? createIpcWorkspaceClient(),
  });
  const controller = controllerRef.current;

  const [state, setState] = useState<WorkspaceState>(() => controller.getState());

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
    // imperatively from the controller, so it cannot lag a render behind
    // what is displayed.
    canAct: state.busy === null,
    selectProject: () => controller.selectProject(),
    refreshTree: (path: string) => controller.refreshTree(path),
    openFile: (path: string) => controller.openFile(path),
    search: (query: string) => controller.search(query),
    createPlan: (objective: string) => controller.createPlan(objective),
    approvePlan: () => {
      controller.approvePlan();
    },
    retry: () => controller.retry(),
    dismissError: () => {
      controller.dismissError();
    },
  };
}
