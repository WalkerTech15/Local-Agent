# Phase 3, Milestone 5 — First public release preparation

**Status: prepared, not published, not distributed.** This milestone pulls
the full release path — build, sign, package, install, uninstall, rollback,
recovery, update — into one reproducible checklist, adds a version/metadata
validation step so a release build cannot silently ship the wrong version or
the placeholder publisher identity, and adds a CI job that validates a
tagged release build without publishing it anywhere. No release has been
built with real signing credentials, no certificate exists, no tag has been
pushed, and nothing has been uploaded, published, or distributed by this
milestone or any before it.

---

## The full release path, reviewed

Every piece this milestone assembles into one checklist already exists,
built by an earlier milestone, and none of it changed here except where
this document says so explicitly:

| Piece                       | Where                                                             | Status                                                                                                |
| --------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Production build            | `npm run build`                                                   | Implemented, CI-verified every push                                                                   |
| Windows installer           | `electron-builder.json`, `npm run package:win`                    | Implemented, CI-verified every push (`docs/phase-3-production-readiness.md`)                          |
| Code signing                | `scripts/check-signing-config.mjs`, `CSC_LINK`/`CSC_KEY_PASSWORD` | Configuration and preflight prepared; **no certificate** (`docs/phase-3-code-signing.md`)             |
| Auto-update                 | `src/shared/update/`, `scripts/check-update-config.mjs`           | State machine and gating prepared; **no updater dependency, no feed** (`docs/phase-3-auto-update.md`) |
| CI verification             | `.github/workflows/ci.yml`, `verify` job                          | Implemented, runs on every push and PR                                                                |
| CI release validation       | `.github/workflows/ci.yml`, `release-validate` job                | **New this milestone.** Dormant — runs only on a `v*` tag push, and none has ever been pushed         |
| Release metadata validation | `scripts/check-release-metadata.mjs`                              | **New this milestone**                                                                                |
| Release checklist           | This document                                                     | **New this milestone**                                                                                |

Nothing in this table required a change to `src/main`, `src/preload`,
`src/renderer`, or any permission, IPC channel, or action type — this
milestone is packaging, CI configuration, and documentation, exactly like
Milestones 1, 3, and 4 before it.

## What's new here

- **`scripts/check-release-metadata.mjs`** — runs as the third preflight in
  `npm run package:win` (`check:release`, after `check:signing` and
  `check:update`). Two tiers:
  - **Always**: `package.json`'s `version` must be a plain `X.Y.Z` semver
    string, and `author` must have a non-empty name. Both already hold for
    this repository's `package.json` today, so this changes nothing about
    an ordinary build — it only guards against a future edit breaking
    either silently.
  - **Only when `LOCAL_AGENT_RELEASE=1`** (nothing sets this today):
    `author.name` must no longer be the placeholder `"Local Agent
Project"` this repository ships with, and if `LOCAL_AGENT_RELEASE_TAG`
    is also set, its version (with or without a leading `v`) must equal
    `package.json`'s `version` exactly.
- **`.github/workflows/ci.yml`** gained a `tags: ['v*']` trigger and a new,
  dormant `release-validate` job — see **CI release validation** below.
- **This document.**

Nothing else. No dependency added, no `electron-builder.json` change, no
IPC channel, no permission.

## Reproducible release checklist

Every step below is either something this repository's own tooling already
does (marked **automated**) or something only the repository owner can do
(marked **manual** — an agent must not perform these; see `AGENTS.md` §7 on
git and `CLAUDE.md` on dependencies and credentials).

1. **(manual)** Decide the version number and update `package.json`'s
   `"version"` field. Follow semver; `check-release-metadata.mjs` requires
   the plain `X.Y.Z` form (no `v` prefix, no pre-release suffix).
2. **(manual, once)** Replace `package.json`'s placeholder
   `"author": { "name": "Local Agent Project" }` with the real publisher
   identity. Do this once, not per release — but a release build will
   refuse to proceed under `LOCAL_AGENT_RELEASE=1` until it's done.
3. **(automated)** Run `npm run verify` (typecheck, lint, format check,
   unit tests), then `npm run test:e2e`, then
   `npm audit --audit-level=low`. All three already run in CI on every
   push; a release should not be cut from a commit that has not passed
   them locally first.
4. **(manual)** Obtain and set a real code-signing certificate
   (`CSC_LINK`/`CSC_KEY_PASSWORD` or the `WIN_`-prefixed forms) — see
   `docs/phase-3-code-signing.md`. Without this, step 6 produces an
   unsigned installer, which is not a first _public_ release regardless of
   how many other steps here are complete.
5. **(automated)** Run
   `LOCAL_AGENT_RELEASE=1 npm run check:release` to confirm the version and
   publisher identity are release-ready before spending time on a full
   build.
6. **(automated)** Run `npm run package:win`. This re-runs step 5 as part
   of its own preflight, then builds and packages the signed installer.
7. **(manual)** Verify the signature:
   `Get-AuthenticodeSignature "release\Local Agent Setup <version>.exe"` —
   must report `Valid`, not `NotSigned` (see
   `docs/phase-3-code-signing.md`'s verification table). **A `NotSigned`
   result here means the release is not ready, no matter what steps 1–6
   reported.**
8. **(manual)** Install the signed installer on a real, clean Windows
   machine (not the development machine, if avoidable). Confirm: the
   application launches; onboarding runs on first launch; the Start Menu
   and, if selected, desktop shortcuts appear. See **Installation** below.
9. **(manual)** Uninstall it. Confirm `%APPDATA%\Local-Agent` still exists
   with the user's settings, secrets, permission policy, memory, and audit
   log intact. See **Uninstallation** below.
10. **(manual)** Reinstall over the confirmed-intact data directory from
    step 9. Confirm the application picks up the prior settings rather than
    re-running onboarding. This is the manual recovery path documented in
    **Rollback and recovery** below, exercised for real at least once
    before calling a release process trustworthy.
11. **(manual)** Commit the version bump from step 1, tag the commit
    `vX.Y.Z` matching it exactly, and push the tag. This is the only action
    in this checklist that triggers the CI `release-validate` job — see
    below. Not performed by this milestone or any agent: `AGENTS.md` §7
    forbids committing, pushing, or tagging without explicit authorization
    for that specific action.
12. **(manual)** Once `release-validate` passes, decide whether and where
    to publish — a GitHub Release, a different host, or nothing yet. **No
    step in this checklist, and nothing this repository's CI runs,
    publishes or uploads anything.** Publishing is a distinct, manual,
    explicitly-out-of-scope-for-every-milestone-so-far decision.

Steps 1–3 and 5–6 can be run today, right now, on the unsigned build this
repository already produces, to rehearse the mechanics. Steps 4, 7, 8, 9,
10, 11, and 12 all require something that does not exist in this
repository or this milestone: a real certificate, a real signed build, and
explicit action by the repository owner.

## CI release validation

`.github/workflows/ci.yml`'s new `release-validate` job runs **only** when
a `v*`-prefixed tag is pushed (`if: startsWith(github.ref, 'refs/tags/v')`).
Since no tag has ever been pushed to this repository, **this job has never
run.** When it does, it repeats the full `verify` job (typecheck, lint,
format, unit tests, build, e2e, audit) on Node 24.x, then runs
`npm run check:release` with `LOCAL_AGENT_RELEASE=1` and
`LOCAL_AGENT_RELEASE_TAG` set from the pushed tag (`github.ref_name`), then
`npm run package:win` with the same optional `CSC_LINK`/`CSC_KEY_PASSWORD`
secrets the existing `verify` job already references.

### What this job does not do

It does not run `actions/upload-artifact`, does not create or update a
GitHub Release, and does not push anything anywhere. The installer it
produces exists only inside that CI run's ephemeral runner and is discarded
when the job finishes. This is deliberate: the task for this milestone is
**validation**, not distribution — confirming a tagged commit _could_
produce a legitimate, correctly-versioned, (if configured) signed release
build, not making that build available to anyone. Actually publishing a
release — uploading an artifact, creating a GitHub Release, or anything
else that puts a build somewhere a user could get it — is a distinct,
manual, out-of-scope decision for every milestone so far, this one
included.

## Installation

The installer built by `npm run package:win` is a standard NSIS installer
(`docs/phase-3-production-readiness.md`): not one-click
(`oneClick: false`), per-user by default (`perMachine: false`, no
administrator prompt), lets the user change the install directory, and
offers Start Menu and desktop shortcuts. Running it installs the
application; nothing in this repository automates that step further, and
nothing should — an installer a script silently ran would be exactly the
kind of unapproved action `AGENTS.md` §5 forbids for the application itself,
let alone for its own installation.

## Uninstallation

Uninstalling (via "Apps & Features" or the generated uninstaller) removes
the installed application files. It does **not** remove
`%APPDATA%\Local-Agent` — settings, the encrypted secret store, the
permission policy, memory, and the audit log all survive an uninstall
untouched, by electron-builder's NSIS default
(`docs/data-locations.md`, `docs/phase-3-production-readiness.md`). This is
intentional, not a gap: a user uninstalling to troubleshoot, or to reinstall
a different version, does not lose their data or have to redo onboarding. A
user who wants their data gone too must delete
`%APPDATA%\Local-Agent` themselves — no code path in this repository does
that automatically, the same way none of it does any other automatic file
deletion (`AGENTS.md` §6).

## Rollback and recovery

Local Agent has no automated rollback and no auto-updater
(`docs/phase-3-auto-update.md`). Every recovery path here is manual, and
all of them rely on the same fact: **`%APPDATA%\Local-Agent` outlives an
uninstall.**

- **A bad installed version** → uninstall it, install a prior known-good
  installer. Because uninstalling does not touch `%APPDATA%\Local-Agent`,
  the prior version starts with the same settings, secrets, and permission
  policy the bad version had — nothing is lost, and nothing needs to be
  reconfigured.
- **A corrupted or unwanted settings/policy file** → each of `settings.json`,
  `permissions\policy.json`, `state\emergency.json`, `agents\profiles.json`,
  `workflows\workflows.json`, and the `memory\` files already has its own
  fail-safe load behavior, documented per-file in `docs/data-locations.md`
  — a corrupt file is detected and handled (most default safely; emergency
  state defaults to _engaged_ on corruption, deliberately, per
  `docs/security-model.md`) rather than crashing the application. Deleting
  a specific file by hand and letting the application recreate its default
  on next launch is always a valid manual recovery, file by file, without
  reinstalling anything.
- **Every prior release artifact should be retained wherever it is
  eventually hosted**, once publishing is a real decision — a GitHub
  Release is not deleted by publishing a newer one, so a prior installer
  stays available for exactly this manual rollback. Nothing in this
  repository enforces that retention; it is a hosting-process discipline
  for whoever eventually publishes, documented here so the requirement is
  not invented under pressure later.
- **No release should overwrite another release's artifact at the same
  version or the same feed location.** A version bump is required for a
  new release specifically so a rollback target (the previous version's
  own artifact) always still exists somewhere unambiguous.

None of this is new: `docs/phase-3-auto-update.md`'s own "Rollback and
recovery requirements" section documents the same facts from the
auto-update side. This section restates them here because a release
checklist that does not mention rollback is not a complete one — not
because anything changed.

## Signing and auto-update prerequisites

Restated briefly; full detail lives in the two milestones that prepared
them:

- **Signing** (`docs/phase-3-code-signing.md`): a purchased Authenticode
  certificate, `CSC_LINK`/`CSC_KEY_PASSWORD` set locally or as the two
  repository secrets CI already references, and a `Get-AuthenticodeSignature`
  check showing `Valid` on the output — not merely a build that completed
  without error.
- **Auto-update** (`docs/phase-3-auto-update.md`): a signed release (the
  above) is a hard prerequisite, plus the `electron-updater` dependency
  (not yet added), a real update feed (not yet published to), and a real
  IPC channel (explicitly out of scope for every milestone so far, since it
  is exactly the kind of permission/IPC change these milestones were told
  not to make). A first public release does not require auto-update to
  exist; it only must not silently promise one that doesn't.

## Tests

`tests/unit/scripts/check-release-metadata.test.ts` — 17 tests: passes for
the current, valid `package.json` shape; accepts both object- and
string-form `author`; fails on a missing, malformed, or non-plain-semver
version (`1`, `1.2`, `1.2.3.4`, a `v`-prefixed value, a pre-release suffix,
empty); fails on a missing or empty author name; does **not** require a
real (non-placeholder) author name when `LOCAL_AGENT_RELEASE` is unset;
fails when it is set and the author is still the placeholder; passes once
the placeholder is replaced; fails when `LOCAL_AGENT_RELEASE_TAG` disagrees
with `package.json`'s version; passes when it agrees, with or without a
`v` prefix; and confirms `LOCAL_AGENT_RELEASE_TAG` is ignored entirely when
a release was not requested.

## Explicitly not done here

Matching the task scope exactly:

- No release published or uploaded — no `actions/upload-artifact`, no
  GitHub Release created, no host configured to receive one.
- No installer distributed to anyone.
- No certificate generated or installed.
- No automatic update installation — unchanged from
  `docs/phase-3-auto-update.md`; there is still no installer-applying code
  path at all.
- No change to JARVIS permissions, IPC channels, automation capabilities,
  or any core feature.
- No commit, push, tag, or pull request performed by this milestone.

## Related documents

- [phase-3-production-readiness.md](phase-3-production-readiness.md) —
  Milestone 1's packaging hardening and the original release-checklist
  sketch, which now points here.
- [phase-3-code-signing.md](phase-3-code-signing.md) — Milestone 3's
  signing configuration and `Get-AuthenticodeSignature` verification.
- [phase-3-auto-update.md](phase-3-auto-update.md) — Milestone 4's
  safety-gating state machine and its own rollback/recovery section.
- [data-locations.md](data-locations.md) — exactly what survives an
  uninstall and why.
- [security-model.md](security-model.md) — the fail-safe behavior each
  on-disk file falls back to if corrupted, referenced above under
  **Rollback and recovery**.
