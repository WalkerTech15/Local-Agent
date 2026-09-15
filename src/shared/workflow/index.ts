/**
 * Barrel for the workflow layer (Phase 2, Milestone 9).
 *
 * Everything exported here is pure: no I/O, no Node built-in, no Electron, no
 * network, no clock. The rules live here so that the main process, which runs
 * the steps, and the renderer, which displays what a workflow permits, apply
 * the identical rule rather than two implementations that can drift.
 */

export {
  WORKFLOW_ERROR_CODES,
  WORKFLOW_ERROR_MESSAGES,
  WorkflowError,
  isWorkflowErrorCode,
} from './errors';
export type { WorkflowErrorCode } from './errors';

export {
  afterStepOutcome,
  classifyWorkflowRun,
  decideNextWorkflowStep,
  describeWorkflowTools,
  evaluateWorkflowVerification,
  isStepConditionMet,
  planWorkflowRollback,
  toRollbackOutcome,
  workflowCheckpointCount,
  workflowStartsProcess,
  workflowStepsWithinProfile,
} from './execution';
export type {
  WorkflowRollbackPlan,
  WorkflowRunProgress,
  WorkflowStepDecision,
  WorkflowStepFollowUp,
} from './execution';
