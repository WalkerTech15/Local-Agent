# Phase 3, Milestone 1 — Production readiness

This milestone adds no capability. It reviews the security boundaries built
across Phase 1 and Phase 2, fixes three production-configuration gaps in the
packaging pipeline, and documents what an actual release still requires —
code signing and auto-updates — without implementing either.

---

## What was reviewed, and what changed

The permission engine, the emergency-stop gate, the encrypted secret store,
the audit writer, the IPC layer and the Windows automation registry were
re-read against [security-model.md](security-model.md) and
[architecture.md](architecture.md). None of them needed a change: every
action still passes through the same unmodified `handleActionProposal` →
`decidePermission` → `execute` → `appendAuditRecord` path documented there,
the confirmation and emergency-availability floors are unchanged, and no new
action type, IPC channel, or automation tool was added. This milestone is
packaging and documentation only.

Three real gaps were found and fixed, all in build configuration, not
application code:

- **`package.json` had no `author` field.** `electron-builder` warned about
  this on every packaging run (`author is missed in the package.json`) and
  falls back to a blank publisher identity in the installer's file
  properties. A placeholder `author` was added; see **Release requirements**
  below for why it must be replaced.
- **`electron-builder.json` relied only on the `--publish never` CLI flag**
  to guarantee a packaging run never attempts to upload anything. That flag
  is easy to forget in a hand-typed command. `"publish": null` is now set in
  the config file itself, so no publish target exists to invoke even if the
  flag is omitted — defense in depth, not a behavior change (there was never
  a publish target configured).
- **The packaged `app.asar` carried `zod`'s own TypeScript source and its
  entire internal test suite** (`node_modules/zod/src/**`, several hundred
  files), even though `zod`'s `package.json` resolves `require('zod')` to
  `index.cjs` and only exposes `src/` under an unused `@zod/source` export
  condition. None of it is reachable at runtime; it was dead weight inside
  the installer, not a secret or a project source file, but still an
  unintended file by this milestone's own bar. `files` now excludes
  `node_modules/zod/src/**`, confirmed by listing the rebuilt asar's contents
  directly.

`.github/workflows/ci.yml` now runs `npm run package:win` once per CI run
(on the newer of the two Node versions in the matrix, since the installer
does not depend on which Node built it). Previously, a change that broke
packaging — a bad `files` pattern, a missing runtime dependency — would only
be caught by whoever happened to run `npm run package:win` locally. It is
now a required CI step alongside the checks in `npm run verify`.

## Release requirements

Cutting an actual release of Local Agent needs, in order:

1. **Bump `package.json`'s `version`.** `electron-builder` reads it for both
   the installed app's version and the installer's file name
   (`Local Agent Setup <version>.exe`). This project has not yet made a
   version-numbering decision beyond semver; that decision is the repository
   owner's, not an agent's, and is out of scope for this milestone.
2. **Replace the placeholder `author` in `package.json`** with the real
   publisher identity that should appear in the installer's file properties
   and, later, on a code-signing certificate (see below). `"Local Agent
Project"` is a placeholder, not a legal identity.
3. **Run the full verification suite**: `npm run verify` (typecheck, lint,
   format check, unit tests), then `npm run test:e2e`, then
   `npm audit --audit-level=low`. All are already required by CI; a release
   should not be cut from a commit that has not passed them.
4. **Build the installer**: `npm run package:win`. See
   [README.md's "Packaging a Windows installer"](../README.md#packaging-a-windows-installer)
   section for what the build includes and excludes.
5. **Smoke-test the installer manually on a real Windows machine**: install
   it, confirm the app launches, confirm uninstalling it leaves
   `%APPDATA%\Local-Agent` in place (electron-builder's NSIS default does not
   remove user data on uninstall — this is intentional; see
   [data-locations.md](data-locations.md)). This cannot be automated from
   this repository's CI, which packages the installer but does not install
   it.
6. **Distribute the exact file `npm run package:win` produced.** Nothing in
   this repository re-signs, re-packages, or otherwise modifies the
   installer after `electron-builder` writes it.

There is no publish or upload step at any point above, and none is added by
this milestone — see **Explicitly not done here** below.

## Code signing — required before a real release

The installer and every executable inside it are currently **unsigned**.
`Get-AuthenticodeSignature` on the built installer reports `NotSigned`,
which means Windows SmartScreen shows an "unknown publisher" warning on
first run, and nothing distinguishes a genuine installer from a tampered
one by signature.

Phase 3 Milestone 3 (`docs/phase-3-code-signing.md`) adds the environment-
variable-driven configuration support, a preflight check that fails safely
if a signing request is incomplete, and full documentation of what
purchasing and wiring a real certificate requires. It remains true, as of
that milestone too, that **no certificate has been purchased, generated, or
installed**, and no build in this repository has ever produced a signed
installer — see that document for the current, authoritative detail
formerly duplicated in this section.

## Auto-update — required before a real release

Local Agent currently has **no update mechanism of any kind**. A user who
installs it gets exactly the version in that installer, forever, until they
manually download and run a newer one. [AGENTS.md §6](../AGENTS.md) lists
"self-updating" among the capabilities this project must not quietly enable,
so this is a deliberate absence, not an oversight — but it is still a real
production gap: there is no way to get a security fix to an installed copy
of Local Agent except asking the user to reinstall it by hand.

Phase 3 Milestone 4 (`docs/phase-3-auto-update.md`) adds the safety-gating
state machine, configuration resolution, and full documentation of what a
real integration, a real feed, and a real publish would still require. It
remains true, as of that milestone too, that **no update dependency, update
feed, or network call was added** — see that document for the current,
authoritative detail formerly duplicated in this section.

## Explicitly not done here

Matching the task scope exactly:

- No new action type, IPC channel, automation tool, or permission.
- No cloud sync, telemetry, or analytics of any kind.
- No code-signing certificate obtained, configured, or referenced.
- No auto-update service, dependency, or feed.
- No publish or release upload — `"publish": null` in
  `electron-builder.json` and `--publish never` in `npm run package:win`
  both say so, redundantly, on purpose.
- No refactor of `src/main`, `src/preload`, `src/renderer` or `src/shared`.

## Related documents

- [phase-3-code-signing.md](phase-3-code-signing.md) — Milestone 3's detailed
  code-signing configuration, environment variables, CI secret handling, and
  `Get-AuthenticodeSignature` verification steps.
- [phase-3-auto-update.md](phase-3-auto-update.md) — Milestone 4's
  safety-gating state machine, configuration resolution, and what a real
  update integration would still require.
- [README.md — "Packaging a Windows installer"](../README.md#packaging-a-windows-installer)
  — the existing build command and what the installer contains.
- [security-model.md](security-model.md) — the full threat model and
  numbered known limitations, including the one this milestone adds about
  the unsigned installer and the absence of updates.
- [data-locations.md](data-locations.md) — confirms packaging adds no new
  on-disk data location.
