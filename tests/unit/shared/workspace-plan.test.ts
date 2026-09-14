import { describe, expect, it } from 'vitest';

import { codingPlanSchema } from '../../../src/shared/schemas/workspace.schema';
import {
  buildCodingPlan,
  extractObjectiveKeywords,
  type CodingPlanObservations,
} from '../../../src/shared/workspace/plan';
import {
  WORKSPACE_OBJECTIVE_MAX_KEYWORDS,
  WORKSPACE_PLAN_MAX_FILES,
  WORKSPACE_PLAN_MAX_RISKS,
  WORKSPACE_PLAN_MAX_STEPS,
  WORKSPACE_PLAN_MAX_TEXT_LENGTH,
} from '../../../src/shared/constants';

/**
 * The pure plan builder (Phase 2, Milestone 5).
 *
 * Every case here runs with no filesystem, no clock and no model — which is
 * the point of the builder being pure. The two properties that carry the
 * milestone's guarantee are asserted first and repeatedly: a plan is always
 * `awaiting-approval`, and it never carries a diff.
 */

const GENERATED_AT = '2026-09-07T00:00:00.000Z';

function observations(overrides: Partial<CodingPlanObservations> = {}): CodingPlanObservations {
  return {
    projectName: 'demo-project',
    markers: ['package.json', 'README.md', '.git'],
    hasGitMetadata: true,
    hasTestTooling: true,
    files: [
      { path: 'src/chat/send.ts', matchCount: 3 },
      { path: 'src/chat/receive.ts', matchCount: 1 },
    ],
    filesInspected: 42,
    searchTruncated: false,
    ...overrides,
  };
}

function plan(
  overrides: Partial<CodingPlanObservations> = {},
  objective = 'Add retry to the chat send path',
) {
  return buildCodingPlan({
    objective,
    observations: observations(overrides),
    generatedAt: GENERATED_AT,
  });
}

describe('extractObjectiveKeywords', () => {
  it('drops stop words and very short terms', () => {
    const keywords = extractObjectiveKeywords('Please add the new retry to the chat send path');
    expect(keywords).not.toContain('the');
    expect(keywords).not.toContain('add');
    expect(keywords).not.toContain('to');
    expect(keywords).toContain('retry');
    expect(keywords).toContain('chat');
  });

  it('keeps dotted, snake-cased and kebab-cased identifiers whole', () => {
    expect(extractObjectiveKeywords('rename chat.send to chat_send')).toContain('chat.send');
    expect(extractObjectiveKeywords('fix the kebab-case parser')).toContain('kebab-case');
    expect(extractObjectiveKeywords('rename snake_case fields')).toContain('snake_case');
  });

  it('de-duplicates and orders the most specific term first', () => {
    const keywords = extractObjectiveKeywords('provider provider registry authentication');
    expect(new Set(keywords).size).toBe(keywords.length);
    expect(keywords[0]).toBe('authentication');
  });

  it('never returns more than the keyword bound', () => {
    const objective = Array.from({ length: 40 }, (_, index) => `identifier${String(index)}`).join(
      ' ',
    );
    expect(extractObjectiveKeywords(objective).length).toBeLessThanOrEqual(
      WORKSPACE_OBJECTIVE_MAX_KEYWORDS,
    );
  });

  it('returns nothing for an objective with no distinctive terms', () => {
    expect(extractObjectiveKeywords('do it for me')).toEqual([]);
  });

  it('is deterministic', () => {
    const objective = 'Add streaming to the provider registry and its tests';
    expect(extractObjectiveKeywords(objective)).toEqual(extractObjectiveKeywords(objective));
  });
});

describe('buildCodingPlan — the approval and no-modification guarantees', () => {
  it('always requires approval and always has an awaiting-approval status', () => {
    for (const override of [
      {},
      { files: [] },
      { hasGitMetadata: false, hasTestTooling: false },
      { searchTruncated: true },
      { markers: [] },
    ]) {
      const built = plan(override);
      expect(built.approvalRequired).toBe(true);
      expect(built.status).toBe('awaiting-approval');
    }
  });

  it('never produces a diff', () => {
    // Pinned to `null` rather than omitted: a diff would have to contain
    // proposed file content, which is one write away from being applied.
    expect(plan().diff).toBeNull();
    expect(plan({ files: [] }).diff).toBeNull();
  });

  it('describes expected changes as review, never as an applied modification', () => {
    const built = plan();
    expect(built.expectedChanges.length).toBeGreaterThan(0);
    for (const change of built.expectedChanges) {
      expect(change.changeType).toBe('review');
    }
  });

  it('states in its own summary that nothing was applied', () => {
    expect(plan().changeSummary).toContain('nothing has been applied');
    expect(plan({ files: [] }).changeSummary).toContain('nothing has been applied');
  });

  it('always carries the read-only risk, whatever else it found', () => {
    for (const override of [{}, { files: [] }, { searchTruncated: true }]) {
      expect(plan(override).risks[0]).toContain('read-only inspection');
    }
  });
});

describe('buildCodingPlan — grounding in what was observed', () => {
  it('echoes the request unchanged and adds a generated summary', () => {
    const built = plan({}, 'Add retry to the chat send path');
    expect(built.objective.request).toBe('Add retry to the chat send path');
    expect(built.objective.summary).not.toBe('Add retry to the chat send path');
    expect(built.objective.keywords).toContain('retry');
  });

  it('reports the project context it was given', () => {
    const built = plan();
    expect(built.context).toEqual({
      projectName: 'demo-project',
      markers: ['package.json', 'README.md', '.git'],
      hasGitMetadata: true,
      hasTestTooling: true,
      filesInspected: 42,
      searchTruncated: false,
    });
  });

  it('lists the identified files with the reason they were identified', () => {
    const built = plan();
    expect(built.relevantFiles.map((file) => file.path)).toEqual([
      'src/chat/send.ts',
      'src/chat/receive.ts',
    ]);
    expect(built.relevantFiles[0]?.reason).toContain('3');
  });

  it('warns when nothing matched, rather than inventing a target', () => {
    const built = plan({ files: [] });
    expect(built.relevantFiles).toEqual([]);
    expect(built.expectedChanges).toEqual([]);
    expect(built.risks.join(' ')).toContain('No file in the project matched');
  });

  it('warns when the inspection was truncated', () => {
    expect(plan({ searchTruncated: true }).risks.join(' ')).toContain('result limit');
    expect(plan({ searchTruncated: false }).risks.join(' ')).not.toContain('result limit');
  });

  it('warns when there is no test tooling, and proposes manual verification', () => {
    const without = plan({ hasTestTooling: false });
    expect(without.risks.join(' ')).toContain('No test tooling');
    expect(without.steps.map((step) => step.title)).toContain(
      'Decide how the change would be verified',
    );

    const with_ = plan({ hasTestTooling: true });
    expect(with_.risks.join(' ')).not.toContain('No test tooling');
    expect(with_.steps.map((step) => step.title)).toContain('Extend the existing tests');
  });

  it('warns when there is no version control to recover through', () => {
    expect(plan({ hasGitMetadata: false }).risks.join(' ')).toContain('not be recoverable');
    expect(plan({ hasGitMetadata: true }).risks.join(' ')).not.toContain('not be recoverable');
  });

  it('states its assumptions, including that excluded paths were not considered', () => {
    const built = plan();
    expect(built.assumptions.join(' ')).toContain('credential files were excluded');
    expect(built.assumptions.join(' ')).toContain('approved project');
  });

  it('adds an assumption when no project markers were found', () => {
    expect(plan({ markers: [] }).assumptions.join(' ')).toContain(
      'No recognisable project-level files',
    );
  });
});

describe('buildCodingPlan — bounds', () => {
  it('numbers its steps from one, in order, within the step bound', () => {
    const built = plan();
    expect(built.steps.length).toBeLessThanOrEqual(WORKSPACE_PLAN_MAX_STEPS);
    built.steps.forEach((step, index) => {
      expect(step.order).toBe(index + 1);
    });
  });

  it('caps the files it lists', () => {
    const many = Array.from({ length: WORKSPACE_PLAN_MAX_FILES + 10 }, (_, index) => ({
      path: `src/file${String(index)}.ts`,
      matchCount: 1,
    }));
    const built = plan({ files: many });
    expect(built.relevantFiles.length).toBe(WORKSPACE_PLAN_MAX_FILES);
    expect(built.expectedChanges.length).toBe(WORKSPACE_PLAN_MAX_FILES);
    expect(built.risks.join(' ')).toContain('More files matched than the plan lists');
  });

  it('caps its risks', () => {
    const built = plan({
      files: [],
      hasGitMetadata: false,
      hasTestTooling: false,
      searchTruncated: true,
    });
    expect(built.risks.length).toBeLessThanOrEqual(WORKSPACE_PLAN_MAX_RISKS);
  });

  it('bounds every generated string', () => {
    const built = plan({
      markers: Array.from({ length: 20 }, (_, i) => `marker${String(i)}.json`),
    });
    const strings = [
      built.objective.summary,
      built.changeSummary,
      ...built.steps.flatMap((step) => [step.title, step.detail]),
      ...built.relevantFiles.map((file) => file.reason),
      ...built.expectedChanges.map((change) => change.rationale),
      ...built.risks,
      ...built.assumptions,
    ];
    for (const value of strings) {
      expect(value.length).toBeLessThanOrEqual(WORKSPACE_PLAN_MAX_TEXT_LENGTH);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it('produces a plan its own schema accepts', () => {
    for (const override of [
      {},
      { files: [] },
      { markers: [], hasGitMetadata: false, hasTestTooling: false, searchTruncated: true },
    ]) {
      expect(codingPlanSchema.safeParse(plan(override)).success).toBe(true);
    }
  });

  it('is deterministic: the same inputs produce the same plan', () => {
    expect(plan()).toEqual(plan());
  });

  it('takes its timestamp from the caller rather than a clock', () => {
    expect(plan().generatedAt).toBe(GENERATED_AT);
  });
});
