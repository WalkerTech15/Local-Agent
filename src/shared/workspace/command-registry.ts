/**
 * The command registry (Phase 2, Milestone 6).
 *
 * This is the whole vocabulary of things Local Agent can run. It is a fixed
 * list in reviewed source, not configuration, not a setting, and not anything
 * a renderer, a project or a model can extend at runtime.
 *
 * The single most important property is the shape of a request: a caller asks
 * for a **command id from an enum**. It cannot send a command string, an
 * argument, a working directory, an environment variable, or a shell. Every
 * argument vector below is a literal in this file, so there is no interpolation
 * point anywhere between the renderer and the process that eventually starts —
 * "no arbitrary command strings" is a property of the type, not a filter
 * applied to one.
 *
 * ## What this does and does not restrict
 *
 * It restricts **which of the project's own scripts may be started**. It does
 * not, and cannot, restrict what those scripts then do: `npm run test` runs
 * whatever the project's `package.json` says, and a project is untrusted input
 * in exactly the sense `AGENTS.md` §5 means. That is not a gap this registry
 * could close — running the project's test command is the requested feature —
 * so the control is placed where it can actually work:
 *
 *  - the command must be one of the five below;
 *  - the project must already declare that script, so nothing is invented;
 *  - `command.run` is on the confirmation floor, which no policy edit can
 *    downgrade, so the user approves it in a native dialog the main process
 *    owns;
 *  - that dialog states the exact program, the exact arguments, the exact
 *    directory, and the project's own script text, so the user is approving
 *    something they can actually read;
 *  - {@link describeScriptRisks} flags scripts that chain commands, reach the
 *    network, delete files or ask for elevation, so the dialog can say what is
 *    unusual about this one.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import { COMMAND_SCRIPT_PREVIEW_MAX_LENGTH } from '../constants';
import { collapseToSingleLine } from './text-safety';

/**
 * Every runnable command. Deliberately the four the milestone names, plus the
 * format check this repository's own verification sequence uses.
 *
 * There is no `install`, no `start`, no `publish` and no `exec`: installing
 * dependencies is excluded from this milestone, and a long-lived server or an
 * arbitrary `npx` target is not something a bounded, timed, output-capped
 * runner should be starting at all.
 */
export const CODING_COMMAND_IDS = ['test', 'lint', 'typecheck', 'build', 'format-check'] as const;

export type CodingCommandId = (typeof CODING_COMMAND_IDS)[number];

export interface CodingCommandDefinition {
  readonly id: CodingCommandId;
  /** Shown in the interface. Fixed text, never from the project. */
  readonly label: string;
  readonly description: string;
  /**
   * The npm script name this command runs.
   *
   * A constant, never a value from a request. The project must *declare* a
   * script by this name for the command to be offered, but the name that ends
   * up in the argument vector is always this one.
   */
  readonly scriptName: string;
  /** The program to start. `npm` for every entry, resolved by the main process. */
  readonly program: 'npm';
  /** The complete argument vector. Every element is a literal. */
  readonly args: readonly string[];
  /** The project file that must exist for this command to be available. */
  readonly requiresMarker: 'package.json';
}

function npmRun(
  id: CodingCommandId,
  scriptName: string,
  label: string,
  description: string,
): CodingCommandDefinition {
  return {
    id,
    label,
    description,
    scriptName,
    program: 'npm',
    args: ['run', scriptName],
    requiresMarker: 'package.json',
  };
}

export const CODING_COMMANDS: readonly CodingCommandDefinition[] = [
  npmRun('test', 'test', 'Run tests', 'Runs the project’s own test script.'),
  npmRun('lint', 'lint', 'Lint', 'Runs the project’s own lint script.'),
  npmRun('typecheck', 'typecheck', 'Type-check', 'Runs the project’s own type-check script.'),
  npmRun('build', 'build', 'Build', 'Runs the project’s own build script.'),
  npmRun(
    'format-check',
    'format:check',
    'Check formatting',
    'Runs the project’s own formatting check.',
  ),
] as const;

/** True for a value that is one of {@link CODING_COMMAND_IDS}. */
export function isCodingCommandId(value: unknown): value is CodingCommandId {
  return typeof value === 'string' && (CODING_COMMAND_IDS as readonly string[]).includes(value);
}

/**
 * The definition for one id, or `null`.
 *
 * Returns `null` rather than throwing for an unknown id: an unrecognised
 * command is a refusal, not an exception, and the caller turns it into the
 * normalized `COMMAND_NOT_AVAILABLE` code.
 */
export function findCodingCommand(id: unknown): CodingCommandDefinition | null {
  if (!isCodingCommandId(id)) return null;
  return CODING_COMMANDS.find((command) => command.id === id) ?? null;
}

/** `npm run test` — what the confirmation dialog shows as the command line. */
export function describeCommandLine(command: CodingCommandDefinition): string {
  return [command.program, ...command.args].join(' ');
}

/**
 * Heuristic flags for a project script, shown alongside it when the user is
 * asked to approve running it.
 *
 * Advisory and nothing more. None of these flags grants or withholds
 * permission — `command.run` requires confirmation either way — and their
 * absence proves nothing, because a script can reach the network or delete a
 * file through any number of spellings this list does not enumerate. Their
 * value is the opposite direction: when a `lint` script turns out to chain
 * four commands and download something, the person approving it gets told
 * before they say yes rather than after.
 */
export const SCRIPT_RISK_FLAGS = [
  'chains-commands',
  'network-access',
  'deletes-files',
  'requests-elevation',
  'runs-inline-code',
] as const;

export type ScriptRiskFlag = (typeof SCRIPT_RISK_FLAGS)[number];

const RISK_PATTERNS: readonly { readonly flag: ScriptRiskFlag; readonly pattern: RegExp }[] = [
  { flag: 'chains-commands', pattern: /(&&|\|\||[;|&])/ },
  {
    flag: 'network-access',
    pattern: /\b(curl|wget|iwr|invoke-webrequest|invoke-restmethod|nc|scp|ftp)\b/i,
  },
  { flag: 'deletes-files', pattern: /\b(rm|rmdir|del|erase|rimraf|remove-item)\b/i },
  { flag: 'requests-elevation', pattern: /\b(sudo|runas|start-process\s+-verb\s+runas)\b/i },
  { flag: 'runs-inline-code', pattern: /(-e\s|--eval|-c\s|-command\s|\beval\b|\bnpx\b)/i },
];

/** Every {@link ScriptRiskFlag} the script text matches, in list order. */
export function describeScriptRisks(scriptBody: string): ScriptRiskFlag[] {
  return RISK_PATTERNS.filter(({ pattern }) => pattern.test(scriptBody)).map(({ flag }) => flag);
}

/**
 * Reduces a project's script text to something safe to put in a dialog.
 *
 * The script body is untrusted input from someone else's `package.json`, and
 * it is about to be shown inside a security prompt, which is the worst place
 * for text that can move the cursor, reorder itself, or run to a hundred
 * lines and push the actual question off the screen. So: every run of
 * whitespace — newlines included — collapses to one space, control characters
 * and bidirectional overrides are dropped, and the result is bounded.
 */
export function sanitizeScriptPreview(scriptBody: string): string {
  return collapseToSingleLine(scriptBody, COMMAND_SCRIPT_PREVIEW_MAX_LENGTH);
}
