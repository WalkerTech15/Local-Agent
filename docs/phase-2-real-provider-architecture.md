# Phase 2 real provider architecture

> **Current state.** Phase 2, Milestone 3 implements the first real,
> network-capable `ChatProvider`: an OpenAI-compatible chat-completions
> adapter. It builds directly on
> [docs/phase-2-chat-architecture.md](phase-2-chat-architecture.md) (message
> model, `ConversationController`) and
> [docs/phase-2-provider-architecture.md](phase-2-provider-architecture.md)
> (the `ChatProvider` interface, the five-code error vocabulary,
> `withProviderTimeout`, the provider request/response schemas), none of
> which changed shape. **`glm` and `ollama` remain unimplemented.
> `anthropic`, `openai`, `claude` and `gemini` remain absent.**

---

## Summary

| Property                            | State                                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- |
| Real `openai-compatible` adapter    | **[implemented]** — `src/main/openai-compatible-provider.ts`                                       |
| Network access location             | **Main process only.** Never the renderer, never `src/shared`                                      |
| New IPC channels                    | **[implemented]** — `chat:send`, `chat:cancel`                                                     |
| New privileged action type          | **[implemented]** — `chat.send`, routed through the unmodified permission/audit pipeline           |
| API-key retrieval                   | **[implemented]** — `main/secrets.ts`'s existing, previously-unused `readSecret`, called only here |
| Plaintext key reaching the renderer | **Never.** No code path returns one; see Security boundary                                         |
| `glm` / `ollama` real adapters      | **[deferred]** — still fail closed via the shared registry                                         |
| Disapproved identifiers             | **Absent.** Not referenced anywhere in source (verified by scan)                                   |

---

## Why this needed a new IPC channel, a new action type, and nothing else new

This is the one architecturally consequential decision in this milestone, so
it is stated explicitly.

A real provider call is a genuine privileged side effect: it reads a
decrypted credential and sends the user's conversation to a remote (or
self-hosted) endpoint over the network. `CLAUDE.md` is explicit that nothing
outside the permission-controlled executor may perform a privileged side
effect, and that an IPC handler must never call the executor directly — it
must go through `handleActionProposal`, exactly like every other action.
There was no way to satisfy that requirement without:

1. a new `ActionType`, `'chat.send'`, added to `ACTION_TYPES`
   (`src/shared/constants.ts`);
2. a default policy rule for it (`createDefaultPermissionPolicy`,
   `src/shared/schemas/permissions.schema.ts`);
3. a new IPC channel, `chat:send`, whose handler
   (`main/ipc.ts`) calls `runAction` — the same function `settings:update`
   and `secrets:write` already call — never the executor or a provider
   directly.

**The one judgment call: `chat.send` is `allow` by default, not
`confirm`.** `AGENTS.md` §5 lists "external" and "privacy-sensitive" among
the categories that require confirmation, and a network call carrying the
user's typed conversation is unmistakably both. The confirmation floor
(`CONFIRMATION_REQUIRED_ACTION_TYPES`) was deliberately **not** widened to
include it, for a reason distinct from every existing floor member: `secrets.write`,
`secrets.clear`, `emergency.reset` and `app.exit` are each a rare,
one-time-per-change action where a confirmation dialog is a proportionate
speed bump. Chat is the product's core, repeated interaction — a dialog on
every single message would not add a meaningful safety check (the user just
finished typing the message and pressed Send, which is already the
deliberate, per-message consent), and would make the feature unusable. The
credential itself already requires its own explicit confirmation exactly
once, when it is first stored, through the pre-existing `secrets.write`
flow — this milestone adds no new path to that store.

`chat.send` is still fully gated, not merely audited: it is **not** on the
emergency-stop exemption list (`EMERGENCY_STOP_EXEMPT_ACTION_TYPES`), so an
engaged emergency stop blocks it exactly as it blocks `settings.write`, and
it is denied by default if a hand-edited policy file omits it (unmatched
actions are always denied). If this reading of "external actions need
confirmation" turns out not to match what was intended, the fix is narrow:
change `chat.send`'s entry in `createDefaultPermissionPolicy` from `allow`
to `confirm`. Nothing else in this milestone assumes one or the other.

`chat:cancel` is deliberately **not** routed through the permission engine
at all — see [Cancellation](#cancellation) below for why that is safe.

---

## The real adapter: `openai-compatible-provider.ts`

`src/main/openai-compatible-provider.ts`'s `createOpenAiCompatibleProvider(config)`
implements the same `ChatProvider` interface every provider in this codebase
implements (`{id, send(request, options)}`) — nothing that consumes a
`ChatProvider` needed to change. It lives in `src/main`, never
`src/shared`, because `src/shared`'s lint-enforced purity boundary
structurally cannot make a network request; see
`docs/phase-2-provider-architecture.md`'s registry section for why
`createChatProviderForSelection` (the shared registry) still fails closed
for `openai-compatible` too, unconditionally, regardless of this adapter's
existence.

What it does, request to response:

1. Builds `<baseUrl>/chat/completions` (trailing slash on `baseUrl` handled).
2. Forwards only `system`/`user`/`assistant` messages as `{role, content}` —
   a `tool`-role message (declared in the schema for forward compatibility,
   never produced by anything in this phase) is dropped rather than sent,
   since this milestone implements no tool-call protocol.
3. Sends `POST` with `Authorization: Bearer <key>` and the conversation as
   `{model, messages, stream: false}`.
4. Reads the response body under a byte cap
   (`MAX_RESPONSE_BYTES`, 1,000,000) via a streaming reader, rejecting a
   response that exceeds it before the whole body is ever buffered — the
   base URL is user-supplied, including self-hosted endpoints, so it is
   never assumed to behave well.
5. Parses the body as JSON, extracts `choices[0].message.content`, and
   validates it through the same `chatProviderResultSchema` every other
   provider's result already passes through — bounded length, no unsafe
   control characters, no bidi overrides — before ever returning it.

Every failure path — a non-2xx status, a network error, an already-aborted
or mid-flight-aborted signal, malformed JSON, a missing or empty `content`,
an oversized body — is caught and re-thrown as a `ChatProviderError` with
one of the five existing codes (see [Error mapping](#error-mapping)) and a
fixed, safe message. **Nothing in this file logs anything** — no request,
no response, no header, no error detail — verified by a test that spies on
`console.log`/`console.error`/`console.warn` across a full successful call
and asserts none were called.

Timeout is **not** implemented inside this adapter. Exactly as
`docs/phase-2-provider-architecture.md`'s Timeout decorator section
anticipated, `main/chat-provider-registry.ts` wraps the constructed
provider in the unmodified `withProviderTimeout` decorator
(`OPENAI_COMPATIBLE_REQUEST_TIMEOUT_MS`, 30 seconds) rather than this file
starting its own timer.

---

## The real registry: `chat-provider-registry.ts`

`src/main/chat-provider-registry.ts`'s `resolveMainChatProvider(options)` is
the main-process counterpart to `src/shared/chat/registry.ts`'s
`createChatProviderForSelection` — a different function, in a different
process, because only this one can read a secret:

- For `none`, `glm`, `ollama`, or an identifier outside `MODEL_PROVIDERS`:
  delegates straight to the shared, always-fail-closed registry rather than
  re-implementing "unavailable" a second time.
- For `openai-compatible`: checks, in order, a non-empty `baseUrl` (already
  enforced by `settingsSchema` for a persisted document, re-checked here as
  defence in depth), a non-empty `model` (not enforced by the settings
  schema, so this is the first real check for it), and a stored key via
  `main/secrets.ts`'s `readSecret` — the same function that has existed,
  fully tested, since Milestone 7, but was previously called by nothing
  outside its own test file (its doc comment already anticipated this: "for
  a future milestone that actually calls a provider from the main
  process"). Any of the three missing produces a `ChatProvider` whose
  `send()` rejects with `PROVIDER_INVALID_CONFIGURATION` and a safe,
  specific message — never a network request.
- Only once all three are present is `createOpenAiCompatibleProvider`
  actually constructed, wrapped in `withProviderTimeout`, and returned.

This function **never throws** — every failure to resolve a working adapter
becomes a fail-closed `ChatProvider`, so `main/ipc.ts` always has exactly
one `ChatProvider` to call, uniformly, regardless of why a real call might
not be possible.

---

## `chat:send` / `chat:cancel`

`src/shared/schemas/ipc.schema.ts` adds both channels:

- **`chatSendRequestSchema`** — `{requestId: uuid, messages: ChatMessage[]}`,
  the array bounded to `CHAT_CONVERSATION_MAX_MESSAGES`, `strictObject` so no
  extra field (an `apiKey`, a `baseUrl`) can ride along. `requestId` exists
  solely to correlate a later `chat:cancel` call to this specific in-flight
  request — it carries no other meaning and is never persisted.
- **`chatSendResponseSchema`** — `{outcome, content?, errorCode?}`.
  `errorCode`, when present, is `z.enum(CHAT_PROVIDER_ERROR_CODES)` — the
  existing five-code vocabulary, reused rather than re-invented at this
  boundary — so a raw provider error string cannot cross into the response
  even by accident. `content`, when present, is the same bounded,
  control-character- and bidi-safe schema every other provider result uses.
- **`chatCancelRequestSchema`** — `{requestId: uuid}`.
- **`chatCancelResponseSchema`** — always exactly `{acknowledged: true}`;
  cancellation is best-effort and idempotent, so there is no failure shape
  to represent.

`main/ipc.ts`'s `chat:send` handler:

1. Validates the request.
2. Reads current settings (for the provider identifier and, later, for
   `resolveMainChatProvider`) and builds a `chat.send` proposal whose
   `parameters` are **only** `{provider, messageCount}` — never message
   content, matching `secrets.write`'s own minimal
   `{provider, keyPresent}` precedent. A dedicated test asserts the full
   conversation text never appears in the audit log.
3. Creates one `AbortController`, registers it in a per-runtime
   `Map<requestId, AbortController>` before calling `runAction`.
4. Calls `runAction(actionRuntime, proposal, null, perform)` — `null`
   because `chat.send` never requires confirmation (see above) — where
   `perform` resolves the provider via `resolveMainChatProvider` and calls
   `provider.send({messages}, {signal})`. A caught `ChatProviderError` is
   re-thrown as `ActionExecutionError(error.code, error.message)`, the same
   translation `secrets.write` already performs for
   `SecretStoreUnavailableError`, so `execute()`'s existing
   `ActionResult.errorCode` extraction picks up the normalized code
   unchanged.
5. Removes the controller from the map in a `finally`, regardless of
   outcome.

`chat:cancel`'s handler looks `requestId` up in that same map and calls
`.abort()` if found — see [Cancellation](#cancellation).

---

## Cancellation

`AbortSignal` cannot cross the IPC boundary directly, so cancellation is a
second, explicit round trip rather than a single shared signal:

- `src/renderer/chat/ipc-chat-provider.ts` generates one `requestId`
  (`crypto.randomUUID()`) per `send()` call and attaches an `'abort'`
  listener to the caller's `AbortSignal` (the same signal
  `ConversationController` already creates and aborts on `setProvider`,
  retry-supersession, and `dispose()`) that calls
  `window.localAgent.chat.cancel(requestId)` — fire-and-forget.
- The adapter's own rejection is **never contingent on that round trip
  succeeding or arriving in time**: immediately after `chat.send` resolves
  (or the signal fires), it re-checks `signal.aborted` and throws
  `PROVIDER_ABORTED` regardless of what the main process ultimately
  answered — mirroring `ConversationController`'s own
  `if (controller.signal.aborted) return;` guard, so a stale, otherwise-
  successful response can never land, exactly as Milestone 2 already
  guaranteed for provider switching. A test using a deliberately
  late-resolving fake bridge proves this: the response is discarded even
  when it reports `outcome: 'success'`.
- `chat:cancel` is **not** routed through `handleActionProposal` — it is
  the one IPC channel in this milestone with no privileged side effect of
  its own. It cannot start a network request, read a secret, or perform any
  action the permission engine would need to authorize; it can only ask an
  **already-authorized**, already-in-flight `chat:send` call to stop early.
  Best-effort and idempotent: cancelling a request that already finished,
  or one that was never sent, is a no-op, not an error — there is nothing
  in the map to abort.

---

## Error mapping

The five codes from `docs/phase-2-provider-architecture.md` are reused
without addition, mapped as follows for a real HTTP exchange:

| Condition                                               | Code                             |
| ------------------------------------------------------- | -------------------------------- |
| `none` selected, or `glm`/`ollama` selected             | `PROVIDER_UNAVAILABLE`           |
| Empty `baseUrl`, empty `model`, or no key stored        | `PROVIDER_INVALID_CONFIGURATION` |
| HTTP `401` / `403`                                      | `PROVIDER_INVALID_CONFIGURATION` |
| HTTP `429`, any other non-2xx status                    | `PROVIDER_REQUEST_FAILED`        |
| `fetch` rejects for a reason other than abort           | `PROVIDER_REQUEST_FAILED`        |
| Malformed JSON, missing/empty `content`, oversized body | `PROVIDER_REQUEST_FAILED`        |
| `withProviderTimeout`'s budget elapses                  | `PROVIDER_TIMEOUT`               |
| Signal aborted (already, or mid-flight)                 | `PROVIDER_ABORTED`               |

**The one judgment call here:** a `401`/`403` is mapped to
`PROVIDER_INVALID_CONFIGURATION` rather than a new "authentication failed"
code, since the five-code vocabulary has no such member and the task
required reusing it, not extending it. This matches
`docs/phase-2-provider-architecture.md`'s own definition of that code —
"the provider is implemented but its configuration is unusable" — and a
rejected credential is exactly that from the caller's perspective: the fix
is in provider settings, not a retry. `429` is deliberately **not** folded
into the same code: a rate limit is not a configuration problem and will
often succeed on retry, so it stays `PROVIDER_REQUEST_FAILED`, the generic,
retry-appropriate bucket.

Every code still carries only a fixed, safe message — never the response
body, a status line, a URL, or a header — verified by a test that stuffs an
identifiable string into a mocked error response body and asserts it never
appears in the thrown error's `message`.

---

## Security boundary

Everything Milestones 1–2 established holds unchanged — see those
documents' own Security boundary sections — plus, new in this milestone:

- **All network access is in the main process.** `src/shared` cannot reach
  it (unchanged, structural). The renderer cannot reach it either: the CSP's
  `connect-src 'none'` (unchanged, `main/index.ts`) still blocks
  `fetch`/`XHR`/`WebSocket` from the renderer's own script context — proven
  unmodified by the e2e suite's existing "enforces the CSP" test — and
  nothing under `src/renderer/chat` imports a network-capable global either,
  per the source-scan boundary test.
- **The plaintext API key never reaches the renderer.** It is read by
  `readSecret` inside `resolveMainChatProvider`, held only for the duration
  of one `provider.send()` call, used only to build one `Authorization`
  header, and is never placed in `ActionProposal.parameters` (the audit
  record only ever sees `{provider, messageCount}`), never in a thrown
  error's message, never in the `chatSendResponseSchema` response shape,
  and never logged. Tests assert the key is absent from the IPC response,
  from every audit record, and from the outgoing request body (it belongs
  in the `Authorization` header alone).
- **The registry fails closed for every provider without a real adapter,
  and for missing configuration on the one that has one** —
  `none`/`glm`/`ollama` via the unmodified shared registry, `openai-compatible`
  with an empty `baseUrl`, an empty `model`, or no stored key via
  `resolveMainChatProvider`'s own checks — verified by tests, in every case
  without a network call.
- **`chat.send` passes through the unmodified permission engine, confirmation
  floor, emergency-stop gate and audit writer**, exactly like every other
  action type — `main/permissions.ts`, `main/executor.ts`,
  `main/action-pipeline.ts` and `main/audit.ts` all have zero diff in this
  milestone. `chat:cancel` has no side effect requiring authorization — see
  [Cancellation](#cancellation).
- **No message content, no response content, and no error detail ever
  reaches the audit log.** Only `{provider, messageCount}` on the request
  side; the audit schema's own bounds and redaction contract
  (`auditParametersSchema`) are the backstop if that were ever violated.
- **Model output still authorizes nothing.** There is no new path from a
  `ChatSendResponse`'s `content` to `main/executor.ts`, to
  `handleActionProposal`, or to any action proposal — it becomes, at most,
  one more assistant `ChatMessage`, rendered as plain JSX text exactly as
  every prior milestone's assistant message was.
- **`src/main`'s pre-existing privileged modules are untouched.**
  `main/permissions.ts`, `main/executor.ts`, `main/action-pipeline.ts`,
  `main/action-runtime.ts`, `main/emergency.ts`, `main/policy.ts`,
  `main/settings.ts`, `main/settings-service.ts` and `main/secrets.ts` all
  have zero diff — confirmed by `git diff --stat`. `main/secrets.ts`'s
  `readSecret` is called for the first time outside its own tests, but its
  implementation did not change.
- **A source-scan test** (`tests/unit/shared/chat-boundary-scan.test.ts`,
  extended this milestone) asserts `window.localAgent` appears in exactly
  one file under `src/renderer/chat` —
  `ipc-chat-provider.ts` — and nowhere under `src/shared/chat`, so a future
  contributor adding a second, uncontrolled call site fails this test
  immediately, independent of code review.

---

## Testing

| Area                                                                                                                                                                                                               | File                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| Real adapter: success, headers/body shape, role filtering, auth failure, rate limit, generic failure, network failure, cancellation, malformed/oversized response, no logging                                      | `tests/unit/main/openai-compatible-provider.test.ts` |
| Main-process registry: fail-closed delegation, missing configuration, successful resolution, timeout wrapping, undecryptable key                                                                                   | `tests/unit/main/chat-provider-registry.test.ts`     |
| `chat:send` / `chat:cancel` IPC: permission gating, emergency-stop denial, request validation, audit content (never message text or the key), successful and failing real calls, cancellation of an in-flight call | `tests/unit/main/ipc.test.ts`                        |
| `chat:send` / `chat:cancel` schema validation, bounds, normalized error-code enum                                                                                                                                  | `tests/unit/shared/ipc.schema.test.ts`               |
| Renderer IPC adapter: request/response mapping, error-code fallback, abort-before-call, abort-mid-flight discarding a late response, listener cleanup                                                              | `tests/unit/renderer/ipc-chat-provider.test.ts`      |
| Registry capability/status changes (`implemented`, `ready`, `missing-api-key`)                                                                                                                                     | `tests/unit/shared/chat-registry.test.ts`            |
| Boundary scan: `window.localAgent` confined to one named file; every other forbidden pattern unchanged                                                                                                             | `tests/unit/shared/chat-boundary-scan.test.ts`       |
| Bridge shape (`chat.send`, `chat.cancel` present; no generic invoke surface; CSP still blocks renderer network access)                                                                                             | `tests/e2e/electron-smoke.test.ts`                   |

No test in this milestone makes a real network request: every `fetch` call
in every new test is either stubbed with `vi.stubGlobal('fetch', ...)` or,
in `tests/e2e/electron-smoke.test.ts`, deliberately never invoked — `chat.send`
is exercised only against a temporary directory and a mocked `fetch`, in
`tests/unit/main/ipc.test.ts`, matching how `settings:*` and `secrets:*` are
already tested there rather than against the real, running application.

---

## What remains deferred

- Real `glm` and `ollama` adapters — both still resolve through the shared,
  fail-closed registry.
- Streaming responses — `stream: false` is hardcoded; the adapter reads one
  complete response, not a token stream.
- Per-provider request options (temperature, max tokens, system-prompt
  overrides) — the request body carries only `model` and `messages`.
- Retrying a rate-limited or transiently failed request automatically — the
  existing `Retry` button in the chat UI (Milestone 1) is the only retry
  path, and it is always user-initiated.
- Everything Milestones 1–2 already deferred and this milestone was not
  asked to add: filesystem tools, shell execution, browser automation,
  model-generated tool execution, vector memory/RAG, plugin runtime,
  telemetry, cloud sync, and any relaxation of the approved-identifier list.
