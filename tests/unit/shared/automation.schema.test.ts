import { describe, expect, it } from 'vitest';

import {
  AUTOMATION_ALLOWED_WEBSITE_HOSTS,
  AUTOMATION_TOOL_IDS,
  AUTOMATION_TOOLS,
  findAutomationTool,
  isAutomationToolId,
} from '../../../src/shared/automation/registry';
import { AUTOMATION_ERROR_CODES, AutomationError } from '../../../src/shared/automation/errors';
import { isSafeAutomationUrl } from '../../../src/shared/automation/validation';
import {
  automationCatalogSchema,
  automationRunResultSchema,
  automationToolSchema,
} from '../../../src/shared/schemas/automation.schema';

const NOW = '2026-01-01T00:00:00.000Z';
const RUN_ID = '11111111-1111-4111-8111-111111111111';

describe('the registry names a closed set of tools', () => {
  it('declares every id exactly once', () => {
    expect(new Set(AUTOMATION_TOOL_IDS).size).toBe(AUTOMATION_TOOL_IDS.length);
    expect(AUTOMATION_TOOLS).toHaveLength(AUTOMATION_TOOL_IDS.length);
  });

  it('finds a definition for every declared id', () => {
    for (const id of AUTOMATION_TOOL_IDS) {
      expect(findAutomationTool(id)?.id).toBe(id);
      expect(isAutomationToolId(id)).toBe(true);
    }
  });

  it('refuses an unregistered app, script or arbitrary tool id', () => {
    for (const bogus of [
      'app.powershell',
      'app.cmd',
      'script.custom',
      'shell.execute',
      'window.any',
      '',
      'app.notepad; rm -rf',
    ]) {
      expect(findAutomationTool(bogus)).toBeNull();
      expect(isAutomationToolId(bogus)).toBe(false);
    }
  });

  it('declares no field capable of carrying a command, an argument override or a shell', () => {
    for (const tool of AUTOMATION_TOOLS) {
      expect(tool).not.toHaveProperty('command');
      expect(tool).not.toHaveProperty('shell');
      expect(tool).not.toHaveProperty('cwd');
      expect(tool).not.toHaveProperty('env');
      if (tool.kind === 'launch-app' || tool.kind === 'run-script') {
        // Every argument vector is a literal declared in reviewed source —
        // never populated from anything external — and is empty for every
        // entry today.
        expect(Array.isArray(tool.args)).toBe(true);
      }
    }
  });

  it('routes every tool through the same action type', () => {
    for (const tool of AUTOMATION_TOOLS) {
      expect(tool.actionType).toBe('automation.run');
    }
  });

  it('requires a project only for the project folder tool', () => {
    for (const tool of AUTOMATION_TOOLS) {
      expect(tool.requiresProject, tool.id).toBe(tool.id === 'folder.project');
    }
  });

  it('gives every website tool a URL on the allowed host list', () => {
    for (const tool of AUTOMATION_TOOLS) {
      if (tool.kind !== 'open-website') continue;
      expect(isSafeAutomationUrl(tool.url), tool.id).toBe(true);
    }
  });

  it('lists at least one host, and every allowed host is used by some tool', () => {
    expect(AUTOMATION_ALLOWED_WEBSITE_HOSTS.length).toBeGreaterThan(0);
    const usedHosts = AUTOMATION_TOOLS.filter((tool) => tool.kind === 'open-website').map(
      (tool) => new URL(tool.url).host,
    );
    for (const host of AUTOMATION_ALLOWED_WEBSITE_HOSTS) {
      expect(usedHosts).toContain(host);
    }
  });
});

describe('AutomationError', () => {
  it('carries a code from the closed list and a reviewed message', () => {
    for (const code of AUTOMATION_ERROR_CODES) {
      const error = new AutomationError(code);
      expect(error.code).toBe(code);
      expect(error.message.length).toBeGreaterThan(0);
    }
  });
});

describe('the safe, display-only tool projection', () => {
  it('accepts every registry entry projected to its safe shape', () => {
    for (const tool of AUTOMATION_TOOLS) {
      const projected = {
        id: tool.id,
        kind: tool.kind,
        label: tool.label,
        description: tool.description,
        requiresProject: tool.requiresProject,
      };
      expect(automationToolSchema.safeParse(projected).success, tool.id).toBe(true);
    }
  });

  it('refuses a field an executor would need', () => {
    const tool = AUTOMATION_TOOLS[0];
    if (tool === undefined) throw new Error('registry is empty');
    const withExecutable = {
      id: tool.id,
      kind: tool.kind,
      label: tool.label,
      description: tool.description,
      requiresProject: tool.requiresProject,
      executable: 'evil.exe',
    };
    expect(automationToolSchema.safeParse(withExecutable).success).toBe(false);
  });
});

describe('the catalog and run result schemas', () => {
  it('accepts an empty, idle catalog', () => {
    expect(automationCatalogSchema.safeParse({ tools: [], busy: false }).success).toBe(true);
  });

  function validRun(overrides: Record<string, unknown> = {}) {
    return {
      runId: RUN_ID,
      toolId: 'app.notepad',
      kind: 'launch-app',
      outcome: 'succeeded',
      startedAt: NOW,
      finishedAt: NOW,
      durationMs: 10,
      attempts: 1,
      timedOut: false,
      cancelled: false,
      stoppedByEmergency: false,
      verified: true,
      ...overrides,
    };
  }

  it('accepts a well-formed run result', () => {
    expect(automationRunResultSchema.safeParse(validRun()).success).toBe(true);
  });

  it('refuses a tool id outside the registry', () => {
    expect(automationRunResultSchema.safeParse(validRun({ toolId: 'app.cmd' })).success).toBe(
      false,
    );
  });

  it('bounds attempts to the declared ceiling', () => {
    expect(automationRunResultSchema.safeParse(validRun({ attempts: 0 })).success).toBe(false);
    expect(automationRunResultSchema.safeParse(validRun({ attempts: 100 })).success).toBe(false);
  });

  it('refuses an outcome outside the closed list', () => {
    expect(automationRunResultSchema.safeParse(validRun({ outcome: 'ok' })).success).toBe(false);
  });

  it('refuses an unknown top-level field', () => {
    expect(
      automationRunResultSchema.safeParse(validRun({ output: 'whatever it printed' })).success,
    ).toBe(false);
  });
});
