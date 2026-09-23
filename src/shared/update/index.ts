export {
  UPDATE_ERROR_CODES,
  UPDATE_ERROR_MESSAGES,
  UpdateError,
  isUpdateErrorCode,
} from './errors';
export type { UpdateErrorCode } from './errors';

export { UPDATE_STATES, UPDATE_EVENTS, transitionUpdateState } from './states';
export type { UpdateState, UpdateEvent } from './states';

export { UPDATE_PROVIDERS, resolveUpdateConfig } from './config';
export type { UpdateProvider, UpdateConfig, ResolveUpdateConfigContext } from './config';

export { canInstallUpdate } from './guard';
export type { UpdateInstallApproval, UpdateInstallDecision } from './guard';
