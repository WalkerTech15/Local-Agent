/**
 * The pure line differ (Phase 2, Milestone 6).
 *
 * A change is only reviewable if the person approving it can see what it
 * does, so this module turns "the file said A, the proposal says B" into a
 * unified diff before anything is written. It is the whole of the "show a
 * diff before applying it" requirement, and it lives in `src/shared` — no
 * I/O, no clock, no Node built-in — so the same function that produces what
 * the user reads can be driven directly by a test with two strings.
 *
 * Three properties are worth stating before the code:
 *
 *  - **It is bounded in every dimension.** Line alignment is quadratic in the
 *    number of *differing* lines, so a shared prefix and suffix are removed
 *    first and what remains is capped by
 *    {@link WORKSPACE_DIFF_MAX_MATRIX_CELLS}. Past that the differ stops
 *    trying to align and reports one coarse replacement, flagged as such.
 *    Line count and line length are capped too. A pathological pair of files
 *    produces a smaller answer, never a slower one.
 *  - **It never decides anything.** A diff is a description. Nothing here
 *    writes, and nothing here authorizes a write — `main/workspace-changes.ts`
 *    does that, from a change set the main process holds, only after the
 *    permission engine and a native confirmation have both allowed it.
 *  - **Displayed text is sanitized, and says so.** Control characters and
 *    bidirectional overrides are removed from the lines shown, because a diff
 *    is the one screen where text that renders differently from how it is
 *    stored would do the most damage: it is where a person decides whether to
 *    write bytes to their own disk. Sanitizing silently would be its own lie,
 *    so any diff that had to sanitize carries a warning saying so. The bytes
 *    actually written are always the proposed content, never this rendering.
 *
 * Pure: no I/O, no Node built-in, no Electron.
 */

import {
  WORKSPACE_DIFF_CONTEXT_LINES,
  WORKSPACE_DIFF_MAX_LINE_LENGTH,
  WORKSPACE_DIFF_MAX_MATRIX_CELLS,
} from '../constants';
import { sanitizeDisplayLine } from './text-safety';

/** What one rendered diff line is. */
export const DIFF_LINE_KINDS = ['context', 'added', 'removed'] as const;
export type DiffLineKind = (typeof DIFF_LINE_KINDS)[number];

/** Conditions a reader must know about before approving the change. */
export const DIFF_WARNINGS = [
  'bidirectional-control-characters',
  'control-characters',
  'newline-at-end-of-file-changed',
  'line-truncated',
] as const;
export type DiffWarning = (typeof DIFF_WARNINGS)[number];

export interface DiffLine {
  readonly kind: DiffLineKind;
  /** Already sanitized and bounded. Never the raw bytes to be written. */
  readonly text: string;
}

export interface DiffHunk {
  /** 1-based first line of the hunk in the original file. */
  readonly oldStart: number;
  readonly oldLines: number;
  /** 1-based first line of the hunk in the proposed file. */
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export interface FileDiff {
  readonly hunks: readonly DiffHunk[];
  readonly added: number;
  readonly removed: number;
  /**
   * True when the differ gave up on aligning lines and reported the whole
   * differing region as one replacement. The change itself is unaffected —
   * only how precisely it is described.
   */
  readonly coarse: boolean;
  /** True when a bound stopped the diff before it was complete. */
  readonly truncated: boolean;
  readonly warnings: readonly DiffWarning[];
}

interface SplitText {
  readonly lines: readonly string[];
  readonly endsWithNewline: boolean;
}

/**
 * Splits text into lines, remembering whether it ended with a newline.
 *
 * Tracked rather than ignored because adding or removing a final newline is a
 * real change to a file that a naive split renders as an empty line appearing
 * or disappearing — which reads as noise instead of as what it is.
 */
function splitLines(text: string): SplitText {
  if (text.length === 0) return { lines: [], endsWithNewline: false };
  const parts = text.split('\n');
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    return { lines: parts.slice(0, -1), endsWithNewline: true };
  }
  return { lines: parts, endsWithNewline: false };
}

/**
 * Renders one line for display, recording anything sanitizing had to change.
 *
 * The change actually written is always the proposed content; this is only
 * how the line is shown. Any alteration is added to the diff's warnings, so a
 * sanitized diff never passes itself off as a verbatim one.
 */
function renderLine(kind: DiffLineKind, raw: string, warnings: Set<DiffWarning>): DiffLine {
  const sanitized = sanitizeDisplayLine(raw, WORKSPACE_DIFF_MAX_LINE_LENGTH);
  if (sanitized.hadControlCharacters) warnings.add('control-characters');
  if (sanitized.hadBidiCharacters) warnings.add('bidirectional-control-characters');
  if (sanitized.truncated) warnings.add('line-truncated');
  return { kind, text: sanitized.text };
}

/** One step of the alignment, before it is grouped into hunks. */
interface EditOp {
  readonly kind: DiffLineKind;
  readonly text: string;
}

/**
 * Aligns two line arrays with a longest-common-subsequence table.
 *
 * Called only on the *differing* middle of the two files, after the shared
 * prefix and suffix have been removed, and only when that middle is small
 * enough — {@link alignLines} makes that decision, not this function.
 *
 * `Int32Array` rather than a nested array: one flat allocation of a known
 * size, which is what makes the cell cap a real memory bound rather than an
 * approximate one.
 */
function lcsOps(before: readonly string[], after: readonly string[]): EditOp[] {
  const rows = before.length + 1;
  const columns = after.length + 1;
  const table = new Int32Array(rows * columns);

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      const index = i * columns + j;
      table[index] =
        before[i] === after[j]
          ? (table[(i + 1) * columns + (j + 1)] ?? 0) + 1
          : Math.max(table[(i + 1) * columns + j] ?? 0, table[index + 1] ?? 0);
    }
  }

  const ops: EditOp[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'context', text: before[i] ?? '' });
      i += 1;
      j += 1;
      continue;
    }
    if ((table[(i + 1) * columns + j] ?? 0) >= (table[i * columns + (j + 1)] ?? 0)) {
      ops.push({ kind: 'removed', text: before[i] ?? '' });
      i += 1;
      continue;
    }
    ops.push({ kind: 'added', text: after[j] ?? '' });
    j += 1;
  }
  while (i < before.length) {
    ops.push({ kind: 'removed', text: before[i] ?? '' });
    i += 1;
  }
  while (j < after.length) {
    ops.push({ kind: 'added', text: after[j] ?? '' });
    j += 1;
  }
  return ops;
}

interface Alignment {
  readonly ops: readonly EditOp[];
  readonly coarse: boolean;
}

/**
 * Produces the full edit script for two files.
 *
 * Shared leading and trailing lines are emitted as context without ever
 * entering the table, which is what keeps an ordinary one-line edit to a
 * handful of cells no matter how large the file is. Only what genuinely
 * differs is aligned, and only if doing so fits inside
 * {@link WORKSPACE_DIFF_MAX_MATRIX_CELLS}.
 */
function alignLines(before: readonly string[], after: readonly string[]): Alignment {
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }

  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const beforeMiddle = before.slice(prefix, before.length - suffix);
  const afterMiddle = after.slice(prefix, after.length - suffix);

  const head: EditOp[] = before
    .slice(0, prefix)
    .map((text) => ({ kind: 'context' as const, text }));
  const tail: EditOp[] = before
    .slice(before.length - suffix)
    .map((text) => ({ kind: 'context' as const, text }));

  const cells = (beforeMiddle.length + 1) * (afterMiddle.length + 1);
  if (cells > WORKSPACE_DIFF_MAX_MATRIX_CELLS) {
    // Too far apart to align affordably. Report the whole differing region as
    // one replacement and say so, rather than spending the privileged
    // process's CPU on a pair of unrelated files.
    const coarseOps: EditOp[] = [
      ...beforeMiddle.map((text) => ({ kind: 'removed' as const, text })),
      ...afterMiddle.map((text) => ({ kind: 'added' as const, text })),
    ];
    return { ops: [...head, ...coarseOps, ...tail], coarse: true };
  }

  return { ops: [...head, ...lcsOps(beforeMiddle, afterMiddle), ...tail], coarse: false };
}

export interface BuildFileDiffInput {
  readonly before: string;
  readonly after: string;
  /**
   * Maximum diff lines this file may contribute. Supplied by the caller so a
   * change set of several files shares one budget rather than each file
   * having its own — the bound that matters is on the whole thing a person
   * has to read.
   */
  readonly maxLines: number;
}

/**
 * Builds one file's unified diff.
 *
 * Returns no hunks at all when the two texts are identical, which is what
 * `main/workspace-changes.ts` uses to refuse a proposal that would change
 * nothing.
 */
export function buildFileDiff(input: BuildFileDiffInput): FileDiff {
  const { before, after, maxLines } = input;

  const beforeSplit = splitLines(before);
  const afterSplit = splitLines(after);
  const warnings = new Set<DiffWarning>();
  if (beforeSplit.endsWithNewline !== afterSplit.endsWithNewline) {
    warnings.add('newline-at-end-of-file-changed');
  }

  const { ops, coarse } = alignLines(beforeSplit.lines, afterSplit.lines);

  const changedIndexes: number[] = [];
  ops.forEach((op, index) => {
    if (op.kind !== 'context') changedIndexes.push(index);
  });

  if (changedIndexes.length === 0 && warnings.size === 0) {
    return { hunks: [], added: 0, removed: 0, coarse, truncated: false, warnings: [] };
  }

  // Group changes into ranges, each padded by the context bound, merging any
  // two ranges that would otherwise overlap or abut.
  const ranges: { start: number; end: number }[] = [];
  for (const index of changedIndexes) {
    const start = Math.max(0, index - WORKSPACE_DIFF_CONTEXT_LINES);
    const end = Math.min(ops.length - 1, index + WORKSPACE_DIFF_CONTEXT_LINES);
    const last = ranges[ranges.length - 1];
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
      continue;
    }
    ranges.push({ start, end });
  }

  const hunks: DiffHunk[] = [];
  let added = 0;
  let removed = 0;
  let emitted = 0;
  let truncated = false;

  // Running 1-based line numbers in each file, advanced by every op so a
  // hunk header reports where it really is rather than where it would be if
  // the skipped context did not exist.
  let oldLine = 1;
  let newLine = 1;
  let cursor = 0;

  for (const range of ranges) {
    while (cursor < range.start) {
      const op = ops[cursor];
      if (op !== undefined) {
        if (op.kind !== 'added') oldLine += 1;
        if (op.kind !== 'removed') newLine += 1;
      }
      cursor += 1;
    }

    const lines: DiffLine[] = [];
    const oldStart = oldLine;
    const newStart = newLine;
    let oldCount = 0;
    let newCount = 0;

    while (cursor <= range.end) {
      if (emitted >= maxLines) {
        truncated = true;
        break;
      }
      const op = ops[cursor];
      cursor += 1;
      if (op === undefined) continue;

      lines.push(renderLine(op.kind, op.text, warnings));
      emitted += 1;
      if (op.kind !== 'added') {
        oldLine += 1;
        oldCount += 1;
      }
      if (op.kind !== 'removed') {
        newLine += 1;
        newCount += 1;
      }
      if (op.kind === 'added') added += 1;
      if (op.kind === 'removed') removed += 1;
    }

    if (lines.length > 0) {
      hunks.push({ oldStart, oldLines: oldCount, newStart, newLines: newCount, lines });
    }
    if (truncated) break;
  }

  return { hunks, added, removed, coarse, truncated, warnings: [...warnings] };
}

/** True when the two texts are byte-identical, so there is nothing to apply. */
export function isUnchanged(before: string, after: string): boolean {
  return before === after;
}
