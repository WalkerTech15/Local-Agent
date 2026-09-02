/**
 * Append-only audit log writer for Local Agent.
 *
 * Writes one validated JSON object per line to
 * `%APPDATA%\Local-Agent\logs\audit\audit-<UTC date>.jsonl`, one file per UTC
 * calendar day. A denial and a rejected confirmation are written through the
 * exact same path as a success — nothing here decides *what* gets logged, it
 * only makes logging safe.
 *
 * Two defences run on every candidate before anything reaches disk:
 *
 *  1. **Recursive, field-name-based redaction** ({@link redactSecrets}), so a
 *     caller that accidentally passes a real credential under a
 *     secret-looking key is scrubbed rather than rejected outright.
 *  2. **Full schema validation** (`auditRecordSchema`), the backstop: if
 *     redaction were ever bypassed, skipped or regressed, a secret-named
 *     field whose value is not the redaction placeholder still fails
 *     validation, and nothing is written.
 *
 * `auditLogDir` is a plain directory path, exactly as `main/settings.ts`
 * takes a plain file path — a test points at a temporary directory and
 * configures nothing else, never the real `%APPDATA%`. There is no clock
 * parameter: the UTC calendar day used for the file name is read directly
 * from the record's own `timestamp` field (already required, already
 * validated as UTC ISO-8601 with no offset), which keeps this module
 * clock-free and every test fully deterministic.
 *
 * This module accepts a fully-formed candidate record — `schemaVersion`,
 * `eventId`, `correlationId` and `timestamp` included — rather than
 * generating any of them itself. Identifier and clock access belong to the
 * caller that knows a real decision just happened (the Milestone 5
 * permission engine); this module stays a pure I/O, redaction and validation
 * boundary, mirroring how `writeSettings` takes a complete `Settings` object
 * rather than assembling one.
 *
 * No function in this module updates, deletes, truncates or rewrites a
 * record, and none reads the log back. Appending is the only capability
 * exposed.
 */

import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';

import {
  AUDIT_LOG_FILE_EXTENSION,
  AUDIT_LOG_FILE_PREFIX,
  AUDIT_PARAM_MAX_DEPTH,
  AUDIT_PARAM_MAX_TOTAL_NODES,
  FORBIDDEN_OBJECT_KEYS,
  isSecretFieldName,
  REDACTED_PLACEHOLDER,
} from '../shared/constants';
import { auditRecordSchema, isPlainObject } from '../shared/schemas';
import type { AuditRecord } from '../shared/schemas';

/**
 * Depth and node budget shared by the safety scan and the redaction walk.
 *
 * Both walks cover the whole candidate record, not just `parameters` — a
 * hostile candidate could nest a pathological structure under any field, not
 * only the one `auditParametersSchema` bounds — so this must have its own
 * cap, independent of and slightly larger than the parameters-only budget,
 * to account for the record's own wrapper fields.
 */
const CANDIDATE_MAX_DEPTH = AUDIT_PARAM_MAX_DEPTH + 4;
const CANDIDATE_MAX_NODES = AUDIT_PARAM_MAX_TOTAL_NODES + 64;

interface WalkBudget {
  nodes: number;
}

/**
 * Recursively scans a candidate for two structural problems that must never
 * reach redaction or validation: a prototype-pollution key at any depth, and
 * a cyclic reference.
 *
 * Neither can be safely left to `auditRecordSchema` alone. Zod's
 * `strictObject` decides whether a key is "known" in a way that, for a
 * literal own property named `"__proto__"`, resolves through the inherited
 * accessor on its shape object instead of an explicit key list — so it does
 * not reliably reject one, even though `Object.keys` on the input correctly
 * lists it. And redaction below builds a *new* object graph rather than
 * mutating in place, so if a cycle were left for the schema to discover
 * after redaction, it would be discovering a cycle in a tree the original
 * cyclic reference never actually reaches. Catching both here, on the raw
 * candidate, before either redaction or validation runs, avoids relying on
 * either downstream step to catch what it cannot reliably see.
 *
 * `auditParametersSchema` already performs an equivalent walk over
 * `parameters` alone; this covers the whole candidate, including the wrapper
 * fields that schema never sees.
 */
function findCandidateSafetyIssue(
  value: unknown,
  ancestors: ReadonlySet<object>,
  depth: number,
  budget: WalkBudget,
): string | null {
  budget.nodes += 1;
  if (budget.nodes > CANDIDATE_MAX_NODES) {
    return 'exceeds the maximum size';
  }
  if (depth > CANDIDATE_MAX_DEPTH) {
    return 'exceeds the maximum nesting depth';
  }
  if (value === null || typeof value !== 'object') {
    return null;
  }
  if (ancestors.has(value)) {
    return 'contains a cycle and cannot be serialised';
  }

  const nextAncestors = new Set(ancestors).add(value);

  if (Array.isArray(value)) {
    for (const element of value) {
      const issue = findCandidateSafetyIssue(element, nextAncestors, depth + 1, budget);
      if (issue !== null) return issue;
    }
    return null;
  }

  if (!isPlainObject(value)) {
    // Date, Map, Set, Error, class instances: not a pollution or cycle
    // concern here — `auditParametersSchema` rejects these as not JSON-safe.
    return null;
  }

  for (const key of Object.keys(value)) {
    if (FORBIDDEN_OBJECT_KEYS.includes(key)) {
      return `contains the forbidden key "${key}"`;
    }
    const issue = findCandidateSafetyIssue(value[key], nextAncestors, depth + 1, budget);
    if (issue !== null) return issue;
  }
  return null;
}

/**
 * Returned in place of a value that hit the redaction walk's own depth or
 * node budget, or that formed a cycle. Deliberately distinct from
 * {@link REDACTED_PLACEHOLDER}: this marks something that was too large or
 * too strange to walk, not a credential.
 */
const REDACTION_LIMIT_PLACEHOLDER = '[TRUNCATED]';

/**
 * Recursively redacts secret-named fields, tolerating anything the walk
 * meets along the way.
 *
 * Values are copied into a fresh object built with `Object.create(null)`
 * rather than `{}`. This matters for a document that has already been through
 * `JSON.parse`: a literal `"__proto__"` key becomes an ordinary *own*
 * property there, not a prototype write — but assigning through *bracket
 * notation* on an ordinary `{}` (`result[key] = value` where `key ===
 * '__proto__'`) does trigger `Object.prototype`'s `__proto__` setter, because
 * `{}` inherits it. A null-prototype target has no such accessor to inherit,
 * so the same assignment creates a harmless own data property, just as
 * `JSON.parse` did.
 *
 * By the time `appendAuditRecord` calls this, {@link findCandidateSafetyIssue}
 * has already rejected any cycle or pathologically large input, so the
 * cycle-tracking (`ancestors`) and depth/node budget here are a second,
 * independent layer rather than the only one — this function does not
 * *rely on* being called after that scan to stay safe on its own.
 *
 * Anything that is not a plain object or array — `Date`, `Map`, `Set`,
 * `Error`, a class instance, a function, a symbol, a `BigInt` — is returned
 * untouched. This function's only job is redaction; `auditRecordSchema`
 * (via `auditParametersSchema`) is what rejects those as not JSON-safe.
 */
function walkRedact(
  value: unknown,
  ancestors: ReadonlySet<object>,
  depth: number,
  budget: WalkBudget,
): unknown {
  budget.nodes += 1;
  if (budget.nodes > CANDIDATE_MAX_NODES || depth > CANDIDATE_MAX_DEPTH) {
    return REDACTION_LIMIT_PLACEHOLDER;
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (ancestors.has(value)) {
    return REDACTION_LIMIT_PLACEHOLDER;
  }

  const nextAncestors = new Set(ancestors).add(value);

  if (Array.isArray(value)) {
    return value.map((element) => walkRedact(element, nextAncestors, depth + 1, budget));
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    result[key] = isSecretFieldName(key)
      ? REDACTED_PLACEHOLDER
      : walkRedact(value[key], nextAncestors, depth + 1, budget);
  }
  return result;
}

/**
 * Redacts every secret-named field in `candidate`, at any depth.
 *
 * Exported so tests can exercise redaction directly, independent of the
 * filesystem. {@link appendAuditRecord} always calls this before validation.
 */
export function redactSecrets(candidate: unknown): unknown {
  return walkRedact(candidate, new Set<object>(), 0, { nodes: 0 });
}

/**
 * Thrown when a candidate, after redaction, still fails `auditRecordSchema`.
 *
 * The message lists only field paths and the schema's own static messages —
 * never a raw value — so it is always safe to log or display.
 */
export class AuditRecordValidationError extends Error {
  constructor(issues: readonly string[]) {
    super(`audit record failed validation: ${issues.join('; ')}`);
    this.name = 'AuditRecordValidationError';
  }
}

/**
 * Thrown when a validated record could not be appended to disk.
 *
 * The message is a fixed, generic string. The underlying filesystem error —
 * which may include an absolute path — is attached as `Error.cause` for
 * local, main-process-only debugging; it is never included in `message`,
 * never sent over IPC and never reaches the renderer.
 */
export class AuditWriteError extends Error {
  constructor(cause: unknown) {
    super('failed to append audit record', { cause });
    this.name = 'AuditWriteError';
  }
}

function auditLogFileName(timestamp: string): string {
  // `timestamp` is already validated as `YYYY-MM-DDTHH:mm:ss[.sss]Z` by
  // `auditRecordSchema` before this is ever called, so the UTC calendar date
  // is just its first ten characters — no `Date` parsing, no timezone logic.
  const utcDate = timestamp.slice(0, 10);
  return `${AUDIT_LOG_FILE_PREFIX}${utcDate}${AUDIT_LOG_FILE_EXTENSION}`;
}

/**
 * Appends one line to `filePath`, creating it if necessary.
 *
 * Opened with the `'a'` (append) flag, never `'w'`: every write this
 * function performs is positioned at end-of-file by the OS, so it can never
 * truncate or overwrite bytes already there, including when several callers
 * race to append to the same file. `sync()` flushes the write to disk before
 * the handle closes.
 */
async function appendLine(filePath: string, line: string): Promise<void> {
  const handle = await open(filePath, 'a');
  try {
    await handle.appendFile(line, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Redacts, validates and appends one audit record.
 *
 * `candidate` is untrusted structured input — never assumed to already be a
 * valid, safe `AuditRecord`. On success, exactly one compact JSON object
 * (never pretty-printed: a multi-line object would break the one-line-per-
 * record JSONL contract) followed by `\n` is appended to the correct UTC
 * daily file under `auditLogDir`, which is created if missing.
 *
 * Rejects rather than writes: a candidate that fails validation after
 * redaction results in {@link AuditRecordValidationError} and nothing is
 * written — no directory is created for an invalid candidate, and no partial
 * or placeholder line is ever appended. A filesystem failure after
 * validation succeeds results in {@link AuditWriteError}; any complete record
 * already written by an earlier call is untouched, since this function only
 * ever appends, never rewrites.
 */
export async function appendAuditRecord(auditLogDir: string, candidate: unknown): Promise<void> {
  const safetyIssue = findCandidateSafetyIssue(candidate, new Set<object>(), 0, { nodes: 0 });
  if (safetyIssue !== null) {
    throw new AuditRecordValidationError([`(root): ${safetyIssue}`]);
  }

  const redacted = redactSecrets(candidate);

  const result = auditRecordSchema.safeParse(redacted);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new AuditRecordValidationError(issues);
  }

  const record: AuditRecord = result.data;
  const line = `${JSON.stringify(record)}\n`;
  const filePath = join(auditLogDir, auditLogFileName(record.timestamp));

  try {
    await mkdir(auditLogDir, { recursive: true });
    await appendLine(filePath, line);
  } catch (error) {
    throw new AuditWriteError(error);
  }
}
