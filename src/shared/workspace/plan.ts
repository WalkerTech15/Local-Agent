/**
 * The coding-plan builder (Phase 2, Milestone 5).
 *
 * Pure, and deliberately so. Given an objective, what was actually observed
 * about a project, and a timestamp, this produces the same plan every time —
 * no I/O, no clock, no randomness, and **no model call**.
 *
 * ## Why the plan is derived rather than generated
 *
 * This milestone builds the planning *layer*: the shape of an objective, the
 * project context a plan is grounded in, the approval gate a future
 * modification would have to pass, and the guarantee that none of it can
 * touch a file. Asking a model to write the plan would add none of that, and
 * would cost two things this milestone is specifically meant to protect:
 *
 *  - a model-written plan is untrusted text that would then have to be parsed
 *    back into the structure below, which is exactly the "treat model output
 *    as data, never as instruction" boundary the brief names — and a parser
 *    for it is new attack surface for no gain while nothing can act on a plan
 *    anyway;
 *  - it would make the workspace unusable whenever `modelProvider.provider`
 *    is `none`, which is the default, so the approval gate could not be
 *    demonstrated or reviewed without first configuring a provider.
 *
 * Every risk and assumption below is therefore *observed*, not invented: each
 * one is emitted because a specific fact about the project was, or was not,
 * found. A later milestone that wants a model to elaborate on a plan can pass
 * this structure to it and validate what comes back against
 * `codingPlanSchema` — the seam is the schema, and it already exists.
 *
 * Pure: no I/O, no Node built-in, no Electron. Consumed by
 * `src/main/workspace-planner.ts`, which supplies the observations.
 */

import {
  WORKSPACE_OBJECTIVE_MAX_KEYWORDS,
  WORKSPACE_PLAN_MAX_ASSUMPTIONS,
  WORKSPACE_PLAN_MAX_FILES,
  WORKSPACE_PLAN_MAX_RISKS,
  WORKSPACE_PLAN_MAX_STEPS,
  WORKSPACE_PLAN_MAX_TEXT_LENGTH,
} from '../constants';
import type {
  CodingObjective,
  CodingPlan,
  CodingPlanChange,
  CodingPlanFile,
  CodingPlanStep,
} from '../schemas/workspace.schema';

/**
 * Words carrying no signal about which files a request concerns.
 *
 * Short and English-only on purpose: this list decides which terms are worth
 * searching the project for, and a keyword that survives it and matches
 * nothing simply produces no results. Over-trimming would be the harmful
 * direction, so the list stays conservative.
 */
const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'when',
  'then',
  'than',
  'has',
  'have',
  'been',
  'was',
  'were',
  'are',
  'you',
  'your',
  'our',
  'its',
  'but',
  'not',
  'all',
  'any',
  'can',
  'should',
  'would',
  'could',
  'make',
  'made',
  'add',
  'adds',
  'added',
  'use',
  'used',
  'using',
  'new',
  'also',
  'need',
  'needs',
  'please',
  'want',
  'wants',
  'let',
  'lets',
  'get',
  'gets',
  'set',
  'sets',
  'how',
  'why',
  'what',
  'where',
  'who',
]);

const MIN_KEYWORD_LENGTH = 3;

/** Trims a generated string to the plan's own bound. */
function bounded(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= WORKSPACE_PLAN_MAX_TEXT_LENGTH) return collapsed;
  return `${collapsed.slice(0, WORKSPACE_PLAN_MAX_TEXT_LENGTH - 1).trimEnd()}…`;
}

/**
 * Extracts the terms worth searching a project for.
 *
 * Lowercases, splits on anything that is not a letter, a digit, `_`, `-` or
 * `.` (so `chat.send`, `snake_case` and `kebab-case` survive as single
 * terms), drops stop words and very short terms, de-duplicates, and keeps at
 * most {@link WORKSPACE_OBJECTIVE_MAX_KEYWORDS}, longest first — a longer
 * term is a more specific one.
 */
export function extractObjectiveKeywords(objective: string): string[] {
  const candidates = objective
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .map((word) => word.replace(/^[.-]+|[.-]+$/g, ''))
    .filter((word) => word.length >= MIN_KEYWORD_LENGTH && !STOP_WORDS.has(word));

  const unique = [...new Set(candidates)];
  unique.sort((a, b) => (b.length === a.length ? a.localeCompare(b) : b.length - a.length));
  return unique.slice(0, WORKSPACE_OBJECTIVE_MAX_KEYWORDS);
}

/** One file the inspection found, and how strongly it matched. */
export interface ObservedFile {
  readonly path: string;
  /** How many of the objective's terms occur in the file or its path. */
  readonly matchCount: number;
}

/** What `src/main/workspace-planner.ts` actually observed about the project. */
export interface CodingPlanObservations {
  readonly projectName: string;
  readonly markers: readonly string[];
  readonly hasGitMetadata: boolean;
  readonly hasTestTooling: boolean;
  /** Files the inspection identified, most relevant first. */
  readonly files: readonly ObservedFile[];
  /** How many files the search opened, whether or not they matched. */
  readonly filesInspected: number;
  /** True when a bound stopped the scan before it finished. */
  readonly searchTruncated: boolean;
}

export interface BuildCodingPlanInput {
  readonly objective: string;
  readonly observations: CodingPlanObservations;
  /** UTC ISO-8601, supplied by the caller — this module reads no clock. */
  readonly generatedAt: string;
}

function buildObjective(request: string): CodingObjective {
  const keywords = extractObjectiveKeywords(request);
  const summary =
    keywords.length === 0
      ? 'A coding request with no distinctive terms to search the project for.'
      : `A coding request concerning ${keywords.slice(0, 4).join(', ')}.`;
  return { request, summary: bounded(summary), keywords };
}

function buildSteps(
  observations: CodingPlanObservations,
  keywords: readonly string[],
): CodingPlanStep[] {
  const drafts: { title: string; detail: string }[] = [];

  drafts.push({
    title: 'Confirm the objective against the project',
    detail:
      observations.files.length > 0
        ? `Read the ${String(observations.files.length)} identified file(s) and confirm the request describes a change that belongs in them.`
        : 'No file matched the request directly, so confirm which part of the project the request concerns before going further.',
  });

  if (observations.markers.length > 0) {
    drafts.push({
      title: 'Read the project conventions',
      detail: `Review the project-level files found at the root (${observations.markers.slice(0, 6).join(', ')}) for conventions the change must follow.`,
    });
  }

  if (keywords.length > 0) {
    drafts.push({
      title: 'Trace each affected area',
      detail: `Follow ${keywords.slice(0, 4).join(', ')} through the identified files to find every call site the change would touch.`,
    });
  }

  drafts.push({
    title: 'Decide the smallest sufficient change',
    detail:
      'Prefer the narrowest edit that satisfies the request, and note anything the request implies but does not state.',
  });

  if (observations.hasTestTooling) {
    drafts.push({
      title: 'Extend the existing tests',
      detail:
        'Test tooling was detected at the project root; plan a test for the new behaviour alongside the change itself.',
    });
  } else {
    drafts.push({
      title: 'Decide how the change would be verified',
      detail:
        'No test tooling was detected at the project root, so verification would have to be manual or introduced as part of the work.',
    });
  }

  if (observations.hasGitMetadata) {
    drafts.push({
      title: 'Review the change before it is kept',
      detail:
        'The project is under version control, so the working tree can be inspected and the change reverted if it is wrong.',
    });
  }

  drafts.push({
    title: 'Request approval before anything is written',
    detail:
      'This plan is inert. No file was modified by producing it, and this milestone has no mechanism to apply it even once approved.',
  });

  return drafts.slice(0, WORKSPACE_PLAN_MAX_STEPS).map((draft, index) => ({
    order: index + 1,
    title: bounded(draft.title),
    detail: bounded(draft.detail),
  }));
}

function buildRelevantFiles(observations: CodingPlanObservations): CodingPlanFile[] {
  return observations.files.slice(0, WORKSPACE_PLAN_MAX_FILES).map((file) => ({
    path: file.path,
    reason: bounded(
      file.matchCount > 0
        ? `Matched ${String(file.matchCount)} of the objective's terms.`
        : 'Identified from the project structure rather than a term match.',
    ),
  }));
}

function buildExpectedChanges(files: readonly CodingPlanFile[]): CodingPlanChange[] {
  return files.map((file) => ({
    path: file.path,
    // Always `review`, never `modify`, while nothing has actually been
    // drafted: calling a file "modified" would overstate what a read-only
    // inspection established about it.
    changeType: 'review' as const,
    rationale: bounded(`${file.reason} Would need to be read in full before any edit.`),
  }));
}

function buildRisks(observations: CodingPlanObservations): string[] {
  const risks: string[] = [
    'This plan was produced by a read-only inspection. Nothing has been written, and this milestone cannot write.',
  ];

  if (observations.files.length === 0) {
    risks.push(
      'No file in the project matched the objective, so the plan rests on project structure alone and may be aimed at the wrong area.',
    );
  }
  if (observations.searchTruncated) {
    risks.push(
      'The inspection reached its result limit, so relevant files beyond the ones listed may exist and were not considered.',
    );
  }
  if (!observations.hasTestTooling) {
    risks.push(
      'No test tooling was detected at the project root, so a change made from this plan could not be verified automatically.',
    );
  }
  if (!observations.hasGitMetadata) {
    risks.push(
      'No version-control metadata was detected, so a change made from this plan would not be recoverable by reverting.',
    );
  }
  if (observations.files.length > WORKSPACE_PLAN_MAX_FILES) {
    risks.push(
      'More files matched than the plan lists; the remainder were dropped to keep the plan bounded.',
    );
  }

  return risks.slice(0, WORKSPACE_PLAN_MAX_RISKS).map(bounded);
}

function buildAssumptions(observations: CodingPlanObservations): string[] {
  const assumptions: string[] = [
    'The approved project is the one the request is about.',
    'Dependencies, build output and credential files were excluded from inspection and are not relevant to this request.',
    'The request describes the intended change completely; nothing was inferred beyond what it says.',
  ];

  if (observations.markers.length === 0) {
    assumptions.push(
      'No recognisable project-level files were found at the root, so no language or framework conventions were assumed.',
    );
  }

  return assumptions.slice(0, WORKSPACE_PLAN_MAX_ASSUMPTIONS).map(bounded);
}

/**
 * Builds one plan.
 *
 * The result is always `status: 'awaiting-approval'`, `approvalRequired:
 * true` and `diff: null` — this function has no branch that produces anything
 * else, and `codingPlanSchema` refuses anything else even if one were added.
 */
export function buildCodingPlan(input: BuildCodingPlanInput): CodingPlan {
  const { objective: request, observations, generatedAt } = input;
  const objective = buildObjective(request);
  const relevantFiles = buildRelevantFiles(observations);
  const expectedChanges = buildExpectedChanges(relevantFiles);

  const changeSummary =
    relevantFiles.length === 0
      ? 'No file was identified for change. Nothing has been generated, and nothing has been applied.'
      : `${String(relevantFiles.length)} file(s) identified for review before any edit. No change has been generated, and nothing has been applied.`;

  return {
    objective,
    context: {
      projectName: observations.projectName,
      markers: [...observations.markers],
      hasGitMetadata: observations.hasGitMetadata,
      hasTestTooling: observations.hasTestTooling,
      filesInspected: observations.filesInspected,
      searchTruncated: observations.searchTruncated,
    },
    steps: buildSteps(observations, objective.keywords),
    relevantFiles,
    risks: buildRisks(observations),
    assumptions: buildAssumptions(observations),
    expectedChanges,
    changeSummary: bounded(changeSummary),
    diff: null,
    approvalRequired: true,
    status: 'awaiting-approval',
    generatedAt,
  };
}
