/**
 * Native confirmation dialogs for Local Agent.
 *
 * `main/action-pipeline.ts`'s `handleActionProposal` calls its
 * `requestConfirmation` callback for, and only for, a `confirm` verdict —
 * `secrets.write`, `secrets.clear`, `emergency.reset` and `app.exit` in
 * Phase 1. This module is the one place that callback is actually
 * implemented: a real, main-process-owned `dialog.showMessageBox`, never HTML
 * rendered by the renderer and never a decision the renderer can answer on
 * the action's behalf. The renderer only ever sees the final `outcome`
 * (`success` or `aborted`) that comes back through the ordinary IPC response.
 *
 * `message` is supplied by the caller that already knows which action is
 * being confirmed and must build it from safe, non-secret text only — this
 * module does not inspect the action or its parameters, so it cannot leak
 * one either way. See `main/ipc.ts`'s secret handlers for what the two
 * secret-related messages actually say (never the key itself, never
 * ciphertext).
 */

import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { dialog } from 'electron';

import type { ConfirmationResult } from '../shared/types';

const APPROVE_BUTTON_INDEX = 0;
const CANCEL_BUTTON_INDEX = 1;

function buildOptions(message: string): MessageBoxOptions {
  return {
    type: 'question',
    buttons: ['Approve', 'Cancel'],
    defaultId: CANCEL_BUTTON_INDEX,
    cancelId: CANCEL_BUTTON_INDEX,
    noLink: true,
    title: 'Local Agent — confirmation required',
    message,
  };
}

/**
 * Shows a native confirmation dialog for `message` and resolves to the
 * user's answer.
 *
 * `window` is parented when available so the dialog is application-modal to
 * the main window rather than floating detached; `dialog.showMessageBox`
 * accepts an absent parent, which this falls back to only if no window
 * exists yet (there should always be one by the time an IPC handler can be
 * reached, but this stays safe either way rather than throwing).
 */
export async function showNativeConfirmation(
  window: BrowserWindow | null,
  message: string,
): Promise<ConfirmationResult> {
  const options = buildOptions(message);
  const { response } = window
    ? await dialog.showMessageBox(window, options)
    : await dialog.showMessageBox(options);
  return response === APPROVE_BUTTON_INDEX ? 'approved' : 'rejected';
}
