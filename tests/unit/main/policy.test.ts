import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadPermissionPolicy } from '../../../src/main/policy';
import { createDefaultPermissionPolicy } from '../../../src/shared/schemas';
import type { PermissionPolicy } from '../../../src/shared/schemas';

let dir: string;
let policyFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-policy-'));
  policyFile = join(dir, 'policy.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('loadPermissionPolicy — missing file', () => {
  it('returns the default policy when policy.json does not exist', async () => {
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(createDefaultPermissionPolicy());
  });

  it('never creates a file merely by reading', async () => {
    await loadPermissionPolicy(policyFile);
    await expect(readFile(policyFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never creates the parent directory merely by reading', async () => {
    const nested = join(dir, 'does', 'not', 'exist', 'policy.json');
    await loadPermissionPolicy(nested);
    await expect(readdir(join(dir, 'does'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('loadPermissionPolicy — unreadable file', () => {
  it('fails safe when the policy path is a directory rather than a file', async () => {
    await mkdir(policyFile, { recursive: true });
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(createDefaultPermissionPolicy());
  });
});

describe('loadPermissionPolicy — malformed JSON', () => {
  const malformed = [
    '{',
    '{"rules": [}',
    'not json at all',
    '',
    '{"rules": [1, 2,]}',
    '{"rules": undefined}',
  ];

  for (const content of malformed) {
    it(`falls back to defaults for: ${JSON.stringify(content)}`, async () => {
      await writeFile(policyFile, content, 'utf8');
      const result = await loadPermissionPolicy(policyFile);
      expect(result).toEqual(createDefaultPermissionPolicy());
    });
  }
});

describe('loadPermissionPolicy — schema-invalid documents', () => {
  it('rejects a policy missing the emergency availability floor', async () => {
    const invalid = { schemaVersion: 1, defaultDecision: 'deny', rules: [] };
    await writeFile(policyFile, JSON.stringify(invalid), 'utf8');
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(createDefaultPermissionPolicy());
  });

  it('rejects a policy that downgrades a confirmation-required action to allow', async () => {
    const invalid = {
      ...createDefaultPermissionPolicy(),
      rules: createDefaultPermissionPolicy().rules.map((rule) =>
        rule.actionType === 'secrets.write' ? { ...rule, decision: 'allow' } : rule,
      ),
    };
    await writeFile(policyFile, JSON.stringify(invalid), 'utf8');
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(createDefaultPermissionPolicy());
  });

  it('rejects a policy that denies an availability-floor action', async () => {
    const invalid = {
      ...createDefaultPermissionPolicy(),
      rules: createDefaultPermissionPolicy().rules.map((rule) =>
        rule.actionType === 'audit.read' ? { ...rule, decision: 'deny' } : rule,
      ),
    };
    await writeFile(policyFile, JSON.stringify(invalid), 'utf8');
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(createDefaultPermissionPolicy());
  });

  it('rejects an unrecognised defaultDecision', async () => {
    const invalid = { ...createDefaultPermissionPolicy(), defaultDecision: 'allow' };
    await writeFile(policyFile, JSON.stringify(invalid), 'utf8');
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(createDefaultPermissionPolicy());
  });

  it('rejects an unknown top-level key', async () => {
    const invalid = { ...createDefaultPermissionPolicy(), extra: 'field' };
    await writeFile(policyFile, JSON.stringify(invalid), 'utf8');
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(createDefaultPermissionPolicy());
  });

  it('rejects a duplicate rule id', async () => {
    const base = createDefaultPermissionPolicy();
    const duplicated = { ...base, rules: [...base.rules, base.rules[0]] };
    await writeFile(policyFile, JSON.stringify(duplicated), 'utf8');
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(createDefaultPermissionPolicy());
  });

  it('rejects an unknown action type in a rule', async () => {
    const base = createDefaultPermissionPolicy();
    const invalid = {
      ...base,
      rules: [
        ...base.rules,
        { id: 'bogus', actionType: 'shell.execute', decision: 'allow', priority: 100, reason: 'x' },
      ],
    };
    await writeFile(policyFile, JSON.stringify(invalid), 'utf8');
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(createDefaultPermissionPolicy());
  });
});

describe('loadPermissionPolicy — prototype pollution', () => {
  function globalIsClean(): boolean {
    return !('polluted' in Object.prototype);
  }

  afterEach(() => {
    delete (Object.prototype as Record<string, unknown>).polluted;
  });

  it('falls back to defaults for a top-level __proto__ key and does not pollute Object.prototype', async () => {
    const hostileJson = JSON.stringify(createDefaultPermissionPolicy()).replace(
      '{"schemaVersion"',
      '{"__proto__":{"polluted":true},"schemaVersion"',
    );
    await writeFile(policyFile, hostileJson, 'utf8');
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(createDefaultPermissionPolicy());
    expect(globalIsClean()).toBe(true);
  });

  it('falls back to defaults for a __proto__ key nested inside a rule', async () => {
    const hostileJson = JSON.stringify({
      schemaVersion: 1,
      defaultDecision: 'deny',
      rules: [
        { id: 'x', actionType: 'settings.read', decision: 'allow', priority: 100, reason: 'x' },
      ],
    }).replace('"id":"x"', '"id":"x","__proto__":{"polluted":true}');
    await writeFile(policyFile, hostileJson, 'utf8');
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(createDefaultPermissionPolicy());
    expect(globalIsClean()).toBe(true);
  });

  it('falls back to defaults for constructor and prototype keys', async () => {
    for (const key of ['constructor', 'prototype']) {
      const hostileJson = JSON.stringify(createDefaultPermissionPolicy()).replace(
        '{"schemaVersion"',
        `{"${key}":"x","schemaVersion"`,
      );
      await writeFile(policyFile, hostileJson, 'utf8');
      const result = await loadPermissionPolicy(policyFile);
      expect(result).toEqual(createDefaultPermissionPolicy());
    }
  });
});

describe('loadPermissionPolicy — valid custom policy', () => {
  it('loads a valid, non-default policy exactly as written', async () => {
    const custom: PermissionPolicy = {
      schemaVersion: 1,
      defaultDecision: 'deny',
      rules: [
        {
          id: 'settings.read',
          actionType: 'settings.read',
          decision: 'deny',
          priority: 500,
          reason: 'locked down for this test',
        },
        {
          id: 'emergency.engage',
          actionType: 'emergency.engage',
          decision: 'allow',
          priority: 100,
          reason: 'floor',
        },
        {
          id: 'emergency.reset',
          actionType: 'emergency.reset',
          decision: 'confirm',
          priority: 100,
          reason: 'floor',
        },
        {
          id: 'audit.read',
          actionType: 'audit.read',
          decision: 'allow',
          priority: 100,
          reason: 'floor',
        },
      ],
    };
    await writeFile(policyFile, JSON.stringify(custom), 'utf8');
    const result = await loadPermissionPolicy(policyFile);
    expect(result).toEqual(custom);
  });
});
