/**
 * The Windows automation tool registry (Phase 2, Milestone 10).
 *
 * This is the complete vocabulary of desktop actions Local Agent can perform.
 * It is a fixed list in reviewed source — not configuration, not a setting,
 * and not anything a renderer, a project or a model can extend at runtime.
 * There is no way to launch a program, open a folder, open a website, focus a
 * window or run a script that is not one of the entries below: a caller sends
 * an {@link AutomationToolId} from this enum, never a path, a URL, a command
 * line or an argument of its own.
 *
 * ## Five kinds, one shape of control
 *
 *  - `launch-app` and `run-script` both resolve to one literal executable name
 *    under `%SystemRoot%\System32` and a literal, fixed argument vector — see
 *    `main/windows-automation.ts`, which is the only module that turns one of
 *    these into a real process, and does so with `shell: false`, exactly as
 *    `main/process-runner.ts` already does for a project's own scripts. The
 *    two kinds are mechanically identical; the distinction is only which list
 *    a tool appears in, so "an application" and "a registered script" read as
 *    what they are in the interface.
 *  - `open-folder` resolves to one of the current user's own special folders,
 *    or to the already-approved project root. There is no field anywhere in
 *    this registry, or in the request that names a tool, that can carry an
 *    arbitrary filesystem path.
 *  - `open-website` resolves to one literal, fixed `https://` URL. There is no
 *    field that can carry a renderer-supplied or model-supplied address.
 *  - `focus-window` resolves to this application's own window. Focusing an
 *    arbitrary window belonging to another process would need either an
 *    unapproved native dependency or unrestricted shell access, both of which
 *    this milestone's own security requirements forbid — see
 *    `docs/phase-2-automation.md` for the limitation stated plainly.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import type { ActionType } from '../constants';

export const AUTOMATION_TOOL_KINDS = [
  'launch-app',
  'open-folder',
  'open-website',
  'focus-window',
  'run-script',
] as const;

export type AutomationToolKind = (typeof AUTOMATION_TOOL_KINDS)[number];

export const AUTOMATION_TOOL_IDS = [
  'app.notepad',
  'app.calculator',
  'app.explorer',
  'app.paint',
  'folder.desktop',
  'folder.documents',
  'folder.downloads',
  'folder.project',
  'website.github',
  'website.mdn',
  'website.npm',
  'website.nodejs',
  'window.local-agent',
  'script.task-manager',
  'script.system-info',
] as const;

export type AutomationToolId = (typeof AUTOMATION_TOOL_IDS)[number];

export const AUTOMATION_SPECIAL_FOLDERS = ['desktop', 'documents', 'downloads', 'project'] as const;
export type AutomationSpecialFolder = (typeof AUTOMATION_SPECIAL_FOLDERS)[number];

interface AutomationToolBase {
  readonly id: AutomationToolId;
  readonly kind: AutomationToolKind;
  /** Shown in the interface. Fixed text, never from a request or a project. */
  readonly label: string;
  readonly description: string;
  /**
   * The **existing** action type this tool routes through. Always
   * `automation.run` — every entry, of every kind, is decided by the
   * permission engine as the same action type, exactly as every
   * {@link CODING_COMMANDS} entry is decided as `command.run`.
   */
  readonly actionType: ActionType;
  /** True when the tool cannot run without an approved project. Only `folder.project`. */
  readonly requiresProject: boolean;
}

export interface AutomationAppTool extends AutomationToolBase {
  readonly kind: 'launch-app' | 'run-script';
  /** A literal file name resolved against `%SystemRoot%\System32`. */
  readonly executable: string;
  /** The complete argument vector. Every element is a literal. */
  readonly args: readonly string[];
}

export interface AutomationFolderTool extends AutomationToolBase {
  readonly kind: 'open-folder';
  readonly folder: AutomationSpecialFolder;
}

export interface AutomationWebsiteTool extends AutomationToolBase {
  readonly kind: 'open-website';
  /** A literal, fixed `https://` URL. Never built from a request. */
  readonly url: string;
}

export interface AutomationWindowTool extends AutomationToolBase {
  readonly kind: 'focus-window';
  /** The only value today: this application's own window. */
  readonly window: 'local-agent';
}

export type AutomationToolDefinition =
  AutomationAppTool | AutomationFolderTool | AutomationWebsiteTool | AutomationWindowTool;

function app(
  id: AutomationToolId,
  label: string,
  description: string,
  executable: string,
): AutomationAppTool {
  return {
    id,
    kind: 'launch-app',
    label,
    description,
    actionType: 'automation.run',
    requiresProject: false,
    executable,
    args: [],
  };
}

function script(
  id: AutomationToolId,
  label: string,
  description: string,
  executable: string,
): AutomationAppTool {
  return {
    id,
    kind: 'run-script',
    label,
    description,
    actionType: 'automation.run',
    requiresProject: false,
    executable,
    args: [],
  };
}

function folder(
  id: AutomationToolId,
  label: string,
  description: string,
  target: AutomationSpecialFolder,
): AutomationFolderTool {
  return {
    id,
    kind: 'open-folder',
    label,
    description,
    actionType: 'automation.run',
    requiresProject: target === 'project',
    folder: target,
  };
}

function website(
  id: AutomationToolId,
  label: string,
  description: string,
  url: string,
): AutomationWebsiteTool {
  return {
    id,
    kind: 'open-website',
    label,
    description,
    actionType: 'automation.run',
    requiresProject: false,
    url,
  };
}

export const AUTOMATION_TOOLS: readonly AutomationToolDefinition[] = [
  app('app.notepad', 'Notepad', 'Opens the Windows text editor.', 'notepad.exe'),
  app('app.calculator', 'Calculator', 'Opens the Windows calculator.', 'calc.exe'),
  app('app.explorer', 'File Explorer', 'Opens a new File Explorer window.', 'explorer.exe'),
  app('app.paint', 'Paint', 'Opens the Windows Paint app.', 'mspaint.exe'),
  folder('folder.desktop', 'Desktop', 'Opens the current user’s Desktop folder.', 'desktop'),
  folder(
    'folder.documents',
    'Documents',
    'Opens the current user’s Documents folder.',
    'documents',
  ),
  folder(
    'folder.downloads',
    'Downloads',
    'Opens the current user’s Downloads folder.',
    'downloads',
  ),
  folder(
    'folder.project',
    'Approved project',
    'Opens the root of the approved project, if one is open in this session.',
    'project',
  ),
  website(
    'website.github',
    'GitHub',
    'Opens github.com in the default browser.',
    'https://github.com',
  ),
  website(
    'website.mdn',
    'MDN Web Docs',
    'Opens developer.mozilla.org in the default browser.',
    'https://developer.mozilla.org',
  ),
  website('website.npm', 'npm', 'Opens npmjs.com in the default browser.', 'https://www.npmjs.com'),
  website(
    'website.nodejs',
    'Node.js',
    'Opens nodejs.org in the default browser.',
    'https://nodejs.org',
  ),
  {
    id: 'window.local-agent',
    kind: 'focus-window',
    label: 'Local Agent',
    description: 'Brings the Local Agent window to the foreground.',
    actionType: 'automation.run',
    requiresProject: false,
    window: 'local-agent',
  },
  script(
    'script.task-manager',
    'Task Manager',
    'Runs the Windows Task Manager utility.',
    'taskmgr.exe',
  ),
  script(
    'script.system-info',
    'System Information',
    'Runs the Windows System Information utility.',
    'msinfo32.exe',
  ),
] as const;

/**
 * The domains {@link AutomationWebsiteTool} entries may resolve to.
 *
 * Stated as data, and checked by a unit test against every registry entry, so
 * "a website tool can only open one of a fixed set of domains" is a property
 * checkable by reading one array rather than re-derived from the list above.
 * See `shared/automation/validation.ts`, which enforces this again at the
 * point a URL is actually opened.
 */
export const AUTOMATION_ALLOWED_WEBSITE_HOSTS: readonly string[] = [
  'github.com',
  'developer.mozilla.org',
  'www.npmjs.com',
  'nodejs.org',
] as const;

/** True for a value that is one of {@link AUTOMATION_TOOL_IDS}. */
export function isAutomationToolId(value: unknown): value is AutomationToolId {
  return typeof value === 'string' && (AUTOMATION_TOOL_IDS as readonly string[]).includes(value);
}

/**
 * The definition for one id, or `null`.
 *
 * Returns `null` rather than throwing, exactly as `findAgentTool` and
 * `findCodingCommand` do: an unrecognised tool is a refusal the caller turns
 * into a normalized code, not an exception.
 */
export function findAutomationTool(id: unknown): AutomationToolDefinition | null {
  if (!isAutomationToolId(id)) return null;
  return AUTOMATION_TOOLS.find((tool) => tool.id === id) ?? null;
}
