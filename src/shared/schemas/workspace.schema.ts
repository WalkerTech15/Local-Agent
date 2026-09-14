/**
 * Schemas for the read-only coding workspace (Phase 2, Milestone 5).
 *
 * Everything the main process learns about a project comes from someone
 * else's directory tree — file names, directory names, file contents — which
 * `AGENTS.md` section 5 classes as untrusted input in exactly the same
 * category as a model's output. These schemas are where that input stops
 * being arbitrary bytes and becomes a value the rest of the application may
 * handle, and they are applied in the main process *before* anything crosses
 * to the renderer, not after.
 *
 * Three properties hold across every shape below:
 *
 *  - **Nothing here can carry a path outside the project.** Every path field
 *    is project-relative and validated by
 *    {@link isSafeWorkspaceRelativePath}, so an absolute path, a `..`
 *    segment, a drive letter or an NTFS stream name cannot be represented at
 *    all — not merely rejected further down.
 *  - **Nothing here is unbounded.** Entry counts, match counts, file size,
 *    text length and every generated plan string are capped by a named
 *    constant, so a project with a million files or a single enormous file
 *    produces a bounded response or an error, never an unbounded one.
 *  - **Nothing here is a modification.** There is no write, no patch and no
 *    content field a caller could fill in. {@link codingPlanSchema} pins
 *    `diff` to `null` and `status` to `'awaiting-approval'` so "this
 *    milestone produces no change" is a schema-level fact rather than an
 *    omission a later edit could quietly fill in.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import { z } from 'zod';

import {
  BIDI_CONTROL_PATTERN,
  CHAT_CONTROL_CHARACTER_PATTERN,
  CONTROL_CHARACTER_PATTERN,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_FILE_CONTENT_LENGTH,
  WORKSPACE_MAX_PATH_SEGMENT_LENGTH,
  WORKSPACE_MAX_PROJECT_PATH_LENGTH,
  WORKSPACE_MAX_RELATIVE_PATH_LENGTH,
  WORKSPACE_MAX_SEARCH_FILES,
  WORKSPACE_MAX_SEARCH_RESULTS,
  WORKSPACE_MAX_TREE_DEPTH,
  WORKSPACE_MAX_TREE_ENTRIES,
  WORKSPACE_OBJECTIVE_MAX_KEYWORDS,
  WORKSPACE_OBJECTIVE_MAX_LENGTH,
  WORKSPACE_OBJECTIVE_MIN_LENGTH,
  WORKSPACE_PLAN_MAX_ASSUMPTIONS,
  WORKSPACE_PLAN_MAX_FILES,
  WORKSPACE_PLAN_MAX_RISKS,
  WORKSPACE_PLAN_MAX_STEPS,
  WORKSPACE_PLAN_MAX_TEXT_LENGTH,
  WORKSPACE_SEARCH_EXCERPT_MAX_LENGTH,
  WORKSPACE_SEARCH_QUERY_MAX_LENGTH,
  WORKSPACE_SEARCH_QUERY_MIN_LENGTH,
} from '../constants';
import { WORKSPACE_PROJECT_MARKER_FILES } from '../workspace/exclusions';
import { isSafeWorkspaceRelativePath } from '../workspace/path-safety';

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * A path relative to the approved project root, in this codebase's one
 * canonical form. The empty string is the project root itself.
 *
 * The `refine` is the same pure function `src/main` calls before touching the
 * disk, not a second implementation of the rule — a duplicated path rule that
 * drifts is worse than no second rule at all.
 */
export const workspaceRelativePathSchema = z
  .string()
  .max(WORKSPACE_MAX_RELATIVE_PATH_LENGTH)
  .refine(isSafeWorkspaceRelativePath, {
    message: 'must be a safe path relative to the project root',
  });

/** As above, but naming an entry rather than the root, so never empty. */
export const workspaceEntryPathSchema = workspaceRelativePathSchema.refine(
  (value) => value.length > 0,
  { message: 'must name an entry, not the project root' },
);

/**
 * One file or directory name.
 *
 * Rejects control characters and bidirectional overrides for the same reason
 * `settings.schema.ts` rejects them in a display name: this string is shown to
 * a person who then decides whether to open it, and a bidi override reorders
 * how it renders without changing what it is.
 */
export const workspaceNameSchema = z
  .string()
  .min(1)
  .max(WORKSPACE_MAX_PATH_SEGMENT_LENGTH)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'must not contain control characters',
  })
  .refine((value) => !BIDI_CONTROL_PATTERN.test(value), {
    message: 'must not contain bidirectional control characters',
  });

/**
 * The project's absolute path, echoed back for display only.
 *
 * Never accepted *from* the renderer — no request schema in `ipc.schema.ts`
 * carries a project path. It is produced by the main process from what the
 * user chose in a native picker, shown so the interface can state plainly
 * which directory is open, and used for nothing else.
 */
export const workspaceProjectPathSchema = z
  .string()
  .min(1)
  .max(WORKSPACE_MAX_PROJECT_PATH_LENGTH)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'must not contain control characters',
  })
  .refine((value) => !BIDI_CONTROL_PATTERN.test(value), {
    message: 'must not contain bidirectional control characters',
  });

/**
 * A file's decoded text.
 *
 * Bounded, and rejects NUL — a NUL means the decoder was handed something
 * that is not text, which the binary check should already have caught, so
 * this is the backstop for that check rather than a duplicate of it.
 *
 * Deliberately does **not** reject bidirectional overrides. Source files in
 * Arabic, Hebrew and Persian legitimately contain them, and refusing to open
 * such a file would be worse than showing it; the presence of one is reported
 * as a {@link workspaceFileWarningSchema} instead, so the interface can warn
 * without the viewer silently altering what is on disk.
 */
export const workspaceFileContentSchema = z
  .string()
  .max(WORKSPACE_MAX_FILE_CONTENT_LENGTH)
  .refine((value) => !value.includes('\u0000'), {
    message: 'must not contain NUL',
  });

/**
 * A single-line excerpt around one search match.
 *
 * Unlike file content, an excerpt is already a lossy summary, so the sender
 * sanitizes it (control characters and bidi overrides removed) rather than
 * warning about it — a one-line fragment in a results list has no legitimate
 * need for either, and a results list is exactly where a spoofed line would
 * be most convincing.
 */
export const workspaceSearchExcerptSchema = z
  .string()
  .max(WORKSPACE_SEARCH_EXCERPT_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'must not contain control characters',
  })
  .refine((value) => !BIDI_CONTROL_PATTERN.test(value), {
    message: 'must not contain bidirectional control characters',
  });

/** A literal substring to search for. Never a regular expression. */
export const workspaceSearchQuerySchema = z
  .string()
  .min(WORKSPACE_SEARCH_QUERY_MIN_LENGTH)
  .max(WORKSPACE_SEARCH_QUERY_MAX_LENGTH)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'must not contain control characters',
  })
  .refine((value) => !BIDI_CONTROL_PATTERN.test(value), {
    message: 'must not contain bidirectional control characters',
  });

/** Generated plan prose. Every string a plan contains is bounded by this. */
export const workspacePlanTextSchema = z
  .string()
  .min(1)
  .max(WORKSPACE_PLAN_MAX_TEXT_LENGTH)
  .refine((value) => !CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'must not contain control characters',
  })
  .refine((value) => !BIDI_CONTROL_PATTERN.test(value), {
    message: 'must not contain bidirectional control characters',
  });

// ---------------------------------------------------------------------------
// Project summary
// ---------------------------------------------------------------------------

export const workspaceProjectSummarySchema = z.strictObject({
  name: workspaceNameSchema,
  path: workspaceProjectPathSchema,
  /** UTC ISO-8601, from the main process's clock at selection time. */
  selectedAt: z.iso.datetime(),
  /**
   * Which of {@link WORKSPACE_PROJECT_MARKER_FILES} exist at the root.
   * Presence only — none of them is opened to produce this list.
   */
  markers: z.array(workspaceNameSchema).max(WORKSPACE_PROJECT_MARKER_FILES.length),
  /** True when a `.git` entry exists. Its contents are never listed or read. */
  hasGitMetadata: z.boolean(),
});

export type WorkspaceProjectSummary = z.infer<typeof workspaceProjectSummarySchema>;

/** `null` when no project has been approved in this session. */
export const workspaceProjectStateSchema = z.strictObject({
  project: workspaceProjectSummarySchema.nullable(),
});

export type WorkspaceProjectState = z.infer<typeof workspaceProjectStateSchema>;

// ---------------------------------------------------------------------------
// Tree listing
// ---------------------------------------------------------------------------

export const WORKSPACE_ENTRY_KINDS = ['file', 'directory'] as const;

export const workspaceEntrySchema = z.strictObject({
  path: workspaceEntryPathSchema,
  name: workspaceNameSchema,
  kind: z.enum(WORKSPACE_ENTRY_KINDS),
  /** Depth below the listing's own root; a direct child is 0. */
  depth: z.int().min(0).max(WORKSPACE_MAX_TREE_DEPTH),
  /** Bytes. Files only — a directory's size is meaningless here. */
  size: z.int().min(0).optional(),
  /**
   * True for an entry the workspace will not descend into, read or search:
   * a dependency or build directory, or a credential-bearing file. It is
   * still listed, so a tree never quietly misrepresents what is there.
   */
  excluded: z.boolean(),
  /**
   * True only for a file the viewer would actually open — not excluded, not
   * binary by extension, not over the size limit. Advisory: the read path
   * re-checks all three itself and never trusts this flag.
   */
  readable: z.boolean(),
});

export type WorkspaceEntry = z.infer<typeof workspaceEntrySchema>;

export const workspaceTreeSchema = z.strictObject({
  /** The directory this listing is rooted at; `''` is the project root. */
  root: workspaceRelativePathSchema,
  entries: z.array(workspaceEntrySchema).max(WORKSPACE_MAX_TREE_ENTRIES),
  /** True when a bound stopped the walk before it ran out of entries. */
  truncated: z.boolean(),
});

export type WorkspaceTree = z.infer<typeof workspaceTreeSchema>;

// ---------------------------------------------------------------------------
// File viewer
// ---------------------------------------------------------------------------

/**
 * Conditions worth telling the reader about, which are not reasons to refuse
 * the file. Currently one: text that renders differently from how it is
 * stored.
 */
export const WORKSPACE_FILE_WARNINGS = ['bidirectional-control-characters'] as const;

export const workspaceFileWarningSchema = z.enum(WORKSPACE_FILE_WARNINGS);

export const workspaceFileMetadataSchema = z.strictObject({
  path: workspaceEntryPathSchema,
  name: workspaceNameSchema,
  /** Bytes on disk, always at or below the viewer's hard limit. */
  size: z.int().min(0).max(WORKSPACE_MAX_FILE_BYTES),
  lineCount: z.int().min(0),
  /** The only encoding this viewer decodes. Anything else is refused as binary. */
  encoding: z.literal('utf-8'),
  warnings: z.array(workspaceFileWarningSchema).max(WORKSPACE_FILE_WARNINGS.length),
});

export type WorkspaceFileMetadata = z.infer<typeof workspaceFileMetadataSchema>;

export const workspaceFileSchema = z.strictObject({
  metadata: workspaceFileMetadataSchema,
  content: workspaceFileContentSchema,
});

export type WorkspaceFile = z.infer<typeof workspaceFileSchema>;

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const workspaceSearchMatchSchema = z.strictObject({
  path: workspaceEntryPathSchema,
  /** 1-based, so it matches what an editor shows. */
  line: z.int().min(1),
  column: z.int().min(1),
  excerpt: workspaceSearchExcerptSchema,
});

export type WorkspaceSearchMatch = z.infer<typeof workspaceSearchMatchSchema>;

export const workspaceSearchResultSchema = z.strictObject({
  query: workspaceSearchQuerySchema,
  matches: z.array(workspaceSearchMatchSchema).max(WORKSPACE_MAX_SEARCH_RESULTS),
  filesScanned: z.int().min(0).max(WORKSPACE_MAX_SEARCH_FILES),
  /** True when the match or file budget stopped the search early. */
  truncated: z.boolean(),
});

export type WorkspaceSearchResult = z.infer<typeof workspaceSearchResultSchema>;

// ---------------------------------------------------------------------------
// Coding plan
//
// A plan is inert. It describes what a change would involve; it contains no
// file content, no patch, and nothing any code in this milestone could apply.
// ---------------------------------------------------------------------------

export const workspaceObjectiveSchema = z
  .string()
  .min(WORKSPACE_OBJECTIVE_MIN_LENGTH)
  .max(WORKSPACE_OBJECTIVE_MAX_LENGTH)
  // Multi-line is allowed — a coding request is legitimately a paragraph —
  // so this uses the chat content pattern (tab, newline and carriage return
  // permitted) rather than the single-line display-string one.
  .refine((value) => !CHAT_CONTROL_CHARACTER_PATTERN.test(value), {
    message: 'must not contain unsafe control characters',
  })
  .refine((value) => !BIDI_CONTROL_PATTERN.test(value), {
    message: 'must not contain bidirectional control characters',
  });

export const codingObjectiveSchema = z.strictObject({
  /** The user's request, as typed, bounded and validated. */
  request: workspaceObjectiveSchema,
  /** A one-line restatement, generated, never echoed verbatim. */
  summary: workspacePlanTextSchema,
  keywords: z.array(z.string().min(1).max(64)).max(WORKSPACE_OBJECTIVE_MAX_KEYWORDS),
});

export type CodingObjective = z.infer<typeof codingObjectiveSchema>;

export const codingPlanContextSchema = z.strictObject({
  projectName: workspaceNameSchema,
  markers: z.array(workspaceNameSchema).max(WORKSPACE_PROJECT_MARKER_FILES.length),
  hasGitMetadata: z.boolean(),
  hasTestTooling: z.boolean(),
  /** How many candidate files the inspection actually looked at. */
  filesInspected: z.int().min(0),
  /** True when the underlying search hit a bound, so the picture is partial. */
  searchTruncated: z.boolean(),
});

export type CodingPlanContext = z.infer<typeof codingPlanContextSchema>;

export const codingPlanStepSchema = z.strictObject({
  order: z.int().min(1).max(WORKSPACE_PLAN_MAX_STEPS),
  title: workspacePlanTextSchema,
  detail: workspacePlanTextSchema,
});

export type CodingPlanStep = z.infer<typeof codingPlanStepSchema>;

export const codingPlanFileSchema = z.strictObject({
  path: workspaceEntryPathSchema,
  reason: workspacePlanTextSchema,
});

export type CodingPlanFile = z.infer<typeof codingPlanFileSchema>;

/**
 * `'modify'` and `'review'` are the only change types, and both are
 * descriptions rather than instructions: nothing in this milestone can act on
 * either. There is deliberately no `'create'` or `'delete'` — proposing to
 * create or remove a file would require naming a path that does not exist
 * yet, which the containment rules could not check against anything real.
 */
export const WORKSPACE_CHANGE_TYPES = ['modify', 'review'] as const;

export const codingPlanChangeSchema = z.strictObject({
  path: workspaceEntryPathSchema,
  changeType: z.enum(WORKSPACE_CHANGE_TYPES),
  rationale: workspacePlanTextSchema,
});

export type CodingPlanChange = z.infer<typeof codingPlanChangeSchema>;

export const codingPlanSchema = z.strictObject({
  objective: codingObjectiveSchema,
  context: codingPlanContextSchema,
  steps: z.array(codingPlanStepSchema).max(WORKSPACE_PLAN_MAX_STEPS),
  relevantFiles: z.array(codingPlanFileSchema).max(WORKSPACE_PLAN_MAX_FILES),
  risks: z.array(workspacePlanTextSchema).max(WORKSPACE_PLAN_MAX_RISKS),
  assumptions: z.array(workspacePlanTextSchema).max(WORKSPACE_PLAN_MAX_ASSUMPTIONS),
  expectedChanges: z.array(codingPlanChangeSchema).max(WORKSPACE_PLAN_MAX_FILES),
  changeSummary: workspacePlanTextSchema,
  /**
   * Pinned to `null`, not omitted.
   *
   * A diff would have to contain proposed file *content*, which is one
   * `writeFile` away from being applied and is precisely what this milestone
   * excludes. Declaring the field and fixing it at `null` means a later edit
   * that starts producing one has to change this schema — and therefore has
   * to be reviewed — rather than filling in a field nobody had constrained.
   */
  diff: z.null(),
  /**
   * Pinned to `true`. No plan is self-approving, and there is no shape in
   * which a plan can arrive already approved.
   */
  approvalRequired: z.literal(true),
  /**
   * Pinned to `'awaiting-approval'`. The only status a generated plan can
   * have: approval is recorded by the interface, and even an approved plan
   * has nothing in this milestone that could act on it.
   */
  status: z.literal('awaiting-approval'),
  generatedAt: z.iso.datetime(),
});

export type CodingPlan = z.infer<typeof codingPlanSchema>;
