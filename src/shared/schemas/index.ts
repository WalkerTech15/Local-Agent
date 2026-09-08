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
