/**
 * Barrel for the Windows automation layer (Phase 2, Milestone 10).
 *
 * Everything exported here is pure: no I/O, no Node built-in, no Electron, no
 * network, no clock. The registry lives here so that the main process, which
 * performs an action, and the renderer, which displays what is available,
 * apply the identical vocabulary rather than two lists that can drift.
 */

export {
  AUTOMATION_ERROR_CODES,
  AUTOMATION_ERROR_MESSAGES,
  AutomationError,
  isAutomationErrorCode,
} from './errors';
export type { AutomationErrorCode } from './errors';

export {
  AUTOMATION_ALLOWED_WEBSITE_HOSTS,
  AUTOMATION_SPECIAL_FOLDERS,
  AUTOMATION_TOOL_IDS,
  AUTOMATION_TOOL_KINDS,
  AUTOMATION_TOOLS,
  findAutomationTool,
  isAutomationToolId,
} from './registry';
export type {
  AutomationAppTool,
  AutomationFolderTool,
  AutomationSpecialFolder,
  AutomationToolDefinition,
  AutomationToolId,
  AutomationToolKind,
  AutomationWebsiteTool,
  AutomationWindowTool,
} from './registry';

export { isSafeAutomationUrl } from './validation';
