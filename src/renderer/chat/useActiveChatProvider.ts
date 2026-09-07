/**
 * Resolves the active `ChatProvider` and its display status (Phase 2,
 * Milestones 2-3).
 *
 * This is the one, explicit place that decides which adapter powers chat —
 * `Chat.tsx` imports neither `createMockChatProvider` nor
 * `createIpcChatProvider` itself. The decision is
 * `getChatProviderCapabilities(modelProvider.provider).implemented`: `true`
 * only for `openai-compatible` since Milestone 3 (a real, network-capable
 * adapter exists for it in `src/main`, reached through `chat:send`), still
 * `false` for `none`, `glm` and `ollama` — those keep talking to the
 * deterministic mock, exactly as every identifier did in Milestone 2. See
 * `docs/phase-2-provider-architecture.md` and
 * `docs/phase-2-real-provider-architecture.md`.
 *
 * Both provider instances are stable for the component's lifetime (`useRef`,
 * not re-created per render), independent of `status`, which does change
 * with `modelProvider` — so a settings change never itself resets the
 * conversation, even before `ConversationController.setProvider`'s own
 * same-reference no-op guard is considered. Switching between the mock and
 * the real adapter goes through that same `setProvider` path as switching
 * between two mock instances would — no special case.
 */

import { useRef } from 'react';

import { createIpcChatProvider } from './ipc-chat-provider';
import {
  createMockChatProvider,
  describeChatProviderStatus,
  getChatProviderCapabilities,
  type ChatProvider,
  type ChatProviderStatus,
} from '../../shared/chat';
import type { ModelProviderSettings } from '../../shared/schemas';

export interface ActiveChatProvider {
  readonly provider: ChatProvider;
  readonly status: ChatProviderStatus;
}

export function useActiveChatProvider(modelProvider: ModelProviderSettings): ActiveChatProvider {
  const mockProviderRef = useRef<ChatProvider | null>(null);
  mockProviderRef.current ??= createMockChatProvider();

  const ipcProviderRef = useRef<ChatProvider | null>(null);
  ipcProviderRef.current ??= createIpcChatProvider();

  const capabilities = getChatProviderCapabilities(modelProvider.provider);

  return {
    provider: capabilities.implemented ? ipcProviderRef.current : mockProviderRef.current,
    status: describeChatProviderStatus(modelProvider),
  };
}
