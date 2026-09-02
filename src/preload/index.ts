import { contextBridge, ipcRenderer } from 'electron';

import {
  healthCheckResponseSchema,
  IPC_HEALTH_CHANNEL,
  type HealthCheckResponse,
} from '../shared/schemas';

/**
 * The narrow, explicitly enumerated API exposed to the renderer.
 *
 * Nothing here forwards `ipcRenderer` itself and nothing here accepts a
 * caller-supplied channel name: each function calls exactly one fixed
 * channel, so the renderer can request only what is listed below, never an
 * arbitrary IPC channel. The result is re-validated against the shared
 * response schema before it leaves this module, so a malformed reply from a
 * compromised or buggy main process cannot reach the renderer looking valid.
 */
const bridge = {
  health: async (): Promise<HealthCheckResponse> => {
    const result: unknown = await ipcRenderer.invoke(IPC_HEALTH_CHANNEL);
    return healthCheckResponseSchema.parse(result);
  },
};

contextBridge.exposeInMainWorld('localAgent', bridge);

export type LocalAgentBridge = typeof bridge;
