/**
 * Thin React binding over `MemoryController` (Phase 2, Milestone 8).
 *
 * Deliberately minimal, exactly like `chat/useConversation.ts`,
 * `workspace/useWorkspace.ts` and `agent/useAgent.ts`: this hook owns no
 * memory logic of its own. Everything observable here is delegated to the
 * controller, which is unit-tested directly in
 * `tests/unit/renderer/memory-controller.test.ts` without React, jsdom, or a
 * filesystem.
 */

import { useEffect, useRef, useState } from 'react';

import { createIpcMemoryClient, type MemoryClient } from './ipc-memory-client';
import { MemoryController, type MemoryState } from './memory-controller';
import type { MemoryRecordInput, MemoryScopeValue } from '../../shared/schemas';

export interface UseMemoryResult {
  readonly state: MemoryState;
  /** True while no request is in flight. */
  readonly canAct: boolean;
  readonly setScope: (scope: MemoryScopeValue) => Promise<void>;
  readonly search: (query: string) => Promise<void>;
  readonly clearSearch: () => Promise<void>;
  readonly addMemory: (record: MemoryRecordInput) => Promise<void>;
  readonly updateMemory: (id: string, record: MemoryRecordInput) => Promise<void>;
  readonly setPinned: (id: string, pinned: boolean) => Promise<void>;
  readonly deleteMemory: (id: string) => Promise<void>;
  readonly clearScope: () => Promise<void>;
  readonly exportScope: () => Promise<void>;
  readonly importScope: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly dismissError: () => void;
}

/**
 * One controller for the component's whole lifetime, created via lazy
 * `useRef` initialisation rather than `useMemo` — React documents `useMemo`
 * as a performance optimisation, not a guarantee it runs exactly once, and
 * this controller carries live state a remount must not discard.
 */
export function useMemory(client?: MemoryClient): UseMemoryResult {
  const controllerRef = useRef<MemoryController | null>(null);
  controllerRef.current ??= new MemoryController({ client: client ?? createIpcMemoryClient() });
  const controller = controllerRef.current;

  const [state, setState] = useState<MemoryState>(() => controller.getState());

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
    setScope: (scope: MemoryScopeValue) => controller.setScope(scope),
    search: (query: string) => controller.search(query),
    clearSearch: () => controller.clearSearch(),
    addMemory: (record: MemoryRecordInput) => controller.addMemory(record),
    updateMemory: (id: string, record: MemoryRecordInput) => controller.updateMemory(id, record),
    setPinned: (id: string, pinned: boolean) => controller.setPinned(id, pinned),
    deleteMemory: (id: string) => controller.deleteMemory(id),
    clearScope: () => controller.clearScope(),
    exportScope: () => controller.exportScope(),
    importScope: () => controller.importScope(),
    refresh: () => controller.refresh(),
    retry: () => controller.retry(),
    dismissError: () => {
      controller.dismissError();
    },
  };
}
