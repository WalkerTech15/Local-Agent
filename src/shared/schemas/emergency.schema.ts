/**
 * Emergency-stop state schema for Local Agent.
 *
 * This describes `%APPDATA%\Local-Agent\state\emergency.json`.
 *
 * Resolution rules, which differ deliberately between two cases that are easy
 * to conflate:
 *
 *  - **No file exists.** This is a legitimate first launch. The state
 *    initialises as *disengaged*. A clean install must never start
 *    permanently blocked.
 *
 *  - **A file exists but is malformed, unreadable or fails validation.**
 *    Something has gone wrong with state that was previously written. The
 *    state is treated as *engaged* until the user explicitly releases it.
 *
 * In Phase 1 the emergency stop is a gate, not a task canceller: no
 * long-running or background work exists yet, so there is nothing to
 * interrupt. It blocks subsequent actions and persists across restarts.
 */

import { z } from 'zod';

import { EMERGENCY_SCHEMA_VERSION } from '../constants';
import type { DeepReadonly } from '../freeze';
import { deepFreeze } from '../freeze';

export const emergencyStateSchema = z
  .strictObject({
    schemaVersion: z.literal(EMERGENCY_SCHEMA_VERSION),
    engaged: z.boolean(),
    /** UTC ISO-8601 when engaged; null when disengaged. */
    engagedAt: z.iso.datetime().nullable(),
    reason: z.string().trim().max(200),
  })
  .superRefine((state, ctx) => {
    if (state.engaged && state.engagedAt === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['engagedAt'],
        message: 'engagedAt is required while the emergency stop is engaged',
      });
    }
    if (!state.engaged && state.engagedAt !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['engagedAt'],
        message: 'engagedAt must be null while the emergency stop is disengaged',
      });
    }
  });

export type EmergencyState = z.infer<typeof emergencyStateSchema>;

/** Reason recorded when an existing state file could not be trusted. */
export const REASON_EMERGENCY_STATE_UNREADABLE = 'emergency-state-file-invalid';

/**
 * Builds the state used on a legitimate first launch, when no state file
 * exists yet. Disengaged: a clean install starts usable.
 *
 * A factory, so every caller receives its own object. `resolveEmergencyState`
 * returns the result of this rather than a shared reference — otherwise one
 * caller mutating the resolved state would silently change the emergency
 * state that a later, unrelated caller resolves.
 */
export function createInitialEmergencyState(): EmergencyState {
  return {
    schemaVersion: EMERGENCY_SCHEMA_VERSION,
    engaged: false,
    engagedAt: null,
    reason: '',
  };
}

/**
 * The initial state as a deeply frozen, read-only reference.
 *
 * Use {@link createInitialEmergencyState} when a mutable copy is needed.
 * Attempting to mutate this throws, because every module here is an ES module
 * and therefore strict mode.
 */
export const INITIAL_EMERGENCY_STATE: DeepReadonly<EmergencyState> = deepFreeze(
  createInitialEmergencyState(),
);

/**
 * The state used when an existing state file is malformed or unreadable.
 * Engaged: previously written state that cannot be trusted fails safe.
 */
export function createFailSafeEmergencyState(engagedAt: string): EmergencyState {
  return {
    schemaVersion: EMERGENCY_SCHEMA_VERSION,
    engaged: true,
    engagedAt,
    reason: REASON_EMERGENCY_STATE_UNREADABLE,
  };
}

/**
 * What the caller found on disk.
 *
 * The caller performs the file access and reports the outcome; this module
 * stays free of I/O so the decision itself is pure and directly testable.
 */
export type EmergencyStateSource =
  | { readonly kind: 'absent' }
  | { readonly kind: 'present'; readonly raw: unknown }
  | { readonly kind: 'unreadable' };

export interface EmergencyStateResolution {
  readonly state: EmergencyState;
  /** True when the resolver had to fall back to the engaged, fail-safe state. */
  readonly failSafe: boolean;
  /** True when a fresh state file should be written for a first launch. */
  readonly initialised: boolean;
}

/**
 * Applies the resolution rules described at the top of this module.
 *
 * @param source what the caller found on disk
 * @param now UTC ISO-8601 timestamp, supplied by the caller
 */
export function resolveEmergencyState(
  source: EmergencyStateSource,
  now: string,
): EmergencyStateResolution {
  if (source.kind === 'absent') {
    // Legitimate first launch. Start disengaged.
    //
    // A fresh object, not the shared INITIAL_EMERGENCY_STATE reference: the
    // caller owns what it receives, and mutating one resolution must not
    // affect any other.
    return { state: createInitialEmergencyState(), failSafe: false, initialised: true };
  }

  if (source.kind === 'unreadable') {
    return { state: createFailSafeEmergencyState(now), failSafe: true, initialised: false };
  }

  const parsed = emergencyStateSchema.safeParse(source.raw);
  if (!parsed.success) {
    return { state: createFailSafeEmergencyState(now), failSafe: true, initialised: false };
  }

  return { state: parsed.data, failSafe: false, initialised: false };
}
