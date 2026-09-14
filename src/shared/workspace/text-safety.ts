/**
 * Making untrusted text safe to display (Phase 2, Milestone 6).
 *
 * Milestone 5 had one place where text from outside had to be shown as a
 * single line — a search excerpt — and sanitized it inline. Milestone 6 has
 * four: a diff line, a line of command output, a line of `git diff`, and a
 * project's own `package.json` script text inside a native confirmation
 * dialog. That last one is why this is worth having in one tested place: a
 * string that can move the cursor, reorder itself, or run to a hundred lines
 * is at its most dangerous inside the prompt where a person decides whether to
 * let something write to their disk.
 *
 * The rules are the same everywhere:
 *
 *  - control characters, including tab, newline and NUL, become a single
 *    space — never removed silently, because `a<TAB>b` and `ab` are different
 *    text and collapsing them would misrepresent the line;
 *  - bidirectional overrides and isolates are dropped, since they change how
 *    text renders without changing what it is — the "Trojan Source" class this
 *    codebase already guards display strings against;
 *  - the result is bounded, and says whether it had to be.
 *
 * Written as a character walk rather than a regular expression replacement so
 * that no control character has to appear in this file's own source.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

/** What sanitizing had to change, so a caller can say so rather than hide it. */
export interface SanitizedLine {
  readonly text: string;
  /** True when a control character was replaced. */
  readonly hadControlCharacters: boolean;
  /** True when a bidirectional override was removed. */
  readonly hadBidiCharacters: boolean;
  /** True when the length bound cut the line short. */
  readonly truncated: boolean;
}

/** Appended in place of what a length bound removed. */
export const TRUNCATION_MARKER = ' …';

function isControl(code: number): boolean {
  return code < 0x20 || code === 0x7f;
}

function isBidi(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/**
 * Reduces one line of untrusted text to something safe to render, bounded to
 * `maxLength` including the truncation marker.
 */
export function sanitizeDisplayLine(line: string, maxLength: number): SanitizedLine {
  let text = '';
  let hadControlCharacters = false;
  let hadBidiCharacters = false;

  for (const character of line) {
    const code = character.codePointAt(0) ?? 0;
    if (isControl(code)) {
      hadControlCharacters = true;
      text += ' ';
      continue;
    }
    if (isBidi(code)) {
      hadBidiCharacters = true;
      continue;
    }
    text += character;
  }

  if (text.length <= maxLength) {
    return { text, hadControlCharacters, hadBidiCharacters, truncated: false };
  }

  const room = Math.max(0, maxLength - TRUNCATION_MARKER.length);
  return {
    text: (text.slice(0, room) + TRUNCATION_MARKER).slice(0, maxLength),
    hadControlCharacters,
    hadBidiCharacters,
    truncated: true,
  };
}

/**
 * Collapses untrusted text to one bounded single-spaced line.
 *
 * Used for the project script shown in a confirmation dialog: a multi-line
 * script must not be able to push the actual question off the screen, so every
 * run of whitespace becomes exactly one space.
 */
export function collapseToSingleLine(value: string, maxLength: number): string {
  const sanitized = sanitizeDisplayLine(value, Number.MAX_SAFE_INTEGER).text;
  const collapsed = sanitized
    .split(' ')
    .filter((part) => part.length > 0)
    .join(' ');
  if (collapsed.length <= maxLength) return collapsed;
  const room = Math.max(0, maxLength - TRUNCATION_MARKER.length);
  return (collapsed.slice(0, room) + TRUNCATION_MARKER).slice(0, maxLength);
}
