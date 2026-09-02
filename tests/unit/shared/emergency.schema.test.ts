import { describe, expect, it } from 'vitest';

import type { EmergencyState } from '../../../src/shared/schemas/emergency.schema';
import {
  createFailSafeEmergencyState,
  createInitialEmergencyState,
  emergencyStateSchema,
  INITIAL_EMERGENCY_STATE,
  REASON_EMERGENCY_STATE_UNREADABLE,
  resolveEmergencyState,
} from '../../../src/shared/schemas/emergency.schema';

const NOW = '2026-08-07T00:00:00.000Z';

const engagedState = (): EmergencyState => ({
  schemaVersion: 1,
  engaged: true,
  engagedAt: NOW,
  reason: 'user pressed stop',
});

describe('emergencyStateSchema', () => {
  it('accepts a disengaged state', () => {
    expect(emergencyStateSchema.safeParse(INITIAL_EMERGENCY_STATE).success).toBe(true);
  });

  it('accepts an engaged state', () => {
    expect(emergencyStateSchema.safeParse(engagedState()).success).toBe(true);
  });

  it('rejects an engaged state with no engagement time', () => {
    const invalid: unknown = { ...engagedState(), engagedAt: null };
    expect(emergencyStateSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects a disengaged state that claims an engagement time', () => {
    const invalid: unknown = { ...INITIAL_EMERGENCY_STATE, engagedAt: NOW };
    expect(emergencyStateSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects a non-boolean engaged flag', () => {
    const invalid: unknown = { ...engagedState(), engaged: 'true' };
    expect(emergencyStateSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    const invalid: unknown = { ...engagedState(), override: true };
    expect(emergencyStateSchema.safeParse(invalid).success).toBe(false);
  });

  it('rejects an unexpected schemaVersion', () => {
    const invalid: unknown = { ...engagedState(), schemaVersion: 2 };
    expect(emergencyStateSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('resolveEmergencyState — a clean first launch is not blocked', () => {
  it('initialises as disengaged when no state file exists', () => {
    const resolution = resolveEmergencyState({ kind: 'absent' }, NOW);
    expect(resolution.state.engaged).toBe(false);
    expect(resolution.state.engagedAt).toBeNull();
    expect(resolution.failSafe).toBe(false);
    expect(resolution.initialised).toBe(true);
  });

  it('produces a state that is itself valid on first launch', () => {
    const resolution = resolveEmergencyState({ kind: 'absent' }, NOW);
    expect(emergencyStateSchema.safeParse(resolution.state).success).toBe(true);
  });
});

describe('resolveEmergencyState — existing state that cannot be trusted fails safe', () => {
  it('engages when an existing state file is malformed', () => {
    const malformed: readonly unknown[] = [
      {},
      { engaged: false },
      { schemaVersion: 1, engaged: true, engagedAt: null, reason: '' },
      { schemaVersion: 1, engaged: 'no', engagedAt: null, reason: '' },
      { schemaVersion: 2, engaged: false, engagedAt: null, reason: '' },
      'not an object',
      null,
      42,
      [],
    ];

    for (const raw of malformed) {
      const resolution = resolveEmergencyState({ kind: 'present', raw }, NOW);
      expect(resolution.state.engaged).toBe(true);
      expect(resolution.failSafe).toBe(true);
      expect(resolution.initialised).toBe(false);
      expect(resolution.state.reason).toBe(REASON_EMERGENCY_STATE_UNREADABLE);
    }
  });

  it('engages when an existing state file cannot be read', () => {
    const resolution = resolveEmergencyState({ kind: 'unreadable' }, NOW);
    expect(resolution.state.engaged).toBe(true);
    expect(resolution.state.engagedAt).toBe(NOW);
    expect(resolution.failSafe).toBe(true);
  });

  it('produces a valid state when failing safe', () => {
    const resolution = resolveEmergencyState({ kind: 'unreadable' }, NOW);
    expect(emergencyStateSchema.safeParse(resolution.state).success).toBe(true);
  });
});

describe('resolveEmergencyState — valid existing state is preserved', () => {
  it('keeps a previously engaged state engaged across a restart', () => {
    const resolution = resolveEmergencyState({ kind: 'present', raw: engagedState() }, NOW);
    expect(resolution.state.engaged).toBe(true);
    expect(resolution.state.reason).toBe('user pressed stop');
    expect(resolution.failSafe).toBe(false);
    expect(resolution.initialised).toBe(false);
  });

  it('keeps a previously disengaged state disengaged', () => {
    const resolution = resolveEmergencyState(
      { kind: 'present', raw: INITIAL_EMERGENCY_STATE },
      NOW,
    );
    expect(resolution.state.engaged).toBe(false);
    expect(resolution.failSafe).toBe(false);
  });
});

describe('createFailSafeEmergencyState', () => {
  it('produces an engaged, valid state stamped with the supplied time', () => {
    const state = createFailSafeEmergencyState(NOW);
    expect(state.engaged).toBe(true);
    expect(state.engagedAt).toBe(NOW);
    expect(emergencyStateSchema.safeParse(state).success).toBe(true);
  });

  it('returns a fresh object each time', () => {
    expect(createFailSafeEmergencyState(NOW)).not.toBe(createFailSafeEmergencyState(NOW));
  });
});

describe('INITIAL_EMERGENCY_STATE — immutability', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(INITIAL_EMERGENCY_STATE)).toBe(true);
  });

  it('throws when a caller tries to engage or disengage it in place', () => {
    const mutable = INITIAL_EMERGENCY_STATE as unknown as {
      engaged: boolean;
      reason: string;
    };
    expect(() => {
      mutable.engaged = true;
    }).toThrow(TypeError);
    expect(() => {
      mutable.reason = 'tampered';
    }).toThrow(TypeError);
    expect(INITIAL_EMERGENCY_STATE.engaged).toBe(false);
    expect(INITIAL_EMERGENCY_STATE.reason).toBe('');
  });

  it('hands out a fresh mutable copy from the factory', () => {
    const first = createInitialEmergencyState();
    const second = createInitialEmergencyState();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
    expect(Object.isFrozen(first)).toBe(false);
  });
});

describe('resolveEmergencyState — callers cannot corrupt each other', () => {
  it('returns a distinct object for each absent-state resolution', () => {
    const first = resolveEmergencyState({ kind: 'absent' }, NOW);
    const second = resolveEmergencyState({ kind: 'absent' }, NOW);
    expect(first.state).not.toBe(second.state);
    expect(first.state).toEqual(second.state);
  });

  it('does not hand back the shared INITIAL_EMERGENCY_STATE reference', () => {
    const resolution = resolveEmergencyState({ kind: 'absent' }, NOW);
    expect(resolution.state).not.toBe(INITIAL_EMERGENCY_STATE);
    expect(resolution.state).toEqual(INITIAL_EMERGENCY_STATE);
  });

  it('mutating one resolution cannot engage a later one', () => {
    const first = resolveEmergencyState({ kind: 'absent' }, NOW);
    first.state.engaged = true;
    first.state.reason = 'mutated by an earlier caller';

    const later = resolveEmergencyState({ kind: 'absent' }, NOW);
    expect(later.state.engaged).toBe(false);
    expect(later.state.reason).toBe('');
    expect(INITIAL_EMERGENCY_STATE.engaged).toBe(false);
  });

  it('mutating a fail-safe resolution cannot disengage a later one', () => {
    const first = resolveEmergencyState({ kind: 'unreadable' }, NOW);
    first.state.engaged = false;

    const later = resolveEmergencyState({ kind: 'unreadable' }, NOW);
    expect(later.state.engaged).toBe(true);
  });
});
