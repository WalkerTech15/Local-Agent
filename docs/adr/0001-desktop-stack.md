# ADR 0001 — Desktop stack

- **Status:** Accepted
- **Date:** 2026-08-07
- **Decision made by:** repository owner, on a proposal from Claude Code
- **Applies to:** Phase 1

## Context

Local Agent needs a Windows desktop shell for Phase 1. The defining
requirement is not the interface — it is a **trustworthy privilege boundary**.
The governing rule of the project is that models propose actions and only a
permission-controlled executor performs them, so the stack must make that
boundary an architectural property rather than a convention.

Secondary requirements:

- The interface is specified by ChatGPT as UI/UX specifications and visual
  mockups, which will be web-idiom.
- Codex reviews the codebase independently; fewer languages means a smaller
  review surface.
- Encrypted secret storage must be available without hand-rolled cryptography.
- Phase 1 should ship without a large new toolchain installation.

Verified state of the development machine at the time of this decision:

| Tool                          | Status            |
| ----------------------------- | ----------------- |
| Node.js 24.18.0, npm 11.16.0  | present           |
| Python 3.12.10                | present           |
| Rust / Cargo                  | **not installed** |
| MSVC Build Tools, Windows SDK | unverified        |

## Options considered

### Electron + TypeScript + React — **chosen**

The main/renderer split _is_ the permission boundary. With `sandbox: true`,
`contextIsolation: true` and `nodeIntegration: false`, the renderer has no
mechanism to reach the filesystem or spawn a process. Electron's `safeStorage`
provides DPAPI-backed encryption with no native module to compile. One
language across every layer. No new host toolchain.

### Tauri 2 + Rust + React — rejected for Phase 1

Genuinely the stronger long-term product: roughly 10 MB binaries instead of
~150 MB, lower memory, a first-class capability system, and a memory-safe
privileged core. Rejected because Rust and Cargo are not installed and Tauri
on Windows additionally needs MSVC Build Tools and the Windows SDK — a
multi-gigabyte installation and a real setup risk — and because it splits the
codebase into TypeScript and Rust, doubling the independent review surface and
slowing iteration.

### .NET 8 + WinUI 3 / WPF — rejected

Truly native, excellent DPAPI and packaging story. Rejected because ChatGPT's
mockups would need manual re-implementation in XAML rather than being used
directly, and no .NET SDK was verified on the machine.

### Python + PySide6 / Tkinter — rejected

Python is already installed and is strong for a future AI ecosystem. Rejected
because Phase 1 is an interface and security-boundary phase, not an inference
phase, so Python's later advantage buys nothing now; the polished
mockup-driven onboarding flow would be disproportionately expensive; and
packaging a Python desktop application on Windows is fragile. A later phase
can call Python out-of-process if it ever needs to.

## Decision

**Electron, TypeScript in strict mode, React for the renderer, the Electron
main process as the privileged boundary, and a sandboxed unprivileged
renderer.**

Supporting choices:

- Package manager: **npm**, already present.
- Dependencies: **exact versions** for direct dependencies. No caret ranges,
  no wildcards, no `latest`. `package-lock.json` is committed.
- Validation: **Zod**, one library for settings, policy, audit records and —
  from Milestone 2 — every IPC payload, with TypeScript types derived from the
  schemas so validation and types cannot drift.
- Secret storage: Electron's **synchronous** `safeStorage` API (verified
  against the installed version's typings in Milestone 7; an older,
  since-superseded assumption of an asynchronous API was corrected there).
- Tests: **Vitest** for unit and integration; **Playwright** for end-to-end,
  approved from Milestone 2.
- Styling: plain CSS initially. Deferred until ChatGPT's mockups arrive; if
  they are Tailwind-based, Tailwind is added then. This is a cheap, late,
  reversible decision.

## Consequences

### Accepted costs

- **Binary size and memory.** Electron is far heavier than Tauri. This is the
  main cost of the decision and the reason Tauri was given a serious hearing.
- **Migration to Tauri later would be expensive.** The React interface would
  port; the entire privileged layer — executor, settings, secrets, audit, IPC
  — would need rewriting in Rust. This decision is therefore made deliberately
  now rather than deferred.
- **npm supply chain becomes the largest realistic security risk.** Mitigated
  by a minimal dependency set, exact pinning, a committed lockfile, `npm
audit` in the verification sequence, and human review before any addition.
  Not eliminated.

### Benefits realised

- No new host toolchain; Milestone 1 required only npm packages.
- The privilege boundary is enforced by the runtime, not by discipline.
- Encrypted secret storage without hand-rolled cryptography.
- A single language and a single test runner for the whole codebase.

### Obligations this creates

Recorded here because they are easy to erode later:

- The renderer must never gain Node integration, and `contextIsolation`,
  `sandbox` and `webSecurity` must never be disabled.
- The preload bridge must never expose `ipcRenderer` or a generic
  invoke-any-channel function.
- No IPC channel may ever return a plaintext secret.

These are restated in [../CLAUDE.md](../CLAUDE.md) and asserted by tests from
Milestone 2.

## Amendment — Milestone 2, main/preload build format

The main process is **CommonJS**, compiled by `tsc`, not the ESM originally
assumed above. `import ... from 'electron'` depends on newer, less mature
Electron ESM support, and broke once the main process's compile unit grew to
include a second real dependency (`zod`, transitively via `src/shared`) —
`require('electron')` is the decade-stable mechanism and is unaffected. The
preload script is bundled by Vite into one self-contained file, `electron`
kept external, because a sandboxed preload (`sandbox: true`) cannot
`require()` a local relative file at runtime at all — only `electron` and a
short built-in allowlist resolve there. Neither constraint touches the
renderer, which remains ordinary Vite-bundled ESM. Full detail is in
[../architecture.md](../architecture.md#desktop-shell-implemented).
