# Phase 3, Milestone 4 — Windows auto-update preparation

**Status: prepared, not implemented, not verified.** This milestone adds the
safety-gating logic, the state model, tests, and documentation an eventual
auto-update mechanism would need — and, deliberately, nothing that could
check for, download, or install one. There is no `electron-updater`
dependency, no update feed, no IPC channel, and no code path anywhere in
this repository that makes a network request looking for a newer version.
Nothing in Local Agent updates itself today, and this milestone does not
change that.

---

## Why so little runs

Three things this milestone was explicitly asked not to do make "implement
auto-update" and "prepare for auto-update" genuinely different tasks here:

- **No update server was published, and none is run by this repository.**
  Whatever provider is eventually configured has to be something that
  already exists — this milestone cannot stand one up.
- **No release has been uploaded anywhere.** There is nothing at any feed
  URL to check against yet, real or placeholder.
- **No certificate exists** (`docs/phase-3-code-signing.md`). An update
  mechanism that could install an unsigned build would be strictly worse
  than having none — see the Security rule below.

Given all three, any code that actually called an update provider would be
calling nothing, and any test claiming to verify "update delivery works"
would be testing against a fake server this repository invented for the
occasion — which is exactly the kind of unverified "looks done" work the
task's own security rule warns against. So this milestone stops at the line
where real network behavior would start: it builds and tests the _decision
logic_ that a real integration would sit behind, in the open, reviewable
now, rather than deferring it to whichever future milestone adds the
network call and hoping the safety logic gets written carefully under that
milestone's own time pressure.

## Chosen distribution approach

**GitHub Releases, via `electron-updater`'s built-in `github` provider,
with `electron-builder`'s `generic` (plain HTTPS) provider supported as a
fallback.** Reasoning:

- `electron-builder` (already a dependency, pinned exact version
  `26.15.3`) and `electron-updater` (same publisher, same major version
  line) are designed as a matched pair — the `latest.yml`
  metadata `electron-builder` already knows how to write during a publish
  is exactly what `electron-updater`'s `github` provider expects to read.
- It needs no infrastructure this project would have to run or secure.
  GitHub Releases is storage and a CDN this repository does not operate;
  the alternative (a `generic` HTTPS provider pointed at a self-hosted
  file server) is supported by the same configuration shape for exactly
  the case where GitHub Releases is not the right fit later, without this
  milestone having to choose between them prematurely.
- Both providers verify the downloaded artifact's signature before
  `electron-updater` allows it to install — see **How signature
  verification works** below.

This is a decision to document and prepare for, not a service to publish.
Nothing here has published a release to GitHub or anywhere else.

## What exists after this milestone

All of it lives in `src/shared/update/` — pure, tested, no I/O, no
Electron, no network — following the same shape as `src/shared/automation/`
and `src/shared/workflow/`:

- **`states.ts`** — the state machine. Seven states (the six the milestone
  brief named, plus `idle`; see the doc comment in the file for why `idle`
  is the necessary seventh), ten events, and one transition table.
  `transitionUpdateState(state, event)` returns the next state or `null`
  for an illegal pair — for example, `approveDownload` from `idle` (nothing
  has been found yet) or `check` from `disabled` (updates are off). No
  state transitions out of `disabled` except an explicit `enable` event,
  and no state transitions _into_ a check, a download, or anything else
  happening on its own — every forward transition in the table is a
  response to something the caller did, never a timer this module owns.
- **`config.ts`** — `resolveUpdateConfig(env, { isPackaged })`. Pure,
  fails closed: updates are `enabled: true` only when **all four** hold at
  once — an explicit `LOCAL_AGENT_ENABLE_UPDATES=1` opt-in, a valid
  `https://` `LOCAL_AGENT_UPDATE_FEED_URL`, a recognized
  `LOCAL_AGENT_UPDATE_PROVIDER` (`github` or `generic`), and
  `isPackaged: true` (a development run is never eligible, regardless of
  environment variables — there is nothing to atomically replace). Missing
  any one produces `enabled: false` with the specific reason(s) why.
- **`guard.ts`** — `canInstallUpdate(state, approval)`. This is the
  milestone's security rule, in code: installation is `allowed: true` only
  when the state is `downloaded` **and** `sourceTrusted` **and**
  `signatureValid` **and** `userApproved` are all true. Each is a named,
  independent field — not one boolean a caller could set once for
  convenience — and the function reports every failing reason at once, not
  just the first.
- **`errors.ts`** — eight error codes (`UpdateError`), the same closed-list
  shape as `AutomationError`/`WorkflowError`: a failure carries a code and
  a reviewed sentence, never an interpolated URL or a fragment of a
  download's own output.
- **`schemas/update.schema.ts`** — `zod` schemas for the state, provider,
  error code, and a display-only status shape. Nothing validates against
  these yet, because nothing crosses an IPC boundary yet; they exist so a
  future milestone that does wire one up starts from a reviewed shape.
  Deliberately **not** re-exported from `schemas/index.ts` yet, unlike
  every other schema there — that barrel is imported by the preload and
  the renderer, and every other entry in it backs a real, wired channel.
  Adding this one would bundle unused code into both processes for no
  present benefit; a future milestone re-exports it the day it wires a
  real channel.

Two build-time-only scripts, mirroring `check-signing-config.mjs` exactly:

- **`scripts/check-update-config.mjs`** — runs as part of `npm run
package:win` (`check:update`, after `check:signing`). If
  `LOCAL_AGENT_ENABLE_UPDATES` is unset, it passes immediately — the normal
  default. If it is `"1"`, it requires a valid feed URL, a recognized
  provider, **and** a complete, valid signing configuration (it calls
  `check-signing-config.mjs`'s own `evaluateSigningConfig` directly rather
  than restating its rules) — enforcing **"require signed releases before
  update installation can be enabled"** at the configuration level, before
  any build work starts.
- **`scripts/check-update-config.d.mts`** — the same typing bridge
  `check-signing-config.d.mts` provides, so the test suite can import the
  `.mjs` module from a typechecked `.ts` test.

Nothing else changed. `electron-builder.json` still has `"publish": null`
(from Milestone 1) — no publish target was added, because publishing a
release is explicitly out of scope. No `IpcHandlerRuntime` field, no IPC
channel, no action type, no renderer component, and no new dependency in
`package.json`.

## Safe update states

| State         | Meaning                                                                                                                                                  | Reachable by                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `disabled`    | Updates are off. The only state possible when `resolveUpdateConfig` returns `enabled: false` — which is every configuration this repository ships today. | Initial state; `disable` from anywhere                                                 |
| `idle`        | Updates are enabled by configuration, but no check is in progress and nothing was found.                                                                 | `enable` from `disabled`; `noUpdateFound` from `checking`; `dismissError` from `error` |
| `checking`    | A check is in progress.                                                                                                                                  | Explicit `check` event from `idle` only — never self-initiated                         |
| `available`   | A newer version was found at the configured, trusted feed.                                                                                               | `updateFound` from `checking`                                                          |
| `downloading` | The user explicitly approved downloading it.                                                                                                             | Explicit `approveDownload` event from `available` only                                 |
| `downloaded`  | The download finished. **Not** "installed," and not a transition to any installing state — see below.                                                    | `downloadSucceeded` from `downloading`                                                 |
| `error`       | The last check or download failed.                                                                                                                       | `checkFailed` from `checking`; `downloadFailed` from `downloading`                     |

Reaching `downloaded` is not itself permission to install anything —
`canInstallUpdate` above is the only thing that can say yes, and it needs
three more facts about that specific download, not just the state.

## The security rule, and how it is enforced here

> Never download, install, or apply an update unless the update is from
> the configured trusted source, has a valid signature, and the user
> explicitly approves installation.

This milestone enforces the two ends of that sentence that are testable
without a live network:

- **"Never enable it at all without a signed release."**
  `check-update-config.mjs` refuses to let `LOCAL_AGENT_ENABLE_UPDATES=1`
  pass CI or a local packaging run unless code signing is also fully
  configured. An unsigned build can never reach the point of having an
  update mechanism turned on for it in the first place.
- **"Never install without trust, a valid signature, and explicit
  approval, once a download exists."** `canInstallUpdate` requires all
  three, plus the `downloaded` state, and refuses on any one missing —
  tested exhaustively in `tests/unit/shared/update-guard.test.ts`.

What this milestone cannot enforce, because it does not exist yet, is the
middle of the sentence — actually checking a signature on a real download.
That is `electron-updater`'s job (see below), not this repository's; this
milestone's job was to make sure nothing here could ever be positioned to
skip that check once it exists.

### How signature verification would work, when wired

`electron-updater` — not currently a dependency — performs Windows
signature verification itself before it will apply a downloaded NSIS
update: it checks the downloaded installer's Authenticode publisher name
against the currently-running application's own publisher name, and
refuses to apply an update whose publisher does not match. This is the
same signature this project already documents verifying manually with
`Get-AuthenticodeSignature` in `docs/phase-3-code-signing.md` — a future
integration would not invent a second verification mechanism, it would
rely on the one that already has to exist for the installer to be
distributable at all.

### Never replacing a running application on a bad download

Neither a failed download nor an invalid signature can replace the running
application, for two independent reasons:

1. **This repository's own state machine.** `downloading` only reaches
   `downloaded` via `downloadSucceeded` — a `downloadFailed` event goes to
   `error` instead, and `canInstallUpdate` refuses anything not in
   `downloaded`.
2. **`electron-updater`'s own mechanism**, once wired: it downloads to a
   staging location, verifies the artifact there, and only replaces
   anything at the moment the application deliberately quits to install
   (`quitAndInstall()`) — never live, never mid-run. A failed or
   unverified download simply never reaches that call.

## Local behavior today

```bash
npm run package:win
```

Unaffected. `check:update` (like `check:signing`) sees no
`LOCAL_AGENT_ENABLE_UPDATES=1`, prints one line saying updates stay
disabled, and exits `0`. The running application makes no update-related
network call, because none exists in the codebase to make. This is true
whether or not any of the `LOCAL_AGENT_UPDATE_*` variables are set —
nothing reads them at runtime yet; only the build-time script does.

## What enabling this later would still require

None of the following exists yet. In order:

1. **A real, purchased code-signing certificate**
   (`docs/phase-3-code-signing.md`) and at least one real signed release
   built and verified with `Get-AuthenticodeSignature`.
2. **The `electron-updater` dependency**, added deliberately — pinned to
   an exact version, reviewed like any other new dependency this project
   takes on — and a real main-process module that drives
   `src/shared/update/`'s state machine from `electron-updater`'s own
   events (`checking-for-update`, `update-available`, `download-progress`,
   `update-downloaded`, `error`), calling `canInstallUpdate` before ever
   calling `quitAndInstall()`.
3. **A real IPC channel** (`update:status`, or similar), added the same
   way every other channel in this codebase was — a new schema, a new
   `IpcHandlerRuntime` field if needed, routed through the unmodified
   permission pipeline — so the renderer can show the state and let the
   user approve a download or an install. This milestone adds none,
   deliberately: **"Do not change JARVIS permissions or automation
   capabilities"** was explicit scope for this milestone, and a real IPC
   channel is exactly that kind of change, correctly deferred to whichever
   milestone actually wires a live update check.
4. **A published release** at the configured feed — `latest.yml` (or
   `latest-windows.yml`) and the signed installer itself, uploaded to
   GitHub Releases (or wherever `LOCAL_AGENT_UPDATE_PROVIDER=generic`
   points). Not done by this milestone; publishing is explicitly out of
   scope for it.
5. **A CI or local decision to actually set `LOCAL_AGENT_ENABLE_UPDATES=1`
   and the three configuration variables** — `check-update-config.mjs`
   already refuses this today unless signing is also complete, so this
   step is safe by construction even before the earlier ones are done; it
   just will not currently produce a build that can update, because the
   dependency and the wiring in step 2 do not exist.

## Rollback and recovery requirements

Not implemented by this milestone; documented so a future one inherits a
plan rather than a blank page:

- **No update this repository ever produces should overwrite the previous
  installer.** Each release's artifact should be retained wherever it is
  hosted (a GitHub Release is not deleted by publishing a new one), so a
  user who needs to reinstall a known-good prior version by hand always
  can.
- **`electron-updater` has no built-in "roll back to the previous version"
  action** — an update, once installed, is installed. The only recovery
  path from a bad update, today and under any design this document
  proposes, is the user manually downloading and running a prior
  installer — exactly the same manual process that is the _only_ update
  mechanism Local Agent has right now, before this milestone or after it.
- **A bad update should never be pushed to the same feed URL a good one
  was served from without a version bump.** `electron-updater` compares
  versions; overwriting a release in place, rather than publishing a new
  version and (if necessary) marking the bad one as a draft/pre-release on
  GitHub, is how a bad update could reach users who already successfully
  updated once. This is a release-process discipline, not something code
  in this repository can enforce.
- **Uninstalling and reinstalling is always available as a manual
  recovery**, independent of anything in this document:
  `%APPDATA%\Local-Agent` is untouched by the NSIS installer's default
  uninstall behavior (`docs/data-locations.md`,
  `docs/phase-3-production-readiness.md`), so a user's settings, secrets,
  permission policy, memory, and audit log all survive a manual
  reinstall even without any update mechanism at all.

## Tests

`tests/unit/shared/update-states.test.ts` — every legal transition, and
representative illegal ones (no self-starting a check, no skipping
approval to reach `downloading`, no transition out of `downloaded` except
`disable`, `disable` legal from every non-`disabled` state, every declared
state reachable).

`tests/unit/shared/update-config.test.ts` — disabled by default; stays
disabled with each of the four conditions individually missing or invalid
(no opt-in, unpackaged, non-https URL, malformed URL, unrecognized
provider); enabled only when all four hold; never leaks a provider or feed
URL while disabled.

`tests/unit/shared/update-guard.test.ts` — installation allowed only with
state `downloaded` and all three approval fields `true`; refused, with the
specific reason(s), for every other state and for each approval field
individually `false`; reports all failing reasons at once.

`tests/unit/scripts/check-update-config.test.ts` — not requested when
unset; fails on a missing/invalid feed URL, an unrecognized provider, and
critically, on signing being absent or incomplete even when the update
configuration itself is otherwise complete; passes only when both are
complete; and one test exercises the real (not injected)
`evaluateSigningConfig` to confirm the default, unconfigured environment
fails closed.

None of these tests, and nothing else in this milestone, exercises a real
network request, a real download, or a real installation. There is nothing
in this repository yet capable of performing any of those.

## Explicitly not done here

Matching the task scope exactly:

- No update server published or run.
- No release uploaded anywhere.
- No certificate generated.
- No automatic installation — there is no installation code path at all,
  automatic or otherwise.
- No change to JARVIS permissions, action types, or automation
  capabilities — no new `IpcHandlerRuntime` field, IPC channel, or
  permission-policy rule.
- No commit, push, or pull request.

## Related documents

- [phase-3-code-signing.md](phase-3-code-signing.md) — the signing
  configuration this milestone's own preflight check requires before
  updates may be enabled.
- [phase-3-production-readiness.md](phase-3-production-readiness.md) —
  Milestone 1's release checklist and the original auto-update section,
  which now points here for detail.
- [security-model.md](security-model.md) — limitation 32, unchanged by
  this milestone: Local Agent still has no update mechanism and makes no
  background network call.
- [../AGENTS.md](../AGENTS.md) §6 — self-updating is listed among the
  capabilities this project must not quietly enable; this milestone's
  entire design is built around never crossing that line by accident.
