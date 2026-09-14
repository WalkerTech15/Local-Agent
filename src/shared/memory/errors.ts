/**
 * The memory layer's normalized failure vocabulary (Phase 2, Milestone 8).
 *
 * The same shape as `shared/workspace/errors.ts` and `shared/agent/errors.ts`,
 * and for the same reason: a failure that crosses the IPC boundary carries a
 * **code from this closed list and nothing else** — never a message, never a
 * path, never a file name, never the content of a record.
 *
 * That matters more here than anywhere else in the codebase. A memory record
 * is the user's own private note; an error string that quoted the record it
 * failed on, or named the file it could not write, would put exactly that
 * content into a channel the renderer displays and, eventually, into a
 * screenshot or a bug report. Codes are bounded and reviewable, so what a
 * failure can disclose is decided here, once.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

export const MEMORY_ERROR_CODES = [
  /** No record with that id exists in the addressed scope. */
  'MEMORY_NOT_FOUND',
  /** The submitted record failed validation, so nothing was written. */
  'MEMORY_INVALID',
  /** The scope already holds `MEMORY_MAX_RECORDS_PER_SCOPE` records. */
  'MEMORY_LIMIT_REACHED',
  /** The store could not be written. The file on disk is unchanged. */
  'MEMORY_STORE_FAILED',
  /** A project-scoped operation was asked for with no project approved. */
  'MEMORY_NO_PROJECT',
  /** The record's own scope disagreed with the scope that was addressed. */
  'MEMORY_SCOPE_MISMATCH',
  /**
   * The content looked like it carried a credential, so it was refused rather
   * than stored. See `shared/memory/secret-scan.ts` — a best-effort control,
   * never a guarantee.
   */
  'MEMORY_SECRET_REJECTED',
  /** The chosen import file could not be read, parsed, or validated. */
  'MEMORY_IMPORT_INVALID',
  /** The chosen import file is larger than `MEMORY_IMPORT_MAX_BYTES`. */
  'MEMORY_IMPORT_TOO_LARGE',
  /** The export file could not be written. Nothing partial is left behind. */
  'MEMORY_EXPORT_FAILED',
  /** The user dismissed the native file dialog. A refusal, not a malfunction. */
  'MEMORY_FILE_SELECTION_CANCELLED',
  /** The store could not be read, and resolving to an empty one was not safe. */
  'MEMORY_READ_FAILED',
] as const;

export type MemoryErrorCode = (typeof MEMORY_ERROR_CODES)[number];

/**
 * One reviewed sentence per code, for logs inside the main process only.
 *
 * None of these strings crosses the IPC boundary. `main/ipc.ts` sends the
 * code; the renderer's own `memory-controller.ts` holds the sentence a person
 * actually reads. Two independent sets of words, so main-process phrasing can
 * never reach the screen by accident.
 */
export const MEMORY_ERROR_MESSAGES: Readonly<Record<MemoryErrorCode, string>> = {
  MEMORY_NOT_FOUND: 'no such memory record in this scope',
  MEMORY_INVALID: 'the memory record failed validation',
  MEMORY_LIMIT_REACHED: 'this scope already holds the maximum number of records',
  MEMORY_STORE_FAILED: 'the memory store could not be written',
  MEMORY_NO_PROJECT: 'no project is approved in this session',
  MEMORY_SCOPE_MISMATCH: 'the record does not belong to the addressed scope',
  MEMORY_SECRET_REJECTED: 'the content looks like a credential',
  MEMORY_IMPORT_INVALID: 'the chosen file is not a valid memory export',
  MEMORY_IMPORT_TOO_LARGE: 'the chosen file is too large to import',
  MEMORY_EXPORT_FAILED: 'the export file could not be written',
  MEMORY_FILE_SELECTION_CANCELLED: 'the file dialog was dismissed',
  MEMORY_READ_FAILED: 'the memory store could not be read',
};

/**
 * A failure inside the memory layer.
 *
 * Carries a code and the reviewed sentence for it — never a cause, and never
 * an interpolated value. Attaching the original error would be how a
 * filesystem path or a fragment of a record's content escapes into a place
 * this module promises it cannot reach.
 */
export class MemoryError extends Error {
  readonly code: MemoryErrorCode;

  constructor(code: MemoryErrorCode) {
    super(MEMORY_ERROR_MESSAGES[code]);
    this.name = 'MemoryError';
    this.code = code;
  }
}

export function isMemoryErrorCode(value: string): value is MemoryErrorCode {
  return (MEMORY_ERROR_CODES as readonly string[]).includes(value);
}
