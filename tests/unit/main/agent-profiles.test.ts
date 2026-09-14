import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  createAgentProfile,
  deleteAgentProfile,
  loadAgentProfileStore,
  readAgentRegistry,
  selectAgentProfile,
  setAgentProfileEnabled,
  updateAgentProfile,
  writeAgentProfileStore,
} from '../../../src/main/agent-profiles';
import { AgentError } from '../../../src/shared/agent';
import {
  BUILT_IN_AGENT_PROFILE_IDS,
  createDefaultAgentProfileStore,
  DEFAULT_AGENT_PROFILE_ID,
  findAgentProfile,
} from '../../../src/shared/agent';
import {
  AGENT_PROFILE_SCHEMA_VERSION,
  AGENT_PROFILE_STORE_MAX_BYTES,
} from '../../../src/shared/constants';
import type { AgentProfileInput } from '../../../src/shared/schemas';

/**
 * Agent profile storage against a real filesystem (Phase 2, Milestone 7).
 *
 * The loader's contract is the same one `main/settings.ts` and
 * `main/policy.ts` already have — fail safe, never merge, never create — and
 * the cases below check it the same way, plus the two rules specific to this
 * store: built-ins are never persisted, and deleting or disabling the active
 * profile falls back to the most restricted built-in rather than to nothing.
 */

const NOW = '2026-09-14T00:00:00.000Z';
const LATER = '2026-09-14T01:00:00.000Z';

let dir: string;
let storeFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-profiles-'));
  storeFile = join(dir, 'agents', 'profiles.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function input(overrides: Partial<AgentProfileInput> = {}): AgentProfileInput {
  return {
    id: 'custom',
    name: 'Custom',
    description: 'A custom profile.',
    instructions: '',
    provider: 'none',
    fallbackProviders: [],
    allowedTools: ['workspace.inspect'],
    approvedWorkspacePaths: ['src'],
    permissionPolicy: [],
    verification: [],
    limits: { maxSteps: 4, maxDurationMs: 30_000, maxOutputBytes: 10_000 },
    enabled: true,
    ...overrides,
  };
}

async function writeRaw(contents: string): Promise<void> {
  await mkdir(dirname(storeFile), { recursive: true });
  await writeFile(storeFile, contents, 'utf8');
}

describe('loading, and failing safe', () => {
  it('returns the default store when the file does not exist, and creates nothing', async () => {
    await expect(loadAgentProfileStore(storeFile)).resolves.toEqual(
      createDefaultAgentProfileStore(),
    );
    await expect(readFile(storeFile, 'utf8')).rejects.toThrow();
  });

  it('returns the default store for malformed JSON', async () => {
    await writeRaw('{ not json');
    await expect(loadAgentProfileStore(storeFile)).resolves.toEqual(
      createDefaultAgentProfileStore(),
    );
  });

  it('returns the default store for a document the schema rejects', async () => {
    await writeRaw(JSON.stringify({ schemaVersion: 99, activeProfileId: 'x', profiles: [] }));
    await expect(loadAgentProfileStore(storeFile)).resolves.toEqual(
      createDefaultAgentProfileStore(),
    );
  });

  it('refuses a document carrying a prototype-polluting key anywhere in it', async () => {
    await writeRaw(
      JSON.stringify({
        schemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
        activeProfileId: DEFAULT_AGENT_PROFILE_ID,
        profiles: [],
        ['__proto__']: { polluted: true },
      }),
    );
    await expect(loadAgentProfileStore(storeFile)).resolves.toEqual(
      createDefaultAgentProfileStore(),
    );
  });

  it('refuses a file larger than the store cap without reading it', async () => {
    await writeRaw('x'.repeat(AGENT_PROFILE_STORE_MAX_BYTES + 1));
    await expect(loadAgentProfileStore(storeFile)).resolves.toEqual(
      createDefaultAgentProfileStore(),
    );
  });

  it('discards the whole document rather than the one bad profile in it', async () => {
    await writeAgentProfileStore(storeFile, {
      schemaVersion: AGENT_PROFILE_SCHEMA_VERSION,
      activeProfileId: DEFAULT_AGENT_PROFILE_ID,
      profiles: [],
    });
    await createAgentProfile(storeFile, input({ id: 'good' }), NOW);

    const document = JSON.parse(await readFile(storeFile, 'utf8')) as Record<string, unknown>;
    const profiles = document.profiles as Record<string, unknown>[];
    profiles.push({ ...profiles[0], id: 'bad', allowedTools: ['workspace.write'] });
    await writeRaw(JSON.stringify(document));

    // There is no partial-trust path: the good profile is discarded with the
    // bad one rather than being kept.
    const loaded = await loadAgentProfileStore(storeFile);
    expect(loaded.profiles).toEqual([]);
  });

  it('refuses a hand-edited file that tries to redefine a built-in', async () => {
    await createAgentProfile(storeFile, input({ id: 'seed' }), NOW);
    const document = JSON.parse(await readFile(storeFile, 'utf8')) as Record<string, unknown>;
    const profiles = document.profiles as Record<string, unknown>[];
    profiles[0] = {
      ...profiles[0],
      id: DEFAULT_AGENT_PROFILE_ID,
      allowedTools: ['command.test'],
      approvedWorkspacePaths: [''],
      verification: [],
      builtIn: true,
    };
    await writeRaw(JSON.stringify(document));

    // The claim to be built in fails validation, so the whole file is
    // discarded and the real built-in is what the registry answers with.
    const registry = await readAgentRegistry(storeFile);
    const reviewer = findAgentProfile(registry.profiles, DEFAULT_AGENT_PROFILE_ID);
    expect(reviewer?.builtIn).toBe(true);
    expect(reviewer?.allowedTools).not.toContain('command.test');
  });
});

describe('writing', () => {
  it('creates the directory and writes a document that loads back identically', async () => {
    const store = createDefaultAgentProfileStore();
    await writeAgentProfileStore(storeFile, store);
    await expect(loadAgentProfileStore(storeFile)).resolves.toEqual(store);
  });

  it('never persists a built-in profile', async () => {
    await createAgentProfile(storeFile, input(), NOW);
    const document = JSON.parse(await readFile(storeFile, 'utf8')) as {
      profiles: { id: string }[];
    };
    for (const profile of document.profiles) {
      expect(BUILT_IN_AGENT_PROFILE_IDS).not.toContain(profile.id);
    }
    expect(document.profiles).toHaveLength(1);
  });

  it('leaves no temporary file behind', async () => {
    await createAgentProfile(storeFile, input(), NOW);
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(dirname(storeFile));
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });
});

describe('create, read, update, delete', () => {
  it('merges built-ins ahead of user profiles', async () => {
    await createAgentProfile(storeFile, input(), NOW);
    const registry = await readAgentRegistry(storeFile);
    expect(registry.profiles.slice(0, BUILT_IN_AGENT_PROFILE_IDS.length).map((p) => p.id)).toEqual([
      ...BUILT_IN_AGENT_PROFILE_IDS,
    ]);
    expect(findAgentProfile(registry.profiles, 'custom')?.builtIn).toBe(false);
  });

  it('supplies builtIn and the timestamps itself', async () => {
    const registry = await createAgentProfile(storeFile, input(), NOW);
    const created = findAgentProfile(registry.profiles, 'custom');
    expect(created?.builtIn).toBe(false);
    expect(created?.createdAt).toBe(NOW);
    expect(created?.updatedAt).toBe(NOW);
  });

  it('refuses an identifier already taken by a built-in', async () => {
    await expect(
      createAgentProfile(storeFile, input({ id: DEFAULT_AGENT_PROFILE_ID }), NOW),
    ).rejects.toMatchObject({ code: 'AGENT_PROFILE_EXISTS' });
  });

  it('refuses a duplicate user identifier', async () => {
    await createAgentProfile(storeFile, input(), NOW);
    await expect(createAgentProfile(storeFile, input(), NOW)).rejects.toMatchObject({
      code: 'AGENT_PROFILE_EXISTS',
    });
  });

  it('preserves every other profile when one is updated', async () => {
    await createAgentProfile(storeFile, input({ id: 'first' }), NOW);
    await createAgentProfile(storeFile, input({ id: 'second' }), NOW);

    const registry = await updateAgentProfile(
      storeFile,
      'first',
      input({ id: 'first', name: 'Renamed' }),
      LATER,
    );

    expect(findAgentProfile(registry.profiles, 'first')?.name).toBe('Renamed');
    expect(findAgentProfile(registry.profiles, 'second')?.name).toBe('Custom');
  });

  it('carries createdAt over rather than taking it from the request', async () => {
    await createAgentProfile(storeFile, input(), NOW);
    const registry = await updateAgentProfile(storeFile, 'custom', input({ name: 'Two' }), LATER);
    const updated = findAgentProfile(registry.profiles, 'custom');
    expect(updated?.createdAt).toBe(NOW);
    expect(updated?.updatedAt).toBe(LATER);
  });

  it('refuses an update whose submitted id does not match the addressed one', async () => {
    await createAgentProfile(storeFile, input(), NOW);
    await expect(
      updateAgentProfile(storeFile, 'custom', input({ id: 'somewhere-else' }), LATER),
    ).rejects.toMatchObject({ code: 'AGENT_PROFILE_INVALID' });
  });

  it('refuses to edit, disable or delete a built-in', async () => {
    for (const attempt of [
      () => updateAgentProfile(storeFile, DEFAULT_AGENT_PROFILE_ID, input(), NOW),
      () => deleteAgentProfile(storeFile, DEFAULT_AGENT_PROFILE_ID),
      () => setAgentProfileEnabled(storeFile, DEFAULT_AGENT_PROFILE_ID, false, NOW),
    ]) {
      await expect(attempt()).rejects.toMatchObject({ code: 'AGENT_PROFILE_READ_ONLY' });
    }
  });

  it('refuses to touch a profile that does not exist', async () => {
    await expect(deleteAgentProfile(storeFile, 'never-existed')).rejects.toMatchObject({
      code: 'AGENT_PROFILE_NOT_FOUND',
    });
  });

  it('throws an AgentError, never a raw filesystem error, when the store cannot be written', async () => {
    // A directory where the file should be: the rename cannot succeed.
    await mkdir(storeFile, { recursive: true });
    const error = await createAgentProfile(storeFile, input(), NOW).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('AGENT_PROFILE_STORE_FAILED');
    expect((error as AgentError).message).not.toContain(dir);
  });
});

describe('selection and safe fallback', () => {
  it('selects an existing enabled profile', async () => {
    await createAgentProfile(storeFile, input(), NOW);
    const registry = await selectAgentProfile(storeFile, 'custom');
    expect(registry.activeProfileId).toBe('custom');
  });

  it('refuses to select something that does not exist', async () => {
    await expect(selectAgentProfile(storeFile, 'nothing-here')).rejects.toMatchObject({
      code: 'AGENT_PROFILE_NOT_FOUND',
    });
  });

  it('refuses to select a disabled profile rather than silently substituting one', async () => {
    await createAgentProfile(storeFile, input({ enabled: false }), NOW);
    await expect(selectAgentProfile(storeFile, 'custom')).rejects.toMatchObject({
      code: 'AGENT_PROFILE_DISABLED',
    });
  });

  it('falls back to the most restricted built-in when the active profile is deleted', async () => {
    await createAgentProfile(storeFile, input(), NOW);
    await selectAgentProfile(storeFile, 'custom');

    const registry = await deleteAgentProfile(storeFile, 'custom');
    expect(registry.activeProfileId).toBe(DEFAULT_AGENT_PROFILE_ID);

    // And the file on disk no longer points at something deleted.
    const store = await loadAgentProfileStore(storeFile);
    expect(store.activeProfileId).toBe(DEFAULT_AGENT_PROFILE_ID);
  });

  it('falls back the same way when the active profile is disabled', async () => {
    await createAgentProfile(storeFile, input(), NOW);
    await selectAgentProfile(storeFile, 'custom');

    const registry = await setAgentProfileEnabled(storeFile, 'custom', false, LATER);
    expect(registry.activeProfileId).toBe(DEFAULT_AGENT_PROFILE_ID);
    expect(findAgentProfile(registry.profiles, 'custom')?.enabled).toBe(false);
  });

  it('keeps the disabled profile itself, so re-enabling restores it', async () => {
    await createAgentProfile(storeFile, input(), NOW);
    await setAgentProfileEnabled(storeFile, 'custom', false, LATER);
    const registry = await setAgentProfileEnabled(storeFile, 'custom', true, LATER);
    expect(findAgentProfile(registry.profiles, 'custom')?.enabled).toBe(true);
  });
});
