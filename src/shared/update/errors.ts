/**
 * The auto-update layer's normalized failure vocabulary (Phase 3, Milestone 4).
 *
 * The same shape as `shared/automation/errors.ts`, `shared/workflow/errors.ts`
 * and `shared/agent/errors.ts`: a failure carries a **code from this closed
 * list and nothing else** — never a message, a URL, or a fragment of a
 * download's own output.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

export const UPDATE_ERROR_CODES = [
  /** Updates are not enabled by configuration; nothing was attempted. */
  'UPDATE_DISABLED',
  /** No update feed URL is configured, or it fails validation. */
  'UPDATE_NO_FEED_CONFIGURED',
  /** This build is not a packaged, installed copy — dev runs never update. */
  'UPDATE_NOT_PACKAGED',
  /** The update did not come from the one configured, trusted source. */
  'UPDATE_UNTRUSTED_SOURCE',
  /** The downloaded update's signature could not be verified. */
  'UPDATE_INVALID_SIGNATURE',
  /** The update could not be downloaded. */
  'UPDATE_DOWNLOAD_FAILED',
  /** Installation was attempted without the user's explicit approval. */
  'UPDATE_NOT_APPROVED',
  /** Checking for an update failed, for a reason with no more specific code. */
  'UPDATE_CHECK_FAILED',
] as const;

export type UpdateErrorCode = (typeof UPDATE_ERROR_CODES)[number];

/**
 * One reviewed sentence per code, for use inside the main process only.
 *
 * None of these strings is required to cross the IPC boundary as written —
 * see `docs/phase-3-auto-update.md` for why this milestone adds no live IPC
 * channel at all yet.
 */
export const UPDATE_ERROR_MESSAGES: Readonly<Record<UpdateErrorCode, string>> = {
  UPDATE_DISABLED: 'updates are not enabled',
  UPDATE_NO_FEED_CONFIGURED: 'no trusted update source is configured',
  UPDATE_NOT_PACKAGED: 'this is not an installed copy of the application',
  UPDATE_UNTRUSTED_SOURCE: 'the update did not come from the configured source',
  UPDATE_INVALID_SIGNATURE: "the update's signature could not be verified",
  UPDATE_DOWNLOAD_FAILED: 'the update could not be downloaded',
  UPDATE_NOT_APPROVED: 'installation was not approved by the user',
  UPDATE_CHECK_FAILED: 'checking for an update failed',
};

/**
 * A failure inside the auto-update layer.
 *
 * Carries a code and the reviewed sentence for it — never a cause, and never
 * an interpolated value, for the same reason `AutomationError` and
 * `WorkflowError` do not.
 */
export class UpdateError extends Error {
  readonly code: UpdateErrorCode;

  constructor(code: UpdateErrorCode) {
    super(UPDATE_ERROR_MESSAGES[code]);
    this.name = 'UpdateError';
    this.code = code;
  }
}

export function isUpdateErrorCode(value: string): value is UpdateErrorCode {
  return (UPDATE_ERROR_CODES as readonly string[]).includes(value);
}
