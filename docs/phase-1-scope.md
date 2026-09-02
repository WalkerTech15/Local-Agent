# Phase 1 scope

The authoritative specification is [PROJECT_SPEC.md](PROJECT_SPEC.md). This
document records the scope boundary in detail, including what was considered
and deliberately deferred, so that a later reader can tell the difference
between "not built yet" and "decided against for now".

---

## In scope

| Capability              | Detail                                                                   |
| ----------------------- | ------------------------------------------------------------------------ |
| Project scaffold        | TypeScript strict, ESLint, Prettier, Vitest, documentation               |
| Windows desktop shell   | Hardened Electron window; sandboxed, unprivileged renderer               |
| First-run onboarding    | Detects first run, collects initial configuration, marks complete        |
| Assistant name          | 1–32 characters, no control characters, default `JARVIS`                 |
| User name               | Up to 64 characters, required once onboarding completes                  |
| Interface language      | `en`, `fr`, `vi`                                                         |
| Model-provider settings | `none`, `glm`, `openai-compatible`, `ollama` — **settings only**         |
| Secure settings storage | Strict schema, atomic writes, fail-closed defaults                       |
| Permission policy       | Default-deny, `allow`/`confirm`/`deny`, code-enforced confirmation floor |
| Audit log               | Append-only JSONL, daily rotation, redaction, denials recorded           |
| Emergency stop          | Persisted gate, evaluated before policy, safe first-launch behaviour     |
| Documentation           | README, spec, architecture, security model, data locations, ADR          |
| Automated tests         | Unit tests now; integration and end-to-end from Milestone 2              |

### Model providers: what "foundation" means

Phase 1 stores provider configuration and nothing more.

- No model SDK is installed.
- No network request is made to any provider.
- No API key is validated against a provider.
- No provider-specific code path exists.

When inference arrives in a later phase, each provider sits behind an adapter.
Phase 1 must not encode a single-provider architecture, which is why the
provider list is a plain enum with no provider-shaped branching anywhere.

---

## Postponed

### Deferred because they belong to a later phase

- Model inference of any kind, cloud or local
- Chat interface, conversation history, prompt templates
- Filesystem tools, shell execution, any tool a model can drive
- Memory, embeddings, vector store, retrieval
- Voice input and output, wake word
- Plugin or extension system
- macOS and Linux support
- Packaged installer, code signing, auto-update

### Deferred deliberately on safety grounds

These are not merely unbuilt. They are excluded from Phase 1 by rule:

- Camera access
- Continuous screen monitoring, screenshots
- Browser automation
- Sending email
- Administrator or elevated execution
- Unrestricted terminal control
- Financial actions
- Automatic file deletion
- Self-updating
- Multi-agent runtime execution
- Network-facing server, remote access, multi-user support, sync
- Telemetry or analytics of any kind

### Deferred with a known gap

- **Audit-log tamper-evidence.** The log is append-only by API but a local
  user can edit the file. Hash chaining or signing is a later decision. See
  [security-model.md](security-model.md), known limitation 1.

---

## Milestones

| #   | Milestone                                        | Independently testable outcome                                               |
| --- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| M1  | Scaffold, tooling, documentation, shared schemas | Type-check, lint, format and unit tests pass; schemas reject malformed input |
| M2  | Desktop shell                                    | The window launches; hardening flags asserted by an end-to-end test          |
| M3  | Settings storage                                 | Defaults on first run; corrupt file loads safely; writes survive restart     |
| M4  | Audit-log foundation                             | Records append; secrets redacted; log rotates; no delete API                 |
| M5  | Permission-policy foundation                     | Default-deny; confirmation honoured; no channel bypasses the engine          |
| M6  | Emergency-stop foundation                        | Blocks non-exempt actions; persists; safe on first launch and on corruption  |
| M7  | Onboarding and provider settings                 | First run completes; no key reaches the settings file; no network request    |
| M8  | Documentation, test hardening, CI                | Clean checkout passes the full suite in CI                                   |

Milestone 1 deliberately produces no window and no runtime behaviour. It
front-loads the schemas that every later milestone depends on, so that the
security-critical shapes are settled and reviewed before any code writes to
disk.

---

## Testing approach by milestone

- **M1** — unit tests only. Everything in `src/shared` is pure, so it is
  tested directly with no mocking.
- **M2** — Playwright drives the built Electron application to assert the
  window-hardening flags. Approved for Milestone 2, not earlier.
- **M3–M6** — integration tests against a temporary application-data
  directory, never the developer's real one.
- **M7** — end-to-end onboarding, including an assertion that no network
  request occurs.
- **M8** — the full suite in CI on a clean checkout.
