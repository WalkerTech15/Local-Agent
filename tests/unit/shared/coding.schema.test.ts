import { describe, expect, it } from 'vitest';

import {
  commandCatalogSchema,
  commandIdSchema,
  commandRunResultSchema,
  fileDiffSchema,
  gitCheckpointSchema,
  gitStatusSchema,
  workspaceChangeSetSchema,
  workspaceEditSchema,
  workspaceProposedContentSchema,
} from '../../../src/shared/schemas/coding.schema';
import {
  commandCancelRequestSchema,
  commandRunRequestSchema,
  gitCheckpointRequestSchema,
  gitDiffRequestSchema,
  gitStatusRequestSchema,
  workspaceApplyRequestSchema,
  workspaceChangesRequestSchema,
  workspaceProposeRequestSchema,
  workspaceRollbackRequestSchema,
} from '../../../src/shared/schemas/ipc.schema';
import {
  WORKSPACE_MAX_CHANGE_FILES,
  WORKSPACE_MAX_WRITE_BYTES,
} from '../../../src/shared/constants';

/**
 * Every shape the Milestone 6 channels can carry.
 *
 * Most of these assertions are about what cannot be expressed. The milestone's
 * central claim — that a change is applied by reference, that a command is
 * named rather than spelled, and that Git is not addressable — is a claim
 * about these schemas, so it is checked here rather than left to the handlers
 * that use them.
 */

const CHANGE_ID = '11111111-1111-4111-8111-111111111111';
const RUN_ID = '22222222-2222-4222-8222-222222222222';

const VALID_CHANGE = {
  id: CHANGE_ID,
  createdAt: '2026-09-08T00:00:00.000Z',
  status: 'awaiting-approval' as const,
  files: [
    {
      path: 'src/index.ts',
      name: 'index.ts',
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: 'removed' as const, text: 'a' },
            { kind: 'added' as const, text: 'b' },
          ],
        },
      ],
      added: 1,
      removed: 1,
      coarse: false,
      truncated: false,
      warnings: [],
    },
  ],
  totalAdded: 1,
  totalRemoved: 1,
  truncated: false,
  approvalRequired: true as const,
  backupAvailable: false,
  appliedAt: null,
  rolledBackAt: null,
};

describe('applying a change names a change, never a destination', () => {
  it('accepts a change id and nothing else', () => {
    expect(workspaceApplyRequestSchema.safeParse([{ changeId: CHANGE_ID }]).success).toBe(true);
    expect(workspaceRollbackRequestSchema.safeParse([{ changeId: CHANGE_ID }]).success).toBe(true);
  });

  it('refuses any additional field, so content can never be substituted', () => {
    for (const extra of [
      { path: 'src/index.ts' },
      { content: 'anything' },
      { edits: [] },
      { force: true },
      { destination: 'C:\\' },
    ]) {
      const parsed = workspaceApplyRequestSchema.safeParse([{ changeId: CHANGE_ID, ...extra }]);
      expect(parsed.success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('refuses a change id that is not a uuid', () => {
    for (const changeId of ['src/index.ts', '../escape', '', '1', 'not-a-uuid']) {
      expect(workspaceApplyRequestSchema.safeParse([{ changeId }]).success, changeId).toBe(false);
    }
  });
});

describe('proposing a change', () => {
  it('accepts a bounded set of edits', () => {
    expect(
      workspaceProposeRequestSchema.safeParse([
        { edits: [{ path: 'src/index.ts', content: 'x\n' }] },
      ]).success,
    ).toBe(true);
  });

  it('refuses a path that is not inside the project', () => {
    for (const path of ['../escape.ts', '/etc/passwd', 'C:/Windows/x', 'src\\index.ts', '']) {
      expect(
        workspaceProposeRequestSchema.safeParse([{ edits: [{ path, content: 'x' }] }]).success,
        path,
      ).toBe(false);
    }
  });

  it('refuses more files than the change-set bound', () => {
    const edits = Array.from({ length: WORKSPACE_MAX_CHANGE_FILES + 1 }, (_, index) => ({
      path: `src/file${String(index)}.ts`,
      content: 'x',
    }));
    expect(workspaceProposeRequestSchema.safeParse([{ edits }]).success).toBe(false);
  });

  it('refuses an empty change set', () => {
    expect(workspaceProposeRequestSchema.safeParse([{ edits: [] }]).success).toBe(false);
  });

  it('refuses a change set naming the same file twice', () => {
    // Two edits to one file would make "what does this do to that file"
    // ambiguous, and an ambiguous change cannot be meaningfully approved.
    const parsed = workspaceProposeRequestSchema.safeParse([
      {
        edits: [
          { path: 'src/index.ts', content: 'a' },
          { path: 'src/index.ts', content: 'b' },
        ],
      },
    ]);
    expect(parsed.success).toBe(false);
  });

  it('bounds the proposed content', () => {
    expect(
      workspaceProposedContentSchema.safeParse('x'.repeat(WORKSPACE_MAX_WRITE_BYTES)).success,
    ).toBe(true);
    expect(
      workspaceProposedContentSchema.safeParse('x'.repeat(WORKSPACE_MAX_WRITE_BYTES + 1)).success,
    ).toBe(false);
  });

  it('refuses NUL in proposed content', () => {
    expect(workspaceProposedContentSchema.safeParse(`a${String.fromCharCode(0)}b`).success).toBe(
      false,
    );
  });

  it('accepts ordinary multi-line source, including non-Latin text', () => {
    for (const content of ['a\nb\n', '', 'const x = "héllo";\n', '// 说明\n', 'a\tb\n']) {
      expect(workspaceEditSchema.safeParse({ path: 'src/a.ts', content }).success, content).toBe(
        true,
      );
    }
  });
});

describe('a change set cannot describe itself as approved', () => {
  it('accepts a well-formed change set', () => {
    expect(workspaceChangeSetSchema.safeParse(VALID_CHANGE).success).toBe(true);
  });

  it('pins approvalRequired to true', () => {
    expect(
      workspaceChangeSetSchema.safeParse({ ...VALID_CHANGE, approvalRequired: false }).success,
    ).toBe(false);
  });

  it('has no status meaning "already approved"', () => {
    for (const status of ['approved', 'authorized', 'pending-write', 'writing']) {
      expect(workspaceChangeSetSchema.safeParse({ ...VALID_CHANGE, status }).success, status).toBe(
        false,
      );
    }
  });

  it('refuses a diff line carrying a control character or a bidi override', () => {
    // These lines are what a person reads before letting the application write
    // to their disk, so text that renders differently from how it is stored is
    // refused at the boundary rather than merely discouraged.
    for (const text of [`a${String.fromCharCode(9)}b`, 'const admin = ‮eurt‬;']) {
      const parsed = fileDiffSchema.safeParse({
        ...VALID_CHANGE.files[0],
        hunks: [
          { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ kind: 'added', text }] },
        ],
      });
      expect(parsed.success, text).toBe(false);
    }
  });
});

describe('a command is named, never spelled', () => {
  it('accepts only the five registry identifiers', () => {
    for (const commandId of ['test', 'lint', 'typecheck', 'build', 'format-check']) {
      expect(commandIdSchema.safeParse(commandId).success, commandId).toBe(true);
    }
    for (const commandId of ['install', 'start', 'publish', 'npm run test', 'TEST', '']) {
      expect(commandIdSchema.safeParse(commandId).success, commandId).toBe(false);
    }
  });

  it('has no field for a command string, an argument, a shell or a directory', () => {
    for (const extra of [
      { command: 'npm run test' },
      { args: ['--watch'] },
      { cwd: 'C:\\' },
      { env: {} },
      { shell: true },
      { program: 'node' },
    ]) {
      const parsed = commandRunRequestSchema.safeParse([
        { runId: RUN_ID, commandId: 'test', ...extra },
      ]);
      expect(parsed.success, JSON.stringify(extra)).toBe(false);
    }
  });

  it('requires a run id so a cancellation has something to address', () => {
    expect(commandRunRequestSchema.safeParse([{ commandId: 'test' }]).success).toBe(false);
    expect(commandCancelRequestSchema.safeParse([{ runId: 'not-a-uuid' }]).success).toBe(false);
    expect(commandCancelRequestSchema.safeParse([{ runId: RUN_ID }]).success).toBe(true);
  });

  it('refuses command output carrying a control character', () => {
    const run = {
      runId: RUN_ID,
      commandId: 'test' as const,
      commandLine: 'npm run test',
      outcome: 'succeeded' as const,
      exitCode: 0,
      startedAt: '2026-09-08T00:00:00.000Z',
      finishedAt: '2026-09-08T00:00:01.000Z',
      durationMs: 1000,
      output: [{ stream: 'stdout' as const, text: `ok${String.fromCharCode(27)}[31m` }],
      outputTruncated: false,
      timedOut: false,
      cancelled: false,
      stoppedByEmergency: false,
    };
    expect(commandRunResultSchema.safeParse(run).success).toBe(false);
    expect(
      commandRunResultSchema.safeParse({ ...run, output: [{ stream: 'stdout', text: 'ok' }] })
        .success,
    ).toBe(true);
  });

  it('bounds the catalog to the size of the registry', () => {
    const descriptor = {
      id: 'test' as const,
      label: 'Run tests',
      description: 'Runs the tests.',
      commandLine: 'npm run test',
      available: true,
      scriptPreview: 'vitest run',
      risks: [],
    };
    expect(commandCatalogSchema.safeParse({ commands: [descriptor], busy: false }).success).toBe(
      true,
    );
    expect(
      commandCatalogSchema.safeParse({
        commands: Array.from({ length: 6 }, () => descriptor),
        busy: false,
      }).success,
    ).toBe(false);
  });
});

describe('Git is not addressable', () => {
  it('takes no arguments for status or a checkpoint', () => {
    expect(gitStatusRequestSchema.safeParse([]).success).toBe(true);
    expect(gitCheckpointRequestSchema.safeParse([]).success).toBe(true);
    expect(gitCheckpointRequestSchema.safeParse([{}]).success).toBe(false);
  });

  it('refuses every field through which a ref, branch, remote or message could arrive', () => {
    for (const payload of [
      { branch: 'main' },
      { ref: 'HEAD~1' },
      { remote: 'origin' },
      { message: 'anything' },
      { subcommand: 'reset' },
      { force: true },
    ]) {
      expect(gitCheckpointRequestSchema.safeParse([payload]).success, JSON.stringify(payload)).toBe(
        false,
      );
    }
  });

  it('takes a project-relative path, or null, for a diff — and nothing else', () => {
    expect(gitDiffRequestSchema.safeParse([{ path: null }]).success).toBe(true);
    expect(gitDiffRequestSchema.safeParse([{ path: 'src/index.ts' }]).success).toBe(true);
    for (const path of ['../escape', '/etc/passwd', 'C:/x', 'src\\index.ts']) {
      expect(gitDiffRequestSchema.safeParse([{ path }]).success, path).toBe(false);
    }
  });

  it('refuses a status entry whose path is not project-relative', () => {
    const base = {
      branch: 'main',
      entries: [{ path: '../escape.ts', code: ' M', state: 'modified' as const, staged: false }],
      clean: false,
      truncated: false,
      unparsableEntries: 0,
    };
    expect(gitStatusSchema.safeParse(base).success).toBe(false);
  });

  it('requires a checkpoint to report a real commit hash', () => {
    const base = {
      branch: 'main',
      commit: 'abc1234',
      message: 'Local Agent checkpoint 2026-09-08T00:00:00.000Z',
      filesChanged: 1,
      createdAt: '2026-09-08T00:00:00.000Z',
    };
    expect(gitCheckpointSchema.safeParse(base).success).toBe(true);
    for (const commit of ['', 'zzz', 'not a hash', 'ABC1234']) {
      expect(gitCheckpointSchema.safeParse({ ...base, commit }).success, commit).toBe(false);
    }
  });
});

describe('the argument-free channels stay argument-free', () => {
  it('rejects any argument at all', () => {
    for (const schema of [workspaceChangesRequestSchema, gitStatusRequestSchema]) {
      expect(schema.safeParse([]).success).toBe(true);
      expect(schema.safeParse([{}]).success).toBe(false);
      expect(schema.safeParse([null]).success).toBe(false);
    }
  });
});
