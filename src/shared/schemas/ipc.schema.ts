/**
 * IPC channel contracts for Local Agent.
 *
 * Every channel the preload bridge is allowed to call is named here as an
 * explicit constant — never a string literal duplicated in `main` and
 * `preload` — and paired with a schema for its request and its response.
 * `main/ipc` validates both directions before a handler runs and before a
 * result crosses back into the renderer, so a malformed call or a
 * malformed result fails loudly instead of reaching untrusted code.
 *
 * Phase 1 / Milestone 2 exposes exactly one channel: a liveness check with no
 * useful payload. It exists to prove the request path end to end — preload →
 * main → validated response → renderer — before any privileged channel is
 * added in a later milestone.
 */

import { z } from 'zod';

/** The only IPC channel Milestone 2 registers. */
export const IPC_HEALTH_CHANNEL = 'app:health';

/**
 * The health check takes no arguments. Validating this explicitly, rather
 * than assuming an empty call, means an unexpected extra argument — from a
 * future bug or a tampered call — is rejected instead of silently ignored.
 */
export const healthCheckRequestSchema = z.tuple([]);

export const healthCheckResponseSchema = z.strictObject({
  status: z.literal('ok'),
});

export type HealthCheckResponse = z.infer<typeof healthCheckResponseSchema>;
