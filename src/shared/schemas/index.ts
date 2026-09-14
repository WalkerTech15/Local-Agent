/**
 * Barrel for the shared schema layer.
 *
 * Everything exported here is pure data or pure logic and is safe to import
 * from any process, including the sandboxed renderer.
 */

export {
  assistantSettingsSchema,
  createDefaultSettings,
  languageSettingsSchema,
  modelProviderInputSchema,
  modelProviderSettingsSchema,
  settingsSchema,
  telemetrySettingsSchema,
  userSettingsSchema,
} from './settings.schema';
export type {
  AssistantSettings,
  LanguageSettings,
  ModelProviderSettings,
  Settings,
  UserSettings,
} from './settings.schema';

export {
  createDefaultPermissionPolicy,
  DEFAULT_PERMISSION_POLICY,
  permissionPolicySchema,
  permissionRuleSchema,
} from './permissions.schema';
export type { PermissionPolicy, PermissionRule } from './permissions.schema';

export { auditRecordSchema } from './audit.schema';
export type { AuditRecord } from './audit.schema';

export {
  auditParametersSchema,
  findAuditParameterIssues,
  isPlainObject,
} from './audit-parameters.schema';
export type { AuditParameters, JsonPrimitive, JsonValue } from './audit-parameters.schema';

export {
  createEngagedEmergencyState,
  createFailSafeEmergencyState,
  createInitialEmergencyState,
  emergencyStateSchema,
  INITIAL_EMERGENCY_STATE,
  REASON_EMERGENCY_STATE_UNREADABLE,
  resolveEmergencyState,
} from './emergency.schema';
export type {
  EmergencyState,
  EmergencyStateResolution,
  EmergencyStateSource,
} from './emergency.schema';

export {
  chatCancelRequestSchema,
  chatCancelResponseSchema,
  chatChunkEventSchema,
  chatSendRequestSchema,
  chatSendResponseSchema,
  healthCheckRequestSchema,
  healthCheckResponseSchema,
  IPC_CHAT_CANCEL_CHANNEL,
  IPC_CHAT_CHUNK_CHANNEL,
  IPC_CHAT_SEND_CHANNEL,
  IPC_HEALTH_CHANNEL,
  IPC_SECRETS_CLEAR_CHANNEL,
  IPC_SECRETS_STATUS_CHANNEL,
  IPC_SECRETS_WRITE_CHANNEL,
  IPC_SETTINGS_GET_CHANNEL,
  IPC_SETTINGS_UPDATE_CHANNEL,
  secretsClearRequestSchema,
  secretsClearResponseSchema,
  secretsStatusRequestSchema,
  secretsStatusResponseSchema,
  secretsWriteRequestSchema,
  secretsWriteResponseSchema,
  secretStatusResultSchema,
  settingsGetRequestSchema,
  settingsGetResponseSchema,
  settingsUpdateRequestSchema,
  settingsUpdateResponseSchema,
} from './ipc.schema';
export type {
  ChatCancelResponse,
  ChatChunkEvent,
  ChatSendRequestInput,
  ChatSendResponse,
  HealthCheckResponse,
  SecretsActionResponse,
  SecretStatusResult,
  SettingsActionResponse,
  SettingsUpdateInput,
} from './ipc.schema';

export { createEmptySecretStoreFile, secretStoreFileSchema } from './secrets.schema';
export type { SecretStoreFile } from './secrets.schema';

export {
  chatContentSchema,
  chatMessageMetadataSchema,
  chatMessageSchema,
  chatProviderRequestSchema,
  chatProviderResultSchema,
  chatStreamDeltaSchema,
  createChatMessage,
} from './chat.schema';
export type {
  ChatMessage,
  ChatMessageMetadata,
  ChatProviderRequestPayload,
  ChatProviderResultPayload,
} from './chat.schema';

export {
  codingObjectiveSchema,
  codingPlanChangeSchema,
  codingPlanContextSchema,
  codingPlanFileSchema,
  codingPlanSchema,
  codingPlanStepSchema,
  WORKSPACE_CHANGE_TYPES,
  WORKSPACE_ENTRY_KINDS,
  WORKSPACE_FILE_WARNINGS,
  workspaceEntryPathSchema,
  workspaceEntrySchema,
  workspaceFileContentSchema,
  workspaceFileMetadataSchema,
  workspaceFileSchema,
  workspaceFileWarningSchema,
  workspaceNameSchema,
  workspaceObjectiveSchema,
  workspacePlanTextSchema,
  workspaceProjectPathSchema,
  workspaceProjectStateSchema,
  workspaceProjectSummarySchema,
  workspaceRelativePathSchema,
  workspaceSearchExcerptSchema,
  workspaceSearchMatchSchema,
  workspaceSearchQuerySchema,
  workspaceSearchResultSchema,
  workspaceTreeSchema,
} from './workspace.schema';
export type {
  CodingObjective,
  CodingPlan,
  CodingPlanChange,
  CodingPlanContext,
  CodingPlanFile,
  CodingPlanStep,
  WorkspaceEntry,
  WorkspaceFile,
  WorkspaceFileMetadata,
  WorkspaceProjectState,
  WorkspaceProjectSummary,
  WorkspaceSearchMatch,
  WorkspaceSearchResult,
  WorkspaceTree,
} from './workspace.schema';

export {
  IPC_WORKSPACE_FILE_CHANNEL,
  IPC_WORKSPACE_PLAN_CHANNEL,
  IPC_WORKSPACE_SEARCH_CHANNEL,
  IPC_WORKSPACE_SELECT_CHANNEL,
  IPC_WORKSPACE_STATUS_CHANNEL,
  IPC_WORKSPACE_TREE_CHANNEL,
  workspaceFileRequestSchema,
  workspaceFileResponseSchema,
  workspacePlanRequestSchema,
  workspacePlanResponseSchema,
  workspaceProjectResponseSchema,
  workspaceSearchRequestSchema,
  workspaceSearchResponseSchema,
  workspaceSelectRequestSchema,
  workspaceSelectResponseSchema,
  workspaceStatusRequestSchema,
  workspaceStatusResponseSchema,
  workspaceTreeRequestSchema,
  workspaceTreeResponseSchema,
} from './ipc.schema';
export type {
  WorkspaceFileRequestInput,
  WorkspaceFileResponse,
  WorkspacePlanRequestInput,
  WorkspacePlanResponse,
  WorkspaceProjectResponse,
  WorkspaceSearchRequestInput,
  WorkspaceSearchResponse,
  WorkspaceTreeRequestInput,
  WorkspaceTreeResponse,
} from './ipc.schema';

// ---------------------------------------------------------------------------
// Controlled coding actions (Phase 2, Milestone 6)
// ---------------------------------------------------------------------------

export {
  COMMAND_OUTCOMES,
  COMMAND_OUTPUT_STREAMS,
  commandCatalogSchema,
  commandDescriptorSchema,
  commandIdSchema,
  commandOutputLineSchema,
  commandRunResultSchema,
  diffHunkSchema,
  diffLineSchema,
  fileDiffSchema,
  GIT_DIFF_LINE_KINDS,
  gitCheckpointSchema,
  gitDiffLineSchema,
  gitDiffSchema,
  gitStatusEntrySchema,
  gitStatusSchema,
  WORKSPACE_CHANGE_STATUSES,
  workspaceChangeHistorySchema,
  workspaceChangeIdSchema,
  workspaceChangeSetSchema,
  workspaceEditSchema,
  workspaceProposedContentSchema,
} from './coding.schema';
export type {
  CommandCatalog,
  CommandDescriptor,
  CommandIdValue,
  CommandOutputLine,
  CommandRunResult,
  DiffLineValue,
  FileDiffValue,
  GitCheckpointValue,
  GitDiffValue,
  GitStatusEntryValue,
  GitStatusValue,
  WorkspaceChangeHistory,
  WorkspaceChangeSet,
  WorkspaceEdit,
} from './coding.schema';

export {
  commandCancelRequestSchema,
  commandCancelResponseSchema,
  commandListRequestSchema,
  commandListResponseSchema,
  commandRunRequestSchema,
  commandRunResponseSchema,
  gitCheckpointRequestSchema,
  gitCheckpointResponseSchema,
  gitDiffRequestSchema,
  gitDiffResponseSchema,
  gitStatusRequestSchema,
  gitStatusResponseSchema,
  IPC_COMMAND_CANCEL_CHANNEL,
  IPC_COMMAND_LIST_CHANNEL,
  IPC_COMMAND_RUN_CHANNEL,
  IPC_GIT_CHECKPOINT_CHANNEL,
  IPC_GIT_DIFF_CHANNEL,
  IPC_GIT_STATUS_CHANNEL,
  IPC_WORKSPACE_APPLY_CHANNEL,
  IPC_WORKSPACE_CHANGES_CHANNEL,
  IPC_WORKSPACE_PROPOSE_CHANNEL,
  IPC_WORKSPACE_ROLLBACK_CHANNEL,
  workspaceApplyRequestSchema,
  workspaceApplyResponseSchema,
  workspaceChangeResponseSchema,
  workspaceChangesRequestSchema,
  workspaceChangesResponseSchema,
  workspaceProposeRequestSchema,
  workspaceProposeResponseSchema,
  workspaceRollbackRequestSchema,
  workspaceRollbackResponseSchema,
} from './ipc.schema';
export type {
  CommandCancelResponse,
  CommandListResponse,
  CommandRunRequestInput,
  CommandRunResponse,
  GitCheckpointResponse,
  GitDiffRequestInput,
  GitDiffResponse,
  GitStatusResponse,
  WorkspaceChangeResponse,
  WorkspaceChangesResponse,
  WorkspaceProposeRequestInput,
} from './ipc.schema';

// ---------------------------------------------------------------------------
// Agent profiles and runs (Phase 2, Milestone 7)
// ---------------------------------------------------------------------------

export {
  AGENT_PROFILE_DECISIONS,
  AGENT_RUN_STATUSES,
  AGENT_STOP_REASONS,
  agentLimitsSchema,
  agentPermissionRuleSchema,
  agentProfileIdSchema,
  agentProfileInputSchema,
  agentProfileSchema,
  agentProfileStoreSchema,
  agentRunSchema,
  agentRunStepSchema,
  agentToolIdSchema,
  agentVerificationRequirementSchema,
  agentVerificationResultSchema,
} from './agent.schema';
export type {
  AgentLimits,
  AgentPermissionRule,
  AgentProfile,
  AgentProfileDecision,
  AgentProfileInput,
  AgentProfileStore,
  AgentRun,
  AgentRunStatus,
  AgentRunStep,
  AgentStopReason,
  AgentVerificationResult,
} from './agent.schema';

export {
  agentCancelRequestSchema,
  agentCancelResponseSchema,
  agentCreateRequestSchema,
  agentCreateResponseSchema,
  agentDeleteRequestSchema,
  agentDeleteResponseSchema,
  agentListRequestSchema,
  agentListResponseSchema,
  agentRegistryResponseSchema,
  agentRunRequestSchema,
  agentRunResponseSchema,
  agentSelectRequestSchema,
  agentSelectResponseSchema,
  agentSetEnabledRequestSchema,
  agentSetEnabledResponseSchema,
  agentUpdateRequestSchema,
  agentUpdateResponseSchema,
  IPC_AGENT_CANCEL_CHANNEL,
  IPC_AGENT_CREATE_CHANNEL,
  IPC_AGENT_DELETE_CHANNEL,
  IPC_AGENT_LIST_CHANNEL,
  IPC_AGENT_RUN_CHANNEL,
  IPC_AGENT_SELECT_CHANNEL,
  IPC_AGENT_SET_ENABLED_CHANNEL,
  IPC_AGENT_UPDATE_CHANNEL,
} from './ipc.schema';
export type {
  AgentCancelResponse,
  AgentCreateInput,
  AgentProfileReferenceInput,
  AgentRegistryResponse,
  AgentRunRequestInput,
  AgentRunResponse,
  AgentSetEnabledInput,
  AgentUpdateInput,
} from './ipc.schema';
