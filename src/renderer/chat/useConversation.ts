/**
 * Thin React binding over `ConversationController` (Phase 2, Milestones 1–2).
 *
 * Deliberately minimal: this hook owns no conversation logic of its own —
 * everything observable here is delegated to the controller, which is
 * unit-tested directly in `tests/unit/renderer/conversation-controller.test.ts`
 * without React. This hook exists only to subscribe a component to the
 * controller's state and to give it stable `submit`/`retry` callbacks.
 */

import { useEffect, useRef, useState } from 'react';

import { ConversationController, type ConversationState } from './conversation-controller';
import type { ChatProvider } from '../../shared/chat';

export interface UseConversationResult {
  readonly state: ConversationState;
  readonly canSubmit: boolean;
  readonly submit: (content: string) => Promise<void>;
  readonly retry: () => Promise<void>;
}

/**
 * One controller instance for the component's whole lifetime, created via
 * lazy `useRef` initialisation rather than `useMemo` — `useMemo` is
 * documented by React as a performance optimisation only, not a correctness
 * guarantee that it runs exactly once, which matters here because the
 * controller carries live conversation state a remount must not discard.
 *
 * A new `provider` reference on a later render does **not** replace the
 * controller (and so does not lose the conversation) — it is forwarded to
 * the existing controller's `setProvider`, per
 * `docs/phase-2-provider-architecture.md`'s "switching provider does not
 * lose conversation state" requirement.
 */
export function useConversation(provider: ChatProvider): UseConversationResult {
  const controllerRef = useRef<ConversationController | null>(null);
  controllerRef.current ??= new ConversationController({ provider });
  const controller = controllerRef.current;

  useEffect(() => {
    controller.setProvider(provider);
  }, [controller, provider]);

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
