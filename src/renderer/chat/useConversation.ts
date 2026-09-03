/**
 * Thin React binding over `ConversationController` (Phase 2, Milestone 1).
 *
 * Deliberately minimal: this hook owns no conversation logic of its own —
 * everything observable here is delegated to the controller, which is
 * unit-tested directly in `tests/unit/renderer/conversation-controller.test.ts`
 * without React. This hook exists only to subscribe a component to the
 * controller's state and to give it stable `submit`/`retry` callbacks.
 */

import { useEffect, useMemo, useState } from 'react';

import { ConversationController, type ConversationState } from './conversation-controller';
import type { ChatProvider } from '../../shared/chat';

export interface UseConversationResult {
  readonly state: ConversationState;
  readonly canSubmit: boolean;
  readonly submit: (content: string) => Promise<void>;
  readonly retry: () => Promise<void>;
}

/**
 * One controller instance per mounted provider identity. Passing a new
 * `provider` reference starts a fresh conversation — this milestone has
 * exactly one call site (`Chat.tsx`) and it never swaps providers at
 * runtime, so this is a deliberate simplicity choice, not an oversight.
 */
export function useConversation(provider: ChatProvider): UseConversationResult {
  const controller = useMemo(() => new ConversationController({ provider }), [provider]);
  const [state, setState] = useState<ConversationState>(() => controller.getState());

  useEffect(() => {
    setState(controller.getState());
    const unsubscribe = controller.subscribe(setState);
    return () => {
      unsubscribe();
      controller.dispose();
    };
  }, [controller]);

  return {
    state,
    // Derived from the same `state` this hook re-renders on, not read
    // imperatively from the controller, so it can never lag one render
    // behind what is displayed.
    canSubmit: state.status === 'idle',
    submit: (content: string) => controller.submit(content),
    retry: () => controller.retry(),
  };
}
