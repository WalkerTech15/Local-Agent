/**
 * The native project-directory picker (Phase 2, Milestone 5).
 *
 * The counterpart to `main/confirm.ts`, and native for exactly the same
 * reason: this dialog is the *consent* for the whole workspace feature. It is
 * the only place a directory outside the application's own data becomes
 * readable, and the renderer must not be able to choose that directory,
 * pre-fill it, forge the dialog, or dismiss it on the user's behalf.
 *
 * So the renderer supplies nothing. `workspaceSelectRequestSchema` takes no
 * arguments at all, this function takes no path, and there is no default,
 * suggested or remembered location: whatever `dialog.showOpenDialog` returns
 * is what the user actually clicked on. A compromised renderer can ask that
 * the user be asked, and nothing more.
 *
 * `properties` is deliberately minimal — `openDirectory` alone. In
 * particular there is no `multiSelections` (one project at a time),
 * no `createDirectory`/`promptToCreate` (this milestone writes nothing, and a
 * picker that can create a folder writes), and no `showHiddenFiles`.
 */

import type { BrowserWindow, OpenDialogOptions } from 'electron';
import { dialog } from 'electron';

const DIALOG_OPTIONS: OpenDialogOptions = {
  title: 'Local Agent — select a project to inspect',
  buttonLabel: 'Approve project',
  message: 'Local Agent will read files inside this directory. It cannot modify them.',
  properties: ['openDirectory'],
};

/**
 * Shows the picker and resolves to the chosen directory, or `null` when the
 * user dismissed it.
 *
 * `null` is a first-class answer, not an error: cancelling a picker is the
 * user declining, and the caller turns it into the dedicated
 * `WORKSPACE_SELECTION_CANCELLED` code rather than a generic failure.
 *
 * The returned string is the raw OS path. It is *not* trusted as a project
 * root on the strength of having come from here — `adoptProjectDirectory`
 * still canonicalises it, confirms it is a directory, and refuses the
 * application's own data directory. A dialog result is still input.
 */
export async function showDirectoryPicker(window: BrowserWindow | null): Promise<string | null> {
  const result = window
    ? await dialog.showOpenDialog(window, DIALOG_OPTIONS)
    : await dialog.showOpenDialog(DIALOG_OPTIONS);

  if (result.canceled) return null;
  const [directory] = result.filePaths;
  return directory === undefined || directory.length === 0 ? null : directory;
}
