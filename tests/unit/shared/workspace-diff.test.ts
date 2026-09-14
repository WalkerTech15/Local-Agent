import { describe, expect, it } from 'vitest';

import { buildFileDiff, isUnchanged, type FileDiff } from '../../../src/shared/workspace/diff';
import { fileDiffSchema } from '../../../src/shared/schemas/coding.schema';
import {
  WORKSPACE_DIFF_CONTEXT_LINES,
  WORKSPACE_DIFF_MAX_LINE_LENGTH,
} from '../../../src/shared/constants';

/**
 * The pure line differ (Phase 2, Milestone 6).
 *
 * This is what a person reads before deciding to let the application write to
 * their disk, so the properties asserted here are in that order of
 * importance: it must describe the change correctly, it must never render
 * text that misrepresents what is stored, and it must stay bounded whatever
 * it is handed.
 */

const BUDGET = 1_000;

function diff(before: string, after: string, maxLines = BUDGET): FileDiff {
  return buildFileDiff({ before, after, maxLines });
}

/** Every line of every hunk, flattened, as `kind:text` for terse assertions. */
function lines(result: FileDiff): string[] {
  return result.hunks.flatMap((hunk) => hunk.lines.map((line) => `${line.kind}:${line.text}`));
}

describe('buildFileDiff — describing the change', () => {
  it('reports no hunks at all when the two texts are identical', () => {
    const result = diff('a\nb\nc\n', 'a\nb\nc\n');
    expect(result.hunks).toEqual([]);
    expect(result.added).toBe(0);
    expect(result.removed).toBe(0);
    expect(isUnchanged('a\nb\nc\n', 'a\nb\nc\n')).toBe(true);
  });

  it('reports a one-line replacement as one removal and one addition', () => {
    const result = diff('a\nb\nc\n', 'a\nB\nc\n');
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
    expect(lines(result)).toContain('removed:b');
    expect(lines(result)).toContain('added:B');
  });

  it('reports a pure insertion without removing anything', () => {
    const result = diff('a\nc\n', 'a\nb\nc\n');
    expect(result.added).toBe(1);
    expect(result.removed).toBe(0);
    expect(lines(result)).toContain('added:b');
  });

  it('reports a pure deletion without adding anything', () => {
    const result = diff('a\nb\nc\n', 'a\nc\n');
    expect(result.added).toBe(0);
    expect(result.removed).toBe(1);
    expect(lines(result)).toContain('removed:b');
  });

  it('keeps unchanged lines as context around the change', () => {
    const result = diff('a\nb\nc\n', 'a\nB\nc\n');
    expect(lines(result)).toContain('context:a');
    expect(lines(result)).toContain('context:c');
  });

  it('numbers a hunk from where it really is, not from the top of the file', () => {
    const before = Array.from({ length: 40 }, (_, index) => `line${String(index)}`).join('\n');
    const after = before.replace('line30', 'CHANGED');
    const result = diff(before, after);

    const hunk = result.hunks[0];
    expect(hunk).toBeDefined();
    // Line 31 is 1-based; the hunk starts `WORKSPACE_DIFF_CONTEXT_LINES` above it.
    expect(hunk?.oldStart).toBe(31 - WORKSPACE_DIFF_CONTEXT_LINES);
    expect(hunk?.newStart).toBe(31 - WORKSPACE_DIFF_CONTEXT_LINES);
  });

  it('shows two distant changes as two separate hunks', () => {
    const before = Array.from({ length: 60 }, (_, index) => `line${String(index)}`).join('\n');
    const after = before.replace('line5', 'FIRST').replace('line50', 'SECOND');
    const result = diff(before, after);
    expect(result.hunks.length).toBe(2);
  });

  it('merges two adjacent changes into one hunk rather than repeating context', () => {
    const before = Array.from({ length: 20 }, (_, index) => `line${String(index)}`).join('\n');
    const after = before.replace('line9', 'A').replace('line10', 'B');
    const result = diff(before, after);
    expect(result.hunks.length).toBe(1);
  });

  it('handles an empty file becoming non-empty, and the reverse', () => {
    expect(diff('', 'a\n').added).toBe(1);
    expect(diff('a\n', '').removed).toBe(1);
  });

  it('reports a changed newline at end of file rather than as a phantom line', () => {
    const result = diff('a\nb\n', 'a\nb');
    expect(result.warnings).toContain('newline-at-end-of-file-changed');
  });

  it('is deterministic: the same inputs produce the same diff', () => {
    expect(diff('a\nb\nc\n', 'a\nX\nc\n')).toEqual(diff('a\nb\nc\n', 'a\nX\nc\n'));
  });
});

describe('buildFileDiff — never misrepresenting what is stored', () => {
  it('replaces a control character and says that it did', () => {
    const result = diff('a\n', `a${String.fromCharCode(9)}b\n`);
    expect(result.warnings).toContain('control-characters');
    for (const line of result.hunks.flatMap((hunk) => hunk.lines)) {
      expect(line.text).not.toContain(String.fromCharCode(9));
    }
  });

  it('removes a bidirectional override and says that it did', () => {
    // A right-to-left override in a diff is the highest-stakes place for one:
    // it is where a person decides whether to write bytes to their own disk.
    const result = diff('const admin = false;\n', 'const admin = ‮eurt‬;\n');
    expect(result.warnings).toContain('bidirectional-control-characters');
    for (const line of result.hunks.flatMap((hunk) => hunk.lines)) {
      expect(line.text).not.toContain('‮');
    }
  });

  it('never reports a warning it did not actually apply', () => {
    const result = diff('a\nb\n', 'a\nc\n');
    expect(result.warnings).toEqual([]);
  });

  it('bounds a very long line and marks it truncated', () => {
    const long = 'x'.repeat(WORKSPACE_DIFF_MAX_LINE_LENGTH * 3);
    const result = diff('a\n', `${long}\n`);
    expect(result.warnings).toContain('line-truncated');
    for (const line of result.hunks.flatMap((hunk) => hunk.lines)) {
      expect(line.text.length).toBeLessThanOrEqual(WORKSPACE_DIFF_MAX_LINE_LENGTH);
    }
  });
});

describe('buildFileDiff — bounds', () => {
  it('stops at the line budget and says the diff is incomplete', () => {
    const before = Array.from({ length: 500 }, (_, index) => `a${String(index)}`).join('\n');
    const after = Array.from({ length: 500 }, (_, index) => `b${String(index)}`).join('\n');
    const result = diff(before, after, 20);
    expect(result.truncated).toBe(true);
    expect(result.hunks.flatMap((hunk) => hunk.lines).length).toBeLessThanOrEqual(20);
  });

  it('falls back to one coarse replacement rather than aligning two huge unrelated files', () => {
    // The pathological case the matrix cap exists for. It must stay fast and
    // must say that it gave up, rather than silently reporting a worse diff.
    const before = Array.from({ length: 2_000 }, (_, index) => `alpha${String(index)}`).join('\n');
    const after = Array.from({ length: 2_000 }, (_, index) => `beta${String(index)}`).join('\n');

    const startedAt = Date.now();
    const result = diff(before, after, 100_000);
    expect(Date.now() - startedAt).toBeLessThan(5_000);

    expect(result.coarse).toBe(true);
    expect(result.added).toBeGreaterThan(0);
    expect(result.removed).toBeGreaterThan(0);
  });

  it('does not claim to be coarse for an ordinary edit to a large file', () => {
    const before = Array.from({ length: 5_000 }, (_, index) => `line${String(index)}`).join('\n');
    const after = before.replace('line2500', 'CHANGED');
    const result = diff(before, after);
    // The shared prefix and suffix are stripped first, so a one-line edit in a
    // 5,000-line file never approaches the matrix bound.
    expect(result.coarse).toBe(false);
    expect(result.added).toBe(1);
    expect(result.removed).toBe(1);
  });

  it('produces a diff its own schema accepts', () => {
    for (const [before, after] of [
      ['a\nb\nc\n', 'a\nX\nc\n'],
      ['', 'new\n'],
      ['old\n', ''],
      ['a\n', `a${String.fromCharCode(7)}‮b\n`],
    ]) {
      const result = diff(before ?? '', after ?? '');
      const parsed = fileDiffSchema.safeParse({
        path: 'src/index.ts',
        name: 'index.ts',
        hunks: result.hunks,
        added: result.added,
        removed: result.removed,
        coarse: result.coarse,
        truncated: result.truncated,
        warnings: result.warnings,
      });
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });
});
