/**
 * The native memory export and import dialogs (Phase 2, Milestone 8).
 *
 * The counterpart to `main/directory-picker.ts`, and native for the same
 * reason: these two dialogs are the *consent* for memory content crossing the
 * application boundary in either direction. The renderer must not be able to
 * choose the file, pre-fill it, forge the dialog, or dismiss it on the user's
 * behalf.
 *
 * So the renderer supplies nothing but a scope. Neither function takes a
 * path, and there is no default directory, no remembered location and no
 * suggested one beyond a plain file name: whatever the dialog returns is what
 * the user actually clicked on. A compromised renderer can ask that the user
 * be asked, and nothing more.
 *
 * `properties` is deliberately minimal on both. The open dialog has
 * `openFile` alone — no `multiSelections` (one file at a time) and no
 * `openDirectory` (there is nothing here that reads a tree). The save dialog
 * gets `showOverwriteConfirmation`, so overwriting an existing file is always
 * the user's second, explicit decision.
 */

import type { BrowserWindow, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { dialog } from 'electron';

import type { MemoryScope } from '../shared/constants';

/**
 * A safe default file name for an export.
 *
 * Built from the scope enum and a fixed prefix — never from a project name, a
 * path, or a record's content — so nothing user-controlled reaches a file
 * name. The user can still type whatever they like in the dialog; this is
 * only what it opens with.
 */
function defaultExportFileName(scope: MemoryScope): string {
  return `local-agent-memory-${scope}.json`;
}

const JSON_FILTERS = [{ name: 'Memory export', extensions: ['json'] }];

/**
 * Shows the save dialog and resolves to the chosen file, or `null` when the
 * user dismissed it.
 *
 * `null` is a first-class answer, not an error: cancelling is the user
 * declining, and the caller turns it into the dedicated
 * `MEMORY_FILE_SELECTION_CANCELLED` code rather than a generic failure.
 */
export async function showMemoryExportPicker(
  window: BrowserWindow | null,
  scope: MemoryScope,
): Promise<string | null> {
  const options: SaveDialogOptions = {
    title: 'Local Agent — export memory',
    buttonLabel: 'Export',
    defaultPath: defaultExportFileName(scope),
    message: 'These notes will be written outside Local Agent, where its protections do not apply.',
    filters: JSON_FILTERS,
    properties: ['showOverwriteConfirmation', 'createDirectory'],
  };

  const result = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);

  if (result.canceled) return null;
  // Electron types `filePath` as a plain string here, unlike the open
  // dialog's array, so an empty string is the only "nothing chosen" case
  // left once `canceled` is false.
  return result.filePath.length === 0 ? null : result.filePath;
}

/**
 * Shows the open dialog and resolves to the chosen file, or `null`.
 *
 * The returned path is *not* trusted as a memory export on the strength of
 * having come from here — `main/memory-transfer.ts` still size-checks it,
 * parses it defensively and hands back `unknown`, and the service still
 * validates it against the schema. A dialog result is still input.
 */
export async function showMemoryImportPicker(window: BrowserWindow | null): Promise<string | null> {
  const options: OpenDialogOptions = {
    title: 'Local Agent — import memory',
    buttonLabel: 'Import',
    message: 'Local Agent will read memory records from this file. Its contents are untrusted.',
    filters: JSON_FILTERS,
    properties: ['openFile'],
  };

  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);

  if (result.canceled) return null;
  const [chosen] = result.filePaths;
  return chosen === undefined || chosen.length === 0 ? null : chosen;
}
