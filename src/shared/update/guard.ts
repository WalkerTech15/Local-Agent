/**
 * The one function allowed to say an update may be installed (Phase 3,
 * Milestone 4).
 *
 * This is the security rule from `docs/phase-3-auto-update.md`, expressed as
 * code instead of only prose: *never download, install, or apply an update
 * unless it is from the configured trusted source, has a valid signature,
 * and the user explicitly approved installation.* Every one of those three
 * conditions is a separate, named field — not a single "isSafe" boolean a
 * caller could set once and forget — and all three, plus being in the
 * `downloaded` state at all, must hold before this returns `true`.
 *
 * Whatever eventually calls `quitAndInstall()` (no such caller exists yet —
 * see `docs/phase-3-auto-update.md`) must call this first and refuse to
 * proceed on anything but `true`.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import type { UpdateState } from './states';
import type { UpdateErrorCode } from './errors';

export interface UpdateInstallApproval {
  /** The update was downloaded from the one feed URL configuration named. */
  readonly sourceTrusted: boolean;
  /** The downloaded artifact's signature verified successfully. */
  readonly signatureValid: boolean;
  /** The user was shown the update and explicitly chose to install it. */
  readonly userApproved: boolean;
}

export interface UpdateInstallDecision {
  readonly allowed: boolean;
  /** Every reason installation is refused. Empty when `allowed` is `true`. */
  readonly reasons: readonly UpdateErrorCode[];
}

export function canInstallUpdate(
  state: UpdateState,
  approval: UpdateInstallApproval,
): UpdateInstallDecision {
  const reasons: UpdateErrorCode[] = [];

  if (state !== 'downloaded') {
    // Covers every other state, including `disabled`: there is nothing
    // finished downloading and verified to install.
    reasons.push('UPDATE_DOWNLOAD_FAILED');
  }
  if (!approval.sourceTrusted) {
    reasons.push('UPDATE_UNTRUSTED_SOURCE');
  }
  if (!approval.signatureValid) {
    reasons.push('UPDATE_INVALID_SIGNATURE');
  }
  if (!approval.userApproved) {
    reasons.push('UPDATE_NOT_APPROVED');
  }

  return { allowed: reasons.length === 0, reasons };
}
