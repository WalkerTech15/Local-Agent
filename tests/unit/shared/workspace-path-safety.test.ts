import { describe, expect, it } from 'vitest';

import {
  isSafeWorkspaceRelativePath,
  joinWorkspacePath,
  normalizeWorkspaceRelativePath,
} from '../../../src/shared/workspace/path-safety';
import {
  WORKSPACE_MAX_PATH_SEGMENT_LENGTH,
  WORKSPACE_MAX_PATH_SEGMENTS,
  WORKSPACE_MAX_RELATIVE_PATH_LENGTH,
} from '../../../src/shared/constants';

/**
 * The lexical half of path containment (Phase 2, Milestone 5).
 *
 * These are the rules that run before anything touches a filesystem, so every
 * case here is checked without a temporary directory, a `realpath` call, or a
 * platform dependency. The filesystem half — joining onto a real root and
 * following links — is covered separately in
 * `tests/unit/main/workspace-paths.test.ts`.
 */

function expectRejected(value: unknown, rejection: string): void {
  const result = normalizeWorkspaceRelativePath(value);
  expect(result.ok, `expected ${JSON.stringify(value)} to be rejected`).toBe(false);
  if (!result.ok) expect(result.rejection).toBe(rejection);
}

describe('normalizeWorkspaceRelativePath — accepted forms', () => {
  it('accepts the empty string as the project root, with no segments', () => {
    const result = normalizeWorkspaceRelativePath('');
    expect(result).toEqual({ ok: true, path: '', segments: [] });
  });

  it('accepts an ordinary nested path and reports its segments', () => {
    const result = normalizeWorkspaceRelativePath('src/main/ipc.ts');
    expect(result).toEqual({
      ok: true,
      path: 'src/main/ipc.ts',
      segments: ['src', 'main', 'ipc.ts'],
    });
  });

  it('accepts dotfiles and names beginning with two dots', () => {
    expect(isSafeWorkspaceRelativePath('.gitignore')).toBe(true);
    expect(isSafeWorkspaceRelativePath('src/.eslintrc')).toBe(true);
    // Not `..` itself: a real directory whose name happens to start with dots.
    expect(isSafeWorkspaceRelativePath('..config/settings')).toBe(true);
  });

  it('accepts accented and non-Latin names', () => {
    expect(isSafeWorkspaceRelativePath('docs/spécification.md')).toBe(true);
    expect(isSafeWorkspaceRelativePath('tài-liệu/hướng-dẫn.md')).toBe(true);
    expect(isSafeWorkspaceRelativePath('文档/说明.md')).toBe(true);
  });

  it('accepts a name whose stem merely resembles a device name', () => {
    expect(isSafeWorkspaceRelativePath('src/constants.ts')).toBe(true);
    expect(isSafeWorkspaceRelativePath('src/console.ts')).toBe(true);
    expect(isSafeWorkspaceRelativePath('src/component.tsx')).toBe(true);
  });
});

describe('normalizeWorkspaceRelativePath — traversal and absolute paths', () => {
  it('rejects a parent-directory segment anywhere in the path', () => {
    expectRejected('..', 'relative-segment');
    expectRejected('../secrets', 'relative-segment');
    expectRejected('src/../../etc/passwd', 'relative-segment');
    expectRejected('src/main/..', 'relative-segment');
  });

  it('rejects a current-directory segment, which would be a second spelling', () => {
    expectRejected('.', 'relative-segment');
    expectRejected('./src', 'relative-segment');
    expectRejected('src/./main', 'relative-segment');
  });

  it('rejects a POSIX absolute path', () => {
    expectRejected('/etc/passwd', 'absolute');
    expectRejected('/', 'absolute');
  });

  it('rejects a UNC path, which the leading-slash rule already covers', () => {
    expectRejected('//server/share/file.txt', 'absolute');
  });

  it('rejects a Windows drive letter through the colon rule', () => {
    expectRejected('C:/Windows/System32/config/SAM', 'forbidden-character');
    expectRejected('C:', 'forbidden-character');
  });

  it('rejects a backslash, so there is exactly one canonical separator', () => {
    // Without this rule, `..\..\Windows` would be one segment that is neither
    // `.` nor `..` and would pass the segment check, while `path.resolve`
    // would still treat the backslashes as separators on Windows.
    expectRejected('..\\..\\Windows', 'forbidden-character');
    expectRejected('src\\main\\ipc.ts', 'forbidden-character');
    expectRejected('\\\\server\\share', 'forbidden-character');
  });

  it('rejects an NTFS alternate-data-stream name', () => {
    // `notes.txt:hidden` names a different stream of the same file, which no
    // listing would ever have shown.
    expectRejected('notes.txt:hidden', 'forbidden-character');
  });
});

describe('normalizeWorkspaceRelativePath — unsafe characters', () => {
  it('rejects a NUL byte', () => {
    expectRejected(`src/main${String.fromCharCode(0)}.ts`, 'control-character');
  });

  it('rejects other control characters, including a newline', () => {
    expectRejected('src/\nmain.ts', 'control-character');
    expectRejected(`src/${String.fromCharCode(9)}main.ts`, 'control-character');
    expectRejected(`src/${String.fromCharCode(127)}main.ts`, 'control-character');
  });

  it('rejects bidirectional overrides, which can disguise an extension', () => {
    // A right-to-left override can make `report.exe` render as `report.txt`.
    expectRejected('report\u202Etxt.exe', 'bidi-character');
    expectRejected('src/\u2066main.ts', 'bidi-character');
  });

  it('rejects wildcard and redirection characters', () => {
    expectRejected('src/*.ts', 'forbidden-character');
    expectRejected('src/?.ts', 'forbidden-character');
    expectRejected('src/a<b', 'forbidden-character');
    expectRejected('src/a>b', 'forbidden-character');
    expectRejected('src/a|b', 'forbidden-character');
    expectRejected('src/"quoted"', 'forbidden-character');
  });
});

describe('normalizeWorkspaceRelativePath — Windows name aliasing', () => {
  it('rejects a trailing dot, which Windows silently strips', () => {
    // `secrets.` and `secrets` name the same file on Windows, so accepting
    // the first would be a second spelling around every name-based rule.
    expectRejected('secrets.', 'trailing-dot-or-space');
    expectRejected('src/config.', 'trailing-dot-or-space');
  });

  it('rejects a trailing or leading space for the same reason', () => {
    expectRejected('secrets ', 'trailing-dot-or-space');
    expectRejected(' secrets', 'trailing-dot-or-space');
  });

  it('rejects reserved device names, with or without an extension', () => {
    for (const name of ['CON', 'con', 'PRN', 'AUX', 'NUL', 'COM1', 'lpt9']) {
      expectRejected(name, 'reserved-device-name');
      expectRejected(`${name}.txt`, 'reserved-device-name');
      expectRejected(`src/${name}.log`, 'reserved-device-name');
    }
  });
});

describe('normalizeWorkspaceRelativePath — bounds and shape', () => {
  it('rejects an empty segment, which a trailing or doubled slash produces', () => {
    expectRejected('src//main.ts', 'empty-segment');
    expectRejected('src/', 'empty-segment');
  });

  it('rejects a path longer than the limit', () => {
    expectRejected('a'.repeat(WORKSPACE_MAX_RELATIVE_PATH_LENGTH + 1), 'too-long');
  });

  it('rejects a segment longer than the limit', () => {
    expectRejected(`src/${'a'.repeat(WORKSPACE_MAX_PATH_SEGMENT_LENGTH + 1)}`, 'segment-too-long');
  });

  it('rejects more segments than the limit', () => {
    const tooDeep = Array.from({ length: WORKSPACE_MAX_PATH_SEGMENTS + 1 }, () => 'a').join('/');
    expectRejected(tooDeep, 'too-many-segments');
  });

  it('accepts a path at exactly the segment limit', () => {
    const atLimit = Array.from({ length: WORKSPACE_MAX_PATH_SEGMENTS }, () => 'a').join('/');
    expect(isSafeWorkspaceRelativePath(atLimit)).toBe(true);
  });

  it('rejects a non-string without throwing', () => {
    expectRejected(undefined, 'not-a-string');
    expectRejected(null, 'not-a-string');
    expectRejected(42, 'not-a-string');
    expectRejected(['src'], 'not-a-string');
    expectRejected({ path: 'src' }, 'not-a-string');
  });

  it('never throws, for any input', () => {
    const hostile: unknown[] = [
      Symbol('x'),
      () => 'src',
      new Map(),
      Number.NaN,
      { toString: () => 'src/main.ts' },
    ];
    for (const value of hostile) {
      expect(() => normalizeWorkspaceRelativePath(value)).not.toThrow();
      expect(normalizeWorkspaceRelativePath(value).ok).toBe(false);
    }
  });
});

describe('joinWorkspacePath', () => {
  it('produces the canonical form the validator accepts', () => {
    expect(joinWorkspacePath('', 'src')).toBe('src');
    expect(joinWorkspacePath('src', 'main')).toBe('src/main');
    expect(joinWorkspacePath('src/main', 'ipc.ts')).toBe('src/main/ipc.ts');
  });

  it('round-trips: anything it builds from safe parts is itself safe', () => {
    let path = '';
    for (const segment of ['src', 'shared', 'workspace', 'path-safety.ts']) {
      path = joinWorkspacePath(path, segment);
      expect(isSafeWorkspaceRelativePath(path)).toBe(true);
    }
    expect(path).toBe('src/shared/workspace/path-safety.ts');
  });
});
