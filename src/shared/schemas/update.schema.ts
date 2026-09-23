/**
 * Auto-update schema for Local Agent (Phase 3, Milestone 4).
 *
 * Nothing here crosses an IPC boundary yet — this milestone adds no update
 * channel and no persisted update state (see `docs/phase-3-auto-update.md`).
 * These schemas exist now so that the day a future milestone does wire one
 * up, the shapes it validates against are already reviewed and tested,
 * rather than invented under the pressure of that milestone.
 */

import { z } from 'zod';

import { UPDATE_ERROR_CODES } from '../update/errors';
import { UPDATE_PROVIDERS } from '../update/config';
import { UPDATE_STATES } from '../update/states';

export const updateStateSchema = z.enum(UPDATE_STATES);

export const updateProviderSchema = z.enum(UPDATE_PROVIDERS);

export const updateErrorCodeSchema = z.enum(UPDATE_ERROR_CODES);

/**
 * The safe, display-only projection of {@link UpdateConfig}. Carries whether
 * updates are enabled and which provider — never a raw feed URL with
 * embedded credentials, though this project's supported providers never
 * carry one; the omission is deliberate defense in depth over "currently
 * true."
 */
export const updateStatusSchema = z.strictObject({
  state: updateStateSchema,
  provider: updateProviderSchema.nullable(),
});

export type UpdateStatus = z.infer<typeof updateStatusSchema>;
