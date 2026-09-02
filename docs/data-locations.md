# Data locations

Application code lives in this repository. **Runtime user data never does.**

Everything the application writes at runtime lives under the Windows per-user
application-data directory, resolved by Electron as
`app.getPath('userData')`:

```
%APPDATA%\Local-Agent\
```

which on a typical machine is:

```
C:\Users\<you>\AppData\Roaming\Local-Agent\
```

> **Current state.** Milestone 1 defines this layout in
> `src/shared/constants.ts` (`USER_DATA_PATHS`). No directory is created and
> no file is written yet; that begins in Milestone 3.

---

## Layout

```
%APPDATA%\Local-Agent\
├── settings.json                    non-secret settings
├── permissions\
│   └── policy.json                  permission policy
├── secrets\
│   └── secrets.enc                  encrypted credentials
├── logs\
│   └── audit\
│       └── audit-YYYY-MM-DD.jsonl   append-only audit trail, one file per UTC day
├── state\
│   └── emergency.json               emergency-stop state
└── memory\                          reserved, unused in Phase 1
```

| Path                      | Contains                                                                  | Notes                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `settings.json`           | Assistant name, user name, language, provider selection, `hasApiKey` flag | **Never a credential.** Strict schema; unknown keys rejected.                                                  |
| `permissions\policy.json` | Permission rules                                                          | Human-readable and human-editable. Cannot widen the model beyond the code-enforced floor.                      |
| `secrets\secrets.enc`     | API keys                                                                  | Encrypted with the asynchronous `safeStorage` API (Windows DPAPI). Never leaves the main process in plaintext. |
| `logs\audit\`             | One JSON object per line                                                  | Append-only. Records denials and rejected confirmations too.                                                   |
| `state\emergency.json`    | Emergency-stop state                                                      | Missing file on first launch means _disengaged_. Malformed existing file means _engaged_.                      |
| `memory\`                 | Reserved                                                                  | Nothing is written here in Phase 1.                                                                            |

## Why they are separate

Keeping these apart means no single file mixes concerns, and a mistake in one
area cannot leak into another. Settings can be shared or inspected without
exposing credentials. The audit log can be read without touching the policy
that produced it. Backing up settings does not back up secrets that would be
useless on another machine anyway.

## What is deliberately not here

- Nothing under `%PROGRAMDATA%` or any machine-wide location. Local Agent is
  per-user.
- No registry keys.
- No temporary files outside the application-data directory.
- No data in the repository working tree.

## For contributors and agents

Do not create runtime user data inside the repository. `.gitignore` covers the
common accidents (`/data/`, `/user-data/`, `/logs/`, `/secrets/`,
`/credentials/`, `.env`, `*.db`), but the rule is the point, not the safety
net.

Those directory rules are anchored to the repository root on purpose. An
unanchored `secrets/` would also match `src/main/secrets/`, a real module of
the application, and would silently drop it from version control. Key _files_
(`*.key`, `*.pem`, `*.pfx`, `*.p12`) stay unanchored and are ignored wherever
they appear.

If you need a scratch file while developing, put it outside the repository or
in a git-ignored path, and never put a real credential in it.
