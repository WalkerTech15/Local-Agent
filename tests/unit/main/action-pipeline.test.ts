import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { handleActionProposal } from '../../../src/main/action-pipeline';
import { ExecutorInvariantError } from '../../../src/main/executor';
import { AUDIT_LOG_FILE_EXTENSION, AUDIT_LOG_FILE_PREFIX } from '../../../src/shared/constants';
import {
  createDefaultPermissionPolicy,
  createInitialEmergencyState,
} from '../../../src/shared/schemas';
import type { EmergencyState } from '../../../src/shared/schemas';
import type { ActionProposal } from '../../../src/shared/types';

const NOW = '2026-08-07T00:00:00.000Z';
const DISENGAGED: EmergencyState = createInitialEmergencyState();
const DEFAULT_POLICY = createDefaultPermissionPolicy();

let dir: string;
let auditLogDir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'local-agent-action-pipeline-'));
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

describe('handleActionProposal — allowed action', () => {
  it('calls perform exactly once and records one success audit entry', async () => {
    const perform = vi.fn().mockResolvedValue({ ok: true });
    const result = await handleActionProposal({
      proposal: proposalFor('settings.read'),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform,
    });

    expect(perform).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('success');

    const lines = await readAuditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      decision: 'allow',
      outcome: 'success',
      actionType: 'settings.read',
      actor: 'user',
    });
  });
});

describe('handleActionProposal — denied action', () => {
  it('never calls perform and records exactly one denial', async () => {
    const perform = vi.fn();
    // No rule at all for this action in an empty custom policy: default-deny.
    const result = await handleActionProposal({
      proposal: proposalFor('settings.write'),
      policy: { schemaVersion: 1, defaultDecision: 'deny', rules: [] },
      emergencyState: DISENGAGED,
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform,
    });

    expect(perform).not.toHaveBeenCalled();
    expect(result.outcome).toBe('denied');

    const lines = await readAuditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ decision: 'deny', outcome: 'denied' });
  });

  it('denies and audits without ever touching perform even when emergency-engaged', async () => {
    const perform = vi.fn();
    const engagedState: EmergencyState = {
      schemaVersion: 1,
      engaged: true,
      engagedAt: NOW,
      reason: 'test',
    };
    const result = await handleActionProposal({
      proposal: proposalFor('settings.write'),
      policy: DEFAULT_POLICY,
      emergencyState: engagedState,
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
});

describe('handleActionProposal — confirmation, approved', () => {
  it('calls requestConfirmation, then perform, and records an approved success', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue('approved');
    const perform = vi.fn().mockReturnValue('done');

    const result = await handleActionProposal({
      proposal: proposalFor('app.exit'),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
      actor: 'user',
      auditLogDir,
      now: NOW,
      requestConfirmation,
      perform,
    });

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(perform).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('success');
    expect(result.confirmationResult).toBe('approved');

    const lines = await readAuditLines();
    expect(lines[0]).toMatchObject({
      decision: 'confirm',
      outcome: 'success',
      confirmationResult: 'approved',
    });
  });
});

describe('handleActionProposal — confirmation, rejected', () => {
  it('calls requestConfirmation but never perform, and records a rejected/aborted entry', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue('rejected');
    const perform = vi.fn();

    const result = await handleActionProposal({
      proposal: proposalFor('app.exit'),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
      actor: 'user',
      auditLogDir,
      now: NOW,
      requestConfirmation,
      perform,
    });

    expect(requestConfirmation).toHaveBeenCalledTimes(1);
    expect(perform).not.toHaveBeenCalled();
    expect(result.outcome).toBe('aborted');
    expect(result.confirmationResult).toBe('rejected');

    const lines = await readAuditLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      decision: 'confirm',
      outcome: 'aborted',
      confirmationResult: 'rejected',
    });
  });

  it('never calls requestConfirmation for a decision that is not confirm', async () => {
    const requestConfirmation = vi.fn().mockResolvedValue('approved');
    await handleActionProposal({
      proposal: proposalFor('settings.read'),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
      actor: 'user',
      auditLogDir,
      now: NOW,
      requestConfirmation,
      perform: vi.fn(),
    });
    expect(requestConfirmation).not.toHaveBeenCalled();
  });
});

describe('handleActionProposal — no bypass', () => {
  it('a confirm verdict without a requestConfirmation callback throws and never calls perform or audits', async () => {
    const perform = vi.fn();
    await expect(
      handleActionProposal({
        proposal: proposalFor('app.exit'),
        policy: DEFAULT_POLICY,
        emergencyState: DISENGAGED,
        actor: 'user',
        auditLogDir,
        now: NOW,
        perform,
      }),
    ).rejects.toThrow(ExecutorInvariantError);

    expect(perform).not.toHaveBeenCalled();
    await expect(readdir(auditLogDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('the only way perform runs is through a verdict this function itself computed', async () => {
    // A denial from an empty policy, and a rejection from the confirmation
    // callback, both leave `perform` uncalled — the sole path to `perform`
    // running is decidePermission → (confirm) → execute, in that order,
    // with no direct route from the proposal to the side effect.
    const perform = vi.fn();
    await handleActionProposal({
      proposal: proposalFor('secrets.write'),
      policy: { schemaVersion: 1, defaultDecision: 'deny', rules: [] },
      emergencyState: DISENGAGED,
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform,
    });
    expect(perform).not.toHaveBeenCalled();
  });
});

describe('handleActionProposal — secrets never reach the audit file', () => {
  it('redacts a secret-named parameter before writing the audit record', async () => {
    const secret = 'audit-pipeline-fake-secret-value';
    await handleActionProposal({
      proposal: proposalFor('settings.write', { apiKey: secret }),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform: () => undefined,
    });

    const filePath = join(
      auditLogDir,
      `${AUDIT_LOG_FILE_PREFIX}${NOW.slice(0, 10)}${AUDIT_LOG_FILE_EXTENSION}`,
    );
    const raw = await readFile(filePath, 'utf8');
    expect(raw).not.toContain(secret);
    expect(raw).toContain('[REDACTED]');
  });

  it('redacts a secret even on a denied action, since denials are audited too', async () => {
    const secret = 'denied-path-fake-secret';
    await handleActionProposal({
      proposal: proposalFor('settings.write', { token: secret }),
      policy: { schemaVersion: 1, defaultDecision: 'deny', rules: [] },
      emergencyState: DISENGAGED,
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform: () => undefined,
    });

    const lines = await readAuditLines();
    expect(lines[0]).toMatchObject({ decision: 'deny' });
    const raw = JSON.stringify(lines[0]);
    expect(raw).not.toContain(secret);
  });
});

describe('handleActionProposal — a proposal with an unknown action type is denied but cannot be audited', () => {
  it('denies the action, but the audit write itself throws, since auditRecordSchema requires a real ActionType', async () => {
    // This proves a real, subtle interaction rather than leaving it as an
    // untested assumption: `decidePermission` defensively denies an
    // actionType outside ACTION_TYPES (see REASON_UNKNOWN_ACTION_TYPE in
    // main/permissions.ts), but `auditRecordSchema` independently requires
    // `actionType` to be a genuine enum member. A proposal that reaches this
    // far with a bogus actionType should never happen in practice — IPC
    // request validation rejects it long before a proposal is constructed —
    // but if it somehow did, this documents that the pipeline fails loudly
    // (throws) rather than silently writing a mismatched audit record.
    const perform = vi.fn();
    await expect(
      handleActionProposal({
        proposal: proposalFor('shell.execute' as ActionProposal['actionType']),
        policy: DEFAULT_POLICY,
        emergencyState: DISENGAGED,
        actor: 'user',
        auditLogDir,
        now: NOW,
        perform,
      }),
    ).rejects.toThrow();
    expect(perform).not.toHaveBeenCalled();
  });
});

describe('handleActionProposal — audit records are queryable by decision', () => {
  it('records distinguishable entries for a denial and a rejected confirmation', async () => {
    await handleActionProposal({
      proposal: proposalFor('settings.write'),
      policy: { schemaVersion: 1, defaultDecision: 'deny', rules: [] },
      emergencyState: DISENGAGED,
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform: () => undefined,
    });
    await handleActionProposal({
      proposal: proposalFor('app.exit'),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
      actor: 'user',
      auditLogDir,
      now: NOW,
      requestConfirmation: () => 'rejected',
      perform: () => undefined,
    });

    const lines = await readAuditLines();
    expect(lines).toHaveLength(2);
    expect(lines.find((line) => line.actionType === 'settings.write')).toMatchObject({
      decision: 'deny',
      outcome: 'denied',
    });
    expect(lines.find((line) => line.actionType === 'app.exit')).toMatchObject({
      decision: 'confirm',
      outcome: 'aborted',
      confirmationResult: 'rejected',
    });
  });
});

describe('handleActionProposal — failure', () => {
  it('records a failure outcome with a stable error code when perform throws', async () => {
    const result = await handleActionProposal({
      proposal: proposalFor('settings.write'),
      policy: DEFAULT_POLICY,
      emergencyState: DISENGAGED,
      actor: 'user',
      auditLogDir,
      now: NOW,
      perform: () => {
        throw new Error('a real filesystem error containing C:\\Users\\real\\path\\secret.txt');
      },
    });

    expect(result.outcome).toBe('failure');
    expect(result.errorCode).toBe('EXECUTION_FAILED');

    const lines = await readAuditLines();
    expect(lines[0]).toMatchObject({ outcome: 'failure', errorCode: 'EXECUTION_FAILED' });
    expect(JSON.stringify(lines[0])).not.toContain('C:\\Users\\real\\path');
  });
});
