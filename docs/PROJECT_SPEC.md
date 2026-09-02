# Local Agent — project specification

Product name: **Local Agent**
Default assistant name: **JARVIS**
Target platform for Phase 1: **Windows 11**

All rights reserved. No licence has been granted.

---

## 1. Vision

Local Agent is a local-first desktop assistant that runs on the user's own
machine, keeps the user's data on that machine, and never acts without
permission.

The distinguishing property is not capability. It is **control**: the user can
see what the assistant proposes to do, decide whether it may, stop it at any
moment, and afterwards read a complete record of what happened.

The product is built in phases. Each phase is small, testable and shippable on
its own. The vision is not implemented opportunistically.

## 2. The governing rule

> **Models propose actions. Only the permission-controlled executor performs
> them.**

A model can emit an _action proposal_: an inert, structured description of
something it would like to happen. A proposal carries no authority. Whatever
produced it, and however convincing its reasoning, it must pass through the
permission engine before the executor will act on it.

This is to be enforced architecturally, not by convention. Each mechanism is
marked with its current status, so that nothing here reads as built when it is
not:

| Mechanism                                                                                        | Status                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The proposal type carries no capability, only data                                               | **implemented** (`ActionProposal`)                                                                                                                           |
| `src/shared` cannot reach the OS, the network, or run code                                       | **implemented** (lint boundary)                                                                                                                              |
| The executor requires a permission decision as an argument, with no path without one             | **planned, Milestone 5**                                                                                                                                     |
| A lint boundary prevents modules other than the IPC layer from importing the executor            | **planned, Milestone 5** — the executor does not exist yet                                                                                                   |
| An integration test asserts every registered channel passes through the permission engine        | **planned, Milestone 5** — one channel exists (`app:health`, a liveness check with no side effect); the assertion applies once a privileged channel is added |
| The permission engine enforces the emergency availability floor independently of the policy file | **planned, Milestone 5**                                                                                                                                     |

## 3. Security principles

1. **Default deny.** An action with no matching policy rule is denied. Adding
   a capability without adding a rule fails closed.
2. **Fail closed, never fail open.** Corrupt configuration produces a safe,
   restrictive state and a visible error — never a permissive fallback.
3. **Confirm what cannot be undone.** Destructive, irreversible,
   privacy-sensitive, external, elevated and security-sensitive actions
   require explicit user confirmation. This floor is enforced in code and
   cannot be removed by editing the policy file.
4. **Separate concerns on disk.** Application code, settings, secrets,
   permission policy, memory and audit logs each live in their own location.
   No file mixes them.
5. **Secrets never leave the privileged process.** Plaintext credentials exist
   only inside the main process. The interface may learn whether a key exists,
   never what it is.
6. **Everything important is recorded.** The audit log is append-only and
   records denials and rejected confirmations with the same fidelity as
   successes.
7. **The user can always stop it.** The emergency stop is reachable, persists
   across restarts, and is evaluated before policy.
8. **All external input is untrusted.** Files, repositories, websites,
   prompts, emails, model output and tool output are untrusted. Untrusted
   content can never escalate its own permissions.
9. **No silent capability growth.** A new capability requires a new action
   type, a new policy rule, tests and a documented decision.

## 4. Phase 1 scope

Phase 1 delivers a hardened desktop shell and a first-run onboarding flow. It
performs **no AI inference** and takes **no autonomous action**.

- Project scaffold
- Windows desktop application shell
- First-run onboarding interface
- Assistant-name configuration
- User-name configuration
- Interface language configuration: `en`, `fr`, `vi`
- Model-provider settings foundation: `none`, `glm`, `openai-compatible`,
  `ollama` — settings only, no model call, no provider-specific behaviour
- Secure local settings storage
- Permission-policy foundation
- Audit-log foundation
- Emergency-stop foundation
- README and project documentation
- Automated tests

Provider-specific behaviour, when it arrives, lives behind adapters. Phase 1
must not encode a single-provider architecture.

## 5. Postponed capabilities

Deferred beyond Phase 1, and deliberately absent:

- Any model inference, cloud or local; any model SDK; any network call
- Chat interface, conversation history, prompt templates
- Filesystem tools, shell execution, or any tool a model can drive
- Memory, embeddings, vector store, retrieval
- Voice input and output, wake word
- Camera access, continuous screen monitoring, screenshots
- Browser automation, web fetching, reading or sending email
- Administrator or elevated execution, unrestricted terminal control
- Financial actions, automatic file deletion, self-updating
- Multi-agent runtime execution
- Plugin or extension system
- Network-facing server, remote access, multi-user support, sync
- Telemetry or analytics of any kind
- Packaged installer, code signing, auto-update
- macOS and Linux support
- Audit-log tamper-evidence such as hash chaining

## 6. Data separation

| Concern               | Location                                                      |
| --------------------- | ------------------------------------------------------------- |
| Application code      | this repository                                               |
| Settings (non-secret) | `%APPDATA%\Local-Agent\settings.json`                         |
| Secrets               | `%APPDATA%\Local-Agent\secrets\secrets.enc` (encrypted)       |
| Permission policy     | `%APPDATA%\Local-Agent\permissions\policy.json`               |
| Audit log             | `%APPDATA%\Local-Agent\logs\audit\` (append-only)             |
| Emergency state       | `%APPDATA%\Local-Agent\state\emergency.json`                  |
| Memory                | `%APPDATA%\Local-Agent\memory\` (reserved, unused in Phase 1) |

Runtime user data never lives inside the repository. See
[data-locations.md](data-locations.md).

## 7. Milestones

| #   | Milestone                                                           | Status                   |
| --- | ------------------------------------------------------------------- | ------------------------ |
| M1  | Scaffold, tooling, documentation, shared schemas                    | complete, pending review |
| M2  | Desktop shell: hardened main process, preload bridge, renderer boot | complete, pending review |
| M3  | Settings storage                                                    | complete, pending review |
| M4  | Audit-log foundation                                                | complete, pending review |
| M5  | Permission-policy foundation                                        | not started              |
| M6  | Emergency-stop foundation                                           | not started              |
| M7  | Onboarding interface and provider settings                          | not started              |
| M8  | Documentation completion, test hardening, CI                        | not started              |

The security foundation (M3–M6) is built before the onboarding interface so
that the first real user data written to disk already passes through settings
validation, the permission engine, the audit log and the emergency gate.

## 8. Related documents

- [phase-1-scope.md](phase-1-scope.md) — scope and postponement detail
- [architecture.md](architecture.md) — module boundaries and request path
- [security-model.md](security-model.md) — threat model and known limitations
- [data-locations.md](data-locations.md) — on-disk layout
- [adr/0001-desktop-stack.md](adr/0001-desktop-stack.md) — stack decision
- [AI_COLLABORATION.md](AI_COLLABORATION.md) — agent workflow
