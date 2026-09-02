import { describe, expect, it } from 'vitest';

import type { AuditRecord } from '../../../src/shared/schemas/audit.schema';
import { auditRecordSchema } from '../../../src/shared/schemas/audit.schema';

const EVENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CORRELATION_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';

const validRecord = (): AuditRecord => ({
  schemaVersion: 1,
  eventId: EVENT_ID,
  correlationId: CORRELATION_ID,
  timestamp: '2026-08-07T00:00:00.000Z',
  actor: 'user',
  actionType: 'settings.write',
  parameters: { field: 'assistant.name' },
  decision: 'allow',
  decisionReason: 'settings.write',
  outcome: 'success',
  durationMs: 12,
});

const patch = (overrides: Record<string, unknown>): unknown => ({
  ...validRecord(),
  ...overrides,
});

describe('auditRecordSchema — valid input', () => {
  it('accepts a well-formed record', () => {
    expect(auditRecordSchema.safeParse(validRecord()).success).toBe(true);
  });

  it('accepts an approved confirmation', () => {
    const result = auditRecordSchema.safeParse(
      patch({
        actionType: 'secrets.write',
        decision: 'confirm',
        confirmationResult: 'approved',
        outcome: 'success',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a rejected confirmation recorded as aborted', () => {
    const result = auditRecordSchema.safeParse(
      patch({
        actionType: 'secrets.clear',
        decision: 'confirm',
        confirmationResult: 'rejected',
        outcome: 'aborted',
      }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a denial, so that blocked actions are recorded too', () => {
    const result = auditRecordSchema.safeParse(
      patch({ decision: 'deny', decisionReason: 'default-deny', outcome: 'denied' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts a failure carrying a stable error code', () => {
    const result = auditRecordSchema.safeParse(
      patch({ outcome: 'failure', errorCode: 'SETTINGS_WRITE_FAILED' }),
    );
    expect(result.success).toBe(true);
  });

  it('accepts empty parameters', () => {
    expect(auditRecordSchema.safeParse(patch({ parameters: {} })).success).toBe(true);
  });
});

describe('auditRecordSchema — rejects malformed input', () => {
  it('rejects a missing correlationId', () => {
    const { correlationId: _omitted, ...rest } = validRecord();
    expect(auditRecordSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a missing eventId', () => {
    const { eventId: _omitted, ...rest } = validRecord();
    expect(auditRecordSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a non-UUID identifier', () => {
    expect(auditRecordSchema.safeParse(patch({ eventId: 'event-1' })).success).toBe(false);
    expect(auditRecordSchema.safeParse(patch({ correlationId: '' })).success).toBe(false);
  });

  it('rejects an unknown outcome', () => {
    for (const outcome of ['ok', 'partial', 'unknown', '']) {
      expect(auditRecordSchema.safeParse(patch({ outcome })).success).toBe(false);
    }
  });

  it('rejects an unknown actor', () => {
    expect(auditRecordSchema.safeParse(patch({ actor: 'attacker' })).success).toBe(false);
  });

  it('rejects an unknown action type', () => {
    expect(auditRecordSchema.safeParse(patch({ actionType: 'shell.execute' })).success).toBe(false);
  });

  it('rejects a timestamp carrying a UTC offset', () => {
    const result = auditRecordSchema.safeParse(patch({ timestamp: '2026-08-07T02:00:00+02:00' }));
    expect(result.success).toBe(false);
  });

  it('rejects an empty decision reason', () => {
    expect(auditRecordSchema.safeParse(patch({ decisionReason: '   ' })).success).toBe(false);
  });

  it('rejects a negative or fractional duration', () => {
    expect(auditRecordSchema.safeParse(patch({ durationMs: -1 })).success).toBe(false);
    expect(auditRecordSchema.safeParse(patch({ durationMs: 1.5 })).success).toBe(false);
  });

  it('rejects unknown keys', () => {
    expect(auditRecordSchema.safeParse(patch({ note: 'extra' })).success).toBe(false);
  });
});

describe('auditRecordSchema — integrity rules', () => {
  it('rejects a confirm decision that does not record the user response', () => {
    const result = auditRecordSchema.safeParse(patch({ decision: 'confirm' }));
    expect(result.success).toBe(false);
  });

  it('rejects a confirmation result on a decision that never prompted', () => {
    const result = auditRecordSchema.safeParse(
      patch({ decision: 'allow', confirmationResult: 'approved' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a denied action claiming to have succeeded', () => {
    for (const outcome of ['success', 'failure', 'aborted']) {
      const result = auditRecordSchema.safeParse(
        patch({ decision: 'deny', decisionReason: 'default-deny', outcome }),
      );
      expect(result.success).toBe(false);
    }
  });

  it('rejects a rejected confirmation claiming to have succeeded', () => {
    const result = auditRecordSchema.safeParse(
      patch({ decision: 'confirm', confirmationResult: 'rejected', outcome: 'success' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects an error code on a successful outcome', () => {
    const result = auditRecordSchema.safeParse(
      patch({ outcome: 'success', errorCode: 'SOMETHING_FAILED' }),
    );
    expect(result.success).toBe(false);
  });
});

describe('auditRecordSchema — contradictions are closed in both directions', () => {
  // A one-directional rule leaves the opposite contradiction writable. These
  // cover the reverse of each pairing.

  it('rejects a denied outcome that did not follow a deny decision', () => {
    for (const decision of ['allow', 'confirm']) {
      const overrides: Record<string, unknown> = { decision, outcome: 'denied' };
      if (decision === 'confirm') overrides.confirmationResult = 'approved';
      const result = auditRecordSchema.safeParse(patch(overrides));
      expect(result.success, `expected decision=${decision} outcome=denied to be rejected`).toBe(
        false,
      );
    }
  });

  it('rejects an aborted outcome that did not follow a rejected confirmation', () => {
    expect(
      auditRecordSchema.safeParse(patch({ decision: 'allow', outcome: 'aborted' })).success,
    ).toBe(false);
    expect(
      auditRecordSchema.safeParse(
        patch({ decision: 'confirm', confirmationResult: 'approved', outcome: 'aborted' }),
      ).success,
    ).toBe(false);
  });

  it('rejects an approved confirmation recorded as denied or aborted', () => {
    for (const outcome of ['denied', 'aborted']) {
      const result = auditRecordSchema.safeParse(
        patch({ decision: 'confirm', confirmationResult: 'approved', outcome }),
      );
      expect(result.success, `expected approved+${outcome} to be rejected`).toBe(false);
    }
  });

  it('accepts an approved confirmation that succeeded or failed', () => {
    expect(
      auditRecordSchema.safeParse(
        patch({ decision: 'confirm', confirmationResult: 'approved', outcome: 'success' }),
      ).success,
    ).toBe(true);
    expect(
      auditRecordSchema.safeParse(
        patch({
          decision: 'confirm',
          confirmationResult: 'approved',
          outcome: 'failure',
          errorCode: 'SECRETS_WRITE_FAILED',
        }),
      ).success,
    ).toBe(true);
  });

  it('requires a stable errorCode on a failure', () => {
    const result = auditRecordSchema.safeParse(patch({ outcome: 'failure' }));
    expect(result.success).toBe(false);
  });

  it('rejects an errorCode on any non-failure outcome', () => {
    const cases: Record<string, unknown>[] = [
      { outcome: 'success', errorCode: 'SOMETHING_FAILED' },
      { decision: 'deny', decisionReason: 'default-deny', outcome: 'denied', errorCode: 'BLOCKED' },
      {
        decision: 'confirm',
        confirmationResult: 'rejected',
        outcome: 'aborted',
        errorCode: 'USER_SAID_NO',
      },
    ];
    for (const overrides of cases) {
      expect(auditRecordSchema.safeParse(patch(overrides)).success).toBe(false);
    }
  });
});

describe('auditRecordSchema — keeps sensitive text out of the log', () => {
  it('rejects a free-text error message in place of an error code', () => {
    const leaky = [
      'Failed to read C:\\Users\\Someone\\AppData\\Roaming\\Local-Agent\\secrets\\secrets.enc',
      'Error: invalid api key sk-abc123',
      'something went wrong',
      'lower_snake_case',
      'AB',
    ];
    for (const errorCode of leaky) {
      const result = auditRecordSchema.safeParse(patch({ outcome: 'failure', errorCode }));
      expect(result.success).toBe(false);
    }
  });
});
