/**
 * Barrel for the read-only coding workspace layer (Phase 2, Milestone 5).
 *
 * Everything exported here is pure: no I/O, no Node built-in, no Electron, no
 * network. The rules live here so that the main process, which does the
 * actual reading, and the renderer, which displays the result, apply the
 * identical rule rather than two implementations that can drift.
 */

export {
  isWorkspaceErrorCode,
  WORKSPACE_ERROR_CODES,
  WORKSPACE_ERROR_MESSAGES,
  WorkspaceError,
} from './errors';
export type { WorkspaceErrorCode } from './errors';

export {
  isSafeWorkspaceRelativePath,
  joinWorkspacePath,
  normalizeWorkspaceRelativePath,
} from './path-safety';
export type { WorkspacePathRejection, WorkspacePathResult } from './path-safety';

export {
  containsExcludedSegment,
  fileExtension,
  fileStem,
  hasBinaryFileExtension,
  isCredentialFileName,
  isExcludedDirectoryName,
  isExcludedEntryName,
  WORKSPACE_BINARY_FILE_EXTENSIONS,
  WORKSPACE_CREDENTIAL_FILE_EXTENSIONS,
  WORKSPACE_CREDENTIAL_FILE_NAMES,
  WORKSPACE_CREDENTIAL_FILE_STEMS,
  WORKSPACE_EXCLUDED_DIRECTORY_NAMES,
  WORKSPACE_PROJECT_MARKER_FILES,
  WORKSPACE_SOURCE_FILE_EXTENSIONS,
  WORKSPACE_TEST_MARKER_FILES,
} from './exclusions';

export { buildCodingPlan, extractObjectiveKeywords } from './plan';
export type { BuildCodingPlanInput, CodingPlanObservations, ObservedFile } from './plan';

// ---------------------------------------------------------------------------
// Controlled coding actions (Phase 2, Milestone 6)
// ---------------------------------------------------------------------------

export { buildFileDiff, DIFF_LINE_KINDS, DIFF_WARNINGS, isUnchanged } from './diff';
export type { DiffHunk, DiffLine, DiffLineKind, DiffWarning, FileDiff } from './diff';

export {
  CODING_COMMAND_IDS,
  CODING_COMMANDS,
  describeCommandLine,
  describeScriptRisks,
  findCodingCommand,
  isCodingCommandId,
  sanitizeScriptPreview,
  SCRIPT_RISK_FLAGS,
} from './command-registry';
export type { CodingCommandDefinition, CodingCommandId, ScriptRiskFlag } from './command-registry';

export {
  buildGitArgv,
  FORBIDDEN_GIT_SUBCOMMANDS,
  GIT_STATUS_STATES,
  gitBranchArgs,
  gitCommitArgs,
  gitDiffArgs,
  gitHeadArgs,
  gitIsRepositoryArgs,
  gitStageAllArgs,
  gitStatusArgs,
  gitToplevelArgs,
  parseGitStatus,
} from './git';
export type { GitStatusEntry, GitStatusState, GitStatusSummary } from './git';

export { collapseToSingleLine, sanitizeDisplayLine, TRUNCATION_MARKER } from './text-safety';
export type { SanitizedLine } from './text-safety';
