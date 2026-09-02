import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  engageEmergencyStop,
  loadEmergencyState,
  resetEmergencyStop,
  writeEmergencyState,
} from '../../../src/main/emergency';
import { REASON_EMERGENCY_ENGAGED_BY_USER } from '../../../src/shared/constants';
import {
  createFailSafeEmergencyState,
  createInitialEmergencyState,
} from '../../../src/shared/schemas';
import type { EmergencyState } from '../../../src/shared/schemas';

const NOW = '2026-08-07T00:00:00.000Z';

let dir: string;
let stateFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-emergency-'));
  stateFile = join(dir, 'emergency.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const validEngaged = (): EmergencyState => ({
  schemaVersion: 1,
  engaged: true,
  engagedAt: NOW,
  reason: 'test-engaged',
});

describe('loadEmergencyState — missing file', () => {
  it('resolves disengaged when emergency.json does not exist, not engaged', async () => {
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result).toEqual(createInitialEmergencyState());
    expect(result.engaged).toBe(false);
  });

  it('never creates a file merely by reading', async () => {
    await loadEmergencyState(stateFile, NOW);
    await expect(readFile(stateFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never creates the parent directory merely by reading', async () => {
    const nested = join(dir, 'does', 'not', 'exist', 'emergency.json');
    await loadEmergencyState(nested, NOW);
    await expect(readdir(join(dir, 'does'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not treat a missing file as corruption', async () => {
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result.reason).not.toBe('emergency-state-file-invalid');
  });
});

describe('loadEmergencyState — unreadable existing state', () => {
  it('fails safe to engaged when the state path is a directory rather than a file', async () => {
    await mkdir(stateFile, { recursive: true });
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result.engaged).toBe(true);
    expect(result).toEqual(createFailSafeEmergencyState(NOW));
  });

  it('fails safe to engaged for malformed JSON', async () => {
    for (const content of ['{', 'not json', '', '{"engaged": true,}', '[1,2,3]']) {
      await writeFile(stateFile, content, 'utf8');
      const result = await loadEmergencyState(stateFile, NOW);
      expect(result.engaged, `expected engaged for: ${JSON.stringify(content)}`).toBe(true);
      expect(result).toEqual(createFailSafeEmergencyState(NOW));
    }
  });

  it('never exposes the raw filesystem path or parse error in the reason', async () => {
    await writeFile(stateFile, '{not json', 'utf8');
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result.reason).not.toContain(dir);
    expect(result.reason).not.toContain('{');
    expect(result.reason).not.toContain('Unexpected');
  });
});

describe('loadEmergencyState — invalid schema data fails safe to engaged', () => {
  it('rejects an unknown top-level key', async () => {
    await writeFile(stateFile, JSON.stringify({ ...validEngaged(), extra: 'field' }), 'utf8');
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result).toEqual(createFailSafeEmergencyState(NOW));
  });

  it('rejects engaged=true with a null engagedAt', async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ schemaVersion: 1, engaged: true, engagedAt: null, reason: '' }),
      'utf8',
    );
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result.engaged).toBe(true);
  });

  it('rejects engaged=false with a non-null engagedAt', async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ schemaVersion: 1, engaged: false, engagedAt: NOW, reason: '' }),
      'utf8',
    );
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result.engaged).toBe(true);
  });

  it('rejects a timestamp carrying a UTC offset', async () => {
    await writeFile(
      stateFile,
      JSON.stringify({
        schemaVersion: 1,
        engaged: true,
        engagedAt: '2026-08-07T02:00:00+02:00',
        reason: 'x',
      }),
      'utf8',
    );
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result).toEqual(createFailSafeEmergencyState(NOW));
  });

  it('rejects an unrecognised schemaVersion', async () => {
    await writeFile(stateFile, JSON.stringify({ ...validEngaged(), schemaVersion: 2 }), 'utf8');
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result).toEqual(createFailSafeEmergencyState(NOW));
  });

  it('rejects a reason exceeding the length limit', async () => {
    await writeFile(
      stateFile,
      JSON.stringify({ ...validEngaged(), reason: 'x'.repeat(201) }),
      'utf8',
    );
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result).toEqual(createFailSafeEmergencyState(NOW));
  });
});

describe('loadEmergencyState — prototype pollution', () => {
  function globalIsClean(): boolean {
    return !('polluted' in Object.prototype);
  }

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it('fails safe for a top-level __proto__ key and does not pollute Object.prototype', async () => {
    const hostileJson = JSON.stringify(validEngaged()).replace(
      '{"schemaVersion"',
      '{"__proto__":{"polluted":true},"schemaVersion"',
    );
    await writeFile(stateFile, hostileJson, 'utf8');
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result).toEqual(createFailSafeEmergencyState(NOW));
    expect(globalIsClean()).toBe(true);
  });

  it('fails safe for constructor and prototype keys', async () => {
    for (const key of ['constructor', 'prototype']) {
      const hostileJson = JSON.stringify(validEngaged()).replace(
        '{"schemaVersion"',
        `{"${key}":"x","schemaVersion"`,
      );
      await writeFile(stateFile, hostileJson, 'utf8');
      const result = await loadEmergencyState(stateFile, NOW);
      expect(result).toEqual(createFailSafeEmergencyState(NOW));
    }
    expect(globalIsClean()).toBe(true);
  });
});

describe('loadEmergencyState — valid state round-trips', () => {
  it('loads a valid engaged state exactly as written', async () => {
    const engaged = validEngaged();
    await writeFile(stateFile, JSON.stringify(engaged), 'utf8');
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result).toEqual(engaged);
  });

  it('loads a valid disengaged state exactly as written', async () => {
    const disengaged = createInitialEmergencyState();
    await writeFile(stateFile, JSON.stringify(disengaged), 'utf8');
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result).toEqual(disengaged);
  });

  it('returns a fresh object each call, not a shared mutable reference', async () => {
    await writeFile(stateFile, JSON.stringify(validEngaged()), 'utf8');
    const first = await loadEmergencyState(stateFile, NOW);
    const second = await loadEmergencyState(stateFile, NOW);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
  });
});

describe('writeEmergencyState — atomic writes', () => {
  it('round-trips a valid engaged state', async () => {
    await writeEmergencyState(stateFile, validEngaged());
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result).toEqual(validEngaged());
  });

  it('round-trips a valid disengaged state', async () => {
    await writeEmergencyState(stateFile, createInitialEmergencyState());
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result).toEqual(createInitialEmergencyState());
  });

  it('creates the parent directory when missing', async () => {
    const nested = join(dir, 'state', 'emergency.json');
    await writeEmergencyState(nested, validEngaged());
    const result = await loadEmergencyState(nested, NOW);
    expect(result).toEqual(validEngaged());
  });

  it('leaves no leftover temporary file after a successful write', async () => {
    await writeEmergencyState(stateFile, validEngaged());
    const entries = await readdir(dir);
    expect(entries).toEqual(['emergency.json']);
  });

  it('writes indented, multi-line JSON, not a single unreadable line', async () => {
    await writeEmergencyState(stateFile, validEngaged());
    const raw = await readFile(stateFile, 'utf8');
    expect(raw).toContain('\n');
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
  });

  it('rejects writing a document that fails schema validation, even if typed as EmergencyState', async () => {
    const invalid = { ...validEngaged(), engagedAt: null } as unknown as EmergencyState;
    await expect(writeEmergencyState(stateFile, invalid)).rejects.toBeDefined();
  });

  it('never truncates an existing valid file when the new write fails', async () => {
    await writeEmergencyState(stateFile, validEngaged());

    const asDirectory = join(dir, 'blocked.json');
    await mkdir(asDirectory);
    await expect(
      writeEmergencyState(asDirectory, createInitialEmergencyState()),
    ).rejects.toBeDefined();

    // The unrelated, already-written file is unaffected by a failed write to
    // a different target.
    const result = await loadEmergencyState(stateFile, NOW);
    expect(result).toEqual(validEngaged());
  });

  it('cleans up its temporary file when the final rename fails', async () => {
    const asDirectory = join(dir, 'emergency.json');
    await mkdir(asDirectory);

    await expect(writeEmergencyState(asDirectory, validEngaged())).rejects.toBeDefined();

    const entries = await readdir(dir);
    const leftoverTempFiles = entries.filter((name) => name.includes('.tmp'));
    expect(leftoverTempFiles).toEqual([]);
  });
});

describe('writeEmergencyState — concurrency', () => {
  it('never leaves a partially written file when two writes race', async () => {
    const engaged = validEngaged();
    const disengaged = createInitialEmergencyState();

    await Promise.all([
      writeEmergencyState(stateFile, engaged),
      writeEmergencyState(stateFile, disengaged),
    ]);

    const raw = await readFile(stateFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    expect([engaged, disengaged]).toContainEqual(parsed);
  });

  it('leaves no orphaned temporary file after many concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeEmergencyState(stateFile, {
          ...validEngaged(),
          reason: `reason-${String(index)}`,
        }),
      ),
    );
    const entries = await readdir(dir);
    expect(entries).toEqual(['emergency.json']);
  });
});

describe('engageEmergencyStop', () => {
  it('persists an engaged state with a valid UTC timestamp and the fixed reason', async () => {
    const result = await engageEmergencyStop(stateFile, NOW);
    expect(result.engaged).toBe(true);
    expect(result.engagedAt).toBe(NOW);
    expect(result.reason).toBe(REASON_EMERGENCY_ENGAGED_BY_USER);
  });

  it('is visible after a simulated restart (loading from disk again)', async () => {
    await engageEmergencyStop(stateFile, NOW);
    const reloaded = await loadEmergencyState(stateFile, '2026-08-08T00:00:00.000Z');
    expect(reloaded.engaged).toBe(true);
    expect(reloaded.engagedAt).toBe(NOW);
    expect(reloaded.reason).toBe(REASON_EMERGENCY_ENGAGED_BY_USER);
  });

  it('is safe when the state directory does not yet exist', async () => {
    const nested = join(dir, 'state', 'emergency.json');
    const result = await engageEmergencyStop(nested, NOW);
    expect(result.engaged).toBe(true);
  });
});

describe('resetEmergencyStop', () => {
  it('persists a disengaged state', async () => {
    await engageEmergencyStop(stateFile, NOW);
    const result = await resetEmergencyStop(stateFile);
    expect(result).toEqual(createInitialEmergencyState());
  });

  it('is visible after a simulated restart (loading from disk again)', async () => {
    await engageEmergencyStop(stateFile, NOW);
    await resetEmergencyStop(stateFile);
    const reloaded = await loadEmergencyState(stateFile, NOW);
    expect(reloaded.engaged).toBe(false);
  });
});
