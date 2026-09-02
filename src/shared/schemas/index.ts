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
} from './ipc.schema';
export type { HealthCheckResponse } from './ipc.schema';
