# Phase 2, Milestone 8 — local memory

Short notes the user writes about how they want to be worked with, stored on
their own machine, retrievable a handful at a time.

This document explains what memory is here, what it deliberately is **not**,
and why each of those decisions was made. It complements
[architecture.md](architecture.md) and [security-model.md](security-model.md);
where they disagree with this file, they are the ones that were written to
cover the whole system and they win.

---

## What a memory is

A record with these fields, and no others:

| Field                     | Meaning                                                             |
| ------------------------- | ------------------------------------------------------------------- |
| `id`                      | A UUID, assigned by the main process.                               |
| `scope`                   | `session`, `project` or `personal`.                                 |
| `category`                | One of seven closed values (see below).                             |
| `content`                 | The note itself. Up to 2 000 characters.                            |
| `source`                  | `user` or `import`. Stamped by the main process.                    |
| `createdAt` / `updatedAt` | UTC ISO-8601, from the main process's clock.                        |
| `importance`              | 1–5. Used only for ordering.                                        |
| `confidence`              | 0–100. Used only for ordering.                                      |
| `expiresAt`               | A UTC ISO-8601 instant, or `null`.                                  |
| `pinned`                  | "Always relevant". The user's own signal, and it outranks the rest. |

The seven categories are the seven memory types the milestone asked for:
`user-preference`, `assistant-setting`, `project-decision`,
`project-convention`, `active-task`, `completed-task`, `agent-preference`. A
closed vocabulary rather than a free-text tag, because a category is
displayed, filtered on and used to break ties in retrieval, and a free-text
tag would be one more unbounded user-controlled string reaching all three.

## What a memory is not

**It is not authority.** A record declares no field for a permission, a tool,
an action type, a provider, a command or a path, and nothing anywhere in this
codebase reads one out of `content`. The string is stored, displayed and
matched against a search query; that is the complete list of things done with
it. No memory can widen what an agent may do, change a permission decision, or
name something to run.

**It is not written by a model.** `source` has exactly two members, `user` and
`import`, and each is stamped by the one handler that performs that operation
— the input schema has no `source` field for a caller to supply. There is no
value a chat reply, an agent step or an inference could be stored under, so
"never silently save model output as memory" is a property of the type rather
than a check that could be forgotten. There is also no `memory.capture`, no
`memory.infer` and no `memory.learn` action type, and nothing in the chat or
agent paths calls a memory writer.

**It is not a transcript.** Nothing stores a conversation. A record is a note
someone typed into a form and saved, capped at 2 000 characters, 200 records
per scope.

**It is not a credential store.** No field of a record can carry one by name —
every object is a `strictObject`, so a document containing `apiKey`, `token`
or `password` is refused outright rather than stored and ignored. Values are a
separate and weaker matter; see "The credential screen" below.

---

## The three scopes are three storage backends

This is the part worth reading closely, because isolation here is a property
of _where the bytes are_ rather than of a filter someone has to remember to
apply.

### `session`

Held in a closure created per `registerIpcHandlers` call, exactly like the
approved-project session. **Never written to disk at all.** There is no
`session` branch in any function in `main/memory-store.ts` that touches the
filesystem, so this is not a policy that could be changed by a configuration
mistake — there is nowhere for a session note to go. Closing Local Agent ends
it.

### `project`

One file per approved project:

```
%APPDATA%\Local-Agent\memory\projects\<key>.json
```

`<key>` is the first 32 hexadecimal characters of the SHA-256 of the project's
**canonical, lowercased** root path. Three consequences, each deliberate:

- **The path is never stored.** A project path carries a user name, often a
  client or employer name, and sometimes the existence of a project that is
  itself confidential. A directory listing of `%APPDATA%` should not disclose
  any of that.
- **The key is derived, never supplied.** No caller passes a path, a key or a
  project name into the store module; `requireProjectMemoryFile()` in
  `main/ipc.ts` reads the approved project from the session and derives the
  name. There is no parameter through which one project's session could name
  another project's file.
- **Lowercasing matters.** Windows paths are case-insensitive, so `C:\Work\App`
  and `c:\work\app` are the same project, and two stores for it would silently
  split someone's notes in half.

Reading or writing this scope requires a project approved in the current
session. With none, every project operation fails with `MEMORY_NO_PROJECT` —
except a retrieval, which skips the scope rather than failing, because a
reminder is not worth refusing because one of three sources is unavailable.

### `personal`

One file, `%APPDATA%\Local-Agent\memory\personal.json`. The only scope that
outlives both the session and the project.

### A record cannot change scope

An update addresses a record by id _within_ the scope its own submitted record
names, and a stored record found in a different scope is refused rather than
relocated. There is no move operation. Editing a project note into a personal
one is therefore not expressible — which is what keeps project isolation from
depending on the renderer behaving.

---

## Storage behaviour

`main/memory-store.ts` mirrors `main/settings.ts`, `main/policy.ts` and
`main/agent-profiles.ts` in detail, because a memory file is the same _kind_
of thing those are: a user-editable document the application must read without
trusting it.

- **Loading never throws and never merges.** A missing file, an unreadable
  one, an oversized one, malformed JSON, a `__proto__` key anywhere in it, a
  document the schema rejects, or a document declaring a scope other than the
  one asked for, all resolve the same way: an empty store. A document either
  validates in full, as itself, or it is discarded in full.
- **The size check happens before the read.** A file that grew without bound
  should not be pulled into the privileged process's memory to discover that
  it is too large.
- **Writing is atomic and re-validated.** Checked against the schema
  immediately before serialising, written to a uniquely named temporary file
  in the same directory, flushed, and moved into place with a single rename.
- **Nothing is created by reading.** The `memory\` directory appears on the
  first write and not before.

### Expiry

A record past its own `expiresAt` is filtered out of every list, search,
retrieval and export, and is dropped from the file on the next write to that
scope. **Reads never write**, so an expiry does not by itself cause disk
activity: the record disappears from every view immediately and leaves the
file the next time anything is saved. An `expiresAt` that will not parse
counts as _expired_, not as "no expiry" — treating unreadable state as "keep
using this indefinitely" is the wrong direction to fail in for a privacy
control.

---

## Retrieval

Bounded keyword retrieval, using the same `extractObjectiveKeywords` the
coding planner already uses — not a second extractor. The whole operation is a
substring scan over at most 200 short strings per scope.

- A record is eligible if its content contains at least one keyword from the
  objective, **or** if it is pinned. Pinning means "always relevant"; a pin
  that only took effect when the objective happened to mention the right word
  would not be a pin.
- Ordering is: relevance (a count of distinct matching keywords), then pinned,
  then importance, then confidence, then recency, then a total tie-break on
  `id`. Deterministic, so the behaviour is testable rather than incidentally
  stable.
- Results are deduplicated _after_ ordering, by case- and
  whitespace-insensitive content, so the survivor of two identical notes is
  the higher-ranked one.
- The result is capped at **8 records**, and `memoryRetrievalResultSchema`
  cannot carry more — the milestone's rule that the whole store is never
  handed to a model is enforced by the type, not only by the code that fills
  it.

There is no vector index, no embedding service and no background indexing
anywhere in this path, and no dependency was added for any of it.

> **Nothing calls retrieval from a model path yet.** `memory:retrieve` exists,
> is permission-gated and is tested, but no chat or agent code path invokes
> it. It is the documented seam for a later milestone, not a working
> integration, and it is described that way rather than implied to be wired.

---

## Security

### Everything goes through the existing pipeline

Five new action types, all routed through the unmodified
`handleActionProposal`:

| Action          | Decision  | Why                                                                                            |
| --------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `memory.read`   | `allow`   | Reading the user's own notes back to them changes nothing and leaves the machine nowhere.      |
| `memory.write`  | `allow`   | Stores text the user typed, in the app's own data directory, reversible by the same operation. |
| `memory.clear`  | `confirm` | Destroys a whole scope at once and cannot be undone.                                           |
| `memory.export` | `confirm` | Writes notes to a file outside the application, where its protections no longer apply.         |
| `memory.import` | `confirm` | Brings content from outside into a store.                                                      |

The last three are on the **confirmation floor**, so no policy edit can
downgrade them to `allow`. The first two are deliberately not: a native dialog
for every note saved or unpinned would train people to click through dialogs,
which is its own security problem, and the closest existing precedent —
`settings.write`, which also writes user-typed data into the app's own data
directory — is not on the floor either.

### The audit trail carries no private content

Memory proposals record an operation name, a scope, a bounded enum and at most
a _length_. **No record content, no search query, no objective and no file
path enters an audit record.** The audit log is append-only and therefore
cannot be redacted afterwards, which is exactly why nothing private is written
into it in the first place. This is asserted directly in
`tests/unit/main/ipc-memory.test.ts`.

### Export and import

Neither channel takes a path. `memory:export` and `memory:import` carry a
scope and nothing else; the file is chosen by the user in a native dialog the
main process owns (`main/memory-picker.ts`), exactly as `workspace:select`
already works. A compromised renderer can ask that the user be asked, and
nothing more.

The confirmation comes **before** the dialog, and declining it means the
dialog never opens at all.

An **export document** carries the records and the time, and nothing about
where they came from: no path, no project name, no project key, no machine
name, no user name. An export is the one artefact of this application designed
to leave the machine.

An **import file** is untrusted content:

- size-checked before it is read;
- parsed as JSON with no reviver, then screened for a prototype-polluting key;
- returned as `unknown` — `main/memory-transfer.ts` never claims it is a
  memory document;
- validated against `memoryExportSchema`, including the `kind` marker, so a
  file that is merely valid JSON is refused as "not a memory export" rather
  than probed field by field for something that happens to fit;
- required to declare the same scope it is being imported into, so someone's
  personal notes cannot land in a project store by accident;
- re-stamped per record: a **fresh id**, so a crafted file cannot collide with
  or address an existing record; `source: 'import'`, so the interface can
  always show that a note came from outside; and a new `updatedAt`.

The document is all-or-nothing; individual records may be refused while the
rest import, and the count is reported. A record is refused if its content
looks like a credential or if the scope already holds the same note. The
summary reports _how many_ were refused and never _why per record_ — a
per-record reason would be one more way for imported content to shape what is
displayed.

### The credential screen

`src/shared/memory/secret-scan.ts` runs at the write boundary — `add`,
`update` and `import` — and refuses content matching a recognisable credential
shape: a provider key with a known prefix, an `Authorization: Bearer` header
pasted out of a browser's network tab, a PEM private-key block, or a
credential-shaped label followed by a value (reusing `SECRET_FIELD_NAMES`, the
codebase's single source of truth for what a credential-bearing name looks
like). It also refuses a long, mixed-case, high-entropy token with no known
prefix.

Two things about it matter:

1. **It is not in the persisted-record schema, deliberately.** A loader that
   started refusing documents on a rule added later would discard a whole file
   of legitimate notes the next time the rule tightened. Screening at the
   boundary keeps new content out without putting existing content at risk.
2. **It is best effort and is described that way everywhere.** A credential is
   just a string; a short database password or a passphrase made of real words
   is indistinguishable from a note by any local rule. The screen reduces
   accidents. It is not a guarantee, and the Memory Centre says so on the
   form.

It reports a _category_ — `known-key-prefix`, `bearer-token`, `private-key`,
`labelled-secret`, `high-entropy-token` — and never the matched text. Echoing
back the fragment that looked like a secret would put the secret into an error
path, which is the one place it must never reach.

### Errors carry a code and nothing else

`MEMORY_ERROR_CODES` is a closed list. A failure crossing the IPC boundary
carries one of those codes and never a message, a path, a file name or the
content of a record. The sentences a person reads live in
`src/renderer/memory/memory-controller.ts`, in its own reviewed
`FAILURE_MESSAGES` table, and none of them interpolates anything.

---

## What was deliberately not built

Vector RAG; embedding services; cloud memory sync; telemetry; full transcript
storage; automatic personality inference; camera or screen memory; browser or
email memory; self-modifying permissions; multi-agent memory coordination;
unbounded background indexing.

No dependency was added for this milestone.

---

## Files

**Shared (pure).** `shared/memory/errors.ts`, `shared/memory/secret-scan.ts`,
`shared/memory/retrieval.ts`, `shared/memory/index.ts`,
`shared/schemas/memory.schema.ts`.

**Main.** `main/memory-store.ts` (where the bytes are),
`main/memory-service.ts` (the operations, over an injected accessor),
`main/memory-transfer.ts` (files outside the application),
`main/memory-picker.ts` (the two native dialogs).

**Renderer.** `renderer/memory/ipc-memory-client.ts` — the single file in that
directory permitted to touch `window.localAgent`, asserted by
`tests/unit/shared/chat-boundary-scan.test.ts` —
`renderer/memory/memory-controller.ts` (framework-independent, where the
testable behaviour lives), `renderer/memory/useMemory.ts`,
`renderer/memory/Memory.tsx`.
