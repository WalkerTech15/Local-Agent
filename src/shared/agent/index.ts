/**
 * Barrel for the agent profile layer (Phase 2, Milestone 7).
 *
 * Everything exported here is pure: no I/O, no Node built-in, no Electron, no
 * network. The rules live here so that the main process, which runs the
 * steps, and the renderer, which displays what a profile permits, apply the
 * identical rule rather than two implementations that can drift.
 */

export { AGENT_ERROR_CODES, AGENT_ERROR_MESSAGES, AgentError, isAgentErrorCode } from './errors';
export type { AgentErrorCode } from './errors';

export {
  AGENT_ALLOWED_ACTION_TYPES,
  AGENT_TOOL_IDS,
  AGENT_TOOL_KINDS,
  AGENT_TOOLS,
  AGENT_VERIFICATION_REQUIREMENTS,
  findAgentTool,
  isAgentToolId,
  isAgentVerificationRequirement,
  requirementToolId,
} from './tools';
export type {
  AgentToolDefinition,
  AgentToolId,
  AgentToolKind,
  AgentVerificationRequirement,
} from './tools';

export {
  agentProfileDecisionFor,
  BUILT_IN_AGENT_PROFILE_IDS,
  createBuiltInAgentProfiles,
  createDefaultAgentProfileStore,
  DEFAULT_AGENT_PROFILE_ID,
  findAgentProfile,
  isAgentToolAllowed,
  isBuiltInAgentProfileId,
  isWorkspacePathAllowed,
  mergeAgentProfiles,
  resolveActiveProfile,
  resolveAgentProvider,
  resolveAgentRegistry,
} from './registry';
export type { AgentRegistry } from './registry';

export {
  buildAgentPlan,
  classifyAgentRun,
  decideNextStep,
  describeProfileTools,
  evaluateAgentVerification,
  profileCanRunCommands,
  profileVerificationRequirements,
} from './orchestration';
export type {
  AgentPlan,
  AgentPlanStep,
  AgentRunProgress,
  AgentStepDecision,
} from './orchestration';
