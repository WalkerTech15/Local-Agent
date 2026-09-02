import { describe, expect, it } from 'vitest';

import {
  AUDIT_PARAM_MAX_ARRAY_LENGTH,
  AUDIT_PARAM_MAX_DEPTH,
  AUDIT_PARAM_MAX_KEY_LENGTH,
  AUDIT_PARAM_MAX_KEYS,
  AUDIT_PARAM_MAX_STRING_LENGTH,
  AUDIT_PARAM_MAX_TOTAL_NODES,
  isSecretFieldName,
  normalizeFieldName,
  REDACTED_PLACEHOLDER,
  SECRET_FIELD_NAMES,
} from '../../../src/shared/constants';
import { auditParametersSchema } from '../../../src/shared/schemas/audit-parameters.schema';

const accepts = (value: unknown): boolean => auditParametersSchema.safeParse(value).success;

/** Builds `{ a: { a: { ... } } }` nested to the requested depth. */
const nest = (depth: number): Record<string, unknown> => {
  let node: Record<string, unknown> = { leaf: 1 };
  for (let level = 1; level < depth; level += 1) {
    node = { a: node };
  }
  return node;
};

describe('auditParametersSchema — accepts useful records', () => {
  it('accepts an empty object', () => {
    expect(accepts({})).toBe(true);
  });

  it('accepts ordinary JSON values', () => {
    expect(
      accepts({
        field: 'assistant.name',
        previousLength: 6,
        changed: true,
        removed: null,
        tags: ['settings', 'write'],
        nested: { language: 'vi', counts: [1, 2, 3] },
      }),
    ).toBe(true);
  });

  it('accepts non-ASCII text, so French and Vietnamese records stay usable', () => {
    expect(accepts({ displayName: 'Élodie Lefèvre', city: 'Đà Nẵng' })).toBe(true);
  });

  it('accepts values at the documented limits', () => {
    expect(accepts({ long: 'x'.repeat(AUDIT_PARAM_MAX_STRING_LENGTH) })).toBe(true);
    expect(accepts({ list: Array.from({ length: AUDIT_PARAM_MAX_ARRAY_LENGTH }, () => 1) })).toBe(
      true,
    );
    expect(accepts({ ['k'.repeat(AUDIT_PARAM_MAX_KEY_LENGTH)]: 1 })).toBe(true);
    expect(accepts(nest(AUDIT_PARAM_MAX_DEPTH))).toBe(true);
  });
});

describe('auditParametersSchema — rejects non-JSON-safe values', () => {
  it('rejects a non-object at the top level', () => {
    for (const value of ['string', 42, true, null, undefined, [1, 2, 3]]) {
      expect(accepts(value), `expected ${String(value)} to be rejected`).toBe(false);
    }
  });

  it('rejects functions', () => {
    expect(accepts({ callback: () => undefined })).toBe(false);
    expect(
      accepts({
        nested: {
          callback: function named() {
            return undefined;
          },
        },
      }),
    ).toBe(false);
  });

  it('rejects symbols, bigints and undefined values', () => {
    expect(accepts({ marker: Symbol('x') })).toBe(false);
    expect(accepts({ big: BigInt(1) })).toBe(false);
    expect(accepts({ missing: undefined })).toBe(false);
  });

  it('rejects class instances and exotic built-ins', () => {
    class Payload {
      public field = 1;
    }
    expect(accepts({ instance: new Payload() })).toBe(false);
    expect(accepts({ when: new Date(0) })).toBe(false);
    expect(accepts({ map: new Map() })).toBe(false);
    expect(accepts({ set: new Set() })).toBe(false);
    expect(accepts({ failure: new Error('boom') })).toBe(false);
  });

  it('rejects non-finite numbers, which JSON would silently turn into null', () => {
    expect(accepts({ ratio: Number.NaN })).toBe(false);
    expect(accepts({ ratio: Number.POSITIVE_INFINITY })).toBe(false);
    expect(accepts({ ratio: Number.NEGATIVE_INFINITY })).toBe(false);
  });

  it('rejects a cyclic structure instead of overflowing during serialisation', () => {
    const cyclic: Record<string, unknown> = { name: 'loop' };
    cyclic.self = cyclic;
    expect(accepts(cyclic)).toBe(false);

    const indirect: Record<string, unknown> = {};
    const child: Record<string, unknown> = { parent: indirect };
    indirect.child = child;
    expect(accepts(indirect)).toBe(false);
  });

  it('accepts a repeated (non-cyclic) reference to the same object', () => {
    const shared = { value: 1 };
    expect(accepts({ first: shared, second: shared })).toBe(true);
  });
});

describe('auditParametersSchema — rejects oversized payloads', () => {
  it('rejects nesting beyond the depth limit', () => {
    expect(accepts(nest(AUDIT_PARAM_MAX_DEPTH + 1))).toBe(false);
  });

  it('rejects an object with too many keys', () => {
    const wide: Record<string, unknown> = {};
    for (let index = 0; index <= AUDIT_PARAM_MAX_KEYS; index += 1) {
      wide[`key${String(index)}`] = index;
    }
    expect(accepts(wide)).toBe(false);
  });

  it('rejects an array beyond the length limit', () => {
    expect(
      accepts({ list: Array.from({ length: AUDIT_PARAM_MAX_ARRAY_LENGTH + 1 }, () => 1) }),
    ).toBe(false);
  });

  it('rejects a string beyond the length limit', () => {
    expect(accepts({ blob: 'x'.repeat(AUDIT_PARAM_MAX_STRING_LENGTH + 1) })).toBe(false);
  });

  it('rejects a key beyond the length limit', () => {
    expect(accepts({ ['k'.repeat(AUDIT_PARAM_MAX_KEY_LENGTH + 1)]: 1 })).toBe(false);
  });

  it('rejects a payload exceeding the total node budget', () => {
    const huge: Record<string, unknown> = {};
    for (let index = 0; index < AUDIT_PARAM_MAX_KEYS; index += 1) {
      huge[`key${String(index)}`] = Array.from({ length: AUDIT_PARAM_MAX_KEYS }, () => 1);
    }
    // AUDIT_PARAM_MAX_KEYS^2 values, comfortably past the node budget.
    expect(AUDIT_PARAM_MAX_KEYS * AUDIT_PARAM_MAX_KEYS).toBeGreaterThan(
      AUDIT_PARAM_MAX_TOTAL_NODES,
    );
    expect(accepts(huge)).toBe(false);
  });
});

describe('auditParametersSchema — the redaction contract', () => {
  it('rejects a plaintext secret', () => {
    expect(accepts({ apiKey: 'fake-secret' })).toBe(false);
  });

  it('accepts a redacted secret', () => {
    expect(accepts({ apiKey: REDACTED_PLACEHOLDER })).toBe(true);
  });

  it('rejects a plaintext secret under every canonical secret name', () => {
    for (const root of SECRET_FIELD_NAMES) {
      expect(accepts({ [root]: 'fake-secret-value' }), `expected ${root} to be rejected`).toBe(
        false,
      );
      expect(accepts({ [root]: REDACTED_PLACEHOLDER }), `expected redacted ${root} to pass`).toBe(
        true,
      );
    }
  });

  it('rejects a secret regardless of spelling or separators', () => {
    for (const key of [
      'apiKey',
      'api_key',
      'API-KEY',
      'accessToken',
      'refresh_token',
      'clientSecret',
      'Authorization',
      'userPassword',
      'privateKey',
      'credentials',
    ]) {
      expect(accepts({ [key]: 'fake-secret-value' }), `expected ${key} to be rejected`).toBe(false);
    }
  });

  it('rejects a secret hidden deeper in the tree', () => {
    expect(accepts({ provider: { auth: { apiKey: 'fake-secret' } } })).toBe(false);
  });

  it('rejects a non-string value under a secret name, including a boolean', () => {
    // Boolean key-presence metadata must be logged under a neutral name such
    // as `keyPresent`, not one that matches the secret denylist.
    expect(accepts({ hasApiKey: false })).toBe(false);
    expect(accepts({ keyPresent: false })).toBe(true);
  });

  it('leaves ordinary field names alone', () => {
    for (const key of ['field', 'provider', 'language', 'keyPresent', 'publicId', 'monkey']) {
      expect(accepts({ [key]: 'value' }), `expected ${key} to be accepted`).toBe(true);
    }
  });

  it('rejects prototype-pollution key names', () => {
    expect(accepts(JSON.parse('{"__proto__": {"polluted": true}}') as unknown)).toBe(false);
    expect(accepts({ constructor: 'x' })).toBe(false);
    expect(accepts({ prototype: 'x' })).toBe(false);
  });
});

describe('SECRET_FIELD_NAMES', () => {
  it('contains no duplicates', () => {
    expect(new Set(SECRET_FIELD_NAMES).size).toBe(SECRET_FIELD_NAMES.length);
  });

  it('is stored in normalised form', () => {
    for (const root of SECRET_FIELD_NAMES) {
      expect(normalizeFieldName(root), `${root} is not normalised`).toBe(root);
    }
  });

  it('contains no redundant entry, since matching is by substring', () => {
    for (const root of SECRET_FIELD_NAMES) {
      const covered = SECRET_FIELD_NAMES.filter((other) => other !== root && root.includes(other));
      expect(covered, `${root} is already covered by ${covered.join(', ')}`).toEqual([]);
    }
  });

  it('still represents every expected high-risk term', () => {
    for (const term of [
      'apiKey',
      'api_key',
      'accessToken',
      'refreshToken',
      'authorization',
      'bearerToken',
      'credential',
      'credentials',
      'password',
      'passphrase',
      'privateKey',
      'secret',
      'token',
    ]) {
      expect(isSecretFieldName(term), `${term} must be detected as secret-bearing`).toBe(true);
    }
  });

  it('does not flag ordinary field names', () => {
    for (const term of ['field', 'provider', 'language', 'monkey', 'keyPresent', 'baseUrl']) {
      expect(isSecretFieldName(term), `${term} must not be flagged`).toBe(false);
    }
  });

  it('over-matches rather than under-matches, by design', () => {
    // Substring matching flags names that merely contain a secret root, such
    // as `tokenizer`. That is the intended direction of error: a false
    // positive is a loudly rejected audit record, while a false negative is a
    // silently logged credential. Callers rename the field; nothing leaks.
    expect(isSecretFieldName('tokenizer')).toBe(true);
    expect(isSecretFieldName('secretariat')).toBe(true);
  });
});

describe('normalizeFieldName', () => {
  it('lowercases and strips separators', () => {
    expect(normalizeFieldName('API_KEY')).toBe('apikey');
    expect(normalizeFieldName('api-key')).toBe('apikey');
    expect(normalizeFieldName('apiKey')).toBe('apikey');
    expect(normalizeFieldName('api key')).toBe('apikey');
  });
});
