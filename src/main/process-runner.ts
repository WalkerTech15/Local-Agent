/**
 * The bounded process runner (Phase 2, Milestone 6).
 *
 * The only module in this codebase that starts a process. It is deliberately
 * small and deliberately dumb: it takes a program, an argument array and a
 * working directory, and it runs them under a set of limits. It makes no
 * decision about *what* may run — `shared/workspace/command-registry.ts` and
 * `shared/workspace/git.ts` own that, and the permission engine plus a native
 * confirmation own whether it happens at all.
 *
 * ## No shell, ever
 *
 * `spawn` is called with `shell: false` in every case. That is the difference
 * between running a program with an argument vector and handing a string to an
 * interpreter that will re-split it on characters this application never
 * intended as syntax.
 *
 * Windows makes this awkward rather than impossible: `npm` is a `.cmd` script,
 * and Node refuses to spawn a `.cmd` without a shell (the fix for
 * CVE-2024-27980). So {@link resolveProgram} finds the real file on `PATH`
 * itself, and a batch file is run by invoking the command interpreter with an
 * explicit argument array — never a command string. Because the interpreter
 * does its own parsing, every argument is additionally checked against
 * {@link SAFE_ARGUMENT_PATTERN} first, and a run is refused outright rather
 * than quoted-and-hoped-for if any argument contains a character the
 * interpreter treats as syntax. In practice no argument ever does: every one
 * comes from a literal in the registry or from a path this codebase built.
 *
 * ## Nothing is unbounded
 *
 * | Dimension        | Behaviour when the bound is reached                      |
 * | ---------------- | -------------------------------------------------------- |
 * | Wall-clock time  | The process tree is killed; `timedOut` is reported       |
 * | Output bytes     | Capture stops, draining continues; `outputTruncated`      |
 * | Output lines     | Same                                                      |
 * | Line length      | The line is elided, marked with the truncation marker     |
 * | Concurrency      | Owned by the caller — this module runs what it is given   |
 *
 * Draining rather than pausing matters: a child whose stdout pipe fills up
 * blocks forever, so output past the cap is read and discarded rather than
 * left unread.
 *
 * ## Two things the child does not get
 *
 *  - **A terminal.** `stdin` is `'ignore'`, so a command that decides to
 *    prompt reads end-of-file and exits instead of hanging until its timeout.
 *  - **The parent's environment.** Only the variables in
 *    {@link INHERITED_ENVIRONMENT_NAMES} are passed through. A user who has
 *    exported an API token into their shell does not hand it to a project's
 *    build script because they asked Local Agent to run one.
 *
 * ## The emergency stop reaches a running process
 *
 * The permission engine already refuses to *start* an action while the stop is
 * engaged. `isEmergencyEngaged` closes the other half: it is polled while the
 * process runs, and an engaged stop kills it. Without that, "emergency stop"
 * would mean "no new work" rather than "stop".
 */

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

import {
  COMMAND_EMERGENCY_POLL_MS,
  COMMAND_KILL_GRACE_MS,
  COMMAND_MAX_OUTPUT_LINE_LENGTH,
} from '../shared/constants';
import type { CommandOutputLine } from '../shared/schemas/coding.schema';
import { WorkspaceError } from '../shared/workspace/errors';
import { sanitizeDisplayLine } from '../shared/workspace/text-safety';

/**
 * Environment variables passed through to a child process.
 *
 * Everything else is dropped. The list is what a Node or Git toolchain
 * genuinely needs to function on Windows and on POSIX, and nothing more —
 * notably no `*_TOKEN`, no `*_KEY`, no `NODE_OPTIONS` (which can inject a
 * module into every child), and no `GIT_*` beyond what is set explicitly
 * below.
 */
export const INHERITED_ENVIRONMENT_NAMES: readonly string[] = [
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'TEMP',
  'TMP',
  'HOME',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'OS',
  'LANG',
  'LC_ALL',
  'TZ',
] as const;

/**
 * Variables set on every child, regardless of the parent's environment.
 *
 * `CI` and `NO_COLOR` between them stop a tool drawing progress spinners or
 * ANSI colour that would only be sanitized away, and stop it deciding to ask
 * an interactive question. `GIT_TERMINAL_PROMPT=0` makes git fail rather than
 * block if it ever decides it wants credentials — which it should never do
 * here, since nothing this application runs talks to a remote.
 */
const FORCED_ENVIRONMENT: Readonly<Record<string, string>> = {
  CI: '1',
  NO_COLOR: '1',
  FORCE_COLOR: '0',
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
  npm_config_color: 'false',
  npm_config_progress: 'false',
  npm_config_audit: 'false',
  npm_config_fund: 'false',
};

/**
 * Characters an argument may contain when the command interpreter is going to
 * re-parse the argument vector.
 *
 * Everything the interpreter treats as syntax is absent: `&`, `|`, `<`, `>`,
 * `^`, `(`, `)`, `%`, `!`, `"`, backtick, `$`, `;` and every control
 * character. A run whose arguments do not all match is refused rather than
 * escaped, because escaping correctly for two different interpreters is a
 * problem this application does not need to have.
 */
export const SAFE_ARGUMENT_PATTERN = /^[A-Za-z0-9 _.:,=+@/\\[\]{}'#~-]*$/;

/** What {@link resolveProgram} decided to actually execute. */
export interface ResolvedProgram {
  /** The file `spawn` is given: the program itself, or the interpreter. */
  readonly file: string;
  /** The real program. Equal to {@link ResolvedProgram.file} when run directly. */
  readonly target: string;
  /** True when a command interpreter will re-parse the argument vector. */
  readonly viaInterpreter: boolean;
}

/** What `spawn` should actually be handed, once the arguments are known. */
export interface SpawnArguments {
  readonly argv: readonly string[];
  /** True when Node must not re-quote the vector. See {@link buildSpawnArguments}. */
  readonly verbatim: boolean;
}

/**
 * Assembles the final argument vector.
 *
 * The direct case is trivial: `spawn` is given the program and the arguments,
 * and quotes each one itself.
 *
 * The interpreter case is not, and the reason is a genuine Windows quirk
 * rather than a stylistic choice. `cmd.exe /s /c` strips the **first and last**
 * quote characters of everything after `/c` and runs what is left verbatim.
 * So handing it `/c "C:\Program Files\nodejs\npm.cmd" run test` yields the
 * command `C:\Program Files\nodejs\npm.cmd" run test` — the path is split at
 * the space and the run fails with `'C:\Program' is not recognized`. The
 * documented fix, and what Node's own `shell: true` does, is to wrap the
 * entire remainder in one further pair of quotes so that the pair `/s` strips
 * is that outer one.
 *
 * That requires `windowsVerbatimArguments`, because Node would otherwise
 * re-quote the string it was handed. Quoting each token here is safe only
 * because {@link SAFE_ARGUMENT_PATTERN} has already refused every character
 * the interpreter treats as syntax — including `"` itself, `%`, `^` and `!` —
 * so there is no escape sequence to get right and nothing to get wrong.
 */
export function buildSpawnArguments(
  resolved: ResolvedProgram,
  args: readonly string[],
): SpawnArguments {
  if (!resolved.viaInterpreter) {
    return { argv: [...args], verbatim: false };
  }

  const quoted = [resolved.target, ...args].map((value) => `"${value}"`).join(' ');
  return { argv: ['/d', '/s', '/c', `"${quoted}"`], verbatim: true };
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Finds the real file for a bare program name on `PATH`.
 *
 * Done here rather than left to `spawn` because Windows needs the answer: a
 * `.cmd` cannot be spawned directly, and knowing which extension was found is
 * what decides between running the program and running it through the command
 * interpreter. On POSIX the bare name is handed to `spawn`, which resolves it
 * the same way any exec would.
 *
 * `program` is always a literal from the registry (`npm`, `git`), never a
 * value from a request — but an absolute path is accepted too, so a test can
 * point this at `process.execPath` and exercise the real spawn path.
 */
export function resolveProgram(program: string, env: NodeJS.ProcessEnv): ResolvedProgram {
  const isWindows = process.platform === 'win32';

  if (isAbsolute(program) || !isWindows) {
    return { file: program, target: program, viaInterpreter: false };
  }

  const pathValue = env.PATH ?? env.Path ?? '';
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const directories = pathValue.split(delimiter).filter(Boolean);

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, program + extension.toLowerCase());
      if (!isExecutableFile(candidate)) continue;

      const lowered = candidate.toLowerCase();
      if (lowered.endsWith('.cmd') || lowered.endsWith('.bat')) {
        // A batch file cannot be spawned directly (the fix for
        // CVE-2024-27980), so it runs through the command interpreter. `/d`
        // skips AutoRun commands from the registry — otherwise a machine
        // configuration could inject a command into every run — and `/s`
        // fixes how the remainder is quoted; see {@link buildSpawnArguments}.
        return { file: env.ComSpec ?? 'cmd.exe', target: candidate, viaInterpreter: true };
      }
      return { file: candidate, target: candidate, viaInterpreter: false };
    }
  }

  throw new WorkspaceError('COMMAND_LAUNCH_FAILED');
}

/** The environment a child receives: an allowlist, plus fixed overrides. */
export function buildChildEnvironment(parent: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const child: NodeJS.ProcessEnv = {};
  const wanted = new Map(INHERITED_ENVIRONMENT_NAMES.map((name) => [name.toLowerCase(), name]));

  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const canonical = wanted.get(name.toLowerCase());
    if (canonical === undefined) continue;
    child[name] = value;
  }
  for (const [name, value] of Object.entries(FORCED_ENVIRONMENT)) child[name] = value;
  return child;
}

export interface RunProcessOptions {
  readonly program: string;
  readonly args: readonly string[];
  /** Always the approved project root. Nothing runs anywhere else. */
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly maxOutputLines: number;
  /** Aborting kills the process tree. Supplied by the caller, as `chat:send` does. */
  readonly signal?: AbortSignal;
  /** Polled while the process runs; a `true` answer kills it. */
  readonly isEmergencyEngaged?: () => Promise<boolean>;
  readonly env?: NodeJS.ProcessEnv;
}

export interface ProcessRunResult {
  /** `null` when the process was killed rather than exiting on its own. */
  readonly exitCode: number | null;
  readonly output: readonly CommandOutputLine[];
  readonly outputTruncated: boolean;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly stoppedByEmergency: boolean;
  readonly durationMs: number;
}

/**
 * Kills a process and, on Windows, everything it started.
 *
 * `child.kill()` signals only the process itself. A `npm run test` on Windows
 * is an interpreter that started Node that started a test runner, and killing
 * the first leaves the rest running — orphaned processes holding file locks
 * inside the user's project. `taskkill /T` is the platform's own answer, with
 * a fixed argument vector and a process id this module owns.
 */
function killProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  child.kill();

  if (process.platform === 'win32' && typeof pid === 'number' && Number.isInteger(pid) && pid > 0) {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], {
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      killer.on('error', () => undefined);
    } catch {
      // Best effort: the direct kill above has already been sent.
    }
    return;
  }

  setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }, COMMAND_KILL_GRACE_MS).unref();
}

/** Accumulates one stream's bytes into bounded, sanitized lines. */
class OutputCollector {
  private readonly lines: CommandOutputLine[] = [];
  private readonly partial = new Map<CommandOutputLine['stream'], string>();
  private bytes = 0;
  private truncatedFlag = false;

  constructor(
    private readonly maxBytes: number,
    private readonly maxLines: number,
  ) {}

  get truncated(): boolean {
    return this.truncatedFlag;
  }

  push(stream: CommandOutputLine['stream'], chunk: Buffer): void {
    this.bytes += chunk.length;
    if (this.bytes > this.maxBytes || this.lines.length >= this.maxLines) {
      // Past the bound the chunk is still consumed — the child would block on
      // a full pipe otherwise — but nothing more is kept.
      this.truncatedFlag = true;
      return;
    }

    const text = (this.partial.get(stream) ?? '') + chunk.toString('utf8');
    const parts = text.split('\n');
    this.partial.set(stream, parts.pop() ?? '');

    for (const part of parts) {
      if (this.lines.length >= this.maxLines) {
        this.truncatedFlag = true;
        return;
      }
      this.append(stream, part);
    }
  }

  /** Flushes whatever was left without a trailing newline. */
  finish(): readonly CommandOutputLine[] {
    for (const [stream, remainder] of this.partial) {
      if (remainder.length === 0) continue;
      if (this.lines.length >= this.maxLines) {
        this.truncatedFlag = true;
        break;
      }
      this.append(stream, remainder);
    }
    this.partial.clear();
    return this.lines;
  }

  private append(stream: CommandOutputLine['stream'], raw: string): void {
    const withoutCarriageReturn = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const sanitized = sanitizeDisplayLine(withoutCarriageReturn, COMMAND_MAX_OUTPUT_LINE_LENGTH);
    if (sanitized.truncated) this.truncatedFlag = true;
    this.lines.push({ stream, text: sanitized.text });
  }
}

/**
 * Runs one process to completion, or until a bound stops it.
 *
 * Never throws for a non-zero exit — a failing test suite is a result, not an
 * error. It throws {@link WorkspaceError} only when the process could not be
 * started at all.
 */
export async function runProcess(options: RunProcessOptions): Promise<ProcessRunResult> {
  const {
    program,
    args,
    cwd,
    timeoutMs,
    maxOutputBytes,
    maxOutputLines,
    signal,
    isEmergencyEngaged,
  } = options;

  const parentEnvironment = options.env ?? process.env;
  const env = buildChildEnvironment(parentEnvironment);
  const resolved = resolveProgram(program, parentEnvironment);

  if (
    resolved.viaInterpreter &&
    ![resolved.target, ...args].every((value) => SAFE_ARGUMENT_PATTERN.test(value))
  ) {
    // Refused rather than escaped: see SAFE_ARGUMENT_PATTERN. Checked before
    // the quoting in `buildSpawnArguments`, which is only safe because this
    // has already run.
    throw new WorkspaceError('COMMAND_LAUNCH_FAILED');
  }

  const spawnArguments = buildSpawnArguments(resolved, args);
  const startedAtMs = Date.now();
  const collector = new OutputCollector(maxOutputBytes, maxOutputLines);

  let child: ChildProcess;
  try {
    child = spawn(resolved.file, [...spawnArguments.argv], {
      cwd,
      env,
      shell: false,
      windowsHide: true,
      windowsVerbatimArguments: spawnArguments.verbatim,
      // No terminal: a command that decides to prompt reads end-of-file.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new WorkspaceError('COMMAND_LAUNCH_FAILED');
  }

  return new Promise<ProcessRunResult>((resolvePromise, rejectPromise) => {
    let timedOut = false;
    let cancelled = false;
    let stoppedByEmergency = false;
    let settled = false;

    child.stdout?.on('data', (chunk: Buffer) => {
      collector.push('stdout', chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      collector.push('stderr', chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);
    timer.unref();

    const onAbort = (): void => {
      cancelled = true;
      killProcessTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const emergencyTimer =
      isEmergencyEngaged === undefined
        ? null
        : setInterval(() => {
            void isEmergencyEngaged()
              .then((engaged) => {
                if (!engaged || settled) return;
                stoppedByEmergency = true;
                killProcessTree(child);
              })
              .catch(() => undefined);
          }, COMMAND_EMERGENCY_POLL_MS);
    emergencyTimer?.unref();

    function cleanUp(): void {
      settled = true;
      clearTimeout(timer);
      if (emergencyTimer !== null) clearInterval(emergencyTimer);
      signal?.removeEventListener('abort', onAbort);
    }

    child.on('error', () => {
      if (settled) return;
      cleanUp();
      rejectPromise(new WorkspaceError('COMMAND_LAUNCH_FAILED'));
    });

    child.on('close', (code) => {
      if (settled) return;
      cleanUp();
      resolvePromise({
        exitCode: code,
        output: collector.finish(),
        outputTruncated: collector.truncated,
        timedOut,
        cancelled,
        stoppedByEmergency,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      });
    });
  });
}
