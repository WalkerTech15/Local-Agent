import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { containsForbiddenKey, loadSettings, writeSettings } from '../../../src/main/settings';
import { createDefaultSettings } from '../../../src/shared/schemas/settings.schema';
import type { Settings } from '../../../src/shared/schemas/settings.schema';

const NOW = '2026-08-07T00:00:00.000Z';

/**
 * A real, isolated temporary directory per test — never the developer's
 * `%APPDATA%`. Created under the OS temp root and removed afterwards.
 */
let dir: string;
let settingsFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-settings-'));
  settingsFile = join(dir, 'settings.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const validSettings = (): Settings => ({
  ...createDefaultSettings(NOW),
  onboardingCompleted: true,
  assistant: { name: 'JARVIS' },
  user: { displayName: 'Alex Martin' },
  modelProvider: {
    provider: 'ollama',
    model: 'llama3.1',
    baseUrl: 'http://localhost:11434',
    hasApiKey: false,
  },
});

describe('loadSettings — missing file', () => {
  it('returns fresh defaults when settings.json does not exist', async () => {
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
  });

  it('never creates a file merely by reading', async () => {
    await loadSettings(settingsFile, NOW);
    await expect(readFile(settingsFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never creates the parent directory merely by reading', async () => {
    const nested = join(dir, 'does', 'not', 'exist', 'settings.json');
    await loadSettings(nested, NOW);
    await expect(readdir(join(dir, 'does'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails safe when the settings path is unreadable for a reason other than absence', async () => {
    // A directory where a file is expected is a real, reproducible way to
    // provoke a non-ENOENT read failure without mocking fs.
    const asDirectory = join(dir, 'settings.json');
    await mkdir(asDirectory);
    const result = await loadSettings(asDirectory, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
  });
});

describe('loadSettings — malformed JSON', () => {
  it('returns defaults for every form of unparsable or unexpected content', async () => {
    const cases: readonly [label: string, contents: string][] = [
      ['truncated object', '{"schemaVersion": 1,'],
      ['not JSON at all', 'not json at all'],
      ['trailing garbage', '{}garbage'],
      ['empty file', ''],
      ['a bare JSON scalar', '"just a string"'],
      ['a JSON array instead of an object', '[1,2,3]'],
    ];
    for (const [label, contents] of cases) {
      await writeFile(settingsFile, contents, 'utf8');
      const result = await loadSettings(settingsFile, NOW);
      expect(result, `expected "${label}" to fall back to defaults`).toEqual(
        createDefaultSettings(NOW),
      );
    }
  });
});

describe('loadSettings — invalid but well-formed JSON', () => {
  it('rejects an unknown top-level field', async () => {
    const document = { ...validSettings(), extraField: 'unexpected' };
    await writeFile(settingsFile, JSON.stringify(document), 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
  });

  it('rejects an unknown nested field', async () => {
    const document = {
      ...validSettings(),
      modelProvider: { ...validSettings().modelProvider, apiKey: 'sk-should-be-rejected' },
    };
    await writeFile(settingsFile, JSON.stringify(document), 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
  });

  it('rejects an unapproved model provider', async () => {
    const document = {
      ...validSettings(),
      modelProvider: { provider: 'anthropic', model: '', baseUrl: '', hasApiKey: false },
    };
    await writeFile(settingsFile, JSON.stringify(document), 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
  });

  it('rejects a baseUrl using a non-http scheme', async () => {
    const document = {
      ...validSettings(),
      modelProvider: {
        provider: 'openai-compatible',
        model: 'gpt-oss',
        baseUrl: 'file:///C:/Windows/System32',
        hasApiKey: false,
      },
    };
    await writeFile(settingsFile, JSON.stringify(document), 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
  });

  it('rejects a baseUrl carrying embedded credentials', async () => {
    const document = {
      ...validSettings(),
      modelProvider: {
        provider: 'ollama',
        model: 'llama3.1',
        baseUrl: 'https://user:password@example.com/v1',
        hasApiKey: false,
      },
    };
    await writeFile(settingsFile, JSON.stringify(document), 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
    // Rejected wholesale, not silently stripped down to a "cleaned" URL.
    expect(JSON.stringify(result)).not.toContain('password');
  });

  it('rejects a timestamp carrying a UTC offset', async () => {
    const document = { ...validSettings(), updatedAt: '2026-08-07T00:00:00+02:00' };
    await writeFile(settingsFile, JSON.stringify(document), 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
  });

  it('rejects a non-ISO timestamp', async () => {
    const document = { ...validSettings(), updatedAt: '07/08/2026' };
    await writeFile(settingsFile, JSON.stringify(document), 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
  });

  it('rejects an out-of-range schemaVersion', async () => {
    const document = { ...validSettings(), schemaVersion: 999 };
    await writeFile(settingsFile, JSON.stringify(document), 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
  });

  it('rejects telemetry switched on', async () => {
    const document = { ...validSettings(), telemetry: { enabled: true } };
    await writeFile(settingsFile, JSON.stringify(document), 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
  });
});

describe('loadSettings — credentials can never enter settings', () => {
  it('rejects a document carrying a plaintext API key under any recognised name', async () => {
    for (const secretKey of ['apiKey', 'token', 'password', 'secret', 'authorization']) {
      const document = {
        ...validSettings(),
        modelProvider: { ...validSettings().modelProvider, [secretKey]: 'sk-leaked-value' },
      };
      await writeFile(settingsFile, JSON.stringify(document), 'utf8');
      const result = await loadSettings(settingsFile, NOW);
      expect(result, `expected ${secretKey} to be rejected`).toEqual(createDefaultSettings(NOW));
    }
  });

  it('round-trips hasApiKey as boolean metadata only, never a key value', async () => {
    const document: Settings = {
      ...validSettings(),
      modelProvider: { provider: 'glm', model: 'glm-4', baseUrl: '', hasApiKey: true },
    };
    await writeSettings(settingsFile, document);
    const result = await loadSettings(settingsFile, NOW);
    expect(result.modelProvider.hasApiKey).toBe(true);
    expect(typeof result.modelProvider.hasApiKey).toBe('boolean');
    expect(JSON.stringify(result)).not.toMatch(/sk-|glm_[a-z0-9]/i);
  });
});

describe('loadSettings — prototype pollution', () => {
  const globalIsClean = (): void => {
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  };

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it('rejects a top-level __proto__ key and pollutes nothing', async () => {
    const raw = '{"__proto__":{"polluted":"yes"},' + JSON.stringify(validSettings()).slice(1);
    await writeFile(settingsFile, raw, 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
    globalIsClean();
  });

  it('rejects a nested __proto__ key and pollutes nothing', async () => {
    // Built as raw JSON text, not via an object literal: `{ __proto__: x }`
    // in source code sets a prototype rather than creating an own property,
    // which is not what a hand-edited settings.json on disk would contain.
    // This constructs the exact byte sequence a hostile or corrupted file
    // would have: a literal `"__proto__"` key nested inside modelProvider.
    const raw = JSON.stringify(validSettings()).replace(
      '"provider":"ollama"',
      '"__proto__":{"polluted":"yes"},"provider":"ollama"',
    );
    await writeFile(settingsFile, raw, 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
    globalIsClean();
  });

  it('rejects a document carrying a constructor key', async () => {
    const raw = JSON.stringify(validSettings()).replace('{', '{"constructor":{"polluted":"yes"},');
    await writeFile(settingsFile, raw, 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
    globalIsClean();
  });

  it('rejects a document carrying a prototype key', async () => {
    const raw = JSON.stringify(validSettings()).replace('{', '{"prototype":{"polluted":"yes"},');
    await writeFile(settingsFile, raw, 'utf8');
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(createDefaultSettings(NOW));
    globalIsClean();
  });

  it('containsForbiddenKey finds __proto__/constructor/prototype at any depth', () => {
    expect(containsForbiddenKey(JSON.parse('{"__proto__":{"x":1}}'))).toBe(true);
    expect(containsForbiddenKey(JSON.parse('{"a":{"b":{"constructor":1}}}'))).toBe(true);
    expect(containsForbiddenKey(JSON.parse('{"a":[{"prototype":1}]}'))).toBe(true);
    expect(containsForbiddenKey(JSON.parse('{"a":[1,2,{"b":3}]}'))).toBe(false);
    expect(containsForbiddenKey(JSON.parse('{"safe":"__proto__ as a value, not a key"}'))).toBe(
      false,
    );
    expect(containsForbiddenKey(null)).toBe(false);
    expect(containsForbiddenKey('a string')).toBe(false);
    expect(containsForbiddenKey(42)).toBe(false);
  });

  it('containsForbiddenKey rejects pathologically deep input rather than overflowing the stack', () => {
    let value: unknown = { leaf: true };
    for (let i = 0; i < 200; i += 1) {
      value = { nested: value };
    }
    expect(() => containsForbiddenKey(value)).not.toThrow();
    expect(containsForbiddenKey(value)).toBe(true);
  });
});

describe('writeSettings — atomic round trip', () => {
  it('writes and reads back an identical document', async () => {
    const document = validSettings();
    await writeSettings(settingsFile, document);
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(document);
  });

  it('creates the parent directory when it does not exist', async () => {
    const nested = join(dir, 'nested', 'deeper', 'settings.json');
    await writeSettings(nested, validSettings());
    const result = await loadSettings(nested, NOW);
    expect(result).toEqual(validSettings());
  });

  it('overwrites a previous document in full', async () => {
    await writeSettings(settingsFile, createDefaultSettings(NOW));
    await writeSettings(settingsFile, validSettings());
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(validSettings());
  });

  it('leaves no temporary file behind after a successful write', async () => {
    await writeSettings(settingsFile, validSettings());
    const entries = await readdir(dir);
    expect(entries).toEqual(['settings.json']);
  });

  it('rejects writing a document that fails schema validation, even if typed as Settings', async () => {
    const invalid = { ...validSettings(), schemaVersion: 999 } as unknown as Settings;
    await expect(writeSettings(settingsFile, invalid)).rejects.toBeDefined();
  });

  it('writes a document that is valid, indented JSON, not a single unreadable line', async () => {
    await writeSettings(settingsFile, validSettings());
    const raw = await readFile(settingsFile, 'utf8');
    expect(raw).toContain('\n');
    expect(() => JSON.parse(raw) as unknown).not.toThrow();
  });
});

describe('writeSettings — atomicity under concurrency and failure', () => {
  it('never leaves a partially written file when two writes race', async () => {
    const a: Settings = { ...validSettings(), assistant: { name: 'AlphaAssistant' } };
    const b: Settings = { ...validSettings(), assistant: { name: 'BetaAssistant' } };

    await Promise.all([writeSettings(settingsFile, a), writeSettings(settingsFile, b)]);

    // Whichever write landed last, the file on disk must be exactly one of
    // the two complete, valid documents — never a truncated or interleaved
    // mixture of both. Both concurrent writers use their own uniquely named
    // temporary file, so only a single atomic rename ever touches the
    // shared target path.
    const raw = await readFile(settingsFile, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    expect([a, b]).toContainEqual(parsed);
  });

  it('leaves no orphaned temporary file after many concurrent writes', async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        writeSettings(settingsFile, {
          ...validSettings(),
          assistant: { name: `Agent${String(index)}` },
        }),
      ),
    );
    const entries = await readdir(dir);
    expect(entries).toEqual(['settings.json']);
  });

  it('cleans up its temporary file when the final rename fails', async () => {
    // Point settingsFile at a path that is actually a directory, so the
    // rename step fails with a real filesystem error (EISDIR/EPERM/EEXIST
    // depending on platform) rather than a mocked one.
    const asDirectory = join(dir, 'settings.json');
    await mkdir(asDirectory);

    await expect(writeSettings(asDirectory, validSettings())).rejects.toBeDefined();

    const entries = await readdir(dir);
    const leftoverTempFiles = entries.filter((name) => name.includes('.tmp'));
    expect(leftoverTempFiles).toEqual([]);
  });

  it('leaves the previous valid document untouched when a write fails', async () => {
    await writeSettings(settingsFile, validSettings());

    const asDirectory = join(dir, 'blocked.json');
    await mkdir(asDirectory);
    await expect(writeSettings(asDirectory, createDefaultSettings(NOW))).rejects.toBeDefined();

    // The unrelated, already-written file is unaffected by the failed write
    // to a different target.
    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(validSettings());
  });

  it('a stray abandoned temp file (simulating an interrupted write) is ignored by loadSettings', async () => {
    await writeSettings(settingsFile, validSettings());

    // Simulates a crash between "temp file written" and "renamed into
    // place": an orphaned temp file sits next to a complete, untouched real
    // file. loadSettings must only ever read the exact target path.
    await writeFile(join(dir, 'settings.json.orphan.tmp'), '{not even valid json', 'utf8');

    const result = await loadSettings(settingsFile, NOW);
    expect(result).toEqual(validSettings());
  });
});
