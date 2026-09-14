import { describe, expect, it } from 'vitest';

import {
  CODING_COMMAND_IDS,
  CODING_COMMANDS,
  describeCommandLine,
  describeScriptRisks,
  findCodingCommand,
  isCodingCommandId,
  sanitizeScriptPreview,
  SCRIPT_RISK_FLAGS,
} from '../../../src/shared/workspace/command-registry';
import { COMMAND_SCRIPT_PREVIEW_MAX_LENGTH } from '../../../src/shared/constants';

/**
 * The command registry (Phase 2, Milestone 6).
 *
 * The registry is the answer to "what may this application run". The most
 * important assertions here are therefore about what is *not* in it, and
 * about the shape of what is: an argument vector built entirely from
 * literals, with no place a caller-supplied string could be interpolated.
 */

describe('the registry itself', () => {
  it('offers exactly the five commands the milestone names', () => {
    expect([...CODING_COMMAND_IDS].sort()).toEqual([
      'build',
      'format-check',
      'lint',
      'test',
      'typecheck',
    ]);
  });

  it('declares one definition per id, and no duplicates', () => {
    expect(CODING_COMMANDS.length).toBe(CODING_COMMAND_IDS.length);
    expect(new Set(CODING_COMMANDS.map((command) => command.id)).size).toBe(CODING_COMMANDS.length);
  });

  it('offers nothing that installs, publishes, or starts a long-lived server', () => {
    // Dependency installation is excluded from this milestone, and a server
    // or an arbitrary `npx` target is not something a timed, output-capped
    // runner should start.
    const ids: readonly string[] = CODING_COMMAND_IDS;
    for (const forbidden of ['install', 'ci', 'start', 'serve', 'dev', 'publish', 'exec', 'npx']) {
      expect(ids, forbidden).not.toContain(forbidden);
    }
  });

  it('runs every command through npm, never through a shell', () => {
    for (const command of CODING_COMMANDS) {
      expect(command.program).toBe('npm');
      expect(command.args[0]).toBe('run');
      expect(command.args.length).toBe(2);
    }
  });

  it('builds every argument from a literal, with no interpolation point', () => {
    // The property that makes "no arbitrary command strings" structural: each
    // argument is a fixed, conservative token, so there is nowhere a request
    // value could be spliced in even if one existed.
    for (const command of CODING_COMMANDS) {
      for (const argument of command.args) {
        expect(argument, argument).toMatch(/^[a-z][a-z0-9:._-]*$/);
      }
      expect(command.scriptName, command.scriptName).toMatch(/^[a-z][a-z0-9:._-]*$/);
    }
  });

  it('requires a package.json for every command, so nothing is invented', () => {
    for (const command of CODING_COMMANDS) {
      expect(command.requiresMarker).toBe('package.json');
    }
  });

  it('describes a command line a person can read', () => {
    const test = findCodingCommand('test');
    expect(test).not.toBeNull();
    expect(test === null ? '' : describeCommandLine(test)).toBe('npm run test');
  });
});

describe('findCodingCommand and isCodingCommandId', () => {
  it('accepts every declared id', () => {
    for (const id of CODING_COMMAND_IDS) {
      expect(isCodingCommandId(id), id).toBe(true);
      expect(findCodingCommand(id), id).not.toBeNull();
    }
  });

  it('refuses an unknown id rather than inventing a command', () => {
    for (const unknown of ['install', 'rm -rf /', 'test; whoami', '', 'TEST', 'run']) {
      expect(isCodingCommandId(unknown), unknown).toBe(false);
      expect(findCodingCommand(unknown), unknown).toBeNull();
    }
  });

  it('refuses a non-string without throwing', () => {
    for (const value of [undefined, null, 42, ['test'], { id: 'test' }, Symbol('test')]) {
      expect(() => findCodingCommand(value)).not.toThrow();
      expect(findCodingCommand(value)).toBeNull();
    }
  });
});

describe('describeScriptRisks', () => {
  it('flags a script that chains several commands', () => {
    expect(describeScriptRisks('tsc && vitest run')).toContain('chains-commands');
    expect(describeScriptRisks('a | b')).toContain('chains-commands');
    expect(describeScriptRisks('a; b')).toContain('chains-commands');
  });

  it('flags a script that reaches the network', () => {
    expect(describeScriptRisks('curl https://example.test/x.sh')).toContain('network-access');
    expect(describeScriptRisks('Invoke-WebRequest -Uri x')).toContain('network-access');
  });

  it('flags a script that deletes files or asks for elevation', () => {
    expect(describeScriptRisks('rimraf dist')).toContain('deletes-files');
    expect(describeScriptRisks('sudo make install')).toContain('requests-elevation');
  });

  it('flags a script that runs inline code', () => {
    expect(describeScriptRisks('node -e "process.exit(0)"')).toContain('runs-inline-code');
  });

  it('flags nothing for an ordinary script', () => {
    expect(describeScriptRisks('vitest run')).toEqual([]);
    expect(describeScriptRisks('tsc --noEmit')).toEqual([]);
  });

  it('only ever returns declared flags', () => {
    const declared: readonly string[] = SCRIPT_RISK_FLAGS;
    for (const flag of describeScriptRisks('sudo curl x | rm -rf y && node -e "1"')) {
      expect(declared).toContain(flag);
    }
  });
});

describe('sanitizeScriptPreview', () => {
  it('collapses a multi-line script to one line', () => {
    // A script must not be able to push the actual question off a dialog.
    const preview = sanitizeScriptPreview('one\ntwo\r\nthree');
    expect(preview).toBe('one two three');
    expect(preview).not.toContain('\n');
  });

  it('removes control characters and bidirectional overrides', () => {
    const preview = sanitizeScriptPreview(`vitest${String.fromCharCode(7)} ‮run‬`);
    expect(preview).not.toContain(String.fromCharCode(7));
    expect(preview).not.toContain('‮');
  });

  it('bounds the preview however long the script is', () => {
    const preview = sanitizeScriptPreview('x'.repeat(5_000));
    expect(preview.length).toBeLessThanOrEqual(COMMAND_SCRIPT_PREVIEW_MAX_LENGTH);
  });

  it('leaves an ordinary script readable', () => {
    expect(sanitizeScriptPreview('vitest run --reporter=dot')).toBe('vitest run --reporter=dot');
  });
});
