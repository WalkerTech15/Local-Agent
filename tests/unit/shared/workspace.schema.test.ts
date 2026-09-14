import { describe, expect, it } from 'vitest';

import {
  codingPlanSchema,
  workspaceEntryPathSchema,
  workspaceEntrySchema,
  workspaceFileContentSchema,
  workspaceFileSchema,
  workspaceNameSchema,
  workspaceObjectiveSchema,
  workspaceProjectPathSchema,
  workspaceProjectSummarySchema,
  workspaceRelativePathSchema,
  workspaceSearchExcerptSchema,
  workspaceSearchQuerySchema,
  workspaceSearchResultSchema,
  workspaceTreeSchema,
} from '../../../src/shared/schemas/workspace.schema';
import {
  WORKSPACE_MAX_FILE_CONTENT_LENGTH,
  WORKSPACE_MAX_SEARCH_RESULTS,
  WORKSPACE_MAX_TREE_ENTRIES,
  WORKSPACE_OBJECTIVE_MAX_LENGTH,
  WORKSPACE_SEARCH_QUERY_MAX_LENGTH,
  WORKSPACE_SEARCH_QUERY_MIN_LENGTH,
} from '../../../src/shared/constants';

const NUL = String.fromCharCode(0);

describe('workspaceRelativePathSchema', () => {
  it('accepts the project root and an ordinary path', () => {
    expect(workspaceRelativePathSchema.safeParse('').success).toBe(true);
    expect(workspaceRelativePathSchema.safeParse('src/main/ipc.ts').success).toBe(true);
  });

  it('rejects a traversal, an absolute path and a backslash', () => {
    for (const value of ['../secrets', '/etc/passwd', 'src\\main', 'C:/Windows']) {
      expect(workspaceRelativePathSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('shares one rule with the main process rather than restating it', () => {
    // The schema delegates to `isSafeWorkspaceRelativePath`, the same function
    // `resolveProjectPath` calls, so the two can never drift apart.
    expect(workspaceRelativePathSchema.safeParse('CON.txt').success).toBe(false);
    expect(workspaceRelativePathSchema.safeParse('report\u202Etxt.exe').success).toBe(false);
  });

  it('requires an entry path to name something other than the root', () => {
    expect(workspaceEntryPathSchema.safeParse('').success).toBe(false);
    expect(workspaceEntryPathSchema.safeParse('README.md').success).toBe(true);
  });
});

describe('workspaceNameSchema and workspaceProjectPathSchema', () => {
  it('accept ordinary and accented names', () => {
    for (const name of ['index.ts', 'spécification.md', 'hướng-dẫn.md', '说明.md']) {
      expect(workspaceNameSchema.safeParse(name).success, name).toBe(true);
    }
  });

  it('reject control characters and bidirectional overrides in a name', () => {
    expect(workspaceNameSchema.safeParse(`bad${NUL}name`).success).toBe(false);
    expect(workspaceNameSchema.safeParse('bad\nname').success).toBe(false);
    expect(workspaceNameSchema.safeParse('report\u202Etxt.exe').success).toBe(false);
  });

  it('reject an empty name, which a drive root would produce', () => {
    expect(workspaceNameSchema.safeParse('').success).toBe(false);
  });

  it('accept a Windows absolute project path but reject an unsafe one', () => {
    expect(workspaceProjectPathSchema.safeParse('C:\\Users\\me\\project').success).toBe(true);
    expect(workspaceProjectPathSchema.safeParse('/home/me/project').success).toBe(true);
    expect(workspaceProjectPathSchema.safeParse(`C:\\bad${NUL}path`).success).toBe(false);
    expect(workspaceProjectPathSchema.safeParse('').success).toBe(false);
  });
});

describe('workspaceProjectSummarySchema', () => {
  const valid = {
    name: 'demo',
    path: 'C:\\Users\\me\\demo',
    selectedAt: '2026-09-07T00:00:00.000Z',
    markers: ['package.json', '.git'],
    hasGitMetadata: true,
  };

  it('accepts a well-formed summary', () => {
    expect(workspaceProjectSummarySchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an unknown field', () => {
    expect(
      workspaceProjectSummarySchema.safeParse({ ...valid, apiKey: 'sk-not-allowed' }).success,
    ).toBe(false);
  });

  it('rejects a timestamp with an offset', () => {
    expect(
      workspaceProjectSummarySchema.safeParse({ ...valid, selectedAt: '2026-09-07T00:00:00+02:00' })
        .success,
    ).toBe(false);
  });
});

describe('workspaceTreeSchema', () => {
  const entry = {
    path: 'src',
    name: 'src',
    kind: 'directory' as const,
    depth: 0,
    excluded: false,
    readable: false,
  };

  it('accepts a listing with a file entry carrying a size', () => {
    const result = workspaceTreeSchema.safeParse({
      root: '',
      entries: [
        entry,
        { ...entry, path: 'README.md', name: 'README.md', kind: 'file', size: 12, readable: true },
      ],
      truncated: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects more entries than the bound allows', () => {
    const entries = Array.from({ length: WORKSPACE_MAX_TREE_ENTRIES + 1 }, (_, index) => ({
      ...entry,
      path: `src/file${String(index)}.ts`,
      name: `file${String(index)}.ts`,
      kind: 'file' as const,
    }));
    expect(workspaceTreeSchema.safeParse({ root: '', entries, truncated: true }).success).toBe(
      false,
    );
  });

  it('rejects an entry whose path escapes the project', () => {
    expect(
      workspaceEntrySchema.safeParse({ ...entry, path: '../outside', name: 'outside' }).success,
    ).toBe(false);
  });

  it('rejects a negative size', () => {
    expect(
      workspaceEntrySchema.safeParse({
        ...entry,
        kind: 'file',
        path: 'a.ts',
        name: 'a.ts',
        size: -1,
      }).success,
    ).toBe(false);
  });
});

describe('workspaceFileSchema', () => {
  const metadata = {
    path: 'README.md',
    name: 'README.md',
    size: 5,
    lineCount: 1,
    encoding: 'utf-8' as const,
    warnings: [],
  };

  it('accepts a text file, including an empty one', () => {
    expect(workspaceFileSchema.safeParse({ metadata, content: 'hello' }).success).toBe(true);
    expect(
      workspaceFileSchema.safeParse({
        metadata: { ...metadata, size: 0, lineCount: 0 },
        content: '',
      }).success,
    ).toBe(true);
  });

  it('rejects content containing NUL, as a backstop to the binary check', () => {
    expect(workspaceFileContentSchema.safeParse(`text${NUL}more`).success).toBe(false);
  });

  it('accepts content containing bidirectional overrides, and warns instead', () => {
    // Refusing would make Arabic, Hebrew and Persian source unopenable; the
    // warning is what tells the reader the text may not render as stored.
    expect(workspaceFileContentSchema.safeParse('const x = "\u202Eevil";').success).toBe(true);
    expect(
      workspaceFileSchema.safeParse({
        metadata: { ...metadata, warnings: ['bidirectional-control-characters'] },
        content: 'const x = "\u202Eevil";',
      }).success,
    ).toBe(true);
  });

  it('rejects content longer than the bound', () => {
    expect(
      workspaceFileContentSchema.safeParse('a'.repeat(WORKSPACE_MAX_FILE_CONTENT_LENGTH + 1))
        .success,
    ).toBe(false);
  });

  it('rejects an unknown warning', () => {
    expect(
      workspaceFileSchema.safeParse({
        metadata: { ...metadata, warnings: ['something-else'] },
        content: 'hello',
      }).success,
    ).toBe(false);
  });
});

describe('workspaceSearchResultSchema', () => {
  const match = { path: 'src/a.ts', line: 3, column: 7, excerpt: 'const answer = 42;' };

  it('accepts a well-formed result', () => {
    expect(
      workspaceSearchResultSchema.safeParse({
        query: 'answer',
        matches: [match],
        filesScanned: 1,
        truncated: false,
      }).success,
    ).toBe(true);
  });

  it('bounds the query at both ends', () => {
    expect(workspaceSearchQuerySchema.safeParse('a').success).toBe(false);
    expect(
      workspaceSearchQuerySchema.safeParse('a'.repeat(WORKSPACE_SEARCH_QUERY_MIN_LENGTH)).success,
    ).toBe(true);
    expect(
      workspaceSearchQuerySchema.safeParse('a'.repeat(WORKSPACE_SEARCH_QUERY_MAX_LENGTH + 1))
        .success,
    ).toBe(false);
  });

  it('rejects a query carrying control characters', () => {
    expect(workspaceSearchQuerySchema.safeParse(`find${NUL}me`).success).toBe(false);
  });

  it('rejects an excerpt carrying control characters or bidi overrides', () => {
    // The sender sanitizes these away, so one arriving means the sanitizer
    // was bypassed.
    expect(workspaceSearchExcerptSchema.safeParse(`line${NUL}break`).success).toBe(false);
    expect(workspaceSearchExcerptSchema.safeParse('spoofed\u202Eline').success).toBe(false);
    expect(workspaceSearchExcerptSchema.safeParse('').success).toBe(true);
  });

  it('rejects more matches than the bound allows', () => {
    const matches = Array.from({ length: WORKSPACE_MAX_SEARCH_RESULTS + 1 }, () => match);
    expect(
      workspaceSearchResultSchema.safeParse({
        query: 'answer',
        matches,
        filesScanned: 1,
        truncated: true,
      }).success,
    ).toBe(false);
  });

  it('rejects a zero line or column, since both are 1-based', () => {
    expect(
      workspaceSearchResultSchema.safeParse({
        query: 'answer',
        matches: [{ ...match, line: 0 }],
        filesScanned: 1,
        truncated: false,
      }).success,
    ).toBe(false);
  });
});

describe('workspaceObjectiveSchema', () => {
  it('accepts a multi-line request', () => {
    expect(workspaceObjectiveSchema.safeParse('Add retry.\nKeep it bounded.').success).toBe(true);
  });

  it('rejects an empty or oversized request', () => {
    expect(workspaceObjectiveSchema.safeParse('').success).toBe(false);
    expect(
      workspaceObjectiveSchema.safeParse('a'.repeat(WORKSPACE_OBJECTIVE_MAX_LENGTH + 1)).success,
    ).toBe(false);
  });

  it('rejects unsafe control characters and bidi overrides', () => {
    expect(workspaceObjectiveSchema.safeParse(`add${NUL}retry`).success).toBe(false);
    expect(workspaceObjectiveSchema.safeParse('add \u202Eretry').success).toBe(false);
  });
});

describe('codingPlanSchema — the shape that cannot describe a modification', () => {
  const validPlan = {
    objective: {
      request: 'Add retry',
      summary: 'A coding request concerning retry.',
      keywords: ['retry'],
    },
    context: {
      projectName: 'demo',
      markers: ['package.json'],
      hasGitMetadata: true,
      hasTestTooling: true,
      filesInspected: 3,
      searchTruncated: false,
    },
    steps: [{ order: 1, title: 'Read', detail: 'Read the files.' }],
    relevantFiles: [{ path: 'src/a.ts', reason: 'Matched.' }],
    risks: ['Read-only.'],
    assumptions: ['The project is correct.'],
    expectedChanges: [{ path: 'src/a.ts', changeType: 'review', rationale: 'Read it first.' }],
    changeSummary: '1 file identified. Nothing has been applied.',
    diff: null,
    approvalRequired: true,
    status: 'awaiting-approval',
    generatedAt: '2026-09-07T00:00:00.000Z',
  };

  it('accepts a well-formed plan', () => {
    expect(codingPlanSchema.safeParse(validPlan).success).toBe(true);
  });

  it('refuses a plan that claims not to need approval', () => {
    expect(codingPlanSchema.safeParse({ ...validPlan, approvalRequired: false }).success).toBe(
      false,
    );
  });

  it('refuses a plan that arrives already approved', () => {
    expect(codingPlanSchema.safeParse({ ...validPlan, status: 'approved' }).success).toBe(false);
    expect(codingPlanSchema.safeParse({ ...validPlan, status: 'applied' }).success).toBe(false);
  });

  it('refuses a plan carrying a diff', () => {
    // The whole point of pinning `diff` to `null`: producing file content is
    // one write away from applying it.
    expect(
      codingPlanSchema.safeParse({ ...validPlan, diff: '--- a/src/a.ts\n+++ b/src/a.ts' }).success,
    ).toBe(false);
  });

  it('refuses a change type that would describe writing or deleting', () => {
    for (const changeType of ['create', 'delete', 'write', 'apply']) {
      expect(
        codingPlanSchema.safeParse({
          ...validPlan,
          expectedChanges: [{ path: 'src/a.ts', changeType, rationale: 'x' }],
        }).success,
        changeType,
      ).toBe(false);
    }
  });

  it('refuses an unknown field, so nothing can ride along', () => {
    expect(codingPlanSchema.safeParse({ ...validPlan, patch: 'anything' }).success).toBe(false);
  });

  it('refuses an expected change pointing outside the project', () => {
    expect(
      codingPlanSchema.safeParse({
        ...validPlan,
        expectedChanges: [{ path: '../../etc/passwd', changeType: 'review', rationale: 'x' }],
      }).success,
    ).toBe(false);
  });
});
