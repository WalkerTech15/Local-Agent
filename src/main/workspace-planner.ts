/**
 * The coding-plan inspection layer (Phase 2, Milestone 5).
 *
 * Gathers what can be observed about an approved project — which files
 * mention the objective's terms, which project markers exist, whether there
 * is test tooling, whether the search saw everything — and hands those
 * observations to the pure builder in `src/shared/workspace/plan.ts`.
 *
 * The split matches the one this codebase already uses for every decision
 * that matters: a pure core (`decidePermission`, `buildCodingPlan`) behind a
 * thin layer that does the I/O. Everything about *what a plan says* is
 * deterministic and testable without a filesystem; everything about *what is
 * true of this project* is measured here, once, under the same bounds every
 * other workspace read obeys.
 *
 * This module performs no write, calls no model, and produces nothing that
 * can be applied. A plan is a document: `codingPlanSchema` pins its `diff` to
 * `null` and its `status` to `'awaiting-approval'`, and there is no function
 * anywhere in this milestone that consumes one.
 */

import { listProjectTree, searchProject } from './workspace-inspector';
import type { ApprovedProject } from './workspace-session';
import { WORKSPACE_PLAN_MAX_FILES, WORKSPACE_PLAN_MAX_SEARCH_TERMS } from '../shared/constants';
import type { CodingPlan } from '../shared/schemas/workspace.schema';
import { buildCodingPlan, extractObjectiveKeywords } from '../shared/workspace/plan';
import type { CodingPlanObservations, ObservedFile } from '../shared/workspace/plan';

/**
 * Runs the bounded searches that identify candidate files.
 *
 * At most {@link WORKSPACE_PLAN_MAX_SEARCH_TERMS} terms are searched, not
 * every keyword: each search opens up to `WORKSPACE_MAX_SEARCH_FILES` files,
 * so an unbounded number of terms would multiply into an unbounded amount of
 * reading. The terms are already ordered longest-first by
 * `extractObjectiveKeywords`, and a longer term is the more specific one, so
 * truncating the list keeps the searches that discriminate best.
 *
 * A file's score is the number of *distinct terms* that matched it, not the
 * number of matches: a file mentioning three of the objective's terms once
 * each is a better candidate than one mentioning a single term thirty times.
 */
async function searchForKeywords(
  project: ApprovedProject,
  keywords: readonly string[],
): Promise<{
  readonly scores: ReadonlyMap<string, number>;
  readonly filesInspected: number;
  readonly truncated: boolean;
}> {
  const scores = new Map<string, number>();
  let filesInspected = 0;
  let truncated = false;

  for (const keyword of keywords.slice(0, WORKSPACE_PLAN_MAX_SEARCH_TERMS)) {
    const result = await searchProject(project, keyword, '');
    filesInspected += result.filesScanned;
    if (result.truncated) truncated = true;

    const seen = new Set<string>();
    for (const match of result.matches) {
      if (seen.has(match.path)) continue;
      seen.add(match.path);
      scores.set(match.path, (scores.get(match.path) ?? 0) + 1);
    }
  }

  return { scores, filesInspected, truncated };
}

/**
 * Adds files whose *path* mentions a keyword, even when their contents do
 * not.
 *
 * A request about "onboarding" should surface `src/renderer/Onboarding.tsx`
 * whether or not the word appears inside it. These score below a content
 * match, which is what the fractional weight expresses — it keeps a
 * path-only match from outranking a file that genuinely discusses the term.
 */
function scorePathMatches(
  paths: readonly string[],
  keywords: readonly string[],
  scores: Map<string, number>,
): void {
  if (keywords.length === 0) return;
  for (const path of paths) {
    const lowered = path.toLowerCase();
    const hits = keywords.filter((keyword) => lowered.includes(keyword)).length;
    if (hits > 0) scores.set(path, (scores.get(path) ?? 0) + hits * 0.5);
  }
}

/**
 * Scores files whose path mentions a keyword, from one bounded listing of the
 * project root, and reports whether that listing was complete.
 *
 * Returns `true` — "the picture is partial" — for both a truncated listing
 * and a root that could not be listed at all. A project whose root is
 * unreadable still produces a plan, one that says so through the builder's
 * own observed risks; failing the whole request here would be less useful and
 * no safer, since nothing about a plan can act on anything.
 *
 * Written to return the flag rather than assign an outer `let`: a variable
 * that is only ever written inside a `try` is exactly the shape a lint
 * auto-fix will "simplify", and simplifying control flow it has misread is
 * how a behaviour change slips in unreviewed.
 */
async function scoreProjectPaths(
  project: ApprovedProject,
  keywords: readonly string[],
  scores: Map<string, number>,
): Promise<boolean> {
  try {
    const tree = await listProjectTree(project, '');
    const readablePaths = tree.entries
      .filter((entry) => entry.kind === 'file' && entry.readable)
      .map((entry) => entry.path);
    scorePathMatches(readablePaths, keywords, scores);
    return tree.truncated;
  } catch {
    return true;
  }
}

/** Everything the plan builder needs, measured from the real project. */
export async function gatherPlanObservations(
  project: ApprovedProject,
  objective: string,
): Promise<CodingPlanObservations> {
  const keywords = extractObjectiveKeywords(objective);
  const { scores, filesInspected, truncated } = await searchForKeywords(project, keywords);

  const mutableScores = new Map(scores);
  const treeTruncated = await scoreProjectPaths(project, keywords, mutableScores);

  const files: ObservedFile[] = [...mutableScores.entries()]
    .map(([path, score]) => ({ path, matchCount: Math.round(score) }))
    .sort((a, b) =>
      b.matchCount === a.matchCount ? a.path.localeCompare(b.path) : b.matchCount - a.matchCount,
    )
    .slice(0, WORKSPACE_PLAN_MAX_FILES);

  return {
    projectName: project.name,
    markers: project.markers,
    hasGitMetadata: project.hasGitMetadata,
    hasTestTooling: project.hasTestTooling,
    files,
    filesInspected,
    searchTruncated: truncated || treeTruncated,
  };
}

/**
 * Produces one inert coding plan for an approved project.
 *
 * `now` is supplied by the caller, following the convention every other
 * module here follows: nothing in the workspace layer reads the clock itself,
 * so a test's plan is byte-for-byte reproducible.
 */
export async function createCodingPlan(
  project: ApprovedProject,
  objective: string,
  now: string,
): Promise<CodingPlan> {
  const observations = await gatherPlanObservations(project, objective);
  return buildCodingPlan({ objective, observations, generatedAt: now });
}
