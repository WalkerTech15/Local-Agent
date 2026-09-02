/**
 * Persisted emergency-stop state storage for Local Agent.
 *
 * Reads and writes `state/emergency.json`. Mirrors `main/settings.ts`
 * closely — same atomic-write mechanics, same "never trust JSON loaded from
 * disk" posture — but with one deliberate difference: settings' loader
 * collapses every read failure (missing, unreadable, malformed, invalid) to
 * the same safe defaults, because for settings that is always the correct
 * fail-safe outcome. Emergency state cannot do that, because *which* failure
 * happened changes the correct outcome: a missing file is a legitimate first
 * launch and must resolve *disengaged*, while an existing file that is
 * unreadable, malformed or fails validation must resolve *engaged* — the
 * failure mode itself carries security meaning here, not just a signal to
 * fall back. `loadEmergencyState` therefore distinguishes "absent" from every
 * other read failure before handing off to the already-pure, already-tested
 * `resolveEmergencyState` (`shared/schemas/emergency.schema.ts`), which
 * applies exactly that rule.
 *
 * `loadEmergencyState` and `writeEmergencyState` take a plain state-file path
 * rather than a `UserDataPaths` object, exactly as `main/settings.ts` and
 * `main/policy.ts` do, so a test points at a file inside a temporary
 * directory and configures nothing else — never the real `%APPDATA%`.
 *
 * `engageEmergencyStop` and `resetEmergencyStop` are the two `perform`
 * callbacks a caller passes to `main/action-pipeline.ts`'s
 * `handleActionProposal` for the `emergency.engage` and `emergency.reset`
 * action types. Neither function makes a permission decision of its own —
 * `emergency.reset` requiring confirmation, surviving a rejected
 * confirmation, and remaining unbypassable by a model or a policy rule are
 * all already guaranteed by the Milestone 5 engine and executor before
 * either of these functions is ever called; this module only performs the
 * I/O once authorized.
 */

import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { FORBIDDEN_OBJECT_KEYS, REASON_EMERGENCY_ENGAGED_BY_USER } from '../shared/constants';
import {
  createEngagedEmergencyState,
  createInitialEmergencyState,
  emergencyStateSchema,
  resolveEmergencyState,
} from '../shared/schemas';
import type { EmergencyState, EmergencyStateSource } from '../shared/schemas';

/**
 * Mirrors `main/settings.ts`'s identical check, duplicated rather than
 * imported for the same reason `main/policy.ts` and `main/audit.ts`
 * duplicate theirs: this module should not gain a runtime dependency on an
 * already-reviewed module from an earlier milestone for one small, pure,
 * self-contained check. `JSON.parse` does not fall for a literal
 * `"__proto__"` key — modern engines create it as an ordinary own property —
 * but nothing downstream of this loader is allowed to assume that.
 */
const MAX_EMERGENCY_STATE_JSON_DEPTH = 64;

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_EMERGENCY_STATE_JSON_DEPTH) return true;
  if (value === null || typeof value !== 'object') return false;

  if (Array.isArray(value)) {
    return value.some((element) => containsForbiddenKey(element, depth + 1));
  }

  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (FORBIDDEN_OBJECT_KEYS.includes(key)) return true;
    if (containsForbiddenKey(record[key], depth + 1)) return true;
  }
  return false;
}

/**
 * Same mechanism as `main/settings.ts`'s identical retry, for the same
 * reason — a destination-file rename can transiently fail on Windows
 * (`EPERM`, `EBUSY`, `EACCES`) when something else briefly holds the
 * destination path open. The budget here is deliberately larger than
 * settings.ts's: this repository now has two modules performing this same
 * atomic-rename pattern, and running both modules' own concurrent-write
 * tests together in one suite measurably increases how often a transient
 * sharing violation needs more than settings.ts's original 5 attempts to
 * clear — observed directly while developing this module's own concurrency
 * test, not a hypothetical concern. Each attempt is still one whole-file
 * rename, so a larger budget only ever risks a longer delay, never a
 * partial write.
 */
const RENAME_MAX_ATTEMPTS = 10;
const RENAME_RETRY_DELAY_MS = 20;

function isTransientRenameError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const { code } = error;
  return code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt === RENAME_MAX_ATTEMPTS || !isTransientRenameError(error)) {
        throw error;
      }
      await delay(RENAME_RETRY_DELAY_MS * attempt);
    }
  }
}

function isEnoent(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const { code } = error;
  return code === 'ENOENT';
}

/**
 * Loads `stateFile`, applying `resolveEmergencyState`'s rules exactly.
 *
 * Never throws. A missing file resolves disengaged — a legitimate first
 * launch, never treated as corruption. Every other read failure (permission
 * denial, a directory sitting where the file should be, any I/O error), any
 * malformed JSON, a `__proto__`/`constructor`/`prototype` key anywhere in the
 * parsed document, or a document `emergencyStateSchema` rejects for any
 * reason, all resolve engaged, with `reason` set to the stable
 * `REASON_EMERGENCY_STATE_UNREADABLE` constant — never a raw error message,
 * a filesystem path, or any other sensitive detail.
 *
 * Never creates a file or directory. Never returns a shared reference —
 * `resolveEmergencyState` already returns a fresh object per call.
 *
 * @param now UTC ISO-8601, supplied by the caller so this stays testable
 *   with a fixed clock — see `resolveEmergencyState`.
 */
export async function loadEmergencyState(stateFile: string, now: string): Promise<EmergencyState> {
  let rawText: string;
  try {
    rawText = await readFile(stateFile, 'utf8');
  } catch (error) {
    const source: EmergencyStateSource = isEnoent(error)
      ? { kind: 'absent' }
      : { kind: 'unreadable' };
    return resolveEmergencyState(source, now).state;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return resolveEmergencyState({ kind: 'unreadable' }, now).state;
  }

  if (containsForbiddenKey(parsed)) {
    return resolveEmergencyState({ kind: 'unreadable' }, now).state;
  }

  return resolveEmergencyState({ kind: 'present', raw: parsed }, now).state;
}

/**
 * Writes `state` to `stateFile` atomically.
 *
 * Re-validates against `emergencyStateSchema` immediately before serialising,
 * so a caller cannot persist a value that only *claims* the `EmergencyState`
 * type at compile time. The directory is created if missing. The document is
 * written to a uniquely named temporary file in the same directory —
 * required for the final rename to be atomic on the same volume — flushed to
 * disk, then moved into place with a single `rename`, retried on a transient
 * Windows sharing violation. A reader therefore only ever sees the previous
 * complete state or the new complete one, never a partial write, and never a
 * truncated file: nothing about this sequence writes through the original
 * path until the replacement is fully ready. On any failure after the
 * temporary file is created, it is removed before the error propagates, and
 * the file at `stateFile` — if one existed — is untouched.
 */
export async function writeEmergencyState(stateFile: string, state: EmergencyState): Promise<void> {
  const validated = emergencyStateSchema.parse(state);
  const payload = JSON.stringify(validated, null, 2);

  const dir = dirname(stateFile);
  await mkdir(dir, { recursive: true });

  const tempFile = join(dir, `${basename(stateFile)}.${randomUUID()}.tmp`);

  try {
    const handle = await open(tempFile, 'w');
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    await renameWithRetry(tempFile, stateFile);
  } catch (error) {
    await rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Engages the emergency stop and persists it. The `perform` callback for the
 * `emergency.engage` action type — call only through
 * `handleActionProposal`, never directly.
 *
 * `emergency.engage` requires no confirmation (it is not in
 * `CONFIRMATION_REQUIRED_ACTION_TYPES`): stopping the assistant must never be
 * obstructed by a prompt. `reason` is always the fixed
 * `REASON_EMERGENCY_ENGAGED_BY_USER` constant, never free text — see
 * `createEngagedEmergencyState`.
 *
 * @param now UTC ISO-8601, supplied by the caller so this stays deterministic.
 */
export async function engageEmergencyStop(stateFile: string, now: string): Promise<EmergencyState> {
  const state = createEngagedEmergencyState(now, REASON_EMERGENCY_ENGAGED_BY_USER);
  await writeEmergencyState(stateFile, state);
  return state;
}

/**
 * Disengages the emergency stop and persists it. The `perform` callback for
 * the `emergency.reset` action type — call only through
 * `handleActionProposal`, never directly.
 *
 * This function itself has no notion of confirmation: `emergency.reset` is
 * in both `CONFIRMATION_REQUIRED_ACTION_TYPES` and
 * `EMERGENCY_AVAILABILITY_FLOOR_ACTION_TYPES`, so `decidePermission` always
 * resolves it to `confirm`, regardless of policy content, and `execute`
 * refuses to run any `perform` callback for a `confirm` verdict without an
 * already-approved confirmation. By the time this function runs, that has
 * already happened; a rejected confirmation means `execute` returns
 * `aborted` without ever calling this function, so the on-disk state is left
 * exactly as it was.
 */
export async function resetEmergencyStop(stateFile: string): Promise<EmergencyState> {
  const state = createInitialEmergencyState();
  await writeEmergencyState(stateFile, state);
  return state;
}
