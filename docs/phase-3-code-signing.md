# Phase 3, Milestone 3 — Windows code-signing preparation

**Status: prepared but not verified.** This milestone wires up safe,
environment-variable-driven configuration support for signing the Windows
installer, adds a preflight check that fails loudly if a signing request is
incomplete, and documents exactly what a real signed build still needs. No
certificate was purchased, generated, or installed, and no build in this
repository has ever produced a signed installer. A successful **unsigned**
build is not evidence that signing works — see **Verifying a signature**
below for the only real test of that.

---

## What exists after this milestone

- `scripts/check-signing-config.mjs` — runs automatically as the first step
  of `npm run package:win` (also runnable alone as `npm run check:signing`).
  It does not sign anything and does not call electron-builder. It only
  checks, before any build work starts, whether a signing request looks
  complete:
  - No `CSC_LINK` / `WIN_CSC_LINK` set → **signing was not requested.**
    Exits `0` immediately; `package:win` proceeds exactly as it always has,
    producing an unsigned installer. This is the state of local development
    and of this repository's CI today.
  - `CSC_LINK` (or `WIN_CSC_LINK`) set, but `CSC_KEY_PASSWORD` (or
    `WIN_CSC_KEY_PASSWORD`) missing, or `CSC_LINK` pointing at a local file
    that does not exist → **signing was requested but is incomplete.** Exits
    `1` with a specific message before `npm run build` or `electron-builder`
    ever runs, instead of failing deep inside a multi-minute build with an
    unclear error, or — worse — silently falling back to an unsigned
    installer that looks like every other build.
  - Both present and the file (if local) exists → prints a confirmation and
    lets the build proceed. **This is a completeness check, not a validity
    check.** It cannot tell a real certificate from an expired, revoked, or
    corrupt one, or from an intentionally wrong passphrase — only
    electron-builder's own signing step, or `Get-AuthenticodeSignature`
    afterward, can tell you that.
- `electron-builder.json` is **unchanged**. Nothing was added there, because
  nothing needs to be: electron-builder already signs automatically,
  whenever it finds those same environment variables, with zero
  configuration. The only thing this milestone adds is the preflight check
  in front of it and the environment plumbing described below.
- `.github/workflows/ci.yml`'s packaging step now passes `CSC_LINK` and
  `CSC_KEY_PASSWORD` through from two repository secrets of the same name.
  **Neither secret exists in this repository.** Referencing an unset GitHub
  Actions secret evaluates to an empty string, which
  `check-signing-config.mjs` treats exactly like signing was never
  requested — so CI's behavior is unchanged by this milestone. See **CI
  secret handling** below for what adding them later would require.
- Two new tests: `tests/unit/scripts/check-signing-config.test.ts` covers
  the pure validation logic (unset, blank, missing password, missing file,
  a URL, a base64 payload, the `WIN_`-prefixed variants, and precedence
  between the two). See **Tests** below.

## Certificate requirements

To actually produce a signed installer, the repository owner (not an agent —
see **Out of scope**, `AGENTS.md`) needs to obtain:

- An **Authenticode code-signing certificate**, in `.pfx`/`.p12` form (a
  private key plus its certificate chain), from a public certificate
  authority. Two shapes exist:
  - A standard **OV (Organization Validation)** certificate. Cheaper and
    faster to obtain, but Windows SmartScreen shows an "unrecognized app"
    warning until the certificate accumulates enough reputation from real
    downloads — which will not happen from CI builds or local testing.
  - An **EV (Extended Validation)** certificate, usually HSM-backed (a
    physical USB token or a cloud signing service such as Azure Trusted
    Signing or DigiCert KeyLocker). SmartScreen trusts it immediately, at
    higher cost and a more involved identity-verification process, and it
    frequently **cannot be exported as a portable `.pfx` file at all** —
    see **HSM-backed certificates** below.
- The certificate's subject name should match the publisher identity in
  `package.json`'s `author` field. That field currently holds a placeholder
  (`"Local Agent Project"`) — see
  [phase-3-production-readiness.md](phase-3-production-readiness.md)'s
  release checklist, which already calls out replacing it before a real
  release.

None of this was purchased, generated, or provisioned by this milestone.

## Supported environment variables

electron-builder reads these natively; nothing in this repository's own
code parses them beyond the completeness check described above.

| Variable                                        | Meaning                                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CSC_LINK` (or Windows-specific `WIN_CSC_LINK`) | The certificate: a path to a local `.pfx`/`.p12` file, an `https://` URL electron-builder downloads it from, or the certificate's own base64-encoded bytes. |
| `CSC_KEY_PASSWORD` (or `WIN_CSC_KEY_PASSWORD`)  | The passphrase protecting that `.pfx`/`.p12` file.                                                                                                          |

The `WIN_`-prefixed forms exist for projects that sign multiple platforms
with different certificates; this project only ever targets Windows, so
either form works identically here, and `CSC_LINK`/`CSC_KEY_PASSWORD` take
precedence if both are set (see the test file for the exact precedence
behavior).

**Never** commit a `.pfx`/`.p12` file, a certificate password, or a
`CSC_LINK` value pointing at one, to this repository — `.gitignore` already
blocks the common extensions (`*.pfx`, `*.p12`, `*.key`, `*.pem`), and
[AGENTS.md §4](../AGENTS.md) forbids it regardless of what `.gitignore`
catches.

### HSM-backed certificates

An EV certificate that lives in a cloud HSM (Azure Trusted Signing,
DigiCert KeyLocker, SSL.com eSigner, and similar) has no exportable `.pfx`
file at all — `CSC_LINK`/`CSC_KEY_PASSWORD` do not apply. Each of these
providers publishes its own `electron-builder` integration (typically a
`win.signtoolOptions.sign` custom signing function, or a dedicated
electron-builder plugin) that calls out to the provider's signing API
instead of a local file. Wiring one in is a real `electron-builder.json`
(or `electron-builder.js`, if the provider's integration needs
configuration logic rather than static JSON) change, deliberately **not**
made here: which provider to use is a purchasing decision this milestone
does not make on the repository owner's behalf, and each provider's
integration is different enough that speculatively wiring one up without a
real account to test against would be exactly the kind of unverified
"looks done" work the security rule for this milestone warns against.

## Local unsigned builds (unchanged)

```bash
npm run package:win
```

Works exactly as before this milestone, with zero environment variables
set. `check-signing-config.mjs` sees no `CSC_LINK`, prints one line saying
so, and exits `0`; `npm run build` and `electron-builder --win nsis` run
unchanged. See
[README.md's "Packaging a Windows installer"](../README.md#packaging-a-windows-installer)
for what the installer contains.

## Local signed builds (only if you have a real certificate)

```bash
# PowerShell, current session only — never written to a file this
# repository tracks.
$env:CSC_LINK = 'C:\path\to\your-certificate.pfx'
$env:CSC_KEY_PASSWORD = 'your-passphrase'
npm run package:win
```

If both variables are complete, `check-signing-config.mjs` prints a
confirmation and the build proceeds; electron-builder signs `Local
Agent.exe`, the NSIS installer, and its uninstaller during the existing
`npm run package:win` flow — no separate signing step to remember. If the
certificate itself turns out to be invalid, expired, or the password is
wrong, electron-builder's own signing step fails the build with `signtool`'s
error, which is a real, visible failure, not a silent fallback to unsigned.

**Always verify the result** — see below — rather than trusting that the
build simply not failing means signing succeeded.

## CI secret handling

`.github/workflows/ci.yml`'s "Package Windows installer" step already
passes `CSC_LINK` and `CSC_KEY_PASSWORD` through from repository secrets of
the same name. **Both are unset today** — this repository has no secrets
configured, and none were added by this milestone. If the repository owner
later obtains a certificate:

1. Base64-encode the `.pfx` file (`[Convert]::ToBase64String([IO.File]::ReadAllBytes('cert.pfx'))`
   in PowerShell), or host it somewhere electron-builder can fetch over
   `https://` — do not commit the raw file anywhere, including as a
   workflow artifact.
2. In the repository's GitHub settings, add two **repository secrets**:
   `CSC_LINK` (the base64 string or URL) and `CSC_KEY_PASSWORD` (the
   passphrase).
3. No further workflow change is needed. The next CI run picks them up
   automatically, `check-signing-config.mjs` sees a complete request, and
   the produced installer is signed.
4. Rotate or revoke the secrets in GitHub's settings if the certificate is
   ever replaced or the CI environment is ever suspected compromised — this
   repository has no code path that can do that for you.

CI logs the outcome of `check-signing-config.mjs` (unsigned vs. requested)
but, like electron-builder itself, never logs the secret values.

## Verifying a signature

The only real evidence a build is signed is checking the artifact itself,
in PowerShell, on the machine that built it:

```powershell
Get-AuthenticodeSignature "release\Local Agent Setup <version>.exe" | Format-List *
```

Read the `Status` field:

| `Status`       | Meaning                                                                                                                                                                                                                             |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Valid`        | Signed, and the signature chains to a certificate Windows trusts. What a real release needs.                                                                                                                                        |
| `NotSigned`    | No signature at all. **This is what every build produced by this repository has shown to date** — see `docs/phase-3-production-readiness.md`'s own `Get-AuthenticodeSignature` check from Milestone 1, unchanged by this milestone. |
| `UnknownError` | A signature is present but something about validating it failed — check `StatusMessage` for detail.                                                                                                                                 |
| `HashMismatch` | The file was signed, then modified afterward. Should never happen to a file straight out of `release/`; would be a real finding if it did.                                                                                          |
| `NotTrusted`   | Signed, but by a certificate Windows does not (yet) trust — expected for a brand-new OV certificate before it accumulates reputation, described above.                                                                              |

This milestone did not run this command against a signed build, because
this milestone has no certificate to sign with. Running it against the
current unsigned build (confirming `NotSigned`, as already recorded in
`phase-3-production-readiness.md`) is not a substitute for that and is not
claimed as one.

## Tests

`tests/unit/scripts/check-signing-config.test.ts` exercises
`evaluateSigningConfig` — the pure function `check-signing-config.mjs`'s CLI
wrapper calls — directly, with a fake `fileExists` so no real filesystem
access happens in the test. It covers: no variables set; a blank `CSC_LINK`;
a set `CSC_LINK` with no password; an existing-file check that fails; both
problems at once; a valid local-file request; an `https://` link (skips the
filesystem check); a long base64-looking link (also skips it); the
`WIN_`-prefixed variables; and that `CSC_LINK` takes precedence over
`WIN_CSC_LINK` when both are set. It does **not** and cannot test that a
real certificate signs successfully — there is no certificate to test with,
and inventing a fake one would only test electron-builder's own signing
code, not anything this repository owns.

## Explicitly not done here

Matching the task scope exactly:

- No certificate generated, purchased, or installed.
- No `.pfx`, private key, password, or secret file committed anywhere —
  confirmed by `git status` before this milestone's changes and unaffected
  by them (nothing new is written under a path `.gitignore` doesn't already
  cover).
- No release published, no publish target added (`electron-builder.json`
  still carries `"publish": null` from Milestone 1).
- No auto-update mechanism (still documented, not implemented, in
  `phase-3-production-readiness.md`).
- No change to assistant permissions, action types, or IPC channels — this
  milestone touches only `scripts/`, `package.json`,
  `electron-builder.json`'s absence of change, `.github/workflows/ci.yml`,
  documentation, and one new test file.

## Related documents

- [phase-3-production-readiness.md](phase-3-production-readiness.md) —
  Milestone 1's release checklist and the original, now-superseded-in-detail
  "Code signing" section, which now points here.
- [README.md — "Packaging a Windows installer"](../README.md#packaging-a-windows-installer)
- [security-model.md](security-model.md) — limitation 32 (unsigned
  installer, no update mechanism), unchanged by this milestone: it remains
  accurate until a real certificate produces a `Valid` result above.
