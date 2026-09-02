import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AuditRecordValidationError,
  AuditWriteError,
  appendAuditRecord,
  redactSecrets,
} from '../../../src/main/audit';
import {
  AUDIT_LOG_FILE_EXTENSION,
  AUDIT_LOG_FILE_PREFIX,
  AUDIT_SCHEMA_VERSION,
  REDACTED_PLACEHOLDER,
} from '../../../src/shared/constants';

const EVENT_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
const CORRELATION_ID = '9c858901-8a57-4791-81fe-4c455b099bc9';
const TIMESTAMP = '2026-08-07T00:00:00.000Z';

/** A real, isolated temporary directory per test — never the real `%APPDATA%`. */
let dir: string;
let auditLogDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-audit-'));
  auditLogDir = join(dir, 'logs', 'audit');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const validCandidate = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schemaVersion: AUDIT_SCHEMA_VERSION,
  eventId: EVENT_ID,
  correlationId: CORRELATION_ID,
  timestamp: TIMESTAMP,
  actor: 'user',
  actionType: 'settings.write',
  parameters: { field: 'assistant.name' },
  decision: 'allow',
  decisionReason: 'settings.write',
  outcome: 'success',
  durationMs: 12,
  ...overrides,
});

function logFileFor(timestamp: string): string {
  return join(
    auditLogDir,
    `${AUDIT_LOG_FILE_PREFIX}${timestamp.slice(0, 10)}${AUDIT_LOG_FILE_EXTENSION}`,
  );
}

async function readLines(filePath: string): Promise<string[]> {
  const raw = await readFile(filePath, 'utf8');
  return raw.split('\n').filter((line) => line.length > 0);
}

/** Reads a log file expected to contain exactly one line, and returns it. */
async function readOneLine(filePath: string): Promise<string> {
  const lines = await readLines(filePath);
  expect(lines).toHaveLength(1);
  const [line] = lines;
  if (line === undefined) {
    throw new Error('expected exactly one line');
  }
  return line;
}

// ---------------------------------------------------------------------------
// Successful writes
// ---------------------------------------------------------------------------

describe('appendAuditRecord — valid records', () => {
  it('writes a valid successful record as one JSON line', async () => {
    await appendAuditRecord(auditLogDir, validCandidate());

    const line = await readOneLine(logFileFor(TIMESTAMP));

    const parsed: unknown = JSON.parse(line);
    expect(parsed).toMatchObject({
      eventId: EVENT_ID,
      correlationId: CORRELATION_ID,
      outcome: 'success',
      decision: 'allow',
    });
  });

  it('writes a valid failed record carrying a stable error code', async () => {
    await appendAuditRecord(
      auditLogDir,
      validCandidate({ outcome: 'failure', errorCode: 'SETTINGS_WRITE_FAILED' }),
    );

    const line = await readOneLine(logFileFor(TIMESTAMP));
    const parsed = JSON.parse(line) as { outcome: string; errorCode: string };
    expect(parsed.outcome).toBe('failure');
    expect(parsed.errorCode).toBe('SETTINGS_WRITE_FAILED');
  });

  it('records a denied action', async () => {
    await appendAuditRecord(
      auditLogDir,
      validCandidate({ decision: 'deny', decisionReason: 'default-deny', outcome: 'denied' }),
    );

    const line = await readOneLine(logFileFor(TIMESTAMP));
    const parsed = JSON.parse(line) as { decision: string; outcome: string };
    expect(parsed.decision).toBe('deny');
    expect(parsed.outcome).toBe('denied');
  });

  it('records a rejected confirmation as aborted', async () => {
    await appendAuditRecord(
      auditLogDir,
      validCandidate({
        actionType: 'secrets.clear',
        decision: 'confirm',
        confirmationResult: 'rejected',
        outcome: 'aborted',
      }),
    );

    const line = await readOneLine(logFileFor(TIMESTAMP));
    const parsed = JSON.parse(line) as { confirmationResult: string; outcome: string };
    expect(parsed.confirmationResult).toBe('rejected');
    expect(parsed.outcome).toBe('aborted');
  });

  it('creates the audit directory when it does not exist', async () => {
    await expect(readdir(auditLogDir)).rejects.toMatchObject({ code: 'ENOENT' });
    await appendAuditRecord(auditLogDir, validCandidate());
    const entries = await readdir(auditLogDir);
    expect(entries).toHaveLength(1);
  });

  it('never creates a directory or file for an invalid candidate', async () => {
    await expect(
      appendAuditRecord(auditLogDir, validCandidate({ actor: 'attacker' })),
    ).rejects.toThrow(AuditRecordValidationError);
    await expect(readdir(auditLogDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe('redactSecrets — recursive redaction', () => {
  it('redacts a top-level secret-named field', () => {
    const result = redactSecrets({ apiKey: 'fake-secret' }) as Record<string, unknown>;
    expect(result.apiKey).toBe(REDACTED_PLACEHOLDER);
  });

  it('redacts a secret-named field nested arbitrarily deep', () => {
    const result = redactSecrets({
      provider: { auth: { nested: { token: 'fake-token-value' } } },
    }) as Record<string, unknown>;
    const provider = result.provider as Record<string, unknown>;
    const auth = provider.auth as Record<string, unknown>;
    const nested = auth.nested as Record<string, unknown>;
    expect(nested.token).toBe(REDACTED_PLACEHOLDER);
  });

  it('redacts secret-named fields inside array elements', () => {
    const result = redactSecrets({
      list: [{ password: 'fake-password' }, { ok: true }, { nested: { secret: 'fake' } }],
    }) as Record<string, unknown>;
    const list = result.list as Record<string, unknown>[];
    const [first, second, third] = list;
    expect(first?.password).toBe(REDACTED_PLACEHOLDER);
    expect(second?.ok).toBe(true);
    expect((third?.nested as Record<string, unknown> | undefined)?.secret).toBe(
      REDACTED_PLACEHOLDER,
    );
  });

  it('leaves ordinary field names and values untouched', () => {
    const result = redactSecrets({ field: 'assistant.name', count: 3, ok: true, list: [1, 2] });
    expect(result).toEqual({ field: 'assistant.name', count: 3, ok: true, list: [1, 2] });
  });

  it('replaces the entire value under a secret-named key, even an object', () => {
    const result = redactSecrets({ credentials: { user: 'a', pass: 'b' } }) as Record<
      string,
      unknown
    >;
    expect(result.credentials).toBe(REDACTED_PLACEHOLDER);
  });

  it('does not mutate the original input', () => {
    const original = { apiKey: 'fake-secret', nested: { token: 'fake' } };
    redactSecrets(original);
    expect(original.apiKey).toBe('fake-secret');
    expect(original.nested.token).toBe('fake');
  });
});

describe('appendAuditRecord — secrets never reach the file', () => {
  it('writes [REDACTED] in place of a plaintext secret and never the secret itself', async () => {
    const secret = 'super-secret-value-should-never-appear-anywhere';
    await appendAuditRecord(
      auditLogDir,
      validCandidate({ parameters: { field: 'x', apiKey: secret } }),
    );

    const raw = await readFile(logFileFor(TIMESTAMP), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain(REDACTED_PLACEHOLDER);
  });

  it('redacts every canonical secret field name before it reaches the file', async () => {
    const secret = 'fake-secret-marker-xyz';
    await appendAuditRecord(
      auditLogDir,
      validCandidate({
        parameters: {
          apiKey: secret,
          token: secret,
          password: secret,
          authorization: secret,
          credential: secret,
        },
      }),
    );

    const raw = await readFile(logFileFor(TIMESTAMP), 'utf8');
    expect(raw).not.toContain(secret);
  });

  it('redacts a secret nested several levels deep inside parameters before validation', async () => {
    const secret = 'deeply-nested-fake-secret';
    await appendAuditRecord(
      auditLogDir,
      validCandidate({
        parameters: { a: { b: { c: { token: secret } } } },
      }),
    );

    const raw = await readFile(logFileFor(TIMESTAMP), 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain(REDACTED_PLACEHOLDER);
  });
});

// ---------------------------------------------------------------------------
// Invalid records
// ---------------------------------------------------------------------------

describe('appendAuditRecord — rejects invalid records', () => {
  it('rejects a record missing a required field', async () => {
    const { correlationId: _omitted, ...rest } = validCandidate();
    await expect(appendAuditRecord(auditLogDir, rest)).rejects.toThrow(AuditRecordValidationError);
  });

  it('rejects an unknown outcome', async () => {
    await expect(
      appendAuditRecord(auditLogDir, validCandidate({ outcome: 'partial' })),
    ).rejects.toThrow(AuditRecordValidationError);
  });

  it('rejects a contradictory record (deny decision, success outcome)', async () => {
    await expect(
      appendAuditRecord(auditLogDir, validCandidate({ decision: 'deny', outcome: 'success' })),
    ).rejects.toThrow(AuditRecordValidationError);
  });

  it('rejects a free-text error message in place of a stable error code', async () => {
    await expect(
      appendAuditRecord(
        auditLogDir,
        validCandidate({
          outcome: 'failure',
          errorCode: 'Failed to read C:\\Users\\Someone\\secrets.enc',
        }),
      ),
    ).rejects.toThrow(AuditRecordValidationError);
  });

  it('never leaks a raw rejected value through the validation error message', async () => {
    const suspiciousValue = 'sk-should-not-appear-in-any-error-message';
    let caught: unknown;
    try {
      await appendAuditRecord(auditLogDir, validCandidate({ actor: suspiciousValue }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AuditRecordValidationError);
    expect((caught as Error).message).not.toContain(suspiciousValue);
  });

  it('rejects a non-object candidate without throwing an unrelated error', async () => {
    for (const candidate of ['a string', 42, true, null, undefined, ['array']]) {
      await expect(appendAuditRecord(auditLogDir, candidate)).rejects.toThrow(
        AuditRecordValidationError,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Unsafe values and cycles
// ---------------------------------------------------------------------------

describe('appendAuditRecord and redactSecrets — unsafe values', () => {
  it('redactSecrets does not throw or hang on a cyclic parameters object', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(() => redactSecrets({ parameters: cyclic })).not.toThrow();
  });

  it('rejects a record whose parameters contain a cycle', async () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    await expect(
      appendAuditRecord(auditLogDir, validCandidate({ parameters: cyclic })),
    ).rejects.toThrow(AuditRecordValidationError);
  });

  it('rejects a record whose parameters contain a function', async () => {
    await expect(
      appendAuditRecord(auditLogDir, validCandidate({ parameters: { callback: () => undefined } })),
    ).rejects.toThrow(AuditRecordValidationError);
  });

  it('rejects a record whose parameters contain a Date, Map, Set or Error', async () => {
    for (const value of [new Date(0), new Map(), new Set(), new Error('boom')]) {
      await expect(
        appendAuditRecord(auditLogDir, validCandidate({ parameters: { value } })),
      ).rejects.toThrow(AuditRecordValidationError);
    }
  });

  it('rejects a record whose parameters contain a BigInt or symbol', async () => {
    await expect(
      appendAuditRecord(auditLogDir, validCandidate({ parameters: { big: BigInt(1) } })),
    ).rejects.toThrow(AuditRecordValidationError);
    await expect(
      appendAuditRecord(auditLogDir, validCandidate({ parameters: { marker: Symbol('x') } })),
    ).rejects.toThrow(AuditRecordValidationError);
  });

  it('rejects non-finite numbers rather than letting JSON silently turn them into null', async () => {
    for (const ratio of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await expect(
        appendAuditRecord(auditLogDir, validCandidate({ parameters: { ratio } })),
      ).rejects.toThrow(AuditRecordValidationError);
    }
  });

  it('redactSecrets safely handles a candidate nested far beyond the depth budget', () => {
    let node: Record<string, unknown> = { leaf: 1 };
    for (let level = 0; level < 200; level += 1) {
      node = { child: node };
    }
    expect(() => redactSecrets({ parameters: node })).not.toThrow();
  });

  it('rejects a candidate that is itself an Error instance', async () => {
    await expect(appendAuditRecord(auditLogDir, new Error('boom'))).rejects.toThrow(
      AuditRecordValidationError,
    );
  });

  it('rejects a candidate that is itself a Map or Set', async () => {
    await expect(appendAuditRecord(auditLogDir, new Map())).rejects.toThrow(
      AuditRecordValidationError,
    );
    await expect(appendAuditRecord(auditLogDir, new Set())).rejects.toThrow(
      AuditRecordValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Prototype pollution
// ---------------------------------------------------------------------------

describe('appendAuditRecord and redactSecrets — prototype pollution', () => {
  function globalIsClean(): boolean {
    return !('polluted' in Object.prototype);
  }

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it('does not pollute Object.prototype when redacting a raw-JSON __proto__ key', () => {
    expect(globalIsClean()).toBe(true);
    const hostile = JSON.parse('{"__proto__": {"polluted": true}, "field": "x"}') as unknown;
    const result = redactSecrets(hostile) as Record<string, unknown>;
    expect(globalIsClean()).toBe(true);
    expect((Object.create(null) as Record<string, unknown>).polluted).toBeUndefined();
    // The literal key survives as an own property, ready for the schema to reject.
    expect(Object.prototype.hasOwnProperty.call(result, '__proto__')).toBe(true);
  });

  it('rejects a record with a top-level __proto__ key rather than silently dropping it', async () => {
    const hostileJson = JSON.stringify(validCandidate()).replace(
      '{"schemaVersion"',
      '{"__proto__":{"polluted":true},"schemaVersion"',
    );
    const hostile = JSON.parse(hostileJson) as unknown;
    await expect(appendAuditRecord(auditLogDir, hostile)).rejects.toThrow(
      AuditRecordValidationError,
    );
    expect(globalIsClean()).toBe(true);
  });

  it('rejects a __proto__ key nested inside parameters', async () => {
    const hostileParameters = JSON.parse('{"__proto__": {"polluted": true}}') as unknown;
    await expect(
      appendAuditRecord(auditLogDir, validCandidate({ parameters: hostileParameters })),
    ).rejects.toThrow(AuditRecordValidationError);
    expect(globalIsClean()).toBe(true);
  });

  it('rejects constructor and prototype keys inside parameters', async () => {
    await expect(
      appendAuditRecord(auditLogDir, validCandidate({ parameters: { constructor: 'x' } })),
    ).rejects.toThrow(AuditRecordValidationError);
    await expect(
      appendAuditRecord(auditLogDir, validCandidate({ parameters: { prototype: 'x' } })),
    ).rejects.toThrow(AuditRecordValidationError);
  });
});

// ---------------------------------------------------------------------------
// UTC rotation
// ---------------------------------------------------------------------------

describe('appendAuditRecord — UTC daily rotation', () => {
  it('writes records from different UTC days to different files', async () => {
    await appendAuditRecord(auditLogDir, validCandidate({ timestamp: '2026-08-07T23:59:59.999Z' }));
    await appendAuditRecord(auditLogDir, validCandidate({ timestamp: '2026-08-08T00:00:00.000Z' }));

    const entries = (await readdir(auditLogDir)).sort();
    expect(entries).toEqual([
      `${AUDIT_LOG_FILE_PREFIX}2026-08-07${AUDIT_LOG_FILE_EXTENSION}`,
      `${AUDIT_LOG_FILE_PREFIX}2026-08-08${AUDIT_LOG_FILE_EXTENSION}`,
    ]);

    const day1 = await readLines(logFileFor('2026-08-07T23:59:59.999Z'));
    const day2 = await readLines(logFileFor('2026-08-08T00:00:00.000Z'));
    expect(day1).toHaveLength(1);
    expect(day2).toHaveLength(1);
  });

  it('appends multiple records from the same UTC day to one file', async () => {
    await appendAuditRecord(auditLogDir, validCandidate({ timestamp: '2026-08-07T01:00:00.000Z' }));
    await appendAuditRecord(auditLogDir, validCandidate({ timestamp: '2026-08-07T12:00:00.000Z' }));
    await appendAuditRecord(auditLogDir, validCandidate({ timestamp: '2026-08-07T23:00:00.000Z' }));

    const entries = await readdir(auditLogDir);
    expect(entries).toHaveLength(1);
    const lines = await readLines(logFileFor('2026-08-07T00:00:00.000Z'));
    expect(lines).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// JSONL integrity
// ---------------------------------------------------------------------------

describe('appendAuditRecord — JSONL integrity', () => {
  it('produces exactly one parseable JSON object per line, with no pretty-printing', async () => {
    await appendAuditRecord(auditLogDir, validCandidate({ eventId: EVENT_ID }));
    await appendAuditRecord(
      auditLogDir,
      validCandidate({
        eventId: '4c9e6679-7425-40de-944b-e07fc1f90ae7',
        parameters: { nested: { a: [1, 2, 3] } },
      }),
    );

    const raw = await readFile(logFileFor(TIMESTAMP), 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    const lines = raw.split('\n').filter((line) => line.length > 0);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
      const parsed = JSON.parse(line) as unknown;
      expect(typeof parsed).toBe('object');
    }
  });

  it('never silently overwrites or truncates an existing log file', async () => {
    await appendAuditRecord(auditLogDir, validCandidate({ eventId: EVENT_ID }));
    await appendAuditRecord(
      auditLogDir,
      validCandidate({ eventId: '4c9e6679-7425-40de-944b-e07fc1f90ae7' }),
    );

    const lines = await readLines(logFileFor(TIMESTAMP));
    expect(lines).toHaveLength(2);
    const [firstLine] = lines;
    if (firstLine === undefined) {
      throw new Error('expected at least one line');
    }
    const firstParsed = JSON.parse(firstLine) as { eventId: string };
    expect(firstParsed.eventId).toBe(EVENT_ID);
  });
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('appendAuditRecord — concurrent writes', () => {
  it('never produces a corrupted or interleaved line when many writes race', async () => {
    const count = 25;
    const writes = Array.from({ length: count }, (_, index) =>
      appendAuditRecord(
        auditLogDir,
        validCandidate({
          eventId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
          decisionReason: `Agent${String(index)}`,
        }),
      ),
    );
    await Promise.all(writes);

    const lines = await readLines(logFileFor(TIMESTAMP));
    expect(lines).toHaveLength(count);

    const eventIds = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as { eventId: string };
      eventIds.add(parsed.eventId);
    }
    expect(eventIds.size).toBe(count);
  });
});

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

describe('appendAuditRecord — failure handling', () => {
  it('wraps a filesystem failure in AuditWriteError without leaking the raw path', async () => {
    // Force the append target to collide with a directory instead of a file.
    await mkdir(logFileFor(TIMESTAMP), { recursive: true });

    let caught: unknown;
    try {
      await appendAuditRecord(auditLogDir, validCandidate());
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AuditWriteError);
    const error = caught as Error;
    expect(error.message).toBe('failed to append audit record');
    expect(error.message).not.toContain(dir);
    expect(error.message).not.toContain(auditLogDir);
  });

  it('leaves a previously written, different day file untouched after another day fails', async () => {
    const otherDayTimestamp = '2026-08-09T00:00:00.000Z';
    await appendAuditRecord(auditLogDir, validCandidate({ timestamp: otherDayTimestamp }));

    // Now break the *original* day's target file for a later write.
    await mkdir(logFileFor(TIMESTAMP), { recursive: true });
    await expect(appendAuditRecord(auditLogDir, validCandidate())).rejects.toThrow(AuditWriteError);

    const untouchedLine = await readOneLine(logFileFor(otherDayTimestamp));
    const parsed = JSON.parse(untouchedLine) as { timestamp: string };
    expect(parsed.timestamp).toBe(otherDayTimestamp);
  });
});
