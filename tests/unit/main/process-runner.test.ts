import { describe, expect, it } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildChildEnvironment,
  buildSpawnArguments,
  INHERITED_ENVIRONMENT_NAMES,
  resolveProgram,
  runProcess,
  SAFE_ARGUMENT_PATTERN,
} from '../../../src/main/process-runner';
import { commandOutputLineSchema } from '../../../src/shared/schemas/coding.schema';
import { WorkspaceError } from '../../../src/shared/workspace/errors';

/**
 * The bounded process runner (Phase 2, Milestone 6).
 *
 * Every case here spawns a **real** process — this project's own Node binary,
 * running a one-line script — because the behaviours under test are exactly
 * the ones a mock cannot have: whether a pipe fills, whether a kill lands,
 * whether a child sees an environment variable. A fake child process would
 * only assert that the fake behaves as the test expects.
 *
 * `process.execPath` is an absolute path, so it takes the same `spawn` path a
 * resolved `npm` or `git` would, without needing either to be installed.
 */

const NODE = process.execPath;

/** Generous, so a slow machine never makes an unrelated assertion flaky. */
const AMPLE_TIMEOUT = 30_000;

interface RunOptions {
  readonly script: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly maxOutputLines?: number;
  readonly signal?: AbortSignal;
  readonly isEmergencyEngaged?: () => Promise<boolean>;
  readonly env?: NodeJS.ProcessEnv;
}

async function run(options: RunOptions) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-proc-')));
  try {
    return await runProcess({
      program: NODE,
      args: ['-e', options.script],
      cwd: dir,
      timeoutMs: options.timeoutMs ?? AMPLE_TIMEOUT,
      maxOutputBytes: options.maxOutputBytes ?? 200_000,
      maxOutputLines: options.maxOutputLines ?? 2_000,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.isEmergencyEngaged === undefined
        ? {}
        : { isEmergencyEngaged: options.isEmergencyEngaged }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function text(output: readonly { readonly text: string }[]): string {
  return output.map((line) => line.text).join('\n');
}

describe('running a process at all', () => {
  it('captures stdout and reports a zero exit code', async () => {
    const result = await run({ script: 'console.log("hello")' });
    expect(result.exitCode).toBe(0);
    expect(text(result.output)).toContain('hello');
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
    expect(result.stoppedByEmergency).toBe(false);
  });

  it('separates stderr from stdout', async () => {
    const result = await run({
      script: 'console.log("out"); console.error("err")',
    });
    const streams = new Map(result.output.map((line) => [line.text, line.stream]));
    expect(streams.get('out')).toBe('stdout');
    expect(streams.get('err')).toBe('stderr');
  });

  it('treats a non-zero exit as a result, not an error', async () => {
    // A failing test suite is information. Throwing here would make a normal
    // outcome indistinguishable from a broken runner.
    const result = await run({ script: 'process.exit(7)' });
    expect(result.exitCode).toBe(7);
  });

  it('runs in the directory it was given', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-cwd-')));
    try {
      const result = await runProcess({
        program: NODE,
        args: ['-e', 'console.log(process.cwd())'],
        cwd: dir,
        timeoutMs: AMPLE_TIMEOUT,
        maxOutputBytes: 200_000,
        maxOutputLines: 100,
      });
      expect(text(result.output)).toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports a normalized failure when the program does not exist', async () => {
    await expect(
      runProcess({
        program: join(tmpdir(), 'local-agent-no-such-program-38f1'),
        args: [],
        cwd: tmpdir(),
        timeoutMs: 5_000,
        maxOutputBytes: 1_000,
        maxOutputLines: 10,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_LAUNCH_FAILED' });
  });

  it('produces output lines its own schema accepts', async () => {
    const result = await run({ script: 'console.log("a\\tb"); console.log("plain")' });
    for (const line of result.output) {
      expect(commandOutputLineSchema.safeParse(line).success, line.text).toBe(true);
    }
  });
});

describe('bounds', () => {
  it('kills a command that runs past its time limit', async () => {
    const result = await run({
      script: 'setTimeout(() => {}, 60000)',
      timeoutMs: 700,
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(20_000);
  }, 30_000);

  it('stops capturing at the line limit and says the output was truncated', async () => {
    const result = await run({
      script: 'for (let i = 0; i < 5000; i += 1) console.log("line" + i)',
      maxOutputLines: 10,
    });
    expect(result.output.length).toBeLessThanOrEqual(10);
    expect(result.outputTruncated).toBe(true);
  }, 30_000);

  it('stops capturing at the byte limit and says the output was truncated', async () => {
    const result = await run({
      script: 'for (let i = 0; i < 5000; i += 1) console.log("x".repeat(200))',
      maxOutputBytes: 2_000,
    });
    expect(result.outputTruncated).toBe(true);
  }, 30_000);

  it('keeps draining past the bound, so a full pipe never wedges the child', async () => {
    // If output past the cap were left unread the child would block forever
    // on a full stdout pipe and only its timeout would end it. It must exit
    // on its own, with its own exit code.
    const result = await run({
      script: 'for (let i = 0; i < 20000; i += 1) console.log("y".repeat(100)); process.exit(0)',
      maxOutputLines: 5,
      timeoutMs: 25_000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.outputTruncated).toBe(true);
  }, 40_000);

  it('elides a single enormous line rather than carrying it whole', async () => {
    const result = await run({ script: 'console.log("z".repeat(50000))' });
    for (const line of result.output) {
      expect(line.text.length).toBeLessThanOrEqual(2_000);
    }
    expect(result.outputTruncated).toBe(true);
  }, 30_000);
});

describe('cancellation and the emergency stop', () => {
  it('kills a running command when its signal is aborted', async () => {
    const controller = new AbortController();
    setTimeout(() => {
      controller.abort();
    }, 300);

    const result = await run({
      script: 'setTimeout(() => {}, 60000)',
      signal: controller.signal,
      timeoutMs: 25_000,
    });
    expect(result.cancelled).toBe(true);
    expect(result.timedOut).toBe(false);
  }, 40_000);

  it('kills a command that was already running when the emergency stop engaged', async () => {
    // The permission engine already refuses to *start* an action while the
    // stop is engaged. This is the other half: without it, "emergency stop"
    // would mean "no new work" rather than "stop".
    let engaged = false;
    setTimeout(() => {
      engaged = true;
    }, 300);

    const result = await run({
      script: 'setTimeout(() => {}, 60000)',
      isEmergencyEngaged: () => Promise.resolve(engaged),
      timeoutMs: 25_000,
    });
    expect(result.stoppedByEmergency).toBe(true);
  }, 40_000);

  it('leaves a command that finishes normally unmarked', async () => {
    const controller = new AbortController();
    const result = await run({
      script: 'console.log("done")',
      signal: controller.signal,
      isEmergencyEngaged: () => Promise.resolve(false),
    });
    expect(result.cancelled).toBe(false);
    expect(result.stoppedByEmergency).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});

describe('what the child does not get', () => {
  it('does not inherit the parent’s environment', async () => {
    // A user who exported an API token into their shell must not hand it to a
    // project's build script because they asked Local Agent to run one.
    const result = await run({
      script: 'console.log(process.env.LOCAL_AGENT_TEST_SECRET ?? "absent")',
      env: { ...process.env, LOCAL_AGENT_TEST_SECRET: 'fake-sentinel-value' },
    });
    expect(text(result.output)).toContain('absent');
    expect(text(result.output)).not.toContain('fake-sentinel-value');
  });

  it('does pass through what a toolchain genuinely needs', async () => {
    const result = await run({
      script: 'console.log(process.env.PATH === undefined ? "no-path" : "has-path")',
    });
    expect(text(result.output)).toContain('has-path');
  });

  it('does not get a terminal, so a command that reads input cannot hang', async () => {
    const startedAt = Date.now();
    const result = await run({
      script: 'try { require("node:fs").readFileSync(0, "utf8"); } catch {} process.exit(0)',
      timeoutMs: 20_000,
    });
    expect(result.timedOut).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(15_000);
  }, 30_000);
});

describe('buildChildEnvironment', () => {
  it('keeps only the allowlisted names', () => {
    const child = buildChildEnvironment({
      PATH: '/usr/bin',
      GITHUB_TOKEN: 'fake-sentinel-value',
      AWS_SECRET_ACCESS_KEY: 'fake-sentinel-value',
      NODE_OPTIONS: '--require ./evil.js',
      SystemRoot: 'C:\\Windows',
    });
    expect(child.PATH).toBe('/usr/bin');
    expect(child.SystemRoot).toBe('C:\\Windows');
    expect(child.GITHUB_TOKEN).toBeUndefined();
    expect(child.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    // `NODE_OPTIONS` would inject a module into every child process.
    expect(child.NODE_OPTIONS).toBeUndefined();
  });

  it('matches an allowlisted name whatever its case', () => {
    const child = buildChildEnvironment({ path: '/usr/bin', COMSPEC: 'C:\\Windows\\cmd.exe' });
    expect(Object.values(child)).toContain('/usr/bin');
    expect(Object.values(child)).toContain('C:\\Windows\\cmd.exe');
  });

  it('forces the variables that stop a tool prompting or colouring', () => {
    const child = buildChildEnvironment({});
    expect(child.CI).toBe('1');
    expect(child.NO_COLOR).toBe('1');
    expect(child.GIT_TERMINAL_PROMPT).toBe('0');
  });

  it('names no credential-shaped variable in the allowlist', () => {
    for (const name of INHERITED_ENVIRONMENT_NAMES) {
      expect(name.toLowerCase(), name).not.toMatch(/token|secret|key|password|auth/);
    }
  });
});

describe('resolveProgram and argument safety', () => {
  it('passes an absolute path straight through, with no interpreter', () => {
    const resolved = resolveProgram(NODE, process.env);
    expect(resolved.file).toBe(NODE);
    expect(resolved.target).toBe(NODE);
    expect(resolved.viaInterpreter).toBe(false);
  });

  it('hands the arguments to spawn unchanged when there is no interpreter', () => {
    const resolved = resolveProgram(NODE, process.env);
    const spawnArguments = buildSpawnArguments(resolved, ['run', 'test']);
    expect(spawnArguments.argv).toEqual(['run', 'test']);
    expect(spawnArguments.verbatim).toBe(false);
  });

  it('double-wraps the interpreter command so a path with spaces survives', () => {
    // `cmd /s /c` strips the first and last quote of everything after `/c`.
    // Without the outer pair, `C:\Program Files\nodejs\npm.cmd` is split at
    // the space and the run fails with "'C:\Program' is not recognized" —
    // which is exactly what this test caught before the fix.
    const resolved = {
      file: 'C:\\Windows\\system32\\cmd.exe',
      target: 'C:\\Program Files\\nodejs\\npm.cmd',
      viaInterpreter: true,
    };
    const spawnArguments = buildSpawnArguments(resolved, ['run', 'test']);

    expect(spawnArguments.verbatim).toBe(true);
    expect(spawnArguments.argv.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(spawnArguments.argv[3]).toBe('""C:\\Program Files\\nodejs\\npm.cmd" "run" "test""');

    // Stripping the outer pair, as `/s` does, must leave a runnable command
    // with the program path still quoted as one token.
    const inner = (spawnArguments.argv[3] ?? '').slice(1, -1);
    expect(inner).toBe('"C:\\Program Files\\nodejs\\npm.cmd" "run" "test"');
  });

  it('reports a normalized failure when a bare name is nowhere on PATH', () => {
    if (process.platform !== 'win32') return;
    expect(() =>
      resolveProgram('local-agent-no-such-tool-7c1a', { PATH: '', PATHEXT: '.EXE' }),
    ).toThrow(WorkspaceError);
  });

  it('accepts every argument this codebase actually builds', () => {
    for (const argument of [
      'run',
      'test',
      'format:check',
      '--porcelain=v1',
      '--no-ext-diff',
      'core.hooksPath=C:\\Users\\me\\AppData\\Roaming\\Local-Agent\\state\\git-hooks-disabled',
      'Local Agent checkpoint 2026-09-08T00:00:00.000Z',
      'src/index.ts',
      '--',
    ]) {
      expect(SAFE_ARGUMENT_PATTERN.test(argument), argument).toBe(true);
    }
  });

  it('refuses every character the command interpreter treats as syntax', () => {
    // The guard that means an argument is never *escaped* for two different
    // interpreters — a run whose arguments are not all plain is refused.
    for (const hostile of [
      'a&b',
      'a|b',
      'a>b',
      'a<b',
      'a^b',
      'a%PATH%b',
      'a!b!',
      'a"b',
      'a`b',
      'a$b',
      'a;b',
      'a(b)',
      `a${String.fromCharCode(10)}b`,
    ]) {
      expect(SAFE_ARGUMENT_PATTERN.test(hostile), hostile).toBe(false);
    }
  });
});
