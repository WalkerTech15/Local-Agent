/**
 * Resolves the active `ChatProvider` and its display status (Phase 2,
 * Milestone 2).
 *
 * This is the one, explicit place that decides which adapter powers chat —
 * `Chat.tsx` no longer imports `createMockChatProvider` itself. In this
 * milestone the answer is always the deterministic mock, for every one of
 * the four approved `ModelProvider` selections, because it is the only
 * adapter that actually works: `createChatProviderForSelection` (the
 * registry) returns a fail-closed placeholder for all four, by design — see
 * `docs/phase-2-provider-architecture.md` for why chat still functions
 * through the mock rather than going inert whenever no provider is
 * configured, while `describeChatProviderStatus` still reports honestly on
 * what the user actually selected.
 *
 * The provider instance is stable for the component's lifetime (`useRef`,
 * not re-created per render), independent of `status`, which does change
 * with `modelProvider.provider` — so a settings change never itself resets
 * the conversation, even before `ConversationController.setProvider`'s own
 * same-reference no-op guard is considered.
 */

import { useRef } from 'react';

import {
  createMockChatProvider,
  describeChatProviderStatus,
  type ChatProvider,
  type ChatProviderStatus,
} from '../../shared/chat';
import type { ModelProviderSettings } from '../../shared/schemas';

export interface ActiveChatProvider {
  readonly provider: ChatProvider;
  readonly status: ChatProviderStatus;
}

export function useActiveChatProvider(modelProvider: ModelProviderSettings): ActiveChatProvider {
  const providerRef = useRef<ChatProvider | null>(null);
  providerRef.current ??= createMockChatProvider();

  return {
    provider: providerRef.current,
    status: describeChatProviderStatus(modelProvider.provider),
  };
}
