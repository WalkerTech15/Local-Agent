/**
 * Barrel for the chat provider layer (Phase 2, Milestones 1–2).
 *
 * Everything exported here is pure, has no Electron or Node dependency, and
 * makes no network request — see `provider.ts`, `mock-provider.ts`,
 * `registry.ts` and `timeout.ts` for why that is enforced structurally, not
 * only by convention.
 */

export { CHAT_PROVIDER_ERROR_CODES, ChatProviderError } from './provider';
export type {
  ChatProvider,
  ChatProviderErrorCode,
  ChatProviderRequest,
  ChatProviderRequestOptions,
  ChatProviderResult,
} from './provider';

export { createMockChatProvider, MOCK_CHAT_PROVIDER_DEFAULT_DELAY_MS } from './mock-provider';
export type { CreateMockChatProviderOptions } from './mock-provider';

export {
  createChatProviderForSelection,
  describeChatProviderStatus,
  getChatProviderCapabilities,
} from './registry';
export type {
  ChatProviderAvailability,
  ChatProviderCapabilities,
  ChatProviderStatus,
  ChatProviderStatusInput,
} from './registry';

export { withProviderTimeout } from './timeout';
