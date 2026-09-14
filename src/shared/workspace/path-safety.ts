/**
 * Lexical safety for renderer-supplied workspace paths (Phase 2, Milestone 5).
 *
 * This is the **first** of two independent containment defences, and the only
 * one that can run without touching a filesystem. It decides whether a string
 * is even shaped like a path inside a project, before `src/main` resolves it
 * against a real root and re-checks the result (`src/main/workspace-paths.ts`).
 * Neither is sufficient alone: a lexical check cannot see a symbolic link, and
 * a `realpath` check cannot run at all on a string that would first have to be
 * joined onto a root — which is exactly the join a `..` segment or an absolute
 * path subverts.
 *
 * The canonical form is deliberately narrow: `/`-separated, relative, no `.`
 * or `..`, no drive letter, no UNC prefix, no NTFS alternate-data-stream
 * colon, no Windows reserved device name, no wildcard or redirection
 * character, and no trailing dot or space (Windows silently strips both, so
 * `secrets.` and `secrets` name the same file — an aliasing route around any
 * name-based rule). Every path the renderer sends was produced by this
 * codebase's own tree listing, in exactly this form, so nothing legitimate is
 * rejected by refusing everything else.
 *
 * Pure: no I/O, no Node built-in, no Electron. `node:path` is deliberately not
 * used — it is unavailable here by lint boundary, and its platform-dependent
 * behaviour is the wrong tool for a rule that must be identical everywhere.
 */

import {
  BIDI_CONTROL_PATTERN,
  CONTROL_CHARACTER_PATTERN,
  WORKSPACE_MAX_PATH_SEGMENT_LENGTH,
  WORKSPACE_MAX_PATH_SEGMENTS,
  WORKSPACE_MAX_RELATIVE_PATH_LENGTH,
} from '../constants';

/**
 * Characters that are never part of a legitimate project-relative path here.
 *
 * `\` — the Windows separator, excluded so there is exactly one canonical
 * separator and `..\..` cannot slip past a `/`-oriented segment check.
 * `:`   — a drive letter (`C:`) and, more subtly, the NTFS alternate-data-
 *         stream separator: `notes.txt:hidden` names a different stream of the
 *         same file, which no listing here would ever have shown.
 * `*?`  — wildcards, which some APIs expand.
 * `<>|` — shell redirection and pipe characters.
 * `"`   — quoting.
 */
const FORBIDDEN_PATH_CHARACTERS = /[\\:*?"<>|]/;

/**
 * Windows reserved device names, matched case-insensitively against the
 * segment's stem (the part before the first dot).
 *
 * `CON`, `NUL` and the `COM`/`LPT` series are devices, not files: opening one
 * succeeds and either blocks or returns device data, whatever directory the
 * name appears in. Rejecting them costs nothing — none is a legal file name
 * on Windows anyway — and removes a whole class of surprising reads on a
 * project tree that may have come from another platform.
 */
const RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com0',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt0',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/** Why a candidate was rejected. Stable identifiers, used by tests and logs. */
export type WorkspacePathRejection =
  | 'not-a-string'
  | 'too-long'
  | 'control-character'
  | 'bidi-character'
  | 'forbidden-character'
  | 'absolute'
  | 'empty-segment'
  | 'relative-segment'
  | 'too-many-segments'
  | 'segment-too-long'
  | 'trailing-dot-or-space'
  | 'reserved-device-name';

export type WorkspacePathResult =
  | { readonly ok: true; readonly path: string; readonly segments: readonly string[] }
  | { readonly ok: false; readonly rejection: WorkspacePathRejection };

/**
 * Validates and canonicalises one project-relative path.
 *
 * The empty string is **valid** and means the project root itself, with no
 * segments. Callers that need an entry rather than the root check
 * `segments.length` themselves rather than this function guessing which they
 * wanted.
 *
 * Never throws, so a caller cannot forget to handle a rejection: an invalid
 * path is a value, not an exception.
 */
export function normalizeWorkspaceRelativePath(value: unknown): WorkspacePathResult {
  if (typeof value !== 'string') return { ok: false, rejection: 'not-a-string' };
  if (value.length > WORKSPACE_MAX_RELATIVE_PATH_LENGTH) {
    return { ok: false, rejection: 'too-long' };
  }
  if (CONTROL_CHARACTER_PATTERN.test(value)) {
    return { ok: false, rejection: 'control-character' };
  }
  // A bidirectional override in a file name reorders how the name *renders*
  // without changing what it is, so `report.exe` can be made to display as
  // `report.txt` in the tree. The same "Trojan Source" defence the settings
  // schema already applies to display strings, extended here because a path
  // is displayed to a human who then decides whether to open it.
  if (BIDI_CONTROL_PATTERN.test(value)) {
    return { ok: false, rejection: 'bidi-character' };
  }
  if (FORBIDDEN_PATH_CHARACTERS.test(value)) {
    return { ok: false, rejection: 'forbidden-character' };
  }
  // A leading `/` is absolute; so is the `//server/share` UNC form, which the
  // leading-slash check already covers.
  if (value.startsWith('/')) return { ok: false, rejection: 'absolute' };

  if (value.length === 0) return { ok: true, path: '', segments: [] };

  const segments = value.split('/');
  if (segments.length > WORKSPACE_MAX_PATH_SEGMENTS) {
    return { ok: false, rejection: 'too-many-segments' };
  }

  for (const segment of segments) {
    // Also catches a trailing separator (`src/`) and a doubled one (`a//b`),
    // both of which would otherwise resolve to the same entry by a second
    // spelling — and a second spelling is what defeats a name-based rule.
    if (segment.length === 0) return { ok: false, rejection: 'empty-segment' };
    if (segment.length > WORKSPACE_MAX_PATH_SEGMENT_LENGTH) {
      return { ok: false, rejection: 'segment-too-long' };
    }
    if (segment === '.' || segment === '..') {
      return { ok: false, rejection: 'relative-segment' };
    }
    if (segment.endsWith('.') || segment.endsWith(' ') || segment.startsWith(' ')) {
      return { ok: false, rejection: 'trailing-dot-or-space' };
    }
    const stem = segment.split('.')[0] ?? '';
    if (RESERVED_DEVICE_NAMES.has(stem.toLowerCase())) {
      return { ok: false, rejection: 'reserved-device-name' };
    }
  }

  return { ok: true, path: segments.join('/'), segments };
}

/** True when {@link normalizeWorkspaceRelativePath} accepts `value`. */
export function isSafeWorkspaceRelativePath(value: unknown): boolean {
  return normalizeWorkspaceRelativePath(value).ok;
}

/**
 * Joins a parent path and one child segment into the canonical form.
 *
 * Used by the tree walk to build each entry's path as it descends, so that
 * every path the renderer ever receives is already in the exact shape
 * {@link normalizeWorkspaceRelativePath} accepts when it comes back.
 */
export function joinWorkspacePath(parent: string, segment: string): string {
  return parent.length === 0 ? segment : `${parent}/${segment}`;
}
