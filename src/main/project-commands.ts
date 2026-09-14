/**
 * Resolving and running the registry's commands (Phase 2, Milestone 6).
 *
 * `shared/workspace/command-registry.ts` says which five commands exist. This
 * module answers the two questions that need the disk: does *this* project
 * actually declare the script a command would run, and what happened when it
 * ran.
 *
 * ## Reading `package.json` is reading untrusted input
 *
 * It is a file from a directory the user merely opened, so it goes through the
 * same read path as any other project file — `readProjectFile`, with its
 * containment, exclusion, size and encoding rules — and then through the same
 * `__proto__`/`constructor`/`prototype` guard every other JSON loader in this
 * codebase applies before anything looks at the parsed value.
 *
 * What is taken from it is deliberately minimal: **whether** a script of a
 * fixed name exists, and its text, sanitized to one bounded line, for the
 * confirmation dialog. The script text is never parsed, never split, and never
 * turned into an argument. The argument vector that eventually reaches
 * `spawn` is `['run', <literal from the registry>]` in every case.
 *
 * ## The honest limit
 *
 * `npm run test` runs whatever the project's `package.json` says it should.
 * This module cannot change that, and neither can the registry: running the
 * project's own test command *is* the feature. What the design can do — and
 * does — is make sure a person sees the exact program, arguments, directory
 * and script text, in a native dialog the renderer cannot forge or answer,
 * before any of it happens; that the run is bounded in time and output; that
 * it inherits neither a terminal nor the parent's environment; and that an
 * engaged emergency stop kills it. That is recorded as this milestone's
 * central limitation in `docs/security-model.md` rather than described as
 * solved.
 */

import { runProcess, type ProcessRunResult } from './process-runner';
import { readProjectFile } from './workspace-inspector';
import type { ApprovedProject } from './workspace-session';
import {
  COMMAND_MAX_OUTPUT_BYTES,
  COMMAND_MAX_OUTPUT_LINES,
  COMMAND_TIMEOUT_MS,
  FORBIDDEN_OBJECT_KEYS,
} from '../shared/constants';
import type { CommandCatalog, CommandDescriptor, CommandRunResult } from '../shared/schemas';
import {
  CODING_COMMANDS,
  describeCommandLine,
  describeScriptRisks,
  findCodingCommand,
  sanitizeScriptPreview,
  type CodingCommandDefinition,
  type CodingCommandId,
} from '../shared/workspace/command-registry';
import { WorkspaceError } from '../shared/workspace/errors';

/**
 * Duplicated from `main/settings.ts` and `main/emergency.ts` for the reason
 * those two already duplicate it from each other: one small, pure,
 * self-contained check is clearer repeated than turned into a dependency
 * between modules with no other relationship. `JSON.parse` does not fall for
 * a literal `"__proto__"` key, but nothing downstream is allowed to assume it.
 */
const MAX_PACKAGE_JSON_DEPTH = 64;

function containsForbiddenKey(value: unknown, depth = 0): boolean {
  if (depth > MAX_PACKAGE_JSON_DEPTH) return true;
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
 * The project's declared scripts, or an empty map.
 *
 * Never throws: a project with no `package.json`, an unreadable one, one that
 * is not JSON, or one whose `scripts` is not an object all mean the same thing
 * here — no command is available — and none of them is an error the user
 * needs to see as a failure.
 */
export async function readProjectScripts(
  project: ApprovedProject,
): Promise<ReadonlyMap<string, string>> {
  let raw: string;
  try {
    raw = (await readProjectFile(project, 'package.json')).content;
  } catch {
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (containsForbiddenKey(parsed)) return new Map();
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map();

  const scripts = (parsed as Record<string, unknown>).scripts;
  if (scripts === null || typeof scripts !== 'object' || Array.isArray(scripts)) return new Map();

  const found = new Map<string, string>();
  // Only the fixed names the registry declares are ever looked up, so the
  // size of the project's own scripts object cannot influence anything here.
  for (const command of CODING_COMMANDS) {
    const record = scripts as Record<string, unknown>;
    if (!Object.hasOwn(record, command.scriptName)) continue;
    const body = record[command.scriptName];
    if (typeof body !== 'string') continue;
    found.set(command.scriptName, body);
  }
  return found;
}

function describe(
  command: CodingCommandDefinition,
  scripts: ReadonlyMap<string, string>,
): CommandDescriptor {
  const body = scripts.get(command.scriptName);
  const available = body !== undefined;
  return {
    id: command.id,
    label: command.label,
    description: command.description,
    commandLine: describeCommandLine(command),
    available,
    scriptPreview: body === undefined ? null : sanitizeScriptPreview(body),
    risks: body === undefined ? [] : describeScriptRisks(body),
  };
}

/** Every registry command, with whether this project declares it. */
export async function buildCommandCatalog(
  project: ApprovedProject,
  busy: boolean,
): Promise<CommandCatalog> {
  const scripts = await readProjectScripts(project);
  return { commands: CODING_COMMANDS.map((command) => describe(command, scripts)), busy };
}

export interface RunCodingCommandOptions {
  readonly project: ApprovedProject;
  readonly commandId: CodingCommandId;
  readonly runId: string;
  /** UTC ISO-8601, supplied by the caller. This module reads no clock of its own. */
  readonly startedAt: string;
  readonly finishedAtFn: () => string;
  readonly signal?: AbortSignal;
  readonly isEmergencyEngaged?: () => Promise<boolean>;
}

function toOutcome(result: ProcessRunResult): CommandRunResult['outcome'] {
  if (result.timedOut || result.cancelled || result.stoppedByEmergency) return 'stopped';
  return result.exitCode === 0 ? 'succeeded' : 'failed';
}

/**
 * Runs one registry command inside the approved project.
 *
 * The working directory is always `project.rootPath` — there is no parameter
 * for anything else, so a command cannot run outside the directory the user
 * approved. Availability is re-checked here, at the moment of running, rather
 * than trusted from whatever the catalog said earlier.
 */
export async function runCodingCommand(
  options: RunCodingCommandOptions,
): Promise<CommandRunResult> {
  const { project, commandId, runId, startedAt, finishedAtFn, signal, isEmergencyEngaged } =
    options;

  const command = findCodingCommand(commandId);
  if (command === null) throw new WorkspaceError('COMMAND_NOT_AVAILABLE');

  const scripts = await readProjectScripts(project);
  if (!scripts.has(command.scriptName)) throw new WorkspaceError('COMMAND_NOT_AVAILABLE');

  const result = await runProcess({
    program: command.program,
    args: [...command.args],
    cwd: project.rootPath,
    timeoutMs: COMMAND_TIMEOUT_MS,
    maxOutputBytes: COMMAND_MAX_OUTPUT_BYTES,
    maxOutputLines: COMMAND_MAX_OUTPUT_LINES,
    ...(signal === undefined ? {} : { signal }),
    ...(isEmergencyEngaged === undefined ? {} : { isEmergencyEngaged }),
  });

  return {
    runId,
    commandId,
    commandLine: describeCommandLine(command),
    outcome: toOutcome(result),
    // `null` when the process was killed: reporting a code it never returned
    // would tell the reader the command finished when it did not.
    exitCode: result.exitCode === null ? null : Math.max(-1, Math.min(255, result.exitCode)),
    startedAt,
    finishedAt: finishedAtFn(),
    durationMs: result.durationMs,
    output: [...result.output],
    outputTruncated: result.outputTruncated,
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    stoppedByEmergency: result.stoppedByEmergency,
  };
}
