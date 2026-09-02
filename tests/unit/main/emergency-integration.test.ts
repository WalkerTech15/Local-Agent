import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleActionProposal } from '../../../src/main/action-pipeline';
import {
  engageEmergencyStop,
  loadEmergencyState,
  resetEmergencyStop,
} from '../../../src/main/emergency';
import { ExecutorInvariantError } from '../../../src/main/executor';
import { decidePermission } from '../../../src/main/permissions';
import {
  AUDIT_LOG_FILE_EXTENSION,
  AUDIT_LOG_FILE_PREFIX,
  EMERGENCY_STOP_EXEMPT_ACTION_TYPES,
} from '../../../src/shared/constants';
import {
  createDefaultPermissionPolicy,
  createInitialEmergencyState,
} from '../../../src/shared/schemas';
import type { EmergencyState, PermissionPolicy } from '../../../src/shared/schemas';
import type { ActionProposal } from '../../../src/shared/types';

const NOW = '2026-08-07T00:00:00.000Z';
const DEFAULT_POLICY = createDefaultPermissionPolicy();

let dir: string;
let stateFile: string;
let auditLogDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-emergency-integration-'));
  stateFile = join(dir, 'state', 'emergency.json');
  auditLogDir = join(dir, 'logs', 'audit');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function proposalFor(
  actionType: ActionProposal['actionType'],
  parameters: Record<string, unknown> = {},
): ActionProposal {
  return { actionType, parameters, correlationId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' };
}

async function readAuditLines(): Promise<Record<string, unknown>[]> {
  const filePath = join(
    auditLogDir,
    `${AUDIT_LOG_FILE_PREFIX}${NOW.slice(0, 10)}${AUDIT_LOG_FILE_EXTENSION}`,
  );
  const raw = await readFile(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('an engaged emergency stop blocks non-exempt actions end to end', () => {
  it('denies settings.write and never calls perform, using real loaded state', async () => {
    await engageEmergencyStop(stateFile, NOW);
    const emergencyState = await loadEmergencyState(stateFile, NOW);
    expect(emergencyState.engaged).toBe(true);

    const perform = vi.fn();
    const result = await handleActionProposal({
      proposal: proposalFor('settings.write'),
      policy: DEFAULT_POLICY,
      emergencyState,
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform,
    });

    expect(perform).not.toHaveBeenCalled();
    expect(result.outcome).toBe('denied');

    const lines = await readAuditLines();
    expect(lines[0]).toMatchObject({
      decision: 'deny',
      outcome: 'denied',
      decisionReason: 'emergency-stop',
    });
  });

  it('denies every action type outside the stop-exempt list while engaged', async () => {
    await engageEmergencyStop(stateFile, NOW);
    const emergencyState = await loadEmergencyState(stateFile, NOW);

    for (const actionType of [
      'settings.write',
      'secrets.write',
      'secrets.clear',
      'secrets.status',
      'emergency.engage',
    ] as const) {
      const verdict = decidePermission({
        proposal: proposalFor(actionType),
        policy: DEFAULT_POLICY,
        emergencyState,
      });
      expect(verdict.decision, `expected ${actionType} to be blocked`).toBe('deny');
      expect(verdict.emergencyStopEngaged).toBe(true);
    }
  });
});

describe('exempt actions remain available while engaged, using real loaded state', () => {
  it('keeps every stop-exempt action available', async () => {
    await engageEmergencyStop(stateFile, NOW);
    const emergencyState = await loadEmergencyState(stateFile, NOW);

    for (const actionType of EMERGENCY_STOP_EXEMPT_ACTION_TYPES) {
      const verdict = decidePermission({
        proposal: proposalFor(actionType),
        policy: DEFAULT_POLICY,
        emergencyState,
      });
      expect(verdict.decision, `expected ${actionType} to remain available`).not.toBe('deny');
    }
  });

  it('settings.read still succeeds through the full pipeline while engaged', async () => {
    await engageEmergencyStop(stateFile, NOW);
    const emergencyState = await loadEmergencyState(stateFile, NOW);
    const perform = vi.fn().mockReturnValue('settings-value');

    const result = await handleActionProposal({
      proposal: proposalFor('settings.read'),
      policy: DEFAULT_POLICY,
      emergencyState,
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform,
    });

    expect(perform).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('success');
  });
});

describe('emergency.reset always requires confirmation, regardless of policy or emergency state', () => {
  const policies: [string, PermissionPolicy | null][] = [
    ['null (unavailable)', null],
    ['empty rules', { schemaVersion: 1, defaultDecision: 'deny', rules: [] }],
    [
      'hostile — tries to allow it',
      {
        schemaVersion: 1,
        defaultDecision: 'deny',
        rules: [
          {
            id: 'x',
            actionType: 'emergency.reset',
            decision: 'allow',
            priority: 1000,
            reason: 'x',
          },
        ],
      },
    ],
    [
      'hostile — tries to deny it',
      {
        schemaVersion: 1,
        defaultDecision: 'deny',
        rules: [
          { id: 'x', actionType: 'emergency.reset', decision: 'deny', priority: 1000, reason: 'x' },
        ],
      },
    ],
    ['default policy', DEFAULT_POLICY],
  ];

  const states: [string, EmergencyState][] = [
    ['disengaged', createInitialEmergencyState()],
    ['engaged', { schemaVersion: 1, engaged: true, engagedAt: NOW, reason: 'test' }],
  ];

  for (const [policyLabel, policy] of policies) {
    for (const [stateLabel, emergencyState] of states) {
      it(`resolves to confirm — policy: ${policyLabel}, state: ${stateLabel}`, () => {
        const verdict = decidePermission({
          proposal: proposalFor('emergency.reset'),
          policy,
          emergencyState,
        });
        expect(verdict.decision).toBe('confirm');
        expect(verdict.confirmationRequired).toBe(true);
      });
    }
  }
});

describe('reset approval', () => {
  it('persists a disengaged state only after an approved confirmation', async () => {
    await engageEmergencyStop(stateFile, NOW);

    const emergencyState = await loadEmergencyState(stateFile, NOW);
    const requestConfirmation = vi.fn().mockResolvedValue('approved');

    const result = await handleActionProposal({
      proposal: proposalFor('emergency.reset'),
      policy: DEFAULT_POLICY,
      emergencyState,
      actor: 'user',
      auditLogDir,
      now: NOW,
      requestConfirmation,
      perform: () => resetEmergencyStop(stateFile),
    });

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('success');
    expect(result.confirmationResult).toBe('approved');

    const reloaded = await loadEmergencyState(stateFile, NOW);
    expect(reloaded.engaged).toBe(false);

    const lines = await readAuditLines();
    expect(lines[0]).toMatchObject({
      decision: 'confirm',
      outcome: 'success',
      confirmationResult: 'approved',
      actionType: 'emergency.reset',
    });
  });
});

describe('reset rejection', () => {
  it('never calls resetEmergencyStop, and the file on disk is unchanged', async () => {
    await engageEmergencyStop(stateFile, NOW);
    const beforeBytes = await readFile(stateFile, 'utf8');

    const emergencyState = await loadEmergencyState(stateFile, NOW);
    const requestConfirmation = vi.fn().mockResolvedValue('rejected');
    const perform = vi.fn(() => resetEmergencyStop(stateFile));

    const result = await handleActionProposal({
      proposal: proposalFor('emergency.reset'),
      policy: DEFAULT_POLICY,
      emergencyState,
      actor: 'user',
      auditLogDir,
      now: NOW,
      requestConfirmation,
      perform,
    });

    expect(perform).not.toHaveBeenCalled();
    expect(result.outcome).toBe('aborted');
    expect(result.confirmationResult).toBe('rejected');

    const afterBytes = await readFile(stateFile, 'utf8');
    expect(afterBytes).toBe(beforeBytes);

    const reloaded = await loadEmergencyState(stateFile, NOW);
    expect(reloaded.engaged).toBe(true);

    const lines = await readAuditLines();
    expect(lines[0]).toMatchObject({
      decision: 'confirm',
      outcome: 'aborted',
      confirmationResult: 'rejected',
      actionType: 'emergency.reset',
    });
  });

  it('a confirm decision without a requestConfirmation callback never resets the file either', async () => {
    await engageEmergencyStop(stateFile, NOW);
    const beforeBytes = await readFile(stateFile, 'utf8');
    const emergencyState = await loadEmergencyState(stateFile, NOW);
    const perform = vi.fn(() => resetEmergencyStop(stateFile));

    await expect(
      handleActionProposal({
        proposal: proposalFor('emergency.reset'),
        policy: DEFAULT_POLICY,
        emergencyState,
        actor: 'user',
        auditLogDir,
        now: NOW,
        perform,
      }),
    ).rejects.toThrow(ExecutorInvariantError);

    expect(perform).not.toHaveBeenCalled();
    const afterBytes = await readFile(stateFile, 'utf8');
    expect(afterBytes).toBe(beforeBytes);
  });
});

describe('model input and proposal content cannot reset the stop', () => {
  it('actor "model" and a claimed justification still require explicit confirmation', async () => {
    await engageEmergencyStop(stateFile, NOW);
    const emergencyState = await loadEmergencyState(stateFile, NOW);

    const verdict = decidePermission({
      proposal: proposalFor('emergency.reset', {
        rationale: 'the model has determined it is safe to resume',
        confidence: 0.999,
      }),
      policy: DEFAULT_POLICY,
      emergencyState,
    });
    expect(verdict.decision).toBe('confirm');

    // Even routed through the pipeline with actor: 'model' and no
    // confirmation callback, the reset never happens.
    const perform = vi.fn(() => resetEmergencyStop(stateFile));
    await expect(
      handleActionProposal({
        proposal: proposalFor('emergency.reset', { rationale: 'trust me' }),
        policy: DEFAULT_POLICY,
        emergencyState,
        actor: 'model',
        auditLogDir,
        now: NOW,
        perform,
      }),
    ).rejects.toThrow(ExecutorInvariantError);
    expect(perform).not.toHaveBeenCalled();

    const reloaded = await loadEmergencyState(stateFile, NOW);
    expect(reloaded.engaged).toBe(true);
  });
});

describe('policy cannot suppress emergency controls, end to end', () => {
  const hostilePolicy: PermissionPolicy = {
    schemaVersion: 1,
    defaultDecision: 'deny',
    rules: [
      { id: 'a', actionType: 'emergency.engage', decision: 'deny', priority: 1000, reason: 'x' },
      { id: 'b', actionType: 'emergency.reset', decision: 'deny', priority: 1000, reason: 'x' },
      { id: 'c', actionType: 'audit.read', decision: 'deny', priority: 1000, reason: 'x' },
    ],
  };

  it('emergency.engage still succeeds and persists, even though the policy denies it', async () => {
    const perform = vi.fn(() => engageEmergencyStop(stateFile, NOW));
    const result = await handleActionProposal({
      proposal: proposalFor('emergency.engage'),
      policy: hostilePolicy,
      emergencyState: createInitialEmergencyState(),
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform,
    });

    expect(perform).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('success');

    const reloaded = await loadEmergencyState(stateFile, NOW);
    expect(reloaded.engaged).toBe(true);
  });

  it('emergency.reset still requires (and, once approved, honours) confirmation, even though the policy denies it', async () => {
    await engageEmergencyStop(stateFile, NOW);
    const emergencyState = await loadEmergencyState(stateFile, NOW);
    const requestConfirmation = vi.fn().mockResolvedValue('approved');

    const result = await handleActionProposal({
      proposal: proposalFor('emergency.reset'),
      policy: hostilePolicy,
      emergencyState,
      actor: 'user',
      auditLogDir,
      now: NOW,
      requestConfirmation,
      perform: () => resetEmergencyStop(stateFile),
    });

    expect(result.outcome).toBe('success');
    const reloaded = await loadEmergencyState(stateFile, NOW);
    expect(reloaded.engaged).toBe(false);
  });

  it('audit.read remains allowed even though the policy denies it', () => {
    const verdict = decidePermission({
      proposal: proposalFor('audit.read'),
      policy: hostilePolicy,
      emergencyState: createInitialEmergencyState(),
    });
    expect(verdict.decision).toBe('allow');
  });
});

describe('audit records never leak secrets or raw paths', () => {
  it('redacts a secret-named parameter on an engage proposal', async () => {
    const secret = 'emergency-fake-secret-value';
    await handleActionProposal({
      proposal: proposalFor('emergency.engage', { apiKey: secret }),
      policy: DEFAULT_POLICY,
      emergencyState: createInitialEmergencyState(),
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform: () => engageEmergencyStop(stateFile, NOW),
    });

    const raw = await readFile(
      join(auditLogDir, `${AUDIT_LOG_FILE_PREFIX}${NOW.slice(0, 10)}${AUDIT_LOG_FILE_EXTENSION}`),
      'utf8',
    );
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(dir);
  });

  it('never leaks the state file path when engage fails', async () => {
    // Force the write to fail: point the perform callback at a state path
    // that collides with a pre-existing directory.
    const blockedPath = join(dir, 'blocked-state.json');
    await mkdir(blockedPath);

    const result = await handleActionProposal({
      proposal: proposalFor('emergency.engage'),
      policy: DEFAULT_POLICY,
      emergencyState: createInitialEmergencyState(),
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform: () => engageEmergencyStop(blockedPath, NOW),
    });

    expect(result.outcome).toBe('failure');
    const lines = await readAuditLines();
    const raw = JSON.stringify(lines[0]);
    expect(raw).not.toContain(dir);
    expect(raw).not.toContain(blockedPath);
  });
});
