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
  healthCheckRequestSchema,
  healthCheckResponseSchema,
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
  HealthCheckResponse,
  SecretsActionResponse,
  SecretStatusResult,
  SettingsActionResponse,
  SettingsUpdateInput,
} from './ipc.schema';

export { createEmptySecretStoreFile, secretStoreFileSchema } from './secrets.schema';
export type { SecretStoreFile } from './secrets.schema';
