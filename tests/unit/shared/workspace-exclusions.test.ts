import { describe, expect, it } from 'vitest';

import {
  containsExcludedSegment,
  fileExtension,
  fileStem,
  hasBinaryFileExtension,
  isCredentialFileName,
  isExcludedDirectoryName,
  isExcludedEntryName,
  WORKSPACE_BINARY_FILE_EXTENSIONS,
  WORKSPACE_CREDENTIAL_FILE_EXTENSIONS,
  WORKSPACE_EXCLUDED_DIRECTORY_NAMES,
  WORKSPACE_PROJECT_MARKER_FILES,
  WORKSPACE_TEST_MARKER_FILES,
} from '../../../src/shared/workspace/exclusions';

/**
 * The exclusion rules (Phase 2, Milestone 5).
 *
 * Two directions matter equally here, and both are asserted: what must never
 * be read (credential files, dependency and build trees) and what must stay
 * readable (ordinary source, including source files *about* credentials). An
 * over-broad rule makes the inspector misrepresent the project it is showing,
 * which is its own kind of failure.
 */

describe('isExcludedDirectoryName', () => {
  it('excludes dependency, build and version-control directories', () => {
    for (const name of ['node_modules', '.git', 'dist', 'build', 'out', 'target', 'coverage']) {
      expect(isExcludedDirectoryName(name), name).toBe(true);
    }
  });

  it('excludes credential stores that appear as directories', () => {
    for (const name of ['.ssh', '.gnupg', '.aws', '.azure']) {
      expect(isExcludedDirectoryName(name), name).toBe(true);
    }
  });

  it('matches case-insensitively', () => {
    expect(isExcludedDirectoryName('NODE_MODULES')).toBe(true);
    expect(isExcludedDirectoryName('Dist')).toBe(true);
  });

  it('matches the whole name only, never a substring', () => {
    // A directory legitimately named `dist-utils` or `outbox` is not build
    // output, and hiding it would misrepresent the project.
    for (const name of ['dist-utils', 'outbox', 'binary-tools', 'distribution', 'my-build']) {
      expect(isExcludedDirectoryName(name), name).toBe(false);
    }
  });

  it('keeps ordinary source directories visible', () => {
    for (const name of ['src', 'tests', 'docs', 'lib', 'app', 'scripts', '.vscode', '.github']) {
      expect(isExcludedDirectoryName(name), name).toBe(false);
    }
  });

  it('declares every excluded directory exactly once', () => {
    expect(new Set(WORKSPACE_EXCLUDED_DIRECTORY_NAMES).size).toBe(
      WORKSPACE_EXCLUDED_DIRECTORY_NAMES.length,
    );
  });
});

describe('isCredentialFileName', () => {
  it('excludes every .env variant, including the example file', () => {
    for (const name of ['.env', '.env.local', '.env.production', '.env.example', '.ENV']) {
      expect(isCredentialFileName(name), name).toBe(true);
    }
  });

  it('excludes known credential file names', () => {
    for (const name of [
      '.netrc',
      '.npmrc',
      '.pgpass',
      '.git-credentials',
      'id_rsa',
      'id_ed25519',
    ]) {
      expect(isCredentialFileName(name), name).toBe(true);
    }
  });

  it('excludes private-key and keystore extensions', () => {
    for (const extension of WORKSPACE_CREDENTIAL_FILE_EXTENSIONS) {
      expect(isCredentialFileName(`server${extension}`), extension).toBe(true);
    }
  });

  it('excludes credential-stemmed data files', () => {
    for (const name of [
      'secrets.json',
      'secret.yaml',
      'credentials.yml',
      'credentials',
      'secrets.enc',
      'SECRETS.JSON',
    ]) {
      expect(isCredentialFileName(name), name).toBe(true);
    }
  });

  it('keeps source files about credentials readable', () => {
    // This repository is its own example: hiding `src/main/secrets.ts` would
    // make the inspector actively misleading about how secrets are handled.
    for (const name of [
      'secrets.ts',
      'secrets.schema.ts',
      'secrets.test.ts',
      'credentials.py',
      'secret-store.go',
      'secrets-policy.md',
      'token.ts',
      'password-strength.ts',
    ]) {
      expect(isCredentialFileName(name), name).toBe(false);
    }
  });

  it('keeps public certificates and public keys readable', () => {
    for (const name of ['server.crt', 'server.cer', 'id_rsa.pub']) {
      expect(isCredentialFileName(name), name).toBe(false);
    }
  });

  it('keeps ordinary project files readable', () => {
    for (const name of ['package.json', 'README.md', 'index.ts', 'tsconfig.json', 'Makefile']) {
      expect(isCredentialFileName(name), name).toBe(false);
    }
  });
});

describe('hasBinaryFileExtension', () => {
  it('flags images, archives, fonts and compiled output', () => {
    for (const name of ['logo.png', 'bundle.zip', 'Inter.woff2', 'app.exe', 'module.wasm']) {
      expect(hasBinaryFileExtension(name), name).toBe(true);
    }
  });

  it('does not flag text formats', () => {
    for (const name of ['index.ts', 'README.md', 'data.json', 'style.css', 'Makefile']) {
      expect(hasBinaryFileExtension(name), name).toBe(false);
    }
  });

  it('declares every binary extension exactly once and with a leading dot', () => {
    expect(new Set(WORKSPACE_BINARY_FILE_EXTENSIONS).size).toBe(
      WORKSPACE_BINARY_FILE_EXTENSIONS.length,
    );
    for (const extension of WORKSPACE_BINARY_FILE_EXTENSIONS) {
      expect(extension.startsWith('.'), extension).toBe(true);
      expect(extension).toBe(extension.toLowerCase());
    }
  });
});

describe('fileExtension and fileStem', () => {
  it('treats a leading dot as a dotfile, not an extension', () => {
    expect(fileExtension('.env')).toBe('');
    expect(fileExtension('.gitignore')).toBe('');
    expect(fileStem('.env')).toBe('env');
  });

  it('takes the last extension and the first stem', () => {
    expect(fileExtension('archive.tar.gz')).toBe('.gz');
    expect(fileStem('secrets.schema.ts')).toBe('secrets');
    expect(fileExtension('secrets.schema.ts')).toBe('.ts');
  });

  it('handles a name with no dot at all', () => {
    expect(fileExtension('Makefile')).toBe('');
    expect(fileStem('Makefile')).toBe('makefile');
  });
});

describe('isExcludedEntryName', () => {
  it('applies the directory rule to directories and the file rule to files', () => {
    expect(isExcludedEntryName('node_modules', 'directory')).toBe(true);
    // A *file* called `dist` is not build output.
    expect(isExcludedEntryName('dist', 'file')).toBe(false);
    expect(isExcludedEntryName('.env', 'file')).toBe(true);
    // A *directory* called `.env` is not one of the excluded directories.
    expect(isExcludedEntryName('.env', 'directory')).toBe(false);
  });
});

describe('containsExcludedSegment', () => {
  it('refuses a path nested under an excluded directory', () => {
    expect(containsExcludedSegment(['node_modules', 'zod', 'index.js'])).toBe(true);
    expect(containsExcludedSegment(['.git', 'config'])).toBe(true);
    expect(containsExcludedSegment(['src', 'dist', 'bundle.js'])).toBe(true);
  });

  it('refuses a credential file at the end of an otherwise fine path', () => {
    expect(containsExcludedSegment(['config', '.env'])).toBe(true);
    expect(containsExcludedSegment(['deploy', 'server.pem'])).toBe(true);
  });

  it('allows an ordinary path', () => {
    expect(containsExcludedSegment(['src', 'main', 'ipc.ts'])).toBe(false);
    expect(containsExcludedSegment(['README.md'])).toBe(false);
    expect(containsExcludedSegment([])).toBe(false);
  });

  it('checks a non-final segment as a directory only', () => {
    // `.env` cannot be a parent of anything in practice, but the rule must be
    // unambiguous: a non-final segment is checked as a directory.
    expect(containsExcludedSegment(['.env', 'inner.txt'])).toBe(false);
    expect(containsExcludedSegment(['secrets.json', 'inner.txt'])).toBe(false);
  });
});

describe('project markers', () => {
  it('includes .git, so version control is detected without reading it', () => {
    expect(WORKSPACE_PROJECT_MARKER_FILES).toContain('.git');
    // ...and `.git` remains an excluded directory, so detection never becomes
    // a licence to list or read its contents.
    expect(isExcludedDirectoryName('.git')).toBe(true);
  });

  it('includes the common project files the milestone names', () => {
    for (const marker of ['package.json', 'tsconfig.json', 'README.md']) {
      expect(WORKSPACE_PROJECT_MARKER_FILES).toContain(marker);
    }
  });

  it('declares every test marker as a project marker too', () => {
    for (const marker of WORKSPACE_TEST_MARKER_FILES) {
      expect(WORKSPACE_PROJECT_MARKER_FILES).toContain(marker);
    }
  });

  it('declares every marker exactly once', () => {
    expect(new Set(WORKSPACE_PROJECT_MARKER_FILES).size).toBe(
      WORKSPACE_PROJECT_MARKER_FILES.length,
    );
  });
});
