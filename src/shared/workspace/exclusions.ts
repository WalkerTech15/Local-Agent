/**
 * What the read-only workspace refuses to descend into, read, or search
 * (Phase 2, Milestone 5).
 *
 * Three separate lists, because they exist for three different reasons and
 * conflating them would make the rationale for any one of them unreadable:
 *
 *  - **Excluded directories** — dependency trees, build output,
 *    version-control internals and tool caches. Excluded because they are
 *    enormous and are not the user's source, not because they are dangerous.
 *    They are still *listed*, marked `excluded`, so a tree does not silently
 *    misrepresent the project; they are simply never descended into, read
 *    from, or searched.
 *  - **Credential-bearing files** — `.env` and its relatives. Excluded because
 *    reading one would put a live secret into renderer memory and onto a
 *    screen. `AGENTS.md` section 4 forbids a credential reaching a place like
 *    that, and this milestone forbids reading one at all.
 *  - **Binary extensions** — a cheap pre-filter so an image or an archive is
 *    skipped before it is opened. Never the only check: content sniffing (a
 *    NUL byte among the first bytes read) is what actually decides, since an
 *    extension is only a claim the file makes about itself.
 *
 * Matching is on the *segment name only* — never on the whole path — so a
 * directory legitimately named `src/dist-utils` is unaffected while `src/dist`
 * is not, and a rule can never be evaded by nesting.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

/**
 * Directory names never descended into.
 *
 * `.git` is here so its internals (packed objects, config, and — with a
 * credential helper configured — stored credentials) are never listed or
 * read. Whether a project *has* Git metadata is still reported, from the mere
 * existence of the entry: see {@link WORKSPACE_PROJECT_MARKER_FILES}.
 *
 * `.vscode` is deliberately **absent**: it is small, commonly part of a
 * project, and useful to inspect. Any credential-shaped file inside it is
 * still caught by {@link isCredentialFileName}, which applies at every depth.
 */
export const WORKSPACE_EXCLUDED_DIRECTORY_NAMES: readonly string[] = [
  // Version control internals
  '.git',
  '.hg',
  '.svn',
  // Dependency trees
  'node_modules',
  'bower_components',
  'vendor',
  '.pnpm-store',
  // Build output
  'dist',
  'build',
  'out',
  'target',
  'bin',
  'obj',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.output',
  // Tool caches and coverage
  '.cache',
  '.turbo',
  '.parcel-cache',
  '.gradle',
  '.terraform',
  'coverage',
  '.nyc_output',
  // Python environments and caches
  '.venv',
  'venv',
  '__pycache__',
  '.mypy_cache',
  '.pytest_cache',
  '.tox',
  // Editor state and credential stores
  '.idea',
  '.ssh',
  '.gnupg',
  '.aws',
  '.azure',
] as const;

/** Exact file names that carry, or routinely carry, a live credential. */
export const WORKSPACE_CREDENTIAL_FILE_NAMES: readonly string[] = [
  '.netrc',
  '_netrc',
  '.npmrc',
  '.pypirc',
  '.htpasswd',
  '.pgpass',
  '.git-credentials',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'secring.gpg',
] as const;

/**
 * Extensions whose contents are a private key, a bundle containing one, or a
 * keystore. `.crt`, `.cer` and `.pub` are deliberately absent — a public
 * certificate or public key is not a credential.
 */
export const WORKSPACE_CREDENTIAL_FILE_EXTENSIONS: readonly string[] = [
  '.pem',
  '.key',
  '.pfx',
  '.p12',
  '.jks',
  '.keystore',
  '.ppk',
  '.gpg',
  '.asc',
] as const;

/**
 * File-name stems (the part before the first dot) treated as credential
 * stores whatever their extension: `secrets.json`, `credentials.yaml`,
 * `secrets.enc`.
 *
 * Deliberately a stem match rather than a substring match. A substring rule
 * would also hide `src/auth/token.ts` and `docs/secrets-policy.md` — ordinary
 * source and documentation a reader has every reason to open — and hiding
 * those would make the inspector untrustworthy in a way that buys no safety.
 */
export const WORKSPACE_CREDENTIAL_FILE_STEMS: readonly string[] = [
  'secret',
  'secrets',
  'credential',
  'credentials',
] as const;

/**
 * Extensions that exempt a file from the stem rule above.
 *
 * A stem match alone would hide `secrets.ts` and `credentials.py` — source
 * files *about* credential handling, not files *of* credentials. This
 * codebase is its own counter-example: `src/main/secrets.ts` and
 * `src/shared/schemas/secrets.schema.ts` are exactly the files a reader would
 * most want to open when inspecting how secrets are stored, and hiding them
 * would make the inspector actively misleading about the project it is
 * showing.
 *
 * So the stem rule applies to *data* files — `secrets.json`, `credentials`,
 * `secrets.enc` — and not to code or documentation. The direction of error is
 * deliberate and narrow: a credential pasted into a `.ts` file is not caught
 * here, which is the same limitation the audit log's own name-based redaction
 * has, recorded as such in `docs/security-model.md`.
 */
export const WORKSPACE_SOURCE_FILE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.java',
  '.kt',
  '.swift',
  '.cs',
  '.c',
  '.h',
  '.cpp',
  '.hpp',
  '.css',
  '.scss',
  '.html',
  '.md',
  '.mdx',
  '.rst',
  '.txt',
  '.sql',
  '.sh',
  '.ps1',
] as const;

/** Extensions treated as binary before a file is ever opened. */
export const WORKSPACE_BINARY_FILE_EXTENSIONS: readonly string[] = [
  // Images and media
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.ico',
  '.icns',
  '.webp',
  '.avif',
  '.tif',
  '.tiff',
  '.psd',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.mp4',
  '.m4a',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  // Fonts
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.eot',
  // Archives
  '.zip',
  '.gz',
  '.tgz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.tar',
  '.jar',
  '.war',
  // Executables and compiled output
  '.exe',
  '.dll',
  '.so',
  '.dylib',
  '.node',
  '.wasm',
  '.class',
  '.pyc',
  '.pyo',
  '.o',
  '.a',
  '.lib',
  '.obj',
  '.pdb',
  // Documents and databases
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.ppt',
  '.pptx',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.mdb',
  '.bin',
  '.dat',
] as const;

/**
 * Root-level entries whose presence identifies what kind of project this is.
 *
 * Detection is presence only — none of these is read to build the project
 * summary. `.git` appears here even though it is an excluded *directory*:
 * knowing a project is version-controlled is exactly the "Git metadata"
 * signal the interface needs, and it is answered without listing or reading
 * one byte inside it.
 */
export const WORKSPACE_PROJECT_MARKER_FILES: readonly string[] = [
  '.git',
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'README.md',
  'AGENTS.md',
  'CLAUDE.md',
  'LICENSE',
  '.gitignore',
  'Dockerfile',
  'Makefile',
  'pyproject.toml',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'composer.json',
  'Gemfile',
] as const;

/**
 * Markers that indicate an automated test setup plausibly exists.
 *
 * Used by the planner to decide, from observation rather than assumption,
 * whether "verify with the existing test suite" is a step it may honestly
 * propose.
 */
export const WORKSPACE_TEST_MARKER_FILES: readonly string[] = [
  'package.json',
  'pyproject.toml',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
] as const;

/** The extension including its dot, lowercased, or `''` when there is none. */
export function fileExtension(name: string): string {
  const index = name.lastIndexOf('.');
  // A leading dot marks a dotfile, not an extension: `.env` has none.
  if (index <= 0) return '';
  return name.slice(index).toLowerCase();
}

/** The part of a file name before its first dot, lowercased. */
export function fileStem(name: string): string {
  const withoutLeadingDot = name.startsWith('.') ? name.slice(1) : name;
  const index = withoutLeadingDot.indexOf('.');
  const stem = index === -1 ? withoutLeadingDot : withoutLeadingDot.slice(0, index);
  return stem.toLowerCase();
}

/** True for a directory the workspace never descends into. */
export function isExcludedDirectoryName(name: string): boolean {
  return WORKSPACE_EXCLUDED_DIRECTORY_NAMES.includes(name.toLowerCase());
}

/**
 * True for a file that must never be read, searched, or have its contents
 * cross any boundary.
 *
 * Covers, in order: anything beginning `.env` (so `.env.local`,
 * `.env.production` and `.env.example` are all included — an example file
 * costs nothing to exclude and is regularly the one that really holds a key);
 * the exact names above; the credential extensions above; and the credential
 * stems above.
 */
export function isCredentialFileName(name: string): boolean {
  const lowered = name.toLowerCase();
  if (lowered === '.env' || lowered.startsWith('.env.')) return true;
  if (WORKSPACE_CREDENTIAL_FILE_NAMES.includes(lowered)) return true;

  const extension = fileExtension(lowered);
  if (WORKSPACE_CREDENTIAL_FILE_EXTENSIONS.includes(extension)) return true;

  // The stem rule is skipped for code and documentation — see
  // {@link WORKSPACE_SOURCE_FILE_EXTENSIONS} for why `secrets.ts` must stay
  // readable while `secrets.json` must not.
  if (WORKSPACE_SOURCE_FILE_EXTENSIONS.includes(extension)) return false;
  return WORKSPACE_CREDENTIAL_FILE_STEMS.includes(fileStem(lowered));
}

/** True when a file's extension alone marks it as binary. */
export function hasBinaryFileExtension(name: string): boolean {
  return WORKSPACE_BINARY_FILE_EXTENSIONS.includes(fileExtension(name));
}

/**
 * True when this entry may not be descended into, read, or searched —
 * whichever of the two rules above applies to its kind.
 */
export function isExcludedEntryName(name: string, kind: 'file' | 'directory'): boolean {
  return kind === 'directory' ? isExcludedDirectoryName(name) : isCredentialFileName(name);
}

/**
 * True when any segment of a project-relative path is excluded.
 *
 * The read path calls this on the whole path rather than only its last
 * segment, so `node_modules/pkg/index.js` is refused even though `index.js`
 * on its own would be fine. A caller that checked only the final name would
 * be relying on the tree never having offered the path — which is exactly the
 * assumption a hand-built request breaks.
 *
 * Every segment but the last is checked as a directory (it must be one, to
 * have something below it); the last is checked as both, because this
 * function is called before anything has looked at the disk to find out which
 * it is.
 */
export function containsExcludedSegment(segments: readonly string[]): boolean {
  return segments.some((segment, index) =>
    index === segments.length - 1
      ? isExcludedDirectoryName(segment) || isCredentialFileName(segment)
      : isExcludedDirectoryName(segment),
  );
}
