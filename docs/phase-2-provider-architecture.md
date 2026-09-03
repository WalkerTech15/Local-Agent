# Phase 2 provider architecture

> **Current state.** Phase 2, Milestone 2 implements the **provider-adapter
> foundation**: a registry, bounded request/response schemas, an expanded
> normalized error vocabulary, a composable timeout decorator, and explicit
> provider selection with safe status display. It builds directly on
> [docs/phase-2-chat-architecture.md](phase-2-chat-architecture.md)'s message
> model and `ConversationController`, both unchanged in shape. **No real
> provider is implemented. No network request is made anywhere in this
> milestone, in tests or in normal execution.**

---

## Summary

| Property                                                            | State                                                                            |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Provider request/response schemas                                   | **[implemented]** — `chatProviderRequestSchema`, `chatProviderResultSchema`      |
| Provider capability metadata                                        | **[implemented]** — `getChatProviderCapabilities`                                |
| Approved-provider registry                                          | **[implemented]** — `createChatProviderForSelection`, fails closed               |
| Timeout decorator                                                   | **[implemented]** — `withProviderTimeout`, composable, provider-neutral          |
| Real GLM / OpenAI-compatible / Ollama network adapters              | **[deferred]** — no HTTP client, no SDK, no network call exists in this codebase |
| API-key retrieval for a provider call                               | **[deferred]** — no provider adapter imports `main/secrets.ts` or settings       |
| Model output treated as authorization                               | **Never.** No mechanism exists by which it could be                              |
| Disapproved identifiers (`anthropic`, `openai`, `claude`, `gemini`) | **Absent.** Not referenced anywhere in source (verified by scan — see Testing)   |

---

## Why `none` and every real identifier still power a working chat

This is the one genuinely ambiguous design decision in this milestone, so it
is stated explicitly rather than left implicit.

The task's registry requirement reads: _"`none` must always produce a safe
'provider unavailable/not configured' result."_ Taken completely literally,
asking the registry to actually `send()` through `none` — or through `glm`,
`openai-compatible`, or `ollama`, none of which has a real implementation
either — **must** fail closed. `createChatProviderForSelection` does exactly
that for all four approved identifiers: every one of them rejects with
`ChatProviderError('PROVIDER_UNAVAILABLE', …)`, unconditionally, verified by
`tests/unit/shared/chat-registry.test.ts`.

Separately, the milestone's scope explicitly includes "mock provider
integration with the existing chat system" and requires the chat UI to
"show mock/not-configured state clearly" — implying chat keeps functioning,
not that it goes inert for the default, unconfigured case every fresh
install starts in.

**Resolution:** these are two different questions, answered by two different
functions, deliberately kept apart:

- `createChatProviderForSelection(id)` (`src/shared/chat/registry.ts`)
  answers _"what happens if you literally invoke the provider the user
  selected?"_ — and fails closed for all four, honestly, with no silent
  substitution.
- `useActiveChatProvider` (`src/renderer/chat/useActiveChatProvider.ts`)
  answers _"what does the chat UI actually talk to right now?"_ — and, since
  no real adapter exists for any selection in this phase, that is always the
  deterministic mock, paired with `describeChatProviderStatus(selected)`'s
  honest, safe status text ("GLM is selected but not connected yet. Chat is
  running on the local mock provider.").

Nothing conflates the two: the mock's own replies are always prefixed
`[Mock provider]` (Milestone 1), and the status line never claims a
connection that does not exist. A future milestone adding a real adapter
changes `useActiveChatProvider` to prefer it once `getChatProviderCapabilities(id).implemented`
is `true`, and changes nothing about `ConversationController` or `Chat.tsx`.

If this reading turns out not to match what was intended, the fix is
narrow: change `useActiveChatProvider`'s single call to
`createChatProviderForSelection` instead of always constructing the mock. That
one function is the entire seam.

---

## Provider request/response schemas

`src/shared/schemas/chat.schema.ts` adds two schemas, validated at the exact
point a conversation crosses into a provider and the exact point a raw
result crosses back — a stricter, independent boundary layered on top of
Milestone 1's per-message validation, not a replacement for it:

- **`chatProviderRequestSchema`** — `{ messages: ChatMessage[] }`, the array
  bounded to `CHAT_CONVERSATION_MAX_MESSAGES`. Before this milestone, that
  bound was enforced only by `ConversationController.submit()`'s own runtime
  `if` check; it is now also a schema-level invariant re-checked at the
  provider boundary. `strictObject` rejects any extra field (a stray
  `apiKey`, say) outright.
- **`chatProviderResultSchema`** — `{ content: string }`, using the same
  bounded, control-character- and bidi-safe string schema a message's own
  `content` uses (factored into a shared `chatContentSchema`). `strictObject`
  means a provider cannot smuggle extra data — a confidence score, a raw
  upstream error object — past this boundary; only `content` is accepted.

`ConversationController.requestAssistantReply` runs both: the request is
validated immediately before `provider.send()` is called, and the raw result
is validated immediately after it resolves, before any of it is trusted
enough to become a `ChatMessage`. Either failing is treated exactly like any
other provider failure — caught, turned into safe conversation-level error
state, prior messages untouched.

---

## Normalized provider errors

`src/shared/chat/provider.ts`'s `CHAT_PROVIDER_ERROR_CODES` now covers the
five categories the milestone requires be distinguishable:

| Code                             | Meaning                                                             | Produced by                                                                 |
| -------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `PROVIDER_UNAVAILABLE`           | Not configured, or configured but not implemented yet               | Every entry in the registry (`registry.ts`)                                 |
| `PROVIDER_INVALID_CONFIGURATION` | Configured but unusable (e.g. a real HTTP adapter with no base URL) | Declared for a future real adapter; nothing constructs it in this milestone |
| `PROVIDER_TIMEOUT`               | Did not settle within a caller's configured budget                  | `withProviderTimeout` (`timeout.ts`)                                        |
| `PROVIDER_ABORTED`               | Cancelled via `AbortSignal`                                         | The mock provider; `withProviderTimeout` forwarding an external abort       |
| `PROVIDER_REQUEST_FAILED`        | A generic failure fitting none of the above                         | The mock provider's deliberate failure trigger                              |

Every code is a `ChatProviderError` with a stable `.code` a caller can branch
on and a safe, fixed `.message` — never a raw provider error, a URL, a
header, or a credential. `ConversationController`'s `describeProviderFailure`
still never forwards a raw `Error.message` to the UI regardless of code,
matching Milestone 1's rule that a thrown error is exactly as untrusted as a
returned reply.

---

## Provider capability metadata

`getChatProviderCapabilities(id)` (`registry.ts`) returns, for each of the
four approved identifiers:

```ts
interface ChatProviderCapabilities {
  readonly id: ModelProvider;
  readonly label: string; // safe to show in the UI
  readonly requiresApiKey: boolean; // derived from PROVIDERS_REQUIRING_API_KEY
  readonly implemented: boolean; // always false in Phase 2
}
```

`requiresApiKey` is **derived** from the same `PROVIDERS_REQUIRING_API_KEY`
constant `main/settings-service.ts`'s `hasApiKey` reconciliation already
uses, not a second hand-maintained table that could silently drift from it.
Nothing in this structure, or in `ChatProviderStatus`'s `summary` text built
from it, ever carries a key, a header, a URL, or `hasApiKey` itself — every
field is either a fixed label or a boolean, verified by
`tests/unit/shared/chat-registry.test.ts`.

---

## Timeout decorator

`src/shared/chat/timeout.ts`'s `withProviderTimeout(provider, timeoutMs)`
wraps any `ChatProvider` so a request that does not settle within
`timeoutMs` is aborted and rejected with `PROVIDER_TIMEOUT`, instead of
hanging indefinitely. Composable and provider-neutral — it will wrap a real
adapter identically to the mock, once one exists, without either
implementation writing its own timer.

Design notes:

- Timeout is **not** a field on `ChatProviderRequestOptions`. Every provider
  already accepts a `signal`; a caller wanting a timeout composes this
  decorator once rather than every adapter reimplementing a timer and every
  call site remembering to pass a budget.
- A single fresh `AbortController` is created per call and passed to the
  wrapped provider — never the caller's own signal directly — so the
  decorator can distinguish its own timer firing from an external
  cancellation via `AbortSignal.abort(reason)`'s `reason`, forwarding the
  external signal's `reason` (or nothing) when relaying an outside abort, and
  a private `Symbol` sentinel for its own timer.
- **An already-aborted external signal is rejected immediately**, before the
  wrapped provider's `send()` is ever called — deliberately not relying on
  every future provider implementation correctly checking `signal.aborted`
  up front the way the mock happens to (see `mock-provider.ts`'s `delay()`).
  This was a real gap found while testing: an early version of the decorator
  depended on the wrapped provider's own abort-event handling to notice a
  pre-aborted signal, which a test provider that only listened for the
  `'abort'` _event_ (rather than also checking `.aborted` synchronously)
  never fired for, hanging the test. Fixed by short-circuiting in the
  decorator itself, which is correct regardless of how any given wrapped
  provider behaves.

Not wired into `useActiveChatProvider`'s default path in this milestone —
the mock resolves in well under a second and has no need of one. The
decorator exists, is real, and is fully tested
(`tests/unit/shared/provider-timeout.test.ts`), ready for whichever future
adapter needs it.

---

## Provider registry and selection

`src/shared/chat/registry.ts`:

- **`getChatProviderCapabilities(id)`** — safe metadata, above.
- **`describeChatProviderStatus(selected)`** — `not-configured` for `none`,
  `not-implemented` for the other three, each with a fixed, safe summary
  string. Never takes free-text input, so its output space is exactly four
  known, reviewed strings.
- **`createChatProviderForSelection(id)`** — fails closed for all four
  approved identifiers and for anything outside `MODEL_PROVIDERS`
  (`anthropic`, `openai`, `claude`, `gemini` included, should one ever reach
  this function through an untrusted boundary that bypassed
  `settingsSchema`). No branch here can resolve successfully; every path
  returns a `ChatProvider` whose `send()` always rejects.

`src/renderer/chat/useActiveChatProvider.ts` is the one place chat decides
which adapter is actually active — see
["Why `none` and every real identifier still power a working chat"](#why-none-and-every-real-identifier-still-power-a-working-chat)
above. The mock instance is created once (`useRef`, stable for the
component's lifetime) independent of `status`, which is recomputed from
`modelProvider.provider` on every render — so a settings change alone never
resets the conversation.

---

## Chat integration

- **Chat uses the provider interface, not a direct mock import.** `Chat.tsx`
  no longer imports `createMockChatProvider` at all; it calls
  `useActiveChatProvider(modelProvider)` and receives back a `ChatProvider`
  plus a `ChatProviderStatus`.
- **Provider selection is explicit.** One named function
  (`useActiveChatProvider`) is the single decision point, not a hardcoded
  call buried inside a component.
- **Switching provider does not lose conversation state — genuinely, not by
  accident.** Before this milestone, `useConversation`'s controller was
  recreated (`useMemo(() => new ConversationController(...), [provider])`)
  whenever the `provider` reference changed, which would have silently
  discarded the conversation the first time a provider identity actually
  changed at runtime. `ConversationController` now has a `setProvider(provider)`
  method — reassigns the active provider, aborts any in-flight request
  against the old one, returns `status` to `'idle'`, and **touches no
  message** — and `useConversation` keeps one controller for the component's
  whole lifetime (`useRef`, not `useMemo`, since only `useRef` is documented
  as a correctness guarantee rather than a performance hint), forwarding a
  new `provider` prop into `setProvider` instead of discarding the
  controller. Covered by dedicated tests in
  `tests/unit/renderer/conversation-controller.test.ts`'s `setProvider`
  suite.
- **Pending requests are handled safely; stale responses cannot overwrite
  newer state.** Each request already got its own `AbortController` in
  Milestone 1; `setProvider` reuses that same mechanism — aborting the
  in-flight controller means `requestAssistantReply`'s
  `if (controller.signal.aborted) return;` guard discards whatever a
  now-superseded provider eventually answers, even if that provider's fake
  implementation ignores its own signal entirely (verified by a test using
  exactly such an implementation: the stale response, resolved deliberately
  late, never appears in the conversation, including after a different,
  successful exchange with the new provider has already completed).
- **Assistant output remains text-only and untrusted**, unchanged from
  Milestone 1 — see that document's UI section.

---

## UI: provider status

`Chat.tsx` renders `status.summary` as a fixed line above the transcript —
built entirely from `describeChatProviderStatus`'s four known templates,
never from settings input directly. It never displays an API key, a header,
a URL, or `hasApiKey`; `Chat.tsx` does not even receive a value that could
contain one — `ModelProviderSettings` carries only `provider`, `model`,
`baseUrl` and the boolean `hasApiKey`, and only `provider` is read here.

---

## Security boundary

Everything Milestone 1 established holds unchanged — see
`phase-2-chat-architecture.md`'s own Security boundary section — plus, new in
this milestone:

- **The registry fails closed for every approved identifier**, verified by
  `tests/unit/shared/chat-registry.test.ts`: `send()` never resolves for
  `none`, `glm`, `openai-compatible`, or `ollama`, and never for an
  identifier outside that set either.
- **No disapproved identifier is referenced anywhere in source.**
  `anthropic`, `openai`, `claude` and `gemini` do not appear in
  `src/shared/chat/registry.ts` or anywhere else added this milestone.
- **`src/main`, `src/preload/index.ts`, `eslint.config.js`, `package.json`
  and `package-lock.json` all have zero diff in this milestone** — no new
  IPC channel, no new dependency, no privileged code touched. Confirmed by
  `git diff --stat` and by the unmodified e2e bridge-shape test still
  passing.
- **A source-scan test** (`tests/unit/shared/chat-boundary-scan.test.ts`)
  reads the actual, comment-stripped source of every file under
  `src/shared/chat/` and `src/renderer/chat/` and asserts none of them
  reference `ipcRenderer`, `window.localAgent`, `electron`, `child_process`,
  `node:fs`, `fetch(`, `XMLHttpRequest`, `WebSocket`, `eval(`,
  `new Function(`, `dangerouslySetInnerHTML`, or `ActionProposal` — a
  regression guard against a future contributor introducing any of these,
  independent of `eslint.config.js` staying correctly configured.

---

## Testing

| Area                                                                                                                                                                        | File                                                                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Provider request/response schema validation, bounds, secret rejection                                                                                                       | `tests/unit/shared/chat-provider-schema.test.ts`                            |
| Registry: capabilities, status text, fail-closed for every approved and disapproved identifier, no network call                                                             | `tests/unit/shared/chat-registry.test.ts`                                   |
| Timeout decorator: success, timeout, external abort, pre-aborted signal, no network call                                                                                    | `tests/unit/shared/provider-timeout.test.ts`                                |
| Source-scan boundary (no privileged API, no network, no unsafe HTML, no action authorization)                                                                               | `tests/unit/shared/chat-boundary-scan.test.ts`                              |
| Provider switching: preserves state while idle, aborts a stale in-flight request, a late-resolving stale response cannot land, retry stays a no-op without a standing error | `tests/unit/renderer/conversation-controller.test.ts` (`setProvider` suite) |

Same toolchain limitation as Milestone 1: no component-level render test for
`Chat.tsx` (no React Testing Library / jsdom). `useActiveChatProvider.ts` is
a thin hook with no branching logic of its own (`describeChatProviderStatus`,
the function that actually decides what to say, is tested directly and
extensively), so the gap this leaves is narrow.

---

## What remains deferred

Unchanged from Milestone 1's list, plus the specific items this milestone
was explicitly told not to add:

- Real network calls of any kind; HTTP clients; provider SDKs
- API-key retrieval, or any provider adapter reading settings or the secret
  store
- Filesystem tools, shell execution, browser automation
- Model-generated tool execution — there is no tool a model can invoke, and
  no path from a `ChatProviderResult` to `main/executor.ts`
- Vector memory, RAG, plugin runtime, telemetry, cloud sync
- Any relaxation of the approved-identifier list (`anthropic`, `openai`,
  `claude`, `gemini` remain absent)
