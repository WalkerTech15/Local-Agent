# Phase 2 provider completion and streaming

> **Current state.** Phase 2, Milestone 4 completes the provider layer — GLM
> and Ollama join the OpenAI-compatible adapter Milestone 3 delivered — and
> adds bounded streaming from the provider all the way to the interface. It
> builds on [docs/phase-2-chat-architecture.md](phase-2-chat-architecture.md),
> [docs/phase-2-provider-architecture.md](phase-2-provider-architecture.md)
> and
> [docs/phase-2-real-provider-architecture.md](phase-2-real-provider-architecture.md),
> none of whose security boundaries changed. **`anthropic`, `openai`,
> `claude` and `gemini` remain absent.**

---

## Summary

| Property                            | State                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------- |
| `glm` adapter                       | **[implemented]** — `src/main/glm-provider.ts`                             |
| `ollama` adapter                    | **[implemented]** — `src/main/ollama-provider.ts`, local endpoints only    |
| Shared HTTP transport               | **[implemented]** — `src/main/chat-completions-transport.ts`               |
| Bounded streaming, provider → main  | **[implemented]** — server-sent events, four independent bounds            |
| Bounded streaming, main → renderer  | **[implemented]** — `chat:chunk`, one-way, validated, correlated, advisory |
| Streaming preview in the interface  | **[implemented]** — plain text, never HTML, never committed as a message   |
| Network access location             | **Main process only.** Unchanged                                           |
| Plaintext key reaching the renderer | **Never.** Unchanged; Ollama reads no key at all                           |
| New privileged action type          | **None.** `chat.send` still covers every provider call                     |

---

## One transport, three adapters

GLM's public API and Ollama's `/v1` API both speak the OpenAI
chat-completions wire format. Rather than implement that exchange three
times, Milestone 4 factored Milestone 3's implementation into
`src/main/chat-completions-transport.ts` and left three thin, separately
reviewable adapters over it:

| Module                          | Endpoint                                  | Credential           | Identity            |
| ------------------------------- | ----------------------------------------- | -------------------- | ------------------- |
| `openai-compatible-provider.ts` | required, user-supplied                   | bearer key, required | `openai-compatible` |
| `glm-provider.ts`               | `GLM_DEFAULT_BASE_URL`, overridable       | bearer key, required | `glm`               |
| `ollama-provider.ts`            | `OLLAMA_DEFAULT_BASE_URL`, **local-only** | none, ever           | `ollama`            |

The transport is where a request is built, sent, bounded, parsed and
normalized, and it is the single place to audit for the properties that hold
for all three: no logging of any kind, the API key confined to one
`Authorization` header, every response validated by the same
`chatProviderResultSchema` as every other provider, and every failure
normalized into the five existing error codes. Ollama's native `/api/chat`
protocol is deliberately **not** implemented — a second streaming format
would be a second thing to get right for no capability this milestone needs.

Milestone 3's behaviour is preserved exactly, including for an endpoint that
ignores `stream`: the transport requests streaming but handles both reply
shapes, branching on the response's `content-type`. That is why no setting
had to be added to describe which behaviour a given endpoint has.

---

## Ollama is local, and that is enforced

"Local" is a security property here, not a label. Ollama's endpoint is
configurable — a different port, a different loopback form, another machine
on the user's own network — but `src/shared/chat/local-endpoint.ts` decides,
**statically and without DNS**, whether a configured `baseUrl` may be used at
all:

- `localhost` and `*.localhost` (RFC 6761), case-insensitively;
- literal IPv4 loopback (`127.0.0.0/8`), private (`10/8`, `172.16/12`,
  `192.168/16`) and link-local (`169.254/16`) addresses;
- literal IPv6 loopback (`[::1]`), unique-local (`fc00::/7`) and link-local
  (`fe80::/10`) addresses.

Everything else is refused, **including a hostname that would resolve to a
private address**. That is the deliberate trade: a name cannot be checked
without asking a resolver, and a resolver's answer is exactly what a typo or
an attacker controls, so names other than `localhost` are not accepted and
the user configures an address instead. Rejecting something legitimate is
recoverable; silently uploading a conversation to a cloud service under the
label "local" is not.

A refused endpoint **fails closed and never falls back** to the local
default: sending the request somewhere the user did not configure would be a
silent provider substitution, which this milestone forbids itself elsewhere
too. The refusal surfaces as an ordinary `PROVIDER_INVALID_CONFIGURATION`
through the existing error and retry UI.

Enforcement lives at provider-resolution time rather than in
`settingsSchema`. Tightening the schema would have made a previously-valid
`settings.json` invalid, and `loadSettings` fails safe by discarding a
document it cannot validate — so a stricter schema would have silently reset
a user's whole configuration. Resolution-time refusal reaches the same
outcome (no request is made) without that cost.

---

## Streaming

### The shape of it

Streaming runs the length of the system, and each hop keeps the guarantees
of the hop before it:

```
provider  ──SSE──▶  transport  ──onChunk──▶  main/ipc.ts  ──chat:chunk──▶  preload  ──▶  renderer
                    (accumulates,            (splits, validates,          (validates)    (previews
                     bounds)                  correlates, one window)                     as text)
```

The load-bearing decision is that **a delta is a preview, never a result**.
The value that becomes a `ChatMessage` is still the whole reply returned by
`chat:send` and validated by `chatProviderResultSchema`, exactly as in
Milestone 3. Dropping every chunk event would cost the live preview and
change nothing about the resulting conversation. That is what lets streaming
be additive: no existing validation, permission, audit or cancellation
behaviour had to be relaxed to make room for it.

### What is bounded, and where

| Bound                            | Value                              | Enforced in                        |
| -------------------------------- | ---------------------------------- | ---------------------------------- |
| Bytes read from a streamed body  | `CHAT_STREAM_MAX_RESPONSE_BYTES`   | transport                          |
| One unterminated protocol line   | `CHAT_STREAM_MAX_LINE_LENGTH`      | transport                          |
| Total accumulated assistant text | `CHAT_MESSAGE_CONTENT_MAX_LENGTH`  | transport, again in the controller |
| One delta crossing IPC           | `CHAT_STREAM_MAX_DELTA_LENGTH`     | `main/ipc.ts`, schema-checked      |
| Whole-call duration              | `CHAT_PROVIDER_REQUEST_TIMEOUT_MS` | `withProviderTimeout`              |
| Renderer-side preview length     | `CHAT_MESSAGE_CONTENT_MAX_LENGTH`  | `ConversationController`           |

Nothing accumulates without a cap, and no single bound is trusted twice over:
the renderer bounds the preview itself rather than assuming the main process
already did.

A delta larger than the IPC bound is **split across several events**, never
truncated and never dropped — the preview stays faithful while each message
stays small.

### Failure, cancellation and partial streams

| Condition                                      | Result                                                     |
| ---------------------------------------------- | ---------------------------------------------------------- |
| Malformed `data:` frame                        | Skipped; the rest of the stream is still read              |
| Frame carrying no content, comment, blank line | Skipped — all three are legitimate SSE                     |
| `[DONE]` sentinel                              | Reading stops; anything after it is not part of the reply  |
| Stream ends without `[DONE]`, content present  | Accepted — many servers simply close                       |
| Stream produces no content at all              | `PROVIDER_REQUEST_FAILED`                                  |
| Any bound exceeded                             | `PROVIDER_REQUEST_FAILED`, read abandoned at once          |
| Connection drops mid-stream                    | `PROVIDER_REQUEST_FAILED`; no partial message is committed |
| `AbortSignal` fires                            | `PROVIDER_ABORTED`; no further delta is forwarded          |
| Budget elapses                                 | `PROVIDER_TIMEOUT`                                         |
| Caller's `onChunk` throws                      | Swallowed; the request completes normally                  |

A failed or cancelled stream discards its preview. Accepting a stream that
ends without `[DONE]` is a deliberate, documented judgement: refusing one
would break every server that simply closes the connection, and the partial
text is validated like any other reply before it is shown.

### The one new IPC channel

`chat:chunk` is the only main → renderer _push_ channel in this codebase. It
is narrow by construction:

- **One direction, one purpose.** The renderer can only listen; there is no
  request it can make on it and no reply it can send back.
- **One window.** Events go to `event.sender` — the `WebContents` that
  invoked that `chat:send` — never broadcast, and never to a destroyed one.
- **Correlated.** Every event carries the `requestId` of the call it belongs
  to, and both the renderer adapter and the controller discard anything that
  is not the request they are waiting on.
- **Validated twice.** `chatChunkEventSchema` runs in `main/ipc.ts` before an
  event is sent and again in `src/preload/index.ts` before any renderer
  listener sees it. A payload that fails is dropped silently.
- **Never a generic listener.** `chat.onChunk` fixes the channel name in the
  preload and hands back an unsubscribe function; it never exposes
  `ipcRenderer`, never accepts a caller-supplied channel, and never passes
  the raw Electron event through. An e2e test asserts no `on`/`once`/
  `addListener`-shaped function exists anywhere on the bridge.

### In the interface

`ConversationState` gains `streamingContent`, kept **outside** `messages` for
the same reason `status` and `error` are: the message list stays append-only
and holds only fully validated messages. The preview renders through the same
bubble as a real message and with the same safety — a plain JSX text child,
which React escapes — so a streamed fragment can no more inject markup than a
completed reply can. `dangerouslySetInnerHTML` remains absent from the whole
codebase, and Markdown is still not rendered at all.

Streamed output reaches nothing but the screen. There is no path from a delta
to `main/executor.ts`, to an `ActionProposal`, to the permission engine, to
the filesystem, to a terminal, to Git, or to any Windows API — the same
structural absence Milestone 1 established, unchanged by making the text
arrive in pieces.

---

## A defect this milestone found and fixed

`withProviderTimeout` (Milestone 2) rebuilt its options object as
`{ signal: combined.signal }`, forwarding only the option it owns. When
`onChunk` was added, every provider the decorator wraps — which is every real
provider — silently lost streaming: the transport streamed correctly, the
main process accumulated correctly, and not one delta ever reached the
renderer. An IPC-level test caught it before any of this shipped.

The decorator now spreads the caller's options and overrides `signal` alone,
so an option it does not understand reaches the wrapped provider unchanged,
and `tests/unit/shared/provider-timeout.test.ts` asserts exactly that so the
next added option cannot repeat it.

A related hazard is worth recording, because it bit twice in this codebase.
A `let` assigned only inside a closure is narrowed by TypeScript to its
initial literal type for the rest of the function, so a later `if (flag)`
reads as statically always-false — and an automated lint fix will "simplify"
it by deleting the check, silently changing behaviour. `src/shared/chat/timeout.ts`
hit this in Milestone 2 and solved it with an `AbortSignal.reason` sentinel;
the streaming reader hit it here and solved it by having its line consumer
**return** whether the stream finished instead of setting a flag. Both are
noted in the code so the pattern is recognised the third time.

---

## Security boundary

Everything Milestones 1–3 established holds unchanged. New in this milestone:

- **No new privileged action type and no new permission decision.** Every
  provider call is still `chat.send`, still routed through the unmodified
  `runAction` → `handleActionProposal` pipeline, still denied while the
  emergency stop is engaged, still audited with `{provider, messageCount}`
  and nothing else. `main/permissions.ts`, `main/executor.ts`,
  `main/action-pipeline.ts`, `main/action-runtime.ts`, `main/audit.ts`,
  `main/secrets.ts` and `main/settings*.ts` all have **zero diff**.
- **Streamed content never reaches the audit log.** Chunks are not audit
  events; the audit record is written once per action, as before, and a test
  asserts streamed text appears nowhere in it.
- **Ollama never reads the secret store.** `createOllamaProvider`'s config
  type has no key field at all, and `resolveMainChatProvider` skips the
  secret read entirely for it, so a key stored for another provider cannot
  reach a local endpoint even by a caller's mistake.
- **GLM's key follows the Milestone 3 path exactly** — read from the
  encrypted store immediately before the adapter is constructed, used only
  for one `Authorization` header, never logged, never in an error, never in
  a response, never in an audit record. Tests assert its absence from the
  request body and from thrown errors.
- **The renderer still cannot reach the network.** CSP `connect-src 'none'`
  is unchanged, `src/shared`'s purity boundary is unchanged, and the
  source-scan test still confines `window.localAgent` to one named file.
- **The new event channel adds no capability to the renderer** beyond
  receiving bounded, validated text for a request it already initiated.

---

## Testing

| Area                                                                                                                                                                  | File                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Transport: request shape, streaming, multi-chunk, split frames, `[DONE]`, malformed frames, every bound, mid-stream failure, abort, no logging, non-streamed fallback | `tests/unit/main/chat-completions-transport.test.ts`  |
| GLM: default and configured endpoint, bearer auth, key never in body or error, streaming                                                                              | `tests/unit/main/glm-provider.test.ts`                |
| Ollama: local default, no auth header, non-local refusal, no fallback, streaming                                                                                      | `tests/unit/main/ollama-provider.test.ts`             |
| Local-endpoint classification: loopback/private/link-local accepted, public and look-alike names refused                                                              | `tests/unit/shared/local-endpoint.test.ts`            |
| Resolution per provider, unapproved identifiers, timeout wrapping                                                                                                     | `tests/unit/main/chat-provider-registry.test.ts`      |
| `chat:chunk` end to end: per-fragment events, correlation, splitting, destroyed window, denial, audit silence                                                         | `tests/unit/main/ipc.test.ts`                         |
| Renderer adapter: forwarding, correlation filtering, abort, unsubscribe, authoritative result                                                                         | `tests/unit/renderer/ipc-chat-provider.test.ts`       |
| Preview state: accumulation, bounds, never a message, cleared on failure/switch/retry                                                                                 | `tests/unit/renderer/conversation-controller.test.ts` |
| Chunk-event schema: bounds, control characters, bidi, correlation, unknown fields                                                                                     | `tests/unit/shared/ipc.schema.test.ts`                |
| Mock streaming: fragments concatenate to the final content, no preview on failure, abort                                                                              | `tests/unit/shared/mock-provider.test.ts`             |
| Timeout decorator forwards options it does not own                                                                                                                    | `tests/unit/shared/provider-timeout.test.ts`          |
| Bridge shape, no generic invoke **or listen** surface, CSP still blocks renderer network access                                                                       | `tests/e2e/electron-smoke.test.ts`                    |

No test makes a real network request: every `fetch` is stubbed, and the e2e
suite still exercises only the bridge's static shape.

---

## What remains deferred

- Ollama's native `/api/chat` protocol, and any provider that does not speak
  the OpenAI chat-completions format.
- Per-provider request options (temperature, max tokens, system prompts) —
  the request body still carries only `model` and `messages`.
- A user-visible streaming toggle: streaming is requested always and
  degrades gracefully, so no setting describes it.
- Automatic retry of a rate-limited or transiently failed request; the
  user-initiated Retry button remains the only retry path.
- Everything earlier milestones deferred and this one was not asked to add:
  filesystem tools, terminal execution, Git automation, browser or email
  tools, memory, voice, screen awareness, workflows, and model-generated
  tool execution.
