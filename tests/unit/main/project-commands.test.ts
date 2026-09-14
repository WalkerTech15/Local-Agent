import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildCommandCatalog,
  readProjectScripts,
  runCodingCommand,
} from '../../../src/main/project-commands';
import { adoptProjectDirectory, type ApprovedProject } from '../../../src/main/workspace-session';
import { commandCatalogSchema, commandRunResultSchema } from '../../../src/shared/schemas';
import { CODING_COMMAND_IDS } from '../../../src/shared/workspace/command-registry';

/**
 * Resolving and running registry commands against a real project (Phase 2,
 * Milestone 6).
 *
 * The `package.json` these tests write is untrusted input in exactly the
 * sense `AGENTS.md` §5 means, so the cases here are mostly about what a
 * hostile or malformed one cannot do: it cannot make a command available that
 * the registry does not declare, cannot inject anything into an argument
 * vector, and cannot put text into a confirmation dialog that would misread.
 */

const NOW = '2026-09-08T00:00:00.000Z';
const RUN_ID = '33333333-3333-4333-8333-333333333333';

let dir: string;
let root: string;
let project: ApprovedProject;

async function writePackageJson(content: string): Promise<void> {
  await writeFile(join(root, 'package.json'), content, 'utf8');
}

async function approve(): Promise<void> {
  project = await adoptProjectDirectory({
    chosenPath: root,
    now: NOW,
    userDataDir: join(dir, 'Local-Agent'),
  });
}

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'local-agent-commands-')));
  root = join(dir, 'demo');
  await mkdir(root, { recursive: true });
  await writePackageJson(
    JSON.stringify({
      name: 'demo',
      scripts: { test: 'vitest run', lint: 'eslint .', build: 'tsc && vite build' },
    }),
  );
  await approve();
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readProjectScripts', () => {
  it('finds the scripts the project declares', async () => {
    const scripts = await readProjectScripts(project);
    expect(scripts.get('test')).toBe('vitest run');
    expect(scripts.get('lint')).toBe('eslint .');
  });

  it('only ever looks up the fixed names the registry declares', async () => {
    await writePackageJson(
      JSON.stringify({ scripts: { test: 'vitest run', 'some-other-script': 'whatever' } }),
    );
    const scripts = await readProjectScripts(project);
    expect([...scripts.keys()]).toEqual(['test']);
  });

  it('returns nothing rather than failing when there is no package.json', async () => {
    await rm(join(root, 'package.json'));
    expect((await readProjectScripts(project)).size).toBe(0);
  });

  it('returns nothing for malformed JSON', async () => {
    await writePackageJson('{ not json');
    expect((await readProjectScripts(project)).size).toBe(0);
  });

  it('returns nothing when scripts is not an object', async () => {
    for (const body of ['{"scripts":"test"}', '{"scripts":[1,2]}', '{"scripts":null}', '[]']) {
      await writePackageJson(body);
      expect((await readProjectScripts(project)).size, body).toBe(0);
    }
  });

  it('refuses a document carrying a prototype-pollution key', async () => {
    await writePackageJson('{"__proto__":{"polluted":true},"scripts":{"test":"vitest run"}}');
    expect((await readProjectScripts(project)).size).toBe(0);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('ignores a script whose value is not a string', async () => {
    await writePackageJson('{"scripts":{"test":{"run":"vitest"},"lint":"eslint ."}}');
    const scripts = await readProjectScripts(project);
    expect(scripts.has('test')).toBe(false);
    expect(scripts.get('lint')).toBe('eslint .');
  });
});

describe('buildCommandCatalog', () => {
  it('lists every registry command, available or not', async () => {
    const catalog = await buildCommandCatalog(project, false);
    expect(catalog.commands.map((command) => command.id).sort()).toEqual(
      [...CODING_COMMAND_IDS].sort(),
    );
    expect(commandCatalogSchema.safeParse(catalog).success).toBe(true);
  });

  it('marks only the commands this project actually declares as available', async () => {
    const catalog = await buildCommandCatalog(project, false);
    const available = catalog.commands.filter((command) => command.available);
    expect(available.map((command) => command.id).sort()).toEqual(['build', 'lint', 'test']);
  });

  it('shows the project’s own script text so a person can see what will run', async () => {
    const catalog = await buildCommandCatalog(project, false);
    const test = catalog.commands.find((command) => command.id === 'test');
    expect(test?.scriptPreview).toBe('vitest run');
  });

  it('flags a script that chains commands', async () => {
    const catalog = await buildCommandCatalog(project, false);
    const build = catalog.commands.find((command) => command.id === 'build');
    expect(build?.risks).toContain('chains-commands');
  });

  it('sanitizes a hostile script before it can reach a dialog', async () => {
    // A multi-line script must not be able to push the real question off the
    // confirmation dialog, and a bidi override must not reorder it.
    await writePackageJson(
      JSON.stringify({
        scripts: { test: `line one\nline two ‮derovaf‬ ${'x'.repeat(500)}` },
      }),
    );
    const catalog = await buildCommandCatalog(project, false);
    const preview = catalog.commands.find((command) => command.id === 'test')?.scriptPreview ?? '';
    expect(preview).not.toContain('\n');
    expect(preview).not.toContain('‮');
    expect(preview.length).toBeLessThanOrEqual(200);
    expect(commandCatalogSchema.safeParse(catalog).success).toBe(true);
  });

  it('never lets a project name the command line that would run', async () => {
    // The project supplies the script *body*. The argument vector is built
    // from registry literals, so it is identical whatever package.json says.
    await writePackageJson(
      JSON.stringify({ scripts: { test: 'anything at all && whoami', build: 'x' } }),
    );
    const catalog = await buildCommandCatalog(project, false);
    for (const command of catalog.commands) {
      expect(command.commandLine, command.id).toMatch(/^npm run [a-z][a-z0-9:._-]*$/);
    }
  });

  it('reports whether a command is already running', async () => {
    expect((await buildCommandCatalog(project, true)).busy).toBe(true);
    expect((await buildCommandCatalog(project, false)).busy).toBe(false);
  });
});

describe('runCodingCommand — refusing before it spawns', () => {
  it('refuses a command the project does not declare', async () => {
    await expect(
      runCodingCommand({
        project,
        commandId: 'typecheck',
        runId: RUN_ID,
        startedAt: NOW,
        finishedAtFn: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_NOT_AVAILABLE' });
  });

  it('re-checks availability at run time, not from whatever the catalog said', async () => {
    const before = await buildCommandCatalog(project, false);
    expect(before.commands.find((command) => command.id === 'test')?.available).toBe(true);

    await writePackageJson(JSON.stringify({ scripts: { lint: 'eslint .' } }));

    await expect(
      runCodingCommand({
        project,
        commandId: 'test',
        runId: RUN_ID,
        startedAt: NOW,
        finishedAtFn: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_NOT_AVAILABLE' });
  });

  it('refuses an identifier that is not in the registry at all', async () => {
    await expect(
      runCodingCommand({
        project,
        // Cast deliberately: the schema makes this unreachable from a request,
        // so this is the module's own defence for a value that arrived by some
        // path that bypassed validation.
        commandId: 'install' as never,
        runId: RUN_ID,
        startedAt: NOW,
        finishedAtFn: () => NOW,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_NOT_AVAILABLE' });
  });
});

describe('runCodingCommand — running the project’s own script', () => {
  it('runs it, captures its output, and reports the fixed command line', async () => {
    await writePackageJson(
      JSON.stringify({
        name: 'demo',
        scripts: { test: 'node -e "console.log(\'from the project\')"' },
      }),
    );

    const result = await runCodingCommand({
      project,
      commandId: 'test',
      runId: RUN_ID,
      startedAt: NOW,
      finishedAtFn: () => '2026-09-08T00:00:05.000Z',
    });

    expect(result.commandLine).toBe('npm run test');
    expect(result.runId).toBe(RUN_ID);
    expect(result.outcome).toBe('succeeded');
    expect(result.exitCode).toBe(0);
    expect(result.output.map((line) => line.text).join('\n')).toContain('from the project');
    expect(commandRunResultSchema.safeParse(result).success).toBe(true);
  }, 120_000);

  it('reports a failing script as failed, not as an error', async () => {
    await writePackageJson(
      JSON.stringify({ name: 'demo', scripts: { test: 'node -e "process.exit(1)"' } }),
    );

    const result = await runCodingCommand({
      project,
      commandId: 'test',
      runId: RUN_ID,
      startedAt: NOW,
      finishedAtFn: () => '2026-09-08T00:00:05.000Z',
    });

    expect(result.outcome).toBe('failed');
    expect(result.exitCode).not.toBe(0);
    expect(commandRunResultSchema.safeParse(result).success).toBe(true);
  }, 120_000);

  it('runs in the approved project and nowhere else', async () => {
    await writePackageJson(
      JSON.stringify({ name: 'demo', scripts: { test: 'node -e "console.log(process.cwd())"' } }),
    );

    const result = await runCodingCommand({
      project,
      commandId: 'test',
      runId: RUN_ID,
      startedAt: NOW,
      finishedAtFn: () => '2026-09-08T00:00:05.000Z',
    });

    expect(result.output.map((line) => line.text).join('\n')).toContain(root);
  }, 120_000);
});
